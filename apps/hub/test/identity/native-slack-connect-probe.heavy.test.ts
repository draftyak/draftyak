import { setImmediate } from "node:timers";
import { describe, expect, it } from "vitest";
import {
	closeNativeSlackConnectProbe,
	createNativeSlackConnectProbe,
	type NativeSlackConnectProbe,
	NativeSlackConnectProbeError,
	type NativeSlackConnectProbeResult,
	probeNativeSlackConnect,
	takeNativeSlackConnectProbeResult,
} from "../../src/identity/native-slack-connect-probe.ts";
import { systemClock, type TimerClock } from "../../src/kernel/clock.ts";
import { device } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import {
	type NativeSlackConnectFixture,
	nativeSlackConnectFixture,
} from "../helpers/native-slack-connect.ts";
import { closeSessionTransport } from "../lifecycle/session-helpers.ts";

requireLoopbackNetworkGuard();
const BODY = Buffer.from('{"ok":true,"team_id":"T-DYTEST","user_id":"U-DYTEST"}');
const TOKEN = "DYTEST+&=?%";
const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function response(body: Uint8Array = BODY, headers: readonly string[] = []): Buffer {
	return Buffer.concat([
		Buffer.from(
			[
				"HTTP/1.1 200 OK",
				"Content-Type: application/json",
				`Content-Length: ${body.byteLength}`,
				"X-OAuth-Scopes: channels:history,chat:write",
				"Connection: close",
				...headers,
				"",
				"",
			].join("\r\n"),
		),
		body,
	]);
}

async function usingFixture(
	run: (fixture: NativeSlackConnectFixture, probe: NativeSlackConnectProbe) => Promise<void>,
	clock?: TimerClock,
): Promise<void> {
	const f = await nativeSlackConnectFixture(clock ? { clock } : {});
	try {
		await run(f, createNativeSlackConnectProbe(f.session, f.clock));
	} finally {
		await f.close();
	}
}

function start(
	f: NativeSlackConnectFixture,
	probe: NativeSlackConnectProbe,
	controller = new AbortController(),
	peer = f.owner.peer,
) {
	const token = Buffer.from(TOKEN);
	const pending = f.provider.withNetwork(() =>
		probeNativeSlackConnect(probe, peer, token, controller.signal),
	);
	token.fill(0);
	void pending.catch(() => undefined);
	return pending;
}

function nextRequest(
	f: NativeSlackConnectFixture,
	pending: Promise<NativeSlackConnectProbeResult>,
) {
	return Promise.race([
		f.provider.nextRequest(),
		pending.then(
			() => {
				throw new Error("Probe returned before observed TLS request");
			},
			() => {
				throw new Error("Probe refused before observed TLS request");
			},
		),
	]);
}

function checkResponse(
	probe: NativeSlackConnectProbe,
	result: NativeSlackConnectProbeResult,
	expected: Buffer = BODY,
): void {
	const data = takeNativeSlackConnectProbeResult(probe, result);
	try {
		expect(data.rawBody.equals(expected)).toBe(true);
		expect(data.rawHeaders).toEqual([
			"Content-Type",
			"application/json",
			"Content-Length",
			String(expected.byteLength),
			"X-OAuth-Scopes",
			"channels:history,chat:write",
			"Connection",
			"close",
		]);
	} finally {
		data.rawBody.fill(0);
	}
}

async function denied(pending: Promise<NativeSlackConnectProbeResult>): Promise<void> {
	await expect(pending).rejects.toMatchObject({
		name: "NativeSlackConnectProbeError",
		code: "SLACK_CONNECT_PROBE_UNAVAILABLE",
		message: "Slack connect probe unavailable",
	});
}

interface TimerTailClock {
	readonly clock: TimerClock;
	readonly cancelled: Promise<void>;
	capturing: boolean;
	armed: boolean;
	signal: AbortSignal | undefined;
	release(): void;
}

