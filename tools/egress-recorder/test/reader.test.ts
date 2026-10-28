import { describe, expect, it } from "vitest";
import { createRecorder, readResult } from "../src/index.ts";
import { hub, parsedZero, required, target, zero } from "./fixtures.ts";

describe("bounded result reader", () => {
	it("independently requires caller instance equality with the same observer id and kind", () => {
		expect(() => readResult(zero(), required)).not.toThrow();
		expect(() =>
			readResult(zero(), {
				...required,
				observers: [{ ...hub, caller: { ...hub.caller, instanceId: "different-hub" } }],
			}),
		).toThrow("COVERAGE_MISMATCH");
	});
	it("refuses an active observer under an otherwise valid complete root", () => {
		const report = parsedZero();
		const observers = report.observers as Record<string, unknown>[];
		report.observers = [{ ...observers[0], state: "active" }];
		expect(() => readResult(JSON.stringify(report), required)).toThrow("INCOMPLETE_RESULT");
	});
	it("refuses a correctly counted pending attempt with complete observer and root", () => {
		const report = parsedZero();
		const observers = report.observers as Record<string, unknown>[];
		report.observers = [{ ...observers[0], attempts: 1 }];
		report.attempts = [
			{ observerId: hub.id, sequence: 0, destination: target, outcome: "pending", stage: "policy" },
		];
		expect(() => readResult(JSON.stringify(report), required)).toThrow("INCOMPLETE_RESULT");
	});
	it("refuses unknown format/version/scope and fields rather than guessing", () => {
		for (const patch of [{ version: 2 }, { format: "other" }, { scope: "native" }]) {
			expect(() => readResult(JSON.stringify({ ...parsedZero(), ...patch }), required)).toThrow(
				"UNSUPPORTED_RESULT",
			);
		}
		expect(() =>
			readResult(JSON.stringify({ ...parsedZero(), payload: "not metadata" }), required),
		).toThrow("INVALID_RESULT");
	});
	it("keeps strict UTF-8, duplicate-key, trailing-data and byte limits", () => {
		expect(() => readResult(`{"version":1,"version":1}`, required)).toThrow("INVALID_RESULT");
		expect(() => readResult(`${zero()} null`, required)).toThrow("INVALID_RESULT");
		expect(() => readResult(new Uint8Array([0xc0, 0xaf]), required)).toThrow("INVALID_RESULT");
		expect(() => readResult(" ".repeat(1_048_577), required)).toThrow("INVALID_RESULT");
	});
	it("rejects malformed observer state, truncation and caller substitution", () => {
		const report = parsedZero();
		const observers = report.observers as Record<string, unknown>[];
		const first = observers[0];
		for (const patch of [
			{ state: ["complete"] },
			{ state: "other" },
			{ attempts: 1 },
			{ canary: "clean" },
		]) {
			expect(() =>
				readResult(JSON.stringify({ ...report, observers: [{ ...first, ...patch }] }), required),
			).toThrow("INVALID_RESULT");
		}
		expect(() => readResult(JSON.stringify({ ...report, observers: [] }), required)).toThrow(
			"COVERAGE_MISMATCH",
		);
		expect(() =>
			readResult(zero(), {
				...required,
				observers: [{ ...hub, caller: { kind: "plugin", instanceId: "other" } }],
			}),
		).toThrow("COVERAGE_MISMATCH");
	});
	it("rejects secret-bearing destination forms and non-metadata fields before observation", async () => {
		for (const host of [
			"https://upstream.example/path?key=value",
			"user@upstream.example",
			"upstream.example/path",
			"upstream.example?key=value",
			"UPPER.example",
			"fe80::1%scope",
		]) {
			const recorder = createRecorder({ profile: "test", observers: [hub] });
			const observer = recorder.observer(hub.id);
			let called = false;
			await expect(
				observer.observe(
					{ host, port: 443, transport: "tcp" },
					{
						policy: () => {
							called = true;
							return true;
						},
						resolve: () => 1,
						connect: () => {},
					},
				),
			).rejects.toThrow("INVALID_RESULT");
			expect(called).toBe(false);
			expect(() => readResult(recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
		}
	});
	it("rejects accessors instead of invoking them and detaches valid descriptors", () => {
		let accessed = false;
		const caller = {
			kind: "hub",
			get instanceId() {
				accessed = true;
				return "id";
			},
		};
		expect(() =>
			createRecorder({ profile: "test", observers: [{ id: "point", caller }] as never }),
		).toThrow("INVALID_RESULT");
		expect(accessed).toBe(false);
		const descriptor = { id: "point", caller: { kind: "hub" as const, instanceId: "before" } };
		const recorder = createRecorder({ profile: "test", observers: [descriptor] });
		descriptor.caller.instanceId = "after";
		recorder.observer("point").complete();
		expect(
			readResult(recorder.finish(), {
				...required,
				observers: [{ id: "point", caller: { kind: "hub", instanceId: "before" } }],
			}).observers[0]?.caller.instanceId,
		).toBe("before");
	});
});
