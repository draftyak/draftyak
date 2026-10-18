import { type Schema, Validator } from "@cfworker/json-schema";
import { expect, it } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { exampleSnapshot, snapshotVectors } from "../scripts/vectors/snapshot.ts";
import { contentHash, fingerprint, SendSnapshotV1, sendWindow } from "../src/snapshot.ts";

it("every declarative snapshot refusal is also refused by its full exported union", () => {
	const validator = new Validator(jsonSchemaOf(SendSnapshotV1) as Schema, "2020-12", false);
	// NFC and leap-calendar validity are semantic checks unavailable to this declarative shape.
	const semantic = new Set(["nfd-body", "nfd-footer", "wall-2027-02-29T00:00+00:00"]);
	for (const vector of snapshotVectors())
		expect(validator.validate(vector.snapshot).valid, vector.id).toBe(
			!vector.error || semantic.has(vector.id),
		);
});

it("walks all exported properties including definitions and forbids claim-time members", () => {
	function walk(value: unknown): void {
		if (!value || typeof value !== "object") return;
		for (const [name, child] of Object.entries(value)) {
			if (name === "properties")
				for (const key of Object.keys(child as object))
					expect(key).not.toMatch(/date|message-?id|boundary/i);
			walk(child);
		}
	}
	walk(jsonSchemaOf(SendSnapshotV1));
});

it("refuses explicitly undefined optional members before hashing or window calculation", () => {
	const base = exampleSnapshot();
	for (const value of [
		{ ...base, render: undefined },
		{ ...base, email: { ...(base.kind === "email" ? base.email : {}), threadId: undefined } },
	]) {
		expect(SendSnapshotV1.safeParse(value).success).toBe(false);
		for (const operation of [
			contentHash,
			fingerprint,
			(input: typeof base) => sendWindow(input, 0),
		])
			expect(() => operation(value as typeof base)).toThrow("SNAPSHOT_INVALID");
	}
});

it("applies the merged lone-surrogate guard exactly once", () => {
	const base = exampleSnapshot();
	const parsed = SendSnapshotV1.safeParse({ ...base, body: { text: "\ud800", footer: "" } });
	expect(parsed.success).toBe(false);
	if (!parsed.success)
		expect(parsed.error.issues).toMatchObject([
			{ path: ["body", "text"], message: "lone surrogate" },
		]);
	if (!parsed.success) expect(parsed.error.issues).toHaveLength(1);
});
