import { HOST_MAX_WS_DATA_LENGTH } from "@draftyak/protocol/host-channel";
import { describe, expect, it, vi } from "vitest";
import { createSocketModeLimiter } from "../../../../src/plugins/broker/socket-mode/index.ts";

const serialized = vi.hoisted(() => ({ count: 0 }));
vi.mock("@draftyak/protocol/jcs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@draftyak/protocol/jcs")>();
	const canonicalize: typeof actual.canonicalize = (value) => {
		serialized.count++;
		return actual.canonicalize(value);
	};
	return { ...actual, canonicalize };
});

describe("Socket Mode frame measurement", () => {
	it("closes with 1009 on text longer than the contract's data length without serializing it", () => {
		const limiter = createSocketModeLimiter({ monotonicMs: () => 50_000 });
		const connect = (n: number): string => {
			const url = `wss://wss-primary.slack.com/link/?ticket=dytest-${n}`;
			const body = new TextEncoder().encode(JSON.stringify({ ok: true, url }));
			limiter.bind({ status: 200, body });
			const { socketId } = limiter.open({ url });
			limiter.upgraded(socketId, 101);
			return socketId;
		};
		const long = connect(1);
		serialized.count = 0;
		expect(limiter.receive(long, "a".repeat(HOST_MAX_WS_DATA_LENGTH + 1))).toEqual({
			kind: "close",
			code: 1009,
		});
		expect(serialized.count).toBe(0);
		const fits = connect(2);
		serialized.count = 0;
		expect(limiter.receive(fits, '{"envelope_id":"E1"}').kind).toBe("deliver");
		expect(serialized.count).toBe(1);
	});
});
