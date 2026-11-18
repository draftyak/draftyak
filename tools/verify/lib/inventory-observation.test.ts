import { describe, expect, it } from "vitest";
import { createInventoryObservation } from "./inventory-observation.ts";

const initial = "I1 0 0 -1 0 0 0 0 0\n";
const observed = "I1 0 3 3731 2 64 11 99 42000\n";
const expected = {
	phase: 3,
	roots: 3731,
	pendingGit: 2,
	pendingFs: 64,
	directoryVisits: 11,
	entries: 99,
	elapsedMs: 42000,
};

describe("diagnostic-only inventory observation", () => {
	it("starts unknown and exposes only an immutable independent numeric snapshot", () => {
		const observation = createInventoryObservation();
		expect(observation.snapshot()).toBeNull();
		observation.push(Buffer.from(initial));
		expect(observation.snapshot()).toEqual({
			phase: 0,
			roots: -1,
			pendingGit: 0,
			pendingFs: 0,
			directoryVisits: 0,
			entries: 0,
			elapsedMs: 0,
		});
		observation.push(Buffer.from(observed));
		const first = observation.snapshot();
		expect(first).toEqual(expected);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Reflect.set(first as object, "phase", 5)).toBe(false);
		observation.push(Buffer.from("I1 1 3 3731 0 1 12 100 42001\n"));
		expect(first).toEqual(expected);
		expect(observation.snapshot()).toEqual({
			...expected,
			pendingGit: 0,
			pendingFs: 1,
			directoryVisits: 12,
			entries: 100,
			elapsedMs: 42001,
		});
	});

	it("joins arbitrary chunk boundaries and hides even an old snapshot while a frame is partial", () => {
		const observation = createInventoryObservation();
		observation.push(Buffer.from(initial));
		for (const chunk of ["I", "1 0 3 37", "31 2 64 11 99 42000"]) {
			observation.push(Buffer.from(chunk));
			expect(observation.snapshot()).toBeNull();
		}
		observation.push(Buffer.from("\n"));
		expect(observation.snapshot()).toEqual(expected);
	});

	it("preserves the latest numeric frame across the exact fixed failure line", () => {
		const observation = createInventoryObservation();
		observation.push(Buffer.from(observed + "file-name inventory failed"));
		expect(observation.snapshot()).toBeNull();
		observation.push(Buffer.from("\n"));
		expect(observation.snapshot()).toEqual(expected);
	});

	it.each([
		["changes known roots", "I1 1 3 3732 0 0 11 99 42001\n"],
		["forgets known roots", "I1 1 3 -1 0 0 11 99 42001\n"],
		["regresses phase", "I1 1 2 3731 0 0 11 99 42001\n"],
		["regresses elapsed time", "I1 1 3 3731 0 0 11 99 41999\n"],
		["regresses visits", "I1 1 3 3731 0 0 10 99 42001\n"],
		["regresses entries", "I1 1 3 3731 0 0 11 98 42001\n"],
	])("keeps %s permanently unknown", (_name, invalid) => {
		const observation = createInventoryObservation();
		observation.push(Buffer.from(observed));
		observation.push(Buffer.from(invalid));
		expect(observation.snapshot()).toBeNull();
		observation.push(Buffer.from(observed));
		expect(observation.snapshot()).toBeNull();
	});

	it.each([
		["unknown kind", "I1 3 3 3731 0 0 11 99 42001\n"],
		["unknown phase", "I1 1 6 3731 0 0 11 99 42001\n"],
		["negative counter", "I1 1 3 3731 -1 0 11 99 42001\n"],
		["unsafe integer", "I1 1 3 3731 9007199254740992 0 11 99 42001\n"],
		["leading zero", "I1 1 3 3731 00 0 11 99 42001\n"],
		["fraction", "I1 1 3 3731 0.5 0 11 99 42001\n"],
		["exponent", "I1 1 3 3731 1e2 0 11 99 42001\n"],
		["extra field", "I1 1 3 3731 0 0 11 99 42001 0\n"],
		["missing field", "I1 1 3 3731 0 0 11 99\n"],
		["carriage return", "I1 1 3 3731 0 0 11 99 42001\r\n"],
		["NUL", "I1 1 3 3731 0 0 11 99 42001\0\n"],
		["unknown prose", "DYTEST_PRIVATE_FRAME /DYTEST_PRIVATE_PATH\n"],
		["decorated failure", "file-name inventory failed [DYTEST_PRIVATE_DETAIL]\n"],
	])("does not throw or recover after %s", (_name, invalid) => {
		const observation = createInventoryObservation();
		observation.push(Buffer.from(observed));
		expect(() => observation.push(Buffer.from(invalid))).not.toThrow();
		expect(observation.snapshot()).toBeNull();
		observation.push(Buffer.from(observed));
		expect(observation.snapshot()).toBeNull();
	});

	it("rejects non-ASCII bytes without throwing or retaining raw text", () => {
		const observation = createInventoryObservation();
		expect(() => observation.push(Buffer.from([0xff, 10]))).not.toThrow();
		expect(observation.snapshot()).toBeNull();
		observation.push(Buffer.from(observed));
		expect(observation.snapshot()).toBeNull();
	});

	it("bounds an oversized unfinished line and never recovers from its bytes", () => {
		const observation = createInventoryObservation();
		observation.push(Buffer.from(observed));
		observation.push(Buffer.alloc(129, 32));
		expect(observation.snapshot()).toBeNull();
		observation.push(Buffer.from("\n" + observed));
		expect(observation.snapshot()).toBeNull();
	});

	it("counts all valid input bytes against the lifetime4096 cap", () => {
		const observation = createInventoryObservation();
		const frame = Buffer.from("I1 1 3 3731 0 0 11 99 42000\n");
		const frames = Math.floor(4096 / frame.length);
		observation.push(Buffer.concat(Array.from({ length: frames }, () => frame)));
		expect(observation.snapshot()).toEqual({ ...expected, pendingGit: 0, pendingFs: 0 });
		observation.push(frame);
		expect(observation.snapshot()).toBeNull();
		observation.push(Buffer.from(initial));
		expect(observation.snapshot()).toBeNull();
	});

	it("accepts safe numeric boundaries without returning kind or authority fields", () => {
		const observation = createInventoryObservation();
		const max = Number.MAX_SAFE_INTEGER;
		observation.push(Buffer.from(`I1 2 5 ${max} ${max} ${max} ${max} ${max} ${max}\n`));
		expect(observation.snapshot()).toEqual({
			phase: 5,
			roots: max,
			pendingGit: max,
			pendingFs: max,
			directoryVisits: max,
			entries: max,
			elapsedMs: max,
		});
	});
});
