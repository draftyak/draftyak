// node spikes/s06-slack/scripts/quotes.ts fetch <folder> | check <folder>
// The re-read before session 2 (notes/session.md; M0.24's handoff). `fetch` saves today's Markdown
// copy (<page>.md, as notes/rate-limits.md was read) of every docs.slack.dev page the notes quote
// into <folder>. `check` looks up each `> ` quote of notes/rate-limits.md, whitespace aside, in
// each page linked on the closest line above it, and exits 1 if one is gone. Quotes inside running
// text are checked by reading the saved pages. ADR 0008 records what changed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const NOTES = new URL("../notes/rate-limits.md", import.meta.url);
const DOCS = "https://docs.slack.dev/";
const LINK = /\]\(https:\/\/docs\.slack\.dev\/([\w./-]+)\)/g;

// Pages the notes quote only inside running text.
export const INLINE_PAGES: readonly string[] = [
	"apis/web-api/rate-limits",
	"apis/events-api/using-socket-mode",
	"apis/events-api/comparing-http-socket-mode",
	"reference/methods/apps.connections.open",
	"reference/methods/auth.test",
];

const flat = (text: string): string => text.replace(/\s+/g, " ").trim();

export interface Quote {
	readonly line: number;
	readonly text: string;
	// The pages linked on the closest line above the quote that has docs.slack.dev links.
	readonly pages: readonly string[];
}

export function quotes(notes: string = readFileSync(NOTES, "utf8")): Quote[] {
	const found: Quote[] = [];
	let pages: string[] = [];
	for (const [index, line] of notes.split(/\r?\n/).entries()) {
		if (line.startsWith("> ")) {
			found.push({ line: index + 1, text: line.slice(2), pages });
			continue;
		}
		const links = [...line.matchAll(LINK)].map((match) => match[1] ?? "");
		if (links.length > 0) pages = links;
	}
	return found;
}

export function pagesOf(all: readonly Quote[] = quotes()): string[] {
	return [...new Set([...all.flatMap((quote) => quote.pages), ...INLINE_PAGES])];
}

export const fileOf = (page: string): string => `${page.replaceAll("/", "__")}.md`;

export interface Miss {
	readonly quote: Quote;
	// The cited page that lacks the quote, or null when no page is cited above it.
	readonly page: string | null;
}

// Each quote against each page it cites; `saved` maps a page to its text, if it was saved.
export function missing(
	saved: ReadonlyMap<string, string>,
	all: readonly Quote[] = quotes(),
): Miss[] {
	return all.flatMap((quote): Miss[] =>
		quote.pages.length === 0
			? [{ quote, page: null }]
			: quote.pages
					.filter((page) => !flat(saved.get(page) ?? "").includes(flat(quote.text)))
					.map((page) => ({ quote, page })),
	);
}

async function fetchPages(folder: string): Promise<number> {
	mkdirSync(folder, { recursive: true });
	let failed = 0;
	for (const page of pagesOf()) {
		const url = `${DOCS}${page}.md`;
		const response = await fetch(url, { redirect: "follow" });
		if (!response.ok) {
			console.error(`quotes: ${url}: HTTP ${response.status}`);
			failed++;
			continue;
		}
		writeFileSync(path.join(folder, fileOf(page)), await response.text());
		console.log(`saved ${url}`);
	}
	return failed === 0 ? 0 : 1;
}

function checkPages(folder: string): number {
	const all = quotes();
	const saved = new Map<string, string>();
	for (const page of pagesOf(all)) {
		const file = path.join(folder, fileOf(page));
		if (existsSync(file)) saved.set(page, readFileSync(file, "utf8"));
		else console.log(`not saved: ${page}`);
	}
	const misses = missing(saved, all);
	for (const { quote, page } of misses) {
		const where = page === null ? "no page cited above it" : `not in ${page}`;
		console.log(`${where}: notes/rate-limits.md:${quote.line}: ${quote.text.slice(0, 80)}`);
	}
	const gone = new Set(misses.map(({ quote }) => quote.line));
	const checks = all.reduce((sum, quote) => sum + quote.pages.length, 0);
	console.log(
		`${all.length - gone.size} of ${all.length} quotes found in the pages they cite (${checks} checks; ${saved.size} pages saved)`,
	);
	return misses.length === 0 && saved.size === pagesOf(all).length ? 0 : 1;
}

if (import.meta.main) {
	const [command, folder, ...rest] = process.argv.slice(2).filter((arg) => arg !== "--");
	const usage = "usage: node spikes/s06-slack/scripts/quotes.ts fetch <folder> | check <folder>";
	if (folder === undefined || rest.length > 0 || (command !== "fetch" && command !== "check")) {
		console.error(usage);
		process.exitCode = 2;
	} else {
		try {
			process.exitCode = command === "fetch" ? await fetchPages(folder) : checkPages(folder);
		} catch (error) {
			console.error(`quotes: ${error instanceof Error ? error.message : String(error)}`);
			process.exitCode = 2;
		}
	}
}
