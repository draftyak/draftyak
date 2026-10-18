import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fileOf, INLINE_PAGES, missing, pagesOf, quotes } from "../scripts/quotes.ts";

// scripts/quotes.ts, the re-read before session 2, offline: pages built from the notes' own quotes.
const cli = fileURLToPath(new URL("../scripts/quotes.ts", import.meta.url));
const HISTORY = "reference/methods/conversations.history";
const REPLIES = "reference/methods/conversations.replies";

// Each cited page as the quotes it should hold, line breaks in place of spaces.
function pagesFor(all: ReturnType<typeof quotes>): Map<string, string> {
	const pages = new Map<string, string>();
	for (const quote of all) {
		for (const page of quote.pages) {
			pages.set(page, `${pages.get(page) ?? "Intro."}\n\n${quote.text.replaceAll(" ", "\n")}\n`);
		}
	}
	return pages;
}

describe("quotes.ts", () => {
	it("cites every quote of notes/rate-limits.md to the pages linked above it", () => {
		const all = quotes();
		expect(all.length).toBeGreaterThanOrEqual(10);
		expect(all.every((quote) => quote.pages.length > 0)).toBe(true);
		// One quote stands for both methods' reference pages.
		expect(all.filter((quote) => quote.pages.length === 2).map((quote) => quote.pages)).toEqual([
			[HISTORY, REPLIES],
		]);
		const pages = pagesOf(all);
		expect(pages).toEqual(expect.arrayContaining([...INLINE_PAGES, HISTORY, REPLIES]));
		expect(new Set(pages).size).toBe(pages.length);
		expect(
			quotes(
				"[a](https://docs.slack.dev/x/one)\n\n> first\nText.\n> second\n[b](https://docs.slack.dev/y/two):\n> third\n",
			),
		).toEqual([
			{ line: 3, text: "first", pages: ["x/one"] },
			{ line: 5, text: "second", pages: ["x/one"] },
			{ line: 7, text: "third", pages: ["y/two"] },
		]);
	});

	it("checks each quote against each page it cites, not against all pages together", () => {
		const all = quotes();
		const pages = pagesFor(all);
		expect(missing(pages, all)).toEqual([]);
		const shared = all.find((quote) => quote.pages.length === 2);
		pages.set(REPLIES, "Another text.");
		const misses = missing(pages, all);
		expect(misses.map(({ quote, page }) => [quote.line, page])).toContainEqual([
			shared?.line,
			REPLIES,
		]);
		expect(misses.every(({ page }) => page === REPLIES)).toBe(true);
		expect(missing(new Map(), [{ line: 1, text: "orphan", pages: [] }])).toEqual([
			{ quote: { line: 1, text: "orphan", pages: [] }, page: null },
		]);
	});

	it("checks a folder of saved pages from the command line", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-s06-quotes-"));
		try {
			const run = () => spawnSync(process.execPath, [cli, "check", dir], { encoding: "utf8" });
			const all = quotes();
			const pages = pagesFor(all);
			for (const page of pagesOf(all)) {
				writeFileSync(path.join(dir, fileOf(page)), pages.get(page) ?? "Quoted inline only.");
			}
			const whole = run();
			expect(whole.status).toBe(0);
			const checks = all.reduce((sum, quote) => sum + quote.pages.length, 0);
			expect(whole.stdout).toContain(
				`${all.length} of ${all.length} quotes found in the pages they cite (${checks} checks; ${pagesOf(all).length} pages saved)`,
			);
			const [first] = all;
			writeFileSync(path.join(dir, fileOf(first?.pages[0] ?? "")), "Changed.");
			const partial = run();
			expect(partial.status).toBe(1);
			expect(partial.stdout).toContain(
				`not in ${first?.pages[0]}: notes/rate-limits.md:${first?.line}:`,
			);
			rmSync(path.join(dir, fileOf(INLINE_PAGES[0] ?? "")));
			expect(run().stdout).toContain(`not saved: ${INLINE_PAGES[0]}`);
			expect(spawnSync(process.execPath, [cli, "check"], { encoding: "utf8" }).status).toBe(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
