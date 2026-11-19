import { describe, expect, it, vi } from "vitest";
import { createRecorder, readResult } from "../src/index.ts";
import { hub, required, target } from "./fixtures.ts";

describe("separate observation phases", () => {
	it("shares one entry across policy, DNS and connection settlement", () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		const attempt = observer.beginAttempt(target);
		attempt.policyAllowed();
		attempt.resolved();
		attempt.succeeded();
		attempt.failed();
		observer.complete();
		expect(readResult(recorder.finish(), required).attempts).toEqual([
			{
				observerId: hub.id,
				sequence: 0,
				destination: target,
				outcome: "succeeded",
				stage: "connect",
			},
		]);
	});
	it.each(["policy", "dns", "connect"] as const)(
		"records failure in the actual %s phase",
		(stage) => {
			const recorder = createRecorder({ profile: "test", observers: [hub] });
			const observer = recorder.observer(hub.id);
			const attempt = observer.beginAttempt(target);
			if (stage !== "policy") attempt.policyAllowed();
			if (stage === "connect") attempt.resolved();
			attempt.failed();
			expect(attempt.signal.aborted).toBe(true);
			observer.complete();
			expect(readResult(recorder.finish(), required).attempts[0]).toMatchObject({
				outcome: "failed",
				stage,
			});
		},
	);
	it("refuses out-of-order or duplicate phase advancement", () => {
		for (const move of ["resolved", "succeeded"] as const) {
			const recorder = createRecorder({ profile: "test", observers: [hub] });
			const observer = recorder.observer(hub.id);
			expect(() => observer.beginAttempt(target)[move]()).toThrow("LIFECYCLE");
			expect(() => readResult(recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
		}
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		const attempt = observer.beginAttempt(target);
		attempt.policyAllowed();
		expect(() => attempt.policyAllowed()).toThrow("LIFECYCLE");
		expect(() => readResult(recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
	});
	it("does not accept a resolver-only unfinished attempt as complete coverage", () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		const attempt = observer.beginAttempt(target);
		attempt.policyAllowed();
		attempt.resolved();
		expect(() => observer.complete()).toThrow("LIFECYCLE");
		expect(attempt.signal.aborted).toBe(true);
		expect(() => readResult(recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
	});
	it("refuses late settlement at the monotonic deadline even before its timer callback", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1000);
		try {
			const recorder = createRecorder({ profile: "test", observers: [hub] });
			const observer = recorder.observer(hub.id);
			const attempt = observer.beginAttempt(target, 50);
			attempt.policyAllowed();
			attempt.resolved();
			now.mockReturnValue(1050);
			expect(() => attempt.succeeded()).toThrow("LIFECYCLE");
			expect(attempt.signal.aborted).toBe(true);
			expect(() => readResult(recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
		} finally {
			now.mockRestore();
		}
	});
});
