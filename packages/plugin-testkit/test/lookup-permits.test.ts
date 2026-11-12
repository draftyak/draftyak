import { createFake } from "@draftyak/fakes";
import { LOOKUP_PERMIT_META_KEY } from "@draftyak/protocol/host-channel";
import { validateManifest } from "@draftyak/protocol/manifest";
import { afterEach, expect, it, vi } from "vitest";
import { createMockHost } from "../src/host.ts";
import { createMockHub } from "../src/index.ts";
import { channelFixture } from "./fixtures/channel/plugin.ts";
import { toolFixture } from "./fixtures/tool/plugin.ts";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function bridgeFor(
	fetch: () => Response | Promise<Response> = () => new Response("data"),
	controls: Parameters<typeof createMockHost>[1] = {},
	timeoutMs = 15_000,
) {
	const checked = validateManifest(toolFixture(undefined, { timeoutMs }).manifest);
	if (!checked.ok) throw new Error("fixture manifest");
	let calls = 0;
	const fake = createFake({ fetch: () => new Response("unused") }, { host: "permit.example" });
	const bridge = createMockHost(
		{
			manifest: checked.manifest,
			instance: "00000000000000000000000001",
			upstreams: [
				{
					...fake,
					async fetch() {
						calls++;
						return fetch();
					},
				},
			],
			secrets: { calendarUrl: "https://permit.example/data" },
		},
		controls,
	);
	cleanup.push(() => bridge.host.close());
	const request = (permit?: string, method: "GET" | "POST" = "GET") =>
		bridge.host.request("host/fetch", {
			method,
			url: "secret://calendarUrl",
			headers: [],
			...(permit === undefined ? {} : { lookupPermit: permit }),
		});
	return { ...bridge, request, calls: () => calls };
}
function token(permit: string | undefined): string {
	expect(permit).toMatch(/^[A-Za-z0-9_-]{43}$/);
	expect(Buffer.from(permit ?? "", "base64url")).toHaveLength(32);
	return permit ?? "";
}
async function turns(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

it("issues a canonical permit and overwrites caller metadata before the real MCP handler", async () => {
	let captured: unknown;
	const hub = createMockHub({
		mode: "in-memory",
		upstreams: [],
		plugin: toolFixture(async (_args, _context, metadata) => {
			captured = metadata[LOOKUP_PERMIT_META_KEY];
			return { entries: [] };
		}),
	});
	cleanup.push(() => hub.close());
	expect(
		(await hub.call("kb.lookup", { topic: "test" }, { [LOOKUP_PERMIT_META_KEY]: { forged: true } }))
			.structuredContent,
	).toEqual({ entries: [] });
	expect(typeof captured).toBe("string");
	token(captured as string);
});

it("does not infer fetch authority from an ambient callback without an echoed permit", async () => {
	const bridge = bridgeFor();
	await bridge.lookup(async () => {
		await expect(bridge.request()).rejects.toMatchObject({ code: "DENIED" });
	}, "kb.lookup");
	expect(bridge.calls()).toBe(0);
});

it("denies missing, unknown and foreign permits even inside another active lookup", async () => {
	const current = bridgeFor(),
		foreign = bridgeFor();
	let other = "";
	await foreign.lookup(async (_signal, foreignPermit) => {
		other = token(foreignPermit);
		await current.lookup(async (_signal, permit) => {
			const valid = token(permit);
			for (const bad of [undefined, Buffer.alloc(32, 91).toString("base64url"), other])
				await expect(current.request(bad)).rejects.toMatchObject({ code: "DENIED" });
			for (let index = 0; index < 4; index++)
				expect((await current.request(valid)).status).toBe(200);
		}, "kb.lookup");
	}, "kb.lookup");
	expect(current.calls()).toBe(4);
	expect(current.host.denials.map((row) => row.lookup)).toEqual([null, null, null]);
});

it("denies retired A while B is active and charges delayed A presenting B only to B", async () => {
	const bridge = bridgeFor();
	const release = Promise.withResolvers<void>();
	let a = "",
		b = "";
	let late: Promise<void> | undefined;
	await bridge.lookup(async (_signal, permit) => {
		a = token(permit);
		late = release.promise.then(async () => {
			await expect(bridge.request(a)).rejects.toMatchObject({ code: "DENIED" });
			for (let index = 0; index < 4; index++) expect((await bridge.request(b)).status).toBe(200);
			await expect(bridge.request(b)).rejects.toMatchObject({ code: "DENIED" });
		});
	}, "kb.lookup");
	await bridge.lookup(async (_signal, permit) => {
		b = token(permit);
		expect(b).not.toBe(a);
		release.resolve();
		await late;
		await expect(bridge.request(b)).rejects.toMatchObject({ code: "DENIED" });
	}, "kb.lookup");
	expect(bridge.calls()).toBe(4);
	expect(bridge.host.denials).toMatchObject([
		{ reason: "LOOKUP_REQUIRED", lookup: null },
		{ reason: "LOOKUP_REQUEST_LIMIT", lookup: 2 },
		{ reason: "LOOKUP_REQUEST_LIMIT", lookup: 2 },
	]);
	expect(JSON.stringify(bridge.host.denials)).not.toContain(a);
	expect(JSON.stringify(bridge.host.denials)).not.toContain(b);
});

it("atomically admits four of five simultaneous attempts without refunds or replay caching", async () => {
	const bridge = bridgeFor();
	await bridge.lookup(async (_signal, permit) => {
		const results = await Promise.allSettled(
			Array.from({ length: 5 }, () => bridge.request(token(permit))),
		);
		expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(4);
		expect(results.filter((row) => row.status === "rejected")).toHaveLength(1);
		await expect(bridge.request(permit)).rejects.toMatchObject({ code: "DENIED" });
	}, "kb.lookup");
	expect(bridge.calls()).toBe(4);
});

it("charges every valid policy-refused attempt before semantic policy", async () => {
	const bridge = bridgeFor();
	await bridge.lookup(async (_signal, permit) => {
		for (let index = 0; index < 4; index++)
			await expect(bridge.request(token(permit), "POST")).rejects.toMatchObject({ code: "DENIED" });
		await expect(bridge.request(permit)).rejects.toMatchObject({ code: "DENIED" });
	}, "kb.lookup");
	expect(bridge.calls()).toBe(0);
	expect(bridge.host.denials.map((row) => row.reason)).toEqual([
		"TOOL_FETCH_FORBIDDEN",
		"TOOL_FETCH_FORBIDDEN",
		"TOOL_FETCH_FORBIDDEN",
		"TOOL_FETCH_FORBIDDEN",
		"LOOKUP_REQUEST_LIMIT",
	]);
});

it("charges synthetic upstream failures without retrying or refunding an attempt", async () => {
	const bridge = bridgeFor(() => Promise.reject(new Error("synthetic resolution failure")));
	await bridge.lookup(async (_signal, permit) => {
		for (let index = 0; index < 5; index++)
			await expect(bridge.request(token(permit))).rejects.toMatchObject({ code: "DENIED" });
	}, "kb.lookup");
	expect(bridge.calls()).toBe(4);
	expect(bridge.host.denials.map((row) => row.reason)).toEqual([
		"UPSTREAM_FAILED",
		"UPSTREAM_FAILED",
		"UPSTREAM_FAILED",
		"UPSTREAM_FAILED",
		"LOOKUP_REQUEST_LIMIT",
	]);
});

it("drops and cancels late headers from a fake that ignored host closure", async () => {
	const response = Promise.withResolvers<Response>();
	const bridge = bridgeFor(() => response.promise);
	let reads = 0,
		cancels = 0;
	const call = bridge
		.lookup(async (_signal, permit) => bridge.request(token(permit)), "kb.lookup")
		.catch((error: unknown) => error);
	await turns();
	expect(bridge.calls()).toBe(1);
	bridge.host.close();
	expect(await call).toMatchObject({ code: "DENIED" });
	response.resolve(
		new Response(
			new ReadableStream<Uint8Array>(
				{
					pull(controller) {
						reads++;
						controller.enqueue(new Uint8Array([1]));
						controller.close();
					},
					cancel() {
						cancels++;
					},
				},
				{ highWaterMark: 0 },
			),
		),
	);
	await turns();
	expect(reads).toBe(0);
	expect(cancels).toBe(1);
});

it("does not issue a kind permit to a probe or admit its unbound fetch", async () => {
	const bridge = bridgeFor();
	await bridge.lookup(async (_signal, permit) => {
		expect(permit).toBeUndefined();
		await expect(bridge.request()).rejects.toMatchObject({ code: "DENIED" });
	});
	expect(bridge.calls()).toBe(0);
});

it("refuses a tool permit on a channel host without sending it upstream", async () => {
	const checked = validateManifest(channelFixture().manifest);
	if (!checked.ok) throw new Error("fixture manifest");
	const bridge = createMockHost({
		manifest: checked.manifest,
		instance: "00000000000000000000000001",
		upstreams: [],
	});
	cleanup.push(() => bridge.host.close());
	await expect(
		bridge.host.request("host/fetch", {
			method: "GET",
			url: "https://hello.draftyak.example/v1/conversations",
			headers: [],
			lookupPermit: Buffer.alloc(32).toString("base64url"),
		}),
	).rejects.toMatchObject({ code: "DENIED" });
	expect(bridge.host.denials[0]?.reason).toBe("LOOKUP_PERMIT_FORBIDDEN");
});

it.each(["throw", "short"])("fails closed before handler dispatch on %s entropy", async (mode) => {
	const action = vi.fn(async () => "not admitted");
	const bridge = bridgeFor(undefined, {
		entropy: () => {
			if (mode === "throw") throw new Error("synthetic entropy failure");
			return new Uint8Array(31);
		},
	});
	await expect(bridge.lookup(action, "kb.lookup")).rejects.toMatchObject({ code: "DENIED" });
	expect(action).not.toHaveBeenCalled();
	expect(bridge.calls()).toBe(0);
});

it("retries live collisions and refuses after exactly four colliding fresh draws", async () => {
	let draws = 0;
	const bridge = bridgeFor(undefined, {
		entropy: () => new Uint8Array(32).fill(++draws === 3 ? 1 : 0),
	});
	await bridge.lookup(async (_signal, first) => {
		await bridge.lookup(async (_otherSignal, second) => {
			expect(token(second)).not.toBe(token(first));
		}, "kb.lookup");
		expect(draws).toBe(3);
		const refused = vi.fn(async () => "not admitted");
		await expect(bridge.lookup(refused, "kb.lookup")).rejects.toMatchObject({ code: "DENIED" });
		expect(draws).toBe(7);
		expect(refused).not.toHaveBeenCalled();
	}, "kb.lookup");
});

it("keeps a retiring fake's permit reserved until real disposal settles", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const response = Promise.withResolvers<Response>();
	let draws = 0;
	const bridge = bridgeFor(() => response.promise, {
		entropy: () => {
			draws++;
			return new Uint8Array(32);
		},
	});
	const first = bridge.lookup(
		async (_signal, permit) => bridge.request(token(permit)),
		"kb.lookup",
	);
	const terminal = first.catch((error: unknown) => error);
	await turns();
	expect(bridge.calls()).toBe(1);
	await vi.advanceTimersByTimeAsync(5000);
	expect(await terminal).toMatchObject({ code: "TIMEOUT" });
	const refused = vi.fn(async () => "not admitted");
	await expect(bridge.lookup(refused, "kb.lookup")).rejects.toMatchObject({ code: "DENIED" });
	expect(draws).toBe(5);
	expect(refused).not.toHaveBeenCalled();
	response.resolve(new Response("late"));
	await turns();
	expect(await bridge.lookup(async () => "disposed", "kb.lookup")).toBe("disposed");
});

