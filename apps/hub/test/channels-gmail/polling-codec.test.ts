import { describe, expect, it, vi } from "vitest";
import {
	advanceGmailPolling,
	createGmailPollingState,
	type GmailPollingEvent,
	type GmailPollingSnapshot,
} from "../../src/channels/gmail/polling.ts";
import {
	decodeGmailPollingPayload,
	encodeGmailPollingPayload,
} from "../../src/channels/gmail/polling-codec.ts";

const invalid = "Invalid Gmail polling payload";

function updated(snapshot: GmailPollingSnapshot, event: GmailPollingEvent): GmailPollingSnapshot {
	const transition = advanceGmailPolling(snapshot, event);
	expect(transition.kind).toBe("update");
	if (transition.kind !== "update") throw new Error("Expected a DATA update");
	return transition.nextSnapshot;
}

function refused(action: () => unknown): void {
	try {
		action();
		throw new Error("Expected payload refusal");
	} catch (caught) {
		expect(caught).toBeInstanceOf(TypeError);
		if (!(caught instanceof TypeError)) throw caught;
		expect(caught.message).toBe(invalid);
		expect(Object.hasOwn(caught, "cause")).toBe(false);
		expect(Object.hasOwn(caught, "reason")).toBe(false);
	}
}

function active(): GmailPollingSnapshot {
	return updated(createGmailPollingState(100, 200_000), { kind: "tick", nowMs: 30_100 });
}

