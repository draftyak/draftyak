import { describe, expect, it } from "vitest";
import {
	checkedInjectionFixture,
	injectionCases,
	injectionFixture,
	injectionYaml,
	parseInjectionCase,
} from "./injection-corpus.ts";

describe("closed injection corpus data", () => {
	it("loads all 24 bounded YAML documents and exact CRLF raw-message fixtures", () => {
		const cases = injectionCases();
		expect(cases).toHaveLength(24);
		expect(new Set(cases.map((row) => row.id)).size).toBe(24);
		for (const row of cases) expect(injectionFixture(row).byteLength).toBeGreaterThan(0);
	});
	it.each([
		{ name: "duplicate key", edit: (source: string) => `${source}\nchannel: email\n` },
		{ name: "extra field", edit: (source: string) => `${source}\napproved: true\n` },
		{
			name: "anchor",
			edit: (source: string) => source.replace("id: fake-approval", "id: &id fake-approval"),
		},
		{
			name: "alias",
			edit: (source: string) => source.replace("channel: 'email'", "channel: *unknown"),
		},
		{
			name: "explicit tag",
			edit: (source: string) => source.replace("id: fake-approval", "id: !!str fake-approval"),
		},
		{
			name: "custom tag",
			edit: (source: string) => source.replace("id: fake-approval", "id: !custom fake-approval"),
		},
		{ name: "multiple documents", edit: (source: string) => `${source}\n---\nid: second\n` },
		{
			name: "fixture traversal",
			edit: (source: string) =>
				source.replace("fixtures/fake-approval.eml", "../fake-approval.eml"),
		},
		{
			name: "array provider",
			edit: (source: string) => source.replace("provider: 'gmail'", "provider: [gmail]"),
		},
		{
			name: "negative removal",
			edit: (source: string) => source.replace("hidden: 0", "hidden: -1"),
		},
		{
			name: "fractional removal",
			edit: (source: string) => source.replace("uris: 0", "uris: 0.5"),
		},
		{
			name: "unobserved flag",
			edit: (source: string) => source.replace("SUSPECTED_INSTRUCTIONS", "UNKNOWN_FLAG"),
		},
		{
			name: "false gate expectation",
			edit: (source: string) => source.replace("no_outbox: true", "no_outbox: false"),
		},
		{ name: "oversized YAML", edit: (source: string) => source + "#".repeat(65_537) },
	])("refuses $name with a fixed diagnostic", ({ edit }) => {
		expect(() =>
			parseInjectionCase(edit(injectionYaml("fake-approval")), "fake-approval"),
		).toThrowError("Invalid injection corpus case.");
	});
	it("binds the document ID and fixture spelling to its inventory filename", () => {
		expect(() => parseInjectionCase(injectionYaml("fake-approval"), "other-case")).toThrowError(
			"Invalid injection corpus case.",
		);
	});
	it.each([
		{ name: "BOM", bytes: Buffer.from("\uFEFFFrom: sender@example.test\r\n\r\nBody") },
		{ name: "oversize", bytes: Buffer.alloc(65_537) },
		{ name: "LF-only", bytes: Buffer.from("From: sender@example.test\n\nBody") },
		{ name: "empty", bytes: Buffer.alloc(0) },
	])("refuses a $name wire fixture", ({ bytes }) => {
		expect(() => checkedInjectionFixture(bytes)).toThrowError("Invalid injection corpus case.");
	});
});