it("retains the finite trusted-fixture slot for each abort-ignoring fake until disposal", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const replies = Array.from({ length: 16 }, () => Promise.withResolvers<Response>());
	let index = 0;
	const bridge = bridgeFor(() => {
		const reply = replies[index++];
		if (!reply) throw new Error("unexpected fixture dispatch");
		return reply.promise;
	});
	const calls = Array.from({ length: 16 }, () =>
		bridge
			.lookup(async (_signal, permit) => bridge.request(token(permit)), "kb.lookup")
			.catch((error: unknown) => error),
	);
	try {
		await turns();
		expect(bridge.calls()).toBe(16);
		await vi.advanceTimersByTimeAsync(5000);
		expect(await Promise.all(calls)).toEqual(
			Array.from({ length: 16 }, () => expect.objectContaining({ code: "TIMEOUT" })),
		);
		for (let repeat = 0; repeat < 3; repeat++) {
			const action = vi.fn(async () => "unbounded admission");
			await expect(bridge.lookup(action, "kb.lookup")).rejects.toMatchObject({
				code: "LOOKUP_LIMIT",
			});
			expect(action).not.toHaveBeenCalled();
		}
		replies[0]?.resolve(new Response("late"));
		await turns();
		expect(await bridge.lookup(async () => "one free slot", "kb.lookup")).toBe("one free slot");
	} finally {
		for (const reply of replies) reply.resolve(new Response("late"));
		await turns();
	}
});
