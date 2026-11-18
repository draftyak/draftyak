import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import { createServer, request } from "node:https";
import { type AddressInfo, createServer as createTcpServer, type Socket } from "node:net";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	assertDestinations,
	createRecorder,
	readResult,
} from "../../../../../tools/egress-recorder/src/index.ts";
import {
	createPinnedHttpsConnection,
	type EgressPolicy,
	type PinnedAddress,
	resolveEgressAnswers,
	validateEgressAnswers,
} from "../../../src/plugins/broker/network/index.ts";
import {
	type NetworkTestHooks,
	withNetworkTestHooks,
} from "../../../src/plugins/broker/network/test-context.ts";
import { createTlsFixture } from "./tls-fixture.ts";

const descriptor = {
	id: "component-network",
	caller: { kind: "hub" as const, instanceId: "DYTEST-hub" },
};
const required = { scope: "component" as const, observers: [descriptor], canary: false };
const target = { host: "guard.example", port: 443, transport: "tcp" as const };
const pin = { address: "8.8.8.8", family: 4 as const };
const policy = { deniedAddresses: [], deniedPorts: [] };
let tls: Awaited<ReturnType<typeof createTlsFixture>>;
beforeAll(async () => {
	tls = await createTlsFixture();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

function recording() {
	const recorder = createRecorder({ profile: "test", observers: [descriptor] });
	const observer = recorder.observer(descriptor.id);
	return {
		recorder,
		observer,
		finish() {
			observer.complete();
			return readResult(recorder.finish(), required);
		},
	};
}
async function peer() {
	const sockets = new Set<Socket>();
	const empty = Promise.withResolvers<void>();
	const seen = {
		connections: 0,
		requests: 0,
		bytes: 0,
		hosts: [] as string[],
		sni: [] as string[],
	};
	const server = createServer({ key: tls.key, cert: tls.cert }, (req, res) => {
		seen.requests++;
		seen.hosts.push(req.headers.host ?? "");
		res.end("DYTEST-body");
	});
	server.on("connection", (socket) => {
		seen.connections++;
		sockets.add(socket);
		socket.once("close", () => {
			sockets.delete(socket);
			if (!sockets.size) empty.resolve();
		});
	});
	server.on("secureConnection", (socket) => {
		if (typeof socket.servername === "string") seen.sni.push(socket.servername);
		socket.on("data", (data) => {
			seen.bytes += data.length;
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		empty: empty.promise,
		active: () => sockets.size,
		port: (server.address() as AddressInfo).port,
		seen,
		async close() {
			const done = new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
			for (const socket of sockets) socket.destroy();
			await done;
		},
	};
}
function fixture(
	port: number,
	observer: ReturnType<typeof recording>["observer"],
): NetworkTestHooks {
	return {
		observer,
		ca: tls.ca,
		resolve: async () => [pin],
		dial: () => ({ address: "127.0.0.1", family: 4, port }),
	};
}
async function get(native: EgressPolicy = policy, provided?: PinnedAddress): Promise<string> {
	const controller = new AbortController();
	let connection: ReturnType<typeof createPinnedHttpsConnection> | undefined;
	try {
		const answers = provided
			? [provided]
			: await resolveEgressAnswers(target.host, target.port, native, controller.signal);
		// Real consumers perform multiple non-consuming validations before opening TLS.
		validateEgressAnswers(answers, native);
		const first = validateEgressAnswers(answers, native);
		const checked = validateEgressAnswers([first], native);
		connection = createPinnedHttpsConnection(target.host, target.port, checked, native);
		const connected = connection;
		return await new Promise<string>((resolve, reject) => {
			let settled = false;
			const req = request({
				...connected.options,
				path: "/DYTEST-private-path?token=DYTEST-hidden",
				method: "GET",
			});
			const timer = setTimeout(() => finish(new Error("DYTEST-timeout")), 2000);
			function finish(error?: Error, body = "") {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				req.destroy();
				connected.destroy();
				if (error) reject(error);
				else resolve(body);
			}
			req.once("error", (error) => finish(error));
			connected.guard(
				req,
				() => false,
				() => req.end(),
				() => finish(new Error("DYTEST-refused")),
			);
			req.once("response", (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (b: Buffer) => chunks.push(b));
				res.once("error", (error) => finish(error));
				res.once("end", () => finish(undefined, Buffer.concat(chunks).toString()));
			});
		});
	} finally {
		controller.abort();
		connection?.destroy();
	}
}

describe("shared network component observations", () => {
	it("preserves unobserved request error behavior", () => {
		const connection = createPinnedHttpsConnection(target.host, 443, pin, policy);
		const request = new EventEmitter();
		try {
			connection.guard(
				request as ClientRequest,
				() => false,
				() => {},
				() => {},
			);
			expect(request.listenerCount("error")).toBe(0);
			expect(() => request.emit("error", new Error("DYTEST-unhandled"))).toThrow(
				"DYTEST-unhandled",
			);
		} finally {
			connection.destroy();
		}
	});
	it("destroys the actual request when observation expires at secure-connect settlement", async () => {
		const remote = await peer(),
			run = recording();
		const now = vi.spyOn(performance, "now").mockReturnValue(1000);
		let settlements = 0;
		const observer: NonNullable<NetworkTestHooks["observer"]> = {
			beginAttempt(destination) {
				const attempt = run.observer.beginAttempt(destination, 30_000);
				return {
					...attempt,
					succeeded() {
						settlements++;
						now.mockReturnValue(31000);
						attempt.succeeded();
					},
				};
			},
			fail: () => run.observer.fail(),
		};
		try {
			await expect(
				withNetworkTestHooks({ ...fixture(remote.port, run.observer), observer }, () => get()),
			).rejects.toThrow();
			expect(settlements).toBe(1);
			await remote.empty;
			expect(remote.active()).toBe(0);
			expect(remote.seen.requests).toBe(0);
			expect(remote.seen.bytes).toBe(0);
			expect(() => readResult(run.recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
		} finally {
			now.mockRestore();
			await remote.close();
		}
	});
	it("records a denied destination before DNS or socket dispatch", async () => {
		const run = recording(),
			resolve = vi.fn(async () => [pin]),
			dial = vi.fn();
		await expect(
			withNetworkTestHooks({ observer: run.observer, resolve, dial }, () =>
				resolveEgressAnswers(
					"cdn.example",
					443,
					{ ...policy, deniedPorts: [443] },
					new AbortController().signal,
				),
			),
		).rejects.toThrow();
		expect(resolve).not.toHaveBeenCalled();
		expect(dial).not.toHaveBeenCalled();
		run.observer.complete();
		const raw = run.recorder.finish();
		expect(readResult(raw, required).attempts).toEqual([
			{
				observerId: descriptor.id,
				sequence: 0,
				destination: { ...target, host: "cdn.example" },
				outcome: "refused",
				stage: "policy",
			},
		]);
		expect(() => assertDestinations(raw, required, [target])).toThrow("COVERAGE_MISMATCH");
	});
	it("records an actual resolver-hook failure without dialing", async () => {
		const run = recording(),
			dial = vi.fn();
		await expect(
			withNetworkTestHooks(
				{
					observer: run.observer,
					resolve: async () => {
						throw Error("DYTEST-private-DNS-error");
					},
					dial,
				},
				() => get(),
			),
		).rejects.toThrow();
		expect(dial).not.toHaveBeenCalled();
		expect(run.finish().attempts).toEqual([
			{
				observerId: descriptor.id,
				sequence: 0,
				destination: target,
				outcome: "failed",
				stage: "dns",
			},
		]);
	});
	it("records a real loopback connection refusal as connect failure", async () => {
		const reserved = createTcpServer();
		await new Promise<void>((resolve) => reserved.listen(0, "127.0.0.1", resolve));
		const port = (reserved.address() as AddressInfo).port;
		await new Promise<void>((resolve) => reserved.close(() => resolve()));
		const run = recording();
		await expect(withNetworkTestHooks(fixture(port, run.observer), () => get())).rejects.toThrow();
		expect(run.finish().attempts).toEqual([
			{
				observerId: descriptor.id,
				sequence: 0,
				destination: target,
				outcome: "failed",
				stage: "connect",
			},
		]);
	});
	it.each([true, false])(
		"records real TLS acceptance=%s exactly once across validation copies",
		async (trusted) => {
			const remote = await peer(),
				run = recording();
			try {
				const result = withNetworkTestHooks(
					{ ...fixture(remote.port, run.observer), ca: trusted ? tls.ca : undefined },
					() => get(),
				);
				if (trusted) await expect(result).resolves.toBe("DYTEST-body");
				else await expect(result).rejects.toThrow();
				const report = run.finish();
				expect(report.attempts).toEqual([
					{
						observerId: descriptor.id,
						sequence: 0,
						destination: target,
						outcome: trusted ? "succeeded" : "failed",
						stage: "connect",
					},
				]);
				expect(remote.seen.connections).toBe(1);
				expect(remote.seen.requests).toBe(trusted ? 1 : 0);
				if (trusted) {
					expect(remote.seen.hosts).toEqual([target.host]);
					expect(remote.seen.sni).toEqual([target.host]);
					expect(remote.seen.bytes).toBeGreaterThan(0);
				} else expect(remote.seen.bytes).toBe(0);
				expect(JSON.stringify(report)).not.toMatch(/private-path|token=|DYTEST-body|127\.0\.0\.1/);
				expect(() => readResult(JSON.stringify(report), { ...required, scope: "native" })).toThrow(
					"COVERAGE_MISMATCH",
				);
			} finally {
				await remote.close();
			}
		},
	);
	it("keeps concurrent same-target attempts separate when DNS settles in reverse order", async () => {
		const remote = await peer(),
			run = recording(),
			first = Promise.withResolvers<readonly PinnedAddress[]>(),
			second = Promise.withResolvers<readonly PinnedAddress[]>();
		let calls = 0;
		try {
			await withNetworkTestHooks(
				{
					...fixture(remote.port, run.observer),
					resolve: () => (++calls === 1 ? first.promise : second.promise),
				},
				async () => {
					const a = get(),
						b = get();
					const aRejected = expect(a).rejects.toThrow();
					second.resolve([pin]);
					await expect(b).resolves.toBe("DYTEST-body");
					first.reject(Error("DYTEST-DNS"));
					await aRejected;
				},
			);
			expect(
				run.finish().attempts.map((x) => [x.sequence, x.destination, x.outcome, x.stage]),
			).toEqual([
				[0, target, "failed", "dns"],
				[1, target, "succeeded", "connect"],
			]);
			expect(remote.seen.requests).toBe(1);
		} finally {
			await remote.close();
		}
	});
	it("records direct pinned TLS without silently omitting an unassociated pin", async () => {
		const remote = await peer(),
			run = recording();
		try {
			await expect(
				withNetworkTestHooks(fixture(remote.port, run.observer), () => get(policy, pin)),
			).resolves.toBe("DYTEST-body");
			expect(run.finish().attempts).toHaveLength(1);
		} finally {
			await remote.close();
		}
	});
	it("refuses a second returned pin from the same resolved attempt before dialing", async () => {
		const run = recording(),
			dial = vi.fn(() => ({ address: "127.0.0.1", family: 4 as const, port: 1 }));
		await withNetworkTestHooks(
			{
				observer: run.observer,
				resolve: async () => [pin, { address: "8.8.4.4", family: 4 }],
				dial,
			},
			async () => {
				const answers = await resolveEgressAnswers(
					target.host,
					443,
					policy,
					new AbortController().signal,
				);
				const first = createPinnedHttpsConnection(
					target.host,
					443,
					answers[0] as PinnedAddress,
					policy,
				);
				try {
					expect(() =>
						createPinnedHttpsConnection(target.host, 443, answers[1] as PinnedAddress, policy),
					).toThrow();
					expect(dial).toHaveBeenCalledTimes(1);
				} finally {
					first.destroy();
				}
			},
		);
		expect(() => readResult(run.recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
	});
	it("refuses host or port substitution without consuming an unobserved socket", async () => {
		for (const [host, port] of [
			["other.example", 443],
			[target.host, 444],
		] as const) {
			const run = recording(),
				dial = vi.fn();
			await withNetworkTestHooks(
				{ observer: run.observer, resolve: async () => [pin], dial },
				async () => {
					const answers = await resolveEgressAnswers(
						target.host,
						443,
						policy,
						new AbortController().signal,
					);
					expect(() =>
						createPinnedHttpsConnection(host, port, answers[0] as PinnedAddress, policy),
					).toThrow();
					expect(dial).not.toHaveBeenCalled();
				},
			);
			expect(() => readResult(run.recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
		}
	});
	it("cancels a resolved but unused attempt with the original caller signal", async () => {
		const run = recording(),
			controller = new AbortController();
		await withNetworkTestHooks({ observer: run.observer, resolve: async () => [pin] }, () =>
			resolveEgressAnswers(target.host, 443, policy, controller.signal),
		);
		controller.abort();
		expect(run.finish().attempts[0]).toMatchObject({ outcome: "failed", stage: "connect" });
	});
	it("does not upgrade held DNS after observation completion fails", async () => {
		const run = recording(),
			dns = Promise.withResolvers<readonly PinnedAddress[]>(),
			dial = vi.fn();
		const result = withNetworkTestHooks(
			{ observer: run.observer, resolve: () => dns.promise, dial },
			() => get(),
		);
		const rejected = expect(result).rejects.toThrow();
		expect(() => run.observer.complete()).toThrow("LIFECYCLE");
		const raw = run.recorder.finish();
		dns.resolve([pin]);
		await rejected;
		expect(dial).not.toHaveBeenCalled();
		expect(() => readResult(raw, required)).toThrow("OBSERVATION_FAILED");
	});
	it("aborts held DNS at its observation deadline and prevents a late connection", async () => {
		const run = recording(),
			dns = Promise.withResolvers<readonly PinnedAddress[]>(),
			aborted = Promise.withResolvers<void>(),
			dial = vi.fn();
		const result = withNetworkTestHooks(
			{
				observer: run.observer,
				observationTimeoutMs: 15,
				resolve: (_host, signal) => {
					signal.addEventListener("abort", () => aborted.resolve(), { once: true });
					return dns.promise;
				},
				dial,
			},
			() => get(),
		);
		const rejected = expect(result).rejects.toThrow();
		await aborted.promise;
		dns.resolve([pin]);
		await rejected;
		expect(dial).not.toHaveBeenCalled();
		expect(run.finish().attempts[0]).toMatchObject({ outcome: "failed", stage: "dns" });
	});
	it.each([
		["production", "true"],
		["test", "false"],
		["test", undefined],
	])("refuses observation hooks outside both test flags %s/%s before callbacks", (node, vitest) => {
		vi.stubEnv("NODE_ENV", node);
		vi.stubEnv("VITEST", vitest);
		const callbacks = vi.fn();
		const hooks = {
			get observer() {
				callbacks();
				return undefined;
			},
			resolve: async () => {
				callbacks();
				return [pin];
			},
		};
		expect(() => withNetworkTestHooks(hooks, callbacks)).toThrow("test profile");
		expect(callbacks).not.toHaveBeenCalled();
	});
});
