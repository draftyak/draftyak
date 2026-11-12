import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanHtml } from "../src/html.ts";
import { cleanText, type HygieneOptions } from "../src/hygiene.ts";

interface CorpusCase {
	id: string;
	kind: "text" | "html";
	input: string | { repeat: string; count: number };
	options?: HygieneOptions;
	expect: {
		includes?: string[];
		excludes?: string[];
		exact?: string;
		hosts?: string[];
		absentFromResult?: string[];
		suspectedInstructions?: boolean;
		removals?: ("hidden" | "invisible" | "quoted" | "truncated")[];
		maxChars?: number;
		errorCode?: string;
	};
}

const cases = JSON.parse(
	readFileSync(new URL("./fixtures/content.json", import.meta.url), "utf8"),
) as CorpusCase[];

describe("synthetic content threat corpus v1", () => {
	it("contains at least twenty independently named threat cases", () => {
		expect(cases.length).toBeGreaterThanOrEqual(20);
		expect(new Set(cases.map(({ id }) => id)).size).toBe(cases.length);
	});

	for (const entry of cases) {
		it(entry.id, () => {
			const input =
				typeof entry.input === "string"
					? entry.input
					: entry.input.repeat.repeat(entry.input.count);
			const clean = entry.kind === "html" ? cleanHtml : cleanText;
			if (entry.expect.errorCode !== undefined) {
				expect(() => clean(input, entry.options)).toThrowError(
					expect.objectContaining({ code: entry.expect.errorCode }),
				);
				return;
			}

			const result = clean(input, entry.options);
			for (const required of entry.expect.includes ?? []) {
				expect(result.text).toContain(required);
			}
			for (const forbidden of entry.expect.excludes ?? []) {
				expect(result.text).not.toContain(forbidden);
			}
			if (entry.expect.exact !== undefined) expect(result.text).toBe(entry.expect.exact);
			if (entry.expect.hosts !== undefined) {
				expect(result.links.map(({ host }) => host)).toEqual(entry.expect.hosts);
			}
			const serialized = JSON.stringify(result);
			for (const forbidden of entry.expect.absentFromResult ?? []) {
				expect(serialized).not.toContain(forbidden);
			}
			if (entry.expect.suspectedInstructions !== undefined) {
				expect(result.suspectedInstructions).toBe(entry.expect.suspectedInstructions);
			}
			for (const category of entry.expect.removals ?? []) {
				expect(result.removals[category]).toBeGreaterThan(0);
			}
			if (entry.expect.maxChars !== undefined) {
				expect(result.text.length).toBeLessThanOrEqual(entry.expect.maxChars);
			}
		});
	}
});