describe("Gmail polling payload DATA codec", () => {
	it("encodes canonical decoder order rather than caller property order", () => {
		const reordered: GmailPollingSnapshot = {
			nextDueMs: 30_010,
			phase: "waiting",
			attempt: 0,
			revision: 0,
			version: 1,
		};
		const keys = Reflect.ownKeys(reordered);
		const encoded = encodeGmailPollingPayload(reordered, 0);
		expect(encoded).toBe(JSON.stringify(createGmailPollingState(10)));
		expect(encoded).not.toBe(JSON.stringify(reordered));
		expect(Reflect.ownKeys(reordered)).toEqual(keys);
	});

	it("roundtrips every phase and each stopped or active stop reason", () => {
		const running = active();
		if (running.phase !== "running") throw new Error("Expected running DATA");
		const uncertain = updated(running, {
			kind: "uncertain",
			runRevision: running.active.runRevision,
			attempt: running.active.attempt,
		});
		const states = [
			createGmailPollingState(100),
			running,
			uncertain,
			updated(running, { kind: "cancel" }),
			updated(running, { kind: "tick", nowMs: 200_000 }),
			updated(uncertain, { kind: "cancel" }),
			updated(createGmailPollingState(100), { kind: "cancel" }),
			createGmailPollingState(100, 100),
			updated(running, {
				kind: "complete",
				runRevision: running.active.runRevision,
				attempt: running.active.attempt,
				nowMs: 40_000,
				outcome: { kind: "stop" },
			}),
		];
		for (const state of states) {
			const encoded = encodeGmailPollingPayload(state, state.revision);
			const restored = decodeGmailPollingPayload(encoded, state.revision);
			expect(restored).toEqual(state);
			expect(restored).not.toBe(state);
			expect(Object.isFrozen(restored)).toBe(true);
			if (restored.phase === "running" || restored.phase === "uncertain") {
				expect(Object.isFrozen(restored.active)).toBe(true);
			}
		}
	});

	it("matches the outer journal revision while preserving an older active run revision", () => {
		const cancelled = updated(active(), { kind: "cancel" });
		if (cancelled.phase !== "running") throw new Error("Expected running DATA");
		expect(cancelled.revision).toBe(2);
		expect(cancelled.active.runRevision).toBe(1);
		const payload = encodeGmailPollingPayload(cancelled, 2);
		expect(decodeGmailPollingPayload(payload, 2)).toEqual(cancelled);
		refused(() => encodeGmailPollingPayload(cancelled, 1));
		refused(() => decodeGmailPollingPayload(payload, 1));
	});

	it("retains the recorded retry floor, attempt and deadline without a clock reset", () => {
		const running = active();
		if (running.phase !== "running") throw new Error("Expected running DATA");
		const waiting = updated(running, {
			kind: "complete",
			runRevision: running.active.runRevision,
			attempt: running.active.attempt,
			nowMs: 40_000,
			outcome: { kind: "retry", notBeforeMs: 150_000 },
		});
		expect(waiting).toMatchObject({
			phase: "waiting",
			revision: 2,
			attempt: 1,
			nextDueMs: 150_000,
			deliverByMs: 200_000,
		});
		const payload = encodeGmailPollingPayload(waiting, 2);
		for (let read = 0; read < 3; read++) {
			expect(decodeGmailPollingPayload(payload, 2)).toEqual(waiting);
			expect(encodeGmailPollingPayload(waiting, 2)).toBe(payload);
		}
	});

	it("keeps a restored unresolved run active rather than starting another poll", () => {
		const running = active();
		if (running.phase !== "running") throw new Error("Expected running DATA");
		const uncertain = updated(running, {
			kind: "uncertain",
			runRevision: 1,
			attempt: 1,
		});
		for (const state of [running, uncertain]) {
			const restored = decodeGmailPollingPayload(
				encodeGmailPollingPayload(state, state.revision),
				state.revision,
			);
			expect(advanceGmailPolling(restored, { kind: "tick", nowMs: 100_000 })).toMatchObject({
				kind: "unchanged",
				reason: "active",
				snapshot: state,
			});
		}
	});

	it("accepts readable MAX revision DATA without incrementing it", () => {
		const snapshot: GmailPollingSnapshot = {
			version: 1,
			revision: Number.MAX_SAFE_INTEGER,
			attempt: 0,
			phase: "waiting",
			nextDueMs: 30_000,
		};
		const payload = encodeGmailPollingPayload(snapshot, Number.MAX_SAFE_INTEGER);
		expect(decodeGmailPollingPayload(payload, Number.MAX_SAFE_INTEGER)).toEqual(snapshot);
	});

	it("rejects mismatched revisions for otherwise canonical waiting DATA", () => {
		const snapshot = createGmailPollingState(0);
		const payload = encodeGmailPollingPayload(snapshot, 0);
		refused(() => encodeGmailPollingPayload(snapshot, 1));
		refused(() => decodeGmailPollingPayload(payload, 1));
	});

	it("rejects unsafe or nonnumeric journal revisions without coercion", () => {
		const snapshot = createGmailPollingState(0);
		const payload = encodeGmailPollingPayload(snapshot, 0);
		for (const revision of [undefined, null, true, "0", 0n, -1, 0.5, NaN, Infinity, 2 ** 53]) {
			refused(() => encodeGmailPollingPayload(snapshot, revision as number));
			refused(() => decodeGmailPollingPayload(payload, revision as number));
		}
	});

	it("rejects missing, nonstring, empty, malformed Unicode and oversized payloads", () => {
		for (const payload of [undefined, null, true, 0, {}, [], "", "\ud800", "x".repeat(16_385)]) {
			refused(() => decodeGmailPollingPayload(payload as string, 0));
		}
	});

	it("checks multibyte UTF-8 bounds before invoking the real JSON parser", () => {
		const parse = vi.spyOn(JSON, "parse");
		try {
			const oversized = `"${"😀".repeat(4096)}"`;
			expect(oversized.length).toBeLessThan(16_384);
			expect(Buffer.byteLength(oversized, "utf8")).toBe(16_386);
			refused(() => decodeGmailPollingPayload(oversized, 0));
			expect(parse).not.toHaveBeenCalled();
			refused(() => decodeGmailPollingPayload("{", 0));
			expect(parse).toHaveBeenCalledExactlyOnceWith("{");
		} finally {
			parse.mockRestore();
		}
	});

	it("rejects noncanonical whitespace, property order, escapes and number spellings", () => {
		const canonical = encodeGmailPollingPayload(createGmailPollingState(0), 0);
		const variants = [
			` ${canonical}`,
			`${canonical}\n`,
			JSON.stringify({ nextDueMs: 30_000, phase: "waiting", attempt: 0, revision: 0, version: 1 }),
			canonical.replace('"version":1', '"version":1.0'),
			canonical.replace("waiting", "wa\\u0069ting"),
		];
		for (const payload of variants) {
			expect(JSON.parse(payload)).toEqual(JSON.parse(canonical));
			refused(() => decodeGmailPollingPayload(payload, 0));
		}
	});

	it("rejects negative-zero and exponent spellings of otherwise valid numbers", () => {
		const canonical = encodeGmailPollingPayload(createGmailPollingState(0), 0);
		const negativeZero = canonical.replace('"revision":0', '"revision":-0');
		expect(JSON.parse(negativeZero).revision).toBe(-0);
		refused(() => decodeGmailPollingPayload(negativeZero, 0));
		const exponent = canonical.replace('"nextDueMs":30000', '"nextDueMs":3e4');
		expect(JSON.parse(exponent)).toEqual(JSON.parse(canonical));
		refused(() => decodeGmailPollingPayload(exponent, 0));
	});

	it("rejects duplicate members even when the last value is correct", () => {
		const waiting = encodeGmailPollingPayload(createGmailPollingState(0), 0);
		const duplicate = waiting.replace('"revision":0', '"revision":9,"revision":0');
		expect(JSON.parse(duplicate)).toEqual(JSON.parse(waiting));
		refused(() => decodeGmailPollingPayload(duplicate, 0));
		const running = encodeGmailPollingPayload(active(), 1);
		const nested = running.replace(
			'"active":{"runRevision":1',
			'"active":{"runRevision":9,"runRevision":1',
		);
		expect(JSON.parse(nested)).toEqual(JSON.parse(running));
		refused(() => decodeGmailPollingPayload(nested, 1));
	});

	it("uses the real decoder to refuse invalid snapshot semantics", () => {
		const cases = [
			{ version: 1, revision: 0, attempt: 0, phase: "waiting", nextDueMs: -1 },
			{ version: 1, revision: 0, attempt: 1, phase: "waiting", nextDueMs: 30_000 },
			{ version: 2, revision: 0, attempt: 0, phase: "waiting", nextDueMs: 30_000 },
			{ version: 1, revision: 0, attempt: 0, phase: "stopped", reason: "deadline" },
			{
				version: 1,
				revision: 1,
				attempt: 1,
				phase: "running",
				active: { runRevision: 1, attempt: 1, startedAtMs: 30_000 },
				stopReason: "deadline",
			},
			{
				version: 1,
				revision: 1,
				attempt: 1,
				phase: "running",
				active: { runRevision: 2, attempt: 1, startedAtMs: 30_000 },
			},
		];
		for (const value of cases) {
			refused(() => encodeGmailPollingPayload(value as GmailPollingSnapshot, value.revision));
			refused(() => decodeGmailPollingPayload(JSON.stringify(value), value.revision));
		}
	});

	it("rejects unknown members, missing fields, extra nested fields and malformed JSON", () => {
		const waiting = createGmailPollingState(0);
		for (const value of [
			{ ...waiting, extra: true },
			{ version: 1, revision: 0, attempt: 0, phase: "waiting" },
			null,
			[],
		]) {
			refused(() => encodeGmailPollingPayload(value as GmailPollingSnapshot, 0));
			refused(() => decodeGmailPollingPayload(JSON.stringify(value), 0));
		}
		const running = active();
		if (running.phase !== "running") throw new Error("Expected running DATA");
		const extraNested = { ...running, active: { ...running.active, extra: true } };
		refused(() => encodeGmailPollingPayload(extraNested, 1));
		refused(() => decodeGmailPollingPayload(JSON.stringify(extraNested), 1));
		for (const payload of ["{", "null", "false", "NaN", `${JSON.stringify(waiting)} trailing`]) {
			refused(() => decodeGmailPollingPayload(payload, 0));
		}
	});

	it("sanitizes thrown input getters without exposing their original error", () => {
		const original = new Error("discard-this-synthetic-input-reason");
		const value = Object.defineProperty({}, "phase", {
			get() {
				throw original;
			},
		});
		refused(() => encodeGmailPollingPayload(value as GmailPollingSnapshot, 0));
	});
});