function timerTailClock(): TimerTailClock {
	const cancelled = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const tail: TimerTailClock = {
		cancelled: cancelled.promise,
		capturing: false,
		armed: false,
		signal: undefined,
		clock: {
			wallMs: () => systemClock.wallMs(),
			monotonicMs: () => systemClock.monotonicMs(),
			async after(ms, signal) {
				const owned =
					tail.capturing && Number.isInteger(ms) && ms > 0 && ms <= 10_000 && signal !== undefined;
				if (owned) tail.signal = signal;
				try {
					await systemClock.after(ms, signal);
				} catch (error) {
					if (owned && tail.armed && signal?.aborted) {
						cancelled.resolve();
						await release.promise;
					}
					throw error;
				}
			},
		},
		release() {
			tail.capturing = false;
			tail.armed = false;
			release.resolve();
		},
	};
	return tail;
}

function settlementOf(pending: Promise<unknown>): () => boolean {
	let settled = false;
	const finish = (): void => {
		settled = true;
	};
	void pending.then(finish, finish);
	return () => settled;
}

describe("original Session Slack connect transport", () => {
	it("uses the fixed POST and captured token, then transfers one-use response DATA", async () => {
		await usingFixture(async (f, probe) => {
			expect(createNativeSlackConnectProbe(f.session, f.clock)).toBe(probe);
			const token = Buffer.from(TOKEN),
				alias = token.subarray(0);
			const pending = f.provider.withNetwork(() =>
				probeNativeSlackConnect(probe, f.owner.peer, token, new AbortController().signal),
			);
			void pending.catch(() => undefined);
			alias.fill(0x41);
			token.fill(0);
			const request = await nextRequest(f, pending);
			expect([request.method, request.target, request.version]).toEqual([
				"POST",
				"/api/auth.test",
				"HTTP/1.1",
			]);
			const header = (name: string) =>
				request.headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);
			expect(header("host")).toEqual(["slack.com"]);
			expect(header("content-type")).toEqual(["application/x-www-form-urlencoded"]);
			expect(header("accept")).toEqual(["application/json"]);
			expect(header("accept-encoding")).toEqual(["identity"]);
			expect(header("authorization")).toEqual([]);
			expect(Buffer.from(request.body).toString("ascii")).toBe("token=DYTEST%2B%26%3D%3F%25");
			expect(header("content-length")).toEqual([String(request.body.byteLength)]);
			await request.end(response());
			const result = await pending;
			checkResponse(probe, result);
			expect(() => takeNativeSlackConnectProbeResult(probe, result)).toThrow(
				NativeSlackConnectProbeError,
			);
			await request.closed;
			expect(f.provider.resolutions).toEqual(["slack.com"]);
			expect(f.provider.dials).toEqual([{ address: "93.184.216.34", port: 443 }]);
			expect(f.provider.failures).toEqual([]);
			token.fill(0);
		});
	});

	it("refuses a genuine peer from another Session and binds results to their original probe", async () => {
		await usingFixture(async (f, probe) => {
			const foreign = await nativeSlackConnectFixture();
			try {
				const other = createNativeSlackConnectProbe(foreign.session, foreign.clock);
				await denied(start(f, probe, new AbortController(), foreign.owner.peer));
				expect(f.provider.resolutions).toEqual([]);
				const pending = start(f, probe),
					request = await nextRequest(f, pending);
				await request.end(response());
				const result = await pending;
				expect(() => takeNativeSlackConnectProbeResult(other, result)).toThrow(
					NativeSlackConnectProbeError,
				);
				checkResponse(probe, result);
			} finally {
				await foreign.close();
			}
		});
	});

	it("refuses a real TLS peer that was never admitted in the native registry", async () => {
		await usingFixture(async (f, probe) => {
			const unpaired = await device(f.transport);
			await denied(start(f, probe, new AbortController(), unpaired.peer));
			expect(f.provider.resolutions).toEqual([]);
		});
	});

	it("rechecks the original peer before transferring a received result", async () => {
		await usingFixture(async (f, probe) => {
			const pending = start(f, probe),
				request = await nextRequest(f, pending);
			await request.end(response());
			const result = await pending;
			await closeSessionTransport(f.transport);
			expect(() => takeNativeSlackConnectProbeResult(probe, result)).toThrow(
				NativeSlackConnectProbeError,
			);
		});
	});

	it("keeps a signal reserved until its one-use result is taken", async () => {
		await usingFixture(async (f, probe) => {
			const controller = new AbortController(),
				pending = start(f, probe, controller);
			const request = await nextRequest(f, pending);
			await denied(start(f, probe, controller));
			await request.end(response());
			const result = await pending;
			await denied(start(f, probe, controller));
			expect(f.provider.requests).toHaveLength(1);
			checkResponse(probe, result);
			const again = start(f, probe, controller),
				second = await nextRequest(f, again);
			await second.end(response());
			checkResponse(probe, await again);
			expect(f.provider.requests).toHaveLength(2);
		});
	});

	it("preserves duplicate raw scope headers instead of normalizing them", async () => {
		await usingFixture(async (f, probe) => {
			const pending = start(f, probe),
				request = await nextRequest(f, pending);
			await request.end(response(BODY, ["x-oauth-scopes: channels:read"]));
			const data = takeNativeSlackConnectProbeResult(probe, await pending);
			try {
				expect(
					data.rawHeaders.filter(
						(value, index) => index % 2 === 0 && value.toLowerCase() === "x-oauth-scopes",
					),
				).toHaveLength(2);
				expect(data.rawBody.equals(BODY)).toBe(true);
			} finally {
				data.rawBody.fill(0);
			}
			expect(data.rawBody.every((byte) => byte === 0)).toBe(true);
		});
	});

	it.each([
		[
			"provider error",
			Buffer.from(
				'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{"ok":false}',
			),
		],
		[
			"non-success status",
			Buffer.concat([
				Buffer.from(
					`HTTP/1.1 503 Unavailable\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\nConnection: close\r\n\r\n`,
				),
				BODY,
			]),
		],
		["redirect", response(BODY, ["Location: https://slack.com/elsewhere"])],
		["compression", response(BODY, ["Content-Encoding: gzip"])],
		[
			"too many raw header pairs",
			response(
				BODY,
				Array.from({ length: 125 }, (_, index) => `X-DYTEST-${index}: x`),
			),
		],
		["duplicate length", response(BODY, [`Content-Length: ${BODY.length}`])],
		[
			"truncated framing",
			Buffer.concat([
				Buffer.from(
					`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length + 1}\r\nConnection: close\r\n\r\n`,
				),
				BODY,
			]),
		],
		["duplicate JSON key", response(Buffer.from('{"ok":true,"ok":true}'))],
		[
			"oversize declared body",
			Buffer.from(
				"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 65537\r\nConnection: close\r\n\r\n",
			),
		],
	] as const)("refuses %s over the actual TLS response", async (_label, wire) => {
		await usingFixture(async (f, probe) => {
			const pending = start(f, probe),
				request = await nextRequest(f, pending);
			await Promise.allSettled([request.end(wire)]);
			await denied(pending);
			await request.closed;
			expect(f.provider.requests).toHaveLength(1);
		});
	});

	it("accepts exactly 64 KiB but refuses an overflowing streamed body without a length header", async () => {
		await usingFixture(async (f, probe) => {
			const prefix = '{"ok":true,"team_id":null,"user_id":"U-DYTEST","padding":"',
				suffix = '"}';
			const boundary = Buffer.from(
				prefix + "x".repeat(65_536 - prefix.length - suffix.length) + suffix,
			);
			expect(boundary).toHaveLength(65_536);
			const first = start(f, probe),
				accepted = await nextRequest(f, first);
			await accepted.end(response(boundary));
			checkResponse(probe, await first, boundary);
			const overflowing = Buffer.concat([boundary, Buffer.from(" ")]);
			const second = start(f, probe),
				refused = await nextRequest(f, second);
			await Promise.allSettled([
				refused.end(
					Buffer.concat([
						Buffer.from(
							"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n",
						),
						overflowing,
					]),
				),
			]);
			await denied(second);
			await refused.closed;
		});
	});

	it("keeps an incomplete real response pending, then cancels and physically closes it", async () => {
		await usingFixture(async (f, probe) => {
			const controller = new AbortController(),
				pending = start(f, probe, controller);
			const request = await nextRequest(f, pending);
			await request.write(
				Buffer.from(
					`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\n\r\n`,
				),
			);
			let settled = false;
			void pending.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			await turn();
			expect(settled).toBe(false);
			controller.abort();
			await denied(pending);
			await request.closed;
			await expect(closeNativeSlackConnectProbe(probe)).resolves.toBeUndefined();
		});
	});

	it("refuses a response at the original monotonic deadline even when wall time stalls", async () => {
		const wall = systemClock.wallMs();
		let mono = 0;
		const clock: TimerClock = {
			wallMs: () => wall,
			monotonicMs: () => mono,
			after: (ms, signal) => systemClock.after(ms, signal),
		};
		await usingFixture(async (f, probe) => {
			const pending = start(f, probe),
				request = await nextRequest(f, pending);
			mono = 10_000;
			await Promise.allSettled([request.end(response())]);
			await denied(pending);
			await request.closed;
		}, clock);
	});

	it("joins the real timer cancellation tail before failure and explicit close settle", async () => {
		const tail = timerTailClock();
		try {
			await usingFixture(async (f, probe) => {
				const controller = new AbortController();
				tail.capturing = true;
				const pending = start(f, probe, controller);
				tail.capturing = false;
				const request = await nextRequest(f, pending);
				expect(tail.signal !== undefined && !tail.signal.aborted).toBe(true);
				tail.armed = true;
				controller.abort();
				const failed = settlementOf(pending);
				const closing = closeNativeSlackConnectProbe(probe);
				const closed = settlementOf(closing);
				try {
					await Promise.all([request.closed, tail.cancelled]);
					await turn();
					expect(failed()).toBe(false);
					expect(closed()).toBe(false);
				} finally {
					tail.release();
				}
				await denied(pending);
				await closing;
			}, tail.clock);
		} finally {
			tail.release();
		}
	});

	it("joins an incomplete probe through original Session.close alone", async () => {
		const tail = timerTailClock();
		try {
			await usingFixture(async (f, probe) => {
				const controller = new AbortController();
				let pending: Promise<NativeSlackConnectProbeResult> | undefined;
				let closing: Promise<void> | undefined;
				try {
					tail.capturing = true;
					pending = start(f, probe, controller);
					tail.capturing = false;
					const request = await nextRequest(f, pending);
					await request.write(
						Buffer.from(
							"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 99\r\n\r\n",
						),
					);
					expect(tail.signal !== undefined && !tail.signal.aborted).toBe(true);
					tail.armed = true;
					const probeSettled = settlementOf(pending);
					closing = f.session.close();
					const sessionSettled = settlementOf(closing);
					const first = await Promise.race([
						tail.cancelled.then(() => "probe-timer-aborted"),
						closing.then(
							() => "session-closed",
							() => "session-refused",
						),
					]);
					expect(first).toBe("probe-timer-aborted");
					expect(tail.signal?.aborted).toBe(true);
					await request.closed;
					await turn();
					expect(probeSettled()).toBe(false);
					expect(sessionSettled()).toBe(false);
					expect(f.session.store.read((sql) => sql.get<{ n: number }>("SELECT 1 AS n")?.n)).toBe(1);
					tail.release();
					await denied(pending);
					await closing;
					let derived: Buffer | undefined,
						usable = false;
					try {
						derived = f.masterKey.derive("db");
						usable = derived.byteLength === 32;
					} catch {
						/* The original Session has erased its original key. */
					} finally {
						derived?.fill(0);
					}
					expect(usable).toBe(false);
				} finally {
					tail.release();
					controller.abort();
					await Promise.allSettled([...(pending ? [pending] : []), ...(closing ? [closing] : [])]);
				}
			}, tail.clock);
		} finally {
			tail.release();
		}
	});
});
