import { describe, expect, it } from "vitest";
import { createRecorder, readResult } from "../src/index.ts";
import { hub, required, target } from "./fixtures.ts";

describe("session resource and lifecycle bounds", () => {
	it("accepts 1,024 attempts and fails closed on the next attempt", async () => {
		const steps = { policy: () => false, resolve: () => 1, connect: () => {} };
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		for (let index = 0; index < 1024; index++) await observer.observe(target, steps);
		observer.complete();
		expect(readResult(recorder.finish(), required).attempts).toHaveLength(1024);
		const excess = createRecorder({ profile: "test", observers: [hub] });
		const capped = excess.observer(hub.id);
		for (let index = 0; index < 1024; index++) await capped.observe(target, steps);
		await expect(capped.observe(target, steps)).rejects.toThrow("CAPACITY_EXCEEDED");
		expect(() => readResult(excess.finish(), required)).toThrow("OBSERVATION_FAILED");
	});
	it("caps pending observations at 64 and cancels their later dispatch", async () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		const steps = {
			policy: () => new Promise<boolean>(() => {}),
			resolve: () => 1,
			connect: () => {},
		};
		const pending = Array.from({ length: 64 }, () => observer.observe(target, steps, 5));
		await expect(observer.observe(target, steps, 5)).rejects.toThrow("CAPACITY_EXCEEDED");
		expect((await Promise.all(pending)).every((item) => item.outcome === "failed")).toBe(true);
		expect(() => readResult(recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
	});
	it("caps declared observers and rejects duplicate, sparse or extended rosters", () => {
		const rows = Array.from({ length: 64 }, (_, index) => ({ ...hub, id: `point-${index}` }));
		const recorder = createRecorder({ profile: "test", observers: rows });
		for (const row of rows) recorder.observer(row.id).complete();
		expect(readResult(recorder.finish(), { ...required, observers: rows }).observers).toHaveLength(
			64,
		);
		for (const observers of [[...rows, { ...hub, id: "extra" }], [hub, hub], new Array(1)]) {
			expect(() => createRecorder({ profile: "test", observers })).toThrow("INVALID_RESULT");
		}
	});
	it("poisons a session on duplicate attachment and disallows use after sealing", async () => {
		const recorder = createRecorder({ profile: "test", observers: [hub] });
		const observer = recorder.observer(hub.id);
		expect(() => recorder.observer(hub.id)).toThrow("LIFECYCLE");
		observer.complete();
		expect(() => readResult(recorder.finish(), required)).toThrow("OBSERVATION_FAILED");
		expect(() => recorder.finish()).toThrow("LIFECYCLE");
		await expect(
			observer.observe(target, { policy: () => true, resolve: () => 1, connect: () => {} }),
		).rejects.toThrow("LIFECYCLE");
	});
});
