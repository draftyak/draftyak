import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { checkThreatLedger } from "../src/threats.ts";

function normalize(source: string): string {
	return source.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

const current = normalize(
	readFileSync(new URL("./fixtures/threat-map/current-ledger.md", import.meta.url), "utf8"),
);
const falsePass = normalize(
	readFileSync(new URL("./fixtures/threat-map/false-pass-row.md", import.meta.url), "utf8"),
).trim();
const actual = normalize(
	readFileSync(new URL("../../../docs/threat-model.md", import.meta.url), "utf8"),
);
const tableHeader =
	"| ID | Original threat heading | Pilot disposition | Item and implementation/evidence owner | Required retained property or preserved later obligation | Binding |";
const separator = "|---|---|---|---|---|---|";
const unbound = "UNBOUND in this ledger; retained evidence is required.";
const deferred = "Deferred obligation; no pilot feature-test pass claimed. A01 remains current.";
const passing = "PASS: current suites accepted.";
const checkedHeaders = [
	{ table: "threat", header: tableHeader },
	{ table: "invariant", header: "| Requirement | Pilot disposition / owner | Acceptance or gap |" },
	{ table: "A01 owner", header: "| Implementing owner | Required current evidence |" },
];
const lazyContainers = ["- note", "1. note", "> note", "[^x]: note"];

function row(id: string, source = current): string {
	const matches = normalize(source)
		.split("\n")
		.filter((line) => line.startsWith(`| ${id} |`));
	expect(matches).toHaveLength(1);
	return matches[0] ?? "";
}

function replace(source: string, before: string, after: string): string {
	source = normalize(source);
	before = normalize(before);
	after = normalize(after);
	expect(before.length).toBeGreaterThan(0);
	expect(source.split(before)).toHaveLength(2);
	return source.replace(before, after);
}

function changeCell(id: string, index: number, value: string): string {
	const before = row(id);
	const fields = before.split("|");
	fields[index + 1] = ` ${value} `;
	return replace(current, before, fields.join("|"));
}

function rules(source: string): string[] {
	return checkThreatLedger(source).structure.map((problem) => problem.rule);
}

function threatTable(source = current): string {
	source = normalize(source);
	const start = source.indexOf(tableHeader);
	const end = source.indexOf("\n\n", start);
	expect(start).toBeGreaterThan(0);
	expect(end).toBeGreaterThan(start);
	return source.slice(start, end);
}

function indent(text: string, prefix: string): string {
	return text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");
}

function lineStarting(prefix: string): string {
	const matches = current.split("\n").filter((line) => line.startsWith(prefix));
	expect(matches).toHaveLength(1);
	return matches[0] ?? "";
}

function lineOf(source: string, text: string): number {
	const lines = normalize(source).split("\n");
	expect(lines.filter((line) => line === text)).toHaveLength(1);
	return lines.indexOf(text) + 1;
}

function expectCurrentObligations(result: ReturnType<typeof checkThreatLedger>): void {
	expect(result.unresolved.map((entry) => entry.id)).toEqual(
		checkThreatLedger(current).unresolved.map((entry) => entry.id),
	);
	expect(result.unresolved.every((entry) => entry.rule === "evidence-unbound")).toBe(true);
}

test("the actual merged ledger has valid structure and retains every unresolved obligation", () => {
	const result = checkThreatLedger(actual);
	expect(result.structure).toEqual([]);
	expect(result.unresolved).toHaveLength(25);
	expect(result.unresolved.every((problem) => problem.rule === "evidence-unbound")).toBe(true);
	expect(result.unresolved.map((problem) => problem.id)).toEqual([
		"T01",
		"T02",
		"T11",
		"T12",
		"T15",
		"T16",
		"T17",
		"T18",
		"T25",
		"T26",
		"T27",
		"T28",
		"T29",
		"T30",
		"T31",
		"T32",
		"T33",
		"T34",
		"T36",
		"T37",
		"T47",
		"T48",
		"T49",
		"T50",
		"A01",
	]);
});

test.each(["\n", "\r\n", "\r"])(
	"canonical newline variant %j stays structurally valid and unresolved",
	(newline) => {
		const source = current.replaceAll("\n", newline);
		expect(checkThreatLedger(source)).toEqual(checkThreatLedger(current));
		expect(threatTable(source)).toBe(threatTable());
		expect(row("T17", source)).toBe(row("T17"));
	},
);

test("a sole T17 replacement hidden in a bare-CR fence cannot supply the missing row", () => {
	const without = replace(current, `${row("T17")}\n`, "");
	const source = `${without}\n~~~md\n${row("T17")}\n~~~\n`.replaceAll("\n", "\r");
	const result = checkThreatLedger(source);
	expect(result.structure.map((entry) => entry.rule)).toContain("identity-count");
	expect(result.unresolved.some((entry) => entry.id === "T17")).toBe(false);
});

test("postponed rows are deferred, never reported as accepted security results", () => {
	const result = checkThreatLedger(current);
	expect(result.structure).toEqual([]);
	expect(result.unresolved.some((problem) => problem.id === "T03")).toBe(false);
	expect(row("T03")).toContain(deferred);
	expect(result).not.toHaveProperty("passed");
});

test.each(["T01", "T25", "T50"])("a missing %s cannot be replaced by another identity", (id) => {
	expect(rules(replace(current, `${row(id)}\n`, ""))).toContain("identity-count");
});

test("duplicate identities fail even with fifty rows", () => {
	const source = replace(current, row("T02"), row("T01"));
	expect(rules(source)).toContain("identity-duplicate");
	expect(rules(source)).toContain("identity-order");
});

test("swapped identities fail without losing a row", () => {
	const source = replace(current, `${row("T17")}\n${row("T18")}`, `${row("T18")}\n${row("T17")}`);
	expect(rules(source)).toContain("identity-order");
});

test("an additive extra T17 fails while every original identity remains present", () => {
	const source = replace(current, row("T50"), `${row("T50")}\n${row("T17")}`);
	const result = checkThreatLedger(source);
	expect(result.structure.map((entry) => entry.rule)).toContain("identity-count");
	expect(result.structure).toContainEqual(
		expect.objectContaining({ rule: "identity-duplicate", id: "T17" }),
	);
});

test("a pipe-less row after T50 cannot add a passing duplicate T17", () => {
	const extra = row("T17").replace(/^\| /, "").replace(unbound, passing);
	expect(extra.startsWith("T17 | ")).toBe(true);
	const source = replace(current, row("T50"), `${row("T50")}\n${extra}`);
	expect(checkThreatLedger(source).structure).toEqual([
		{ line: lineOf(source, extra), rule: "table-boundary" },
	]);
});

test.each(
	["| T50 |", "| E2E/axe/Tauri ACL/native WebKit |", "| M11.8/.15 |"].flatMap((last) =>
		["Ordinary note", "    indented note"].map((extra) => ({ last, extra })),
	),
)("$extra directly after the last row $last fails", ({ last, extra }) => {
	const before = lineStarting(last);
	const source = replace(current, before, `${before}\n${extra}`);
	expect(checkThreatLedger(source).structure).toEqual([
		{ line: lineOf(source, extra), rule: "table-boundary" },
	]);
});

test.each(["## Original threat identities", "## A01 — Postponed"])(
	"a checked table may end directly at the next section heading %s",
	(next) => {
		const result = checkThreatLedger(replace(current, `\n\n${next}`, `\n${next}`));
		expect(result.structure).toEqual([]);
		expectCurrentObligations(result);
	},
);

test.each(
	checkedHeaders.flatMap(({ table, header }) =>
		lazyContainers.map((container) => ({ table, header, container })),
	),
)("$container directly above the $table header makes it a lazy line", ({ header, container }) => {
	const lazy = replace(current, `\n\n${header}\n`, `\n\n${container}\n${header}\n`);
	expect(checkThreatLedger(lazy).structure).toEqual([
		{ line: lineOf(lazy, header), rule: "table-boundary" },
	]);
	for (const gap of ["", " \t "]) {
		const result = checkThreatLedger(
			replace(current, `\n\n${header}\n`, `\n\n${container}\n${gap}\n${header}\n`),
		);
		expect(result.structure).toEqual([]);
		expectCurrentObligations(result);
	}
});

test.each(["- note\n    continued note", "> note\n    continued note"])(
	"an indented continuation %j is not a blank line before the threat header",
	(container) => {
		const source = replace(current, `\n\n${tableHeader}\n`, `\n\n${container}\n${tableHeader}\n`);
		expect(checkThreatLedger(source).structure).toEqual([
			{ line: lineOf(source, tableHeader), rule: "table-boundary" },
		]);
	},
);

test("checked headings and table lines count only at column 0", () => {
	const t17 = `  ${row("T17")}`;
	const indentedRow = replace(current, row("T17"), t17);
	expect(checkThreatLedger(indentedRow).structure).toEqual([
		{ line: lineOf(indentedRow, t17), rule: "table-row" },
	]);
	expect(rules(replace(current, separator, ` ${separator}`))).toEqual(["table-separator"]);
	expect(rules(replace(current, tableHeader, `   ${tableHeader}`))).toEqual(["table-header"]);
	const heading = "## Original threat identities and pilot obligations";
	expect(rules(replace(current, `\n${heading}\n`, `\n  ${heading}\n`))).toEqual(["section"]);
});

test("an extra identity or altered original heading fails", () => {
	expect(
		rules(replace(current, row("T50"), `${row("T50")}\n${row("T50").replace("T50", "T51")}`)),
	).toContain("identity-count");
	expect(rules(changeCell("T37", 1, "Different threat"))).toContain("threat-heading");
});

test.each(["Passed", "retained", "NotRun"])("unsupported disposition %s fails", (status) => {
	expect(rules(changeCell("T01", 2, status))).toContain("disposition-unsupported");
});

test("a retained row cannot be postponed to remove its unresolved requirement", () => {
	const source = changeCell("T01", 2, "Postponed").replace(unbound, deferred);
	expect(rules(source)).toContain("disposition-changed");
	expect(checkThreatLedger(source).unresolved.some((problem) => problem.id === "T01")).toBe(true);
});

test.each([1, 3, 4, 5])("blank field %s fails", (index) => {
	expect(rules(changeCell("T01", index, ""))).toContain("empty-field");
});

test("wrong field count, header, separator and incomplete row fail", () => {
	expect(rules(replace(current, row("T01"), `${row("T01")} extra |`))).toContain("field-count");
	expect(
		rules(replace(current, tableHeader, tableHeader.replace("Pilot disposition", "Status"))),
	).toContain("table-header");
	expect(rules(replace(current, separator, "|--|---|---|---|---|---|"))).toContain(
		"table-separator",
	);
	expect(rules(replace(current, row("T01"), row("T01").slice(0, -1)))).toContain("table-row");
});

test("escaped-pipe laundering fails even when raw delimiter count stays unchanged", () => {
	const before = row("T17");
	const fields = before.split("|");
	fields[4] = `${fields[4]}\\| synthetic owner tail ${fields[5]}`;
	fields.splice(5, 1);
	const laundered = fields.join("|");
	expect(laundered.split("|")).toHaveLength(before.split("|").length);
	expect(rules(replace(current, before, laundered))).toContain("table-escaped-delimiter");
	const terminal = `${before.slice(0, -1)}\\|`;
	expect(terminal.split("|")).toHaveLength(before.split("|").length);
	expect(rules(replace(current, before, terminal))).toContain("table-escaped-delimiter");
});

test("duplicate or split visible ledger headers fail; fenced duplicate headers stay literal", () => {
	const table = threatTable();
	expect(rules(replace(current, table, `${table}\n\n${table}`))).toContain("table-header");
	const rows = table.split("\n").slice(2);
	expect(rows).toHaveLength(50);
	const split = `${tableHeader}\n${separator}\n${rows.slice(0, 25).join("\n")}\n\n${tableHeader}\n${separator}\n${rows.slice(25).join("\n")}`;
	expect(rules(replace(current, table, split))).toContain("table-header");
	expect(rules(replace(current, table, split))).toContain("identity-count");
	const literal = replace(current, table, `${table}\n\n\`\`\`md\n${table}\n\`\`\``);
	expect(checkThreatLedger(literal).structure).toEqual([]);
	expect(checkThreatLedger(literal).unresolved).toHaveLength(25);
});

test("a row moved outside the authoritative table is not counted", () => {
	const source = replace(current, row("T25"), `\n${row("T25")}`);
	expect(rules(source)).toContain("identity-count");
	expect(rules(source)).toContain("threat-row-outside-table");
});

test.each(["```md\n", "~~~~md\n", "<!--\n", "    "])(
	"literal table substitution %s cannot pass",
	(open) => {
		const table = threatTable();
		const literal =
			open === "    "
				? table
						.split("\n")
						.map((line) => `    ${line}`)
						.join("\n")
				: `${open}${table}\n${open.startsWith("<!--") ? "-->" : open.startsWith("~") ? "~~~~" : "```"}`;
		const result = checkThreatLedger(replace(current, table, literal));
		expect(result.structure.map((problem) => problem.rule)).toContain("table-header");
		expect(result.unresolved.some((problem) => problem.id === "A01")).toBe(true);
	},
);

test.each([
	{ open: "- ```md", indent: 2 },
	{ open: "1. ```md", indent: 3 },
	{ open: "+ ~~~md", indent: 2 },
])("list-container fence $open cannot supply the complete threat table", ({ open, indent }) => {
	const table = threatTable();
	expect(table.split("\n")).toHaveLength(52);
	const indented = table
		.split("\n")
		.map((line) => `${" ".repeat(indent)}${line}`)
		.join("\n");
	const marker = open.includes("~") ? "~~~" : "```";
	const source = replace(current, table, `${open}\n${indented}\n    ${marker}`);
	expect(checkThreatLedger(source).structure).toContainEqual(
		expect.objectContaining({ rule: "markdown-container-fence" }),
	);
});

test.each([
	{ name: "dash item", item: "- a", fence: "    ", content: "  " },
	{ name: "star item", item: "* a", fence: "    ", content: "  " },
	{ name: "plus item", item: "+ a", fence: "    ", content: "  " },
	{ name: "dot item", item: "1. a", fence: "    ", content: "   " },
	{ name: "paren item", item: "1) a", fence: "    ", content: "   " },
	{ name: "bare dash", item: "-", fence: "    ", content: "  " },
	{ name: "bare paren", item: "1)", fence: "    ", content: "   " },
	{ name: "tab-indented fence", item: "- a", fence: "\t", content: "  " },
	{ name: "space-tab-indented fence", item: "- a", fence: " \t", content: "  " },
])(
	"a later-line list fence ($name) cannot hide the threat table, closed or not",
	({ item, fence, content }) => {
		const table = threatTable();
		for (const close of [`\n${fence}\`\`\``, ""]) {
			const source = replace(
				current,
				table,
				`${item}\n${fence}\`\`\`md\n${indent(table, content)}${close}`,
			);
			expect(checkThreatLedger(source).structure).toContainEqual({
				line: lineOf(source, `${content}${tableHeader}`),
				rule: "table-header",
			});
		}
	},
);

test.each([
	{ item: "- a", open: "<!--", close: "-->" },
	{ item: "- a", open: "<pre>", close: "</pre>" },
	{ item: "- a", open: "<details>", close: "</details>" },
	{ item: "-", open: "<span>", close: "</span>" },
])("a later-line list $open block cannot hide the threat table", ({ item, open, close }) => {
	const table = threatTable();
	const source = replace(
		current,
		table,
		`${item}\n    ${open}\n${indent(table, "  ")}\n    ${close}`,
	);
	expect(checkThreatLedger(source).structure).toContainEqual({
		line: lineOf(source, `  ${tableHeader}`),
		rule: "table-header",
	});
});

test.each([
	{ name: "dash", item: "- a", prefix: "    ", open: "<!--", gap: "" },
	{ name: "loose dash", item: "- a", prefix: "    ", open: "<!--", gap: "\n" },
	{ name: "ordered", item: "1. a", prefix: "    ", open: "<!--", gap: "" },
	{ name: "tab", item: "- a", prefix: "\t", open: "<!--", gap: "" },
	{ name: "pre", item: "- a", prefix: "    ", open: "<pre>", gap: "" },
	{ name: "details", item: "- a", prefix: "    ", open: "<details>", gap: "" },
])(
	"list raw HTML before a dedented table ($name) cannot hide later obligations",
	({ item, prefix, open, gap }) => {
		const opener = `${prefix}${open}`;
		const source = replace(
			current,
			`\n\n${tableHeader}\n`,
			`\n\n${item}\n${gap}${opener}\n\n${tableHeader}\n`,
		);
		const result = checkThreatLedger(source);
		expect(result.structure).toEqual([
			{ line: lineOf(source, opener), rule: "markdown-container-html" },
		]);
		expectCurrentObligations(result);
	},
);

test.each([
	{ item: "- a", open: "```md", close: "```" },
	{ item: "- a", open: "<!--", close: "-->" },
])(
	"a list item's own later-line $open block keeps diagnostics bounded",
	({ item, open, close }) => {
		const block = `${item}\n    ${open}\n    literal note\n    ${close}\n\n`;
		const source = replace(current, `\n\n${tableHeader}\n`, `\n\n${block}${tableHeader}\n`);
		const result = checkThreatLedger(source);
		expect(result.structure).toEqual(
			open === "<!--"
				? [
						{
							line: lineOf(source, `    ${open}`),
							rule: "markdown-container-html",
						},
					]
				: [],
		);
		expectCurrentObligations(result);
	},
);

test("a list followed by visible prose leaves top-level indented HTML literal", () => {
	const source = `- a\n\nOrdinary paragraph\n\n    <!-- literal opener\n\n${current}`;
	const result = checkThreatLedger(source);
	expect(result.structure).toEqual([]);
	expectCurrentObligations(result);
});

test("raw HTML inside a closed indented list fence remains literal", () => {
	const prefix = "- a\n    ```md\n    <!-- literal note\n    ```\n\n";
	const result = checkThreatLedger(prefix + current);
	expect(result.structure).toEqual([]);
	expectCurrentObligations(result);
});

test.each([
	{ name: "reported eight-space bullet", item: "- a", marker: "        ", html: "    " },
	{ name: "bullet code boundary", item: "- a", marker: "      ", html: "    " },
	{ name: "ordered code boundary", item: "1. a", marker: "       ", html: "    " },
	{ name: "two-digit marker", item: "10. a", marker: "        ", html: "    " },
	{
		name: "nine-digit marker",
		item: "123456789. a",
		marker: "               ",
		html: "           ",
	},
	{ name: "leading indentation", item: "   - a", marker: "         ", html: "     " },
	{ name: "three-space padding", item: "-   a", marker: "        ", html: "    " },
	{ name: "five-space padding", item: "-     a", marker: "      ", html: "    " },
	{ name: "tab padding and indentation", item: "-\ta", marker: "\t\t", html: "\t" },
	{ name: "nested item", item: "- a\n  - b", marker: "        ", html: "    " },
	{ name: "empty padded item", item: "-    ", marker: "        ", html: "    " },
	{ name: "inline nested item", item: "- - a", marker: "          ", html: "    " },
	{ name: "noninterrupting ordered marker", item: "- a\n2. b", marker: "      ", html: "    " },
])(
	"a code-indented list marker ($name) cannot exempt a later raw comment",
	({ item, marker, html }) => {
		const opener = `${html}<!--`;
		const source = replace(
			current,
			`\n\n${tableHeader}\n`,
			`\n\n${item}\n\n${marker}\`\`\`md\n${opener}\n\n${tableHeader}\n`,
		);
		const result = checkThreatLedger(source);
		expect(result.structure).toEqual([
			{ line: lineOf(source, opener), rule: "markdown-container-html" },
		]);
		expectCurrentObligations(result);
	},
);

test.each([
	{ item: "- a", prefix: "    " },
	{ item: "- a", prefix: "     " },
	{ item: "1. a", prefix: "      " },
	{ item: "10. a", prefix: "       " },
	{ item: "-   a", prefix: "       " },
	{ item: "   - a", prefix: "        " },
])("a fence within three columns of $item content stays literal", ({ item, prefix }) => {
	const source = `${item}\n${prefix}\`\`\`md\n${prefix}<!-- literal note\n${prefix}\`\`\`\n\n${current}`;
	const result = checkThreatLedger(source);
	expect(result.structure).toEqual([]);
	expectCurrentObligations(result);
});

test("a lazy list continuation cannot hide a later raw comment", () => {
	const opener = "    <!--";
	const source = replace(
		current,
		`\n\n${tableHeader}\n`,
		`\n\n- a\nlazy continuation\n\n${opener}\n\n${tableHeader}\n`,
	);
	const result = checkThreatLedger(source);
	expect(result.structure).toEqual([
		{ line: lineOf(source, opener), rule: "markdown-container-html" },
	]);
	expectCurrentObligations(result);
});

test.each([
	{ item: "- x", opener: "  ```", closer: "```", rule: "markdown-indented-opener" },
	{ item: "1. x", opener: "   ```", closer: "```", rule: "markdown-indented-opener" },
	{ item: "- x", opener: "  ~~~", closer: "~~~", rule: "markdown-indented-opener" },
	{ item: "- x", opener: "  <!--", closer: "-->", rule: "markdown-indented-opener" },
	{ item: "- x", opener: "  <details>", closer: "</details>", rule: "markdown-unsupported" },
])(
	"item opener $opener cannot hide a passing copy while the original stays checked",
	({ item, opener, closer, rule }) => {
		const table = threatTable();
		const copy = table.replaceAll(unbound, passing);
		const source = replace(current, table, `${item}\n${opener}\n${copy}\n${closer}\n${table}`);
		expect(checkThreatLedger(source).structure).toContainEqual({
			line: lineOf(source, opener),
			rule,
		});
	},
);

test.each([
	"## Invariants and retained suite ownership",
	"## Original threat identities and pilot obligations",
	"## A01 — Postponed surfaces remain absent or refused",
])("section heading %s inside a list-item fence does not count", (heading) => {
	const source = replace(
		current,
		`\n${heading}\n`,
		`\n- x\n    \`\`\`\n  ${heading}\n    \`\`\`\n`,
	);
	expect(checkThreatLedger(source).structure).toEqual([
		{ line: lineOf(source, `  ${heading}`), rule: "section" },
	]);
});

test.each(["- ```sh\n  pnpm test\n  ```\n\n", "1. ```sh\n   pnpm test\n   ```\n\n"])(
	"a refused list fence %j keeps its diagnostics on the fence lines",
	(prefix) => {
		const result = checkThreatLedger(prefix + current);
		expect(result.structure).toEqual([
			{ line: 1, rule: "markdown-container-fence" },
			{ line: 3, rule: "markdown-indented-opener" },
		]);
		expectCurrentObligations(result);
	},
);

test.each(["  ```md", "   ~~~", " <!--"])(
	"indented opener %j is reported once, without a cascade",
	(opener) => {
		const result = checkThreatLedger(`${opener}\nliteral note\n\n${current}`);
		expect(result.structure).toEqual([{ line: 1, rule: "markdown-indented-opener" }]);
		expectCurrentObligations(result);
	},
);

test("a column-0 fence still closes at a closer indented up to three spaces", () => {
	const literal = `\`\`\`md\n${row("T17").replace(unbound, passing)}\n   \`\`\`\n\n`;
	const result = checkThreatLedger(literal + current);
	expect(result.structure).toEqual([]);
	expectCurrentObligations(result);
});

test.each([
	"~~~text\n- ```md\n> ```md\n~~~\n\n",
	"<!--\n- ```md\n> ~~~md\n-->\n\n",
	"    - ```md\n    > ~~~md\n\n",
])("list-fence text inside a genuine literal context %j stays inert", (literal) => {
	const prose = "- note with `inline code`\n1. ordinary note\n> quoted prose\n\n";
	const result = checkThreatLedger(prose + literal + current);
	expect(result.structure).toEqual([]);
	expect(result.unresolved).toHaveLength(25);
	expect(result.unresolved.map((entry) => entry.id)).toEqual(
		checkThreatLedger(current).unresolved.map((entry) => entry.id),
	);
	expect(result.unresolved.every((entry) => entry.rule === "evidence-unbound")).toBe(true);
});

test("fenced comment openers and commented fence openers stay literal", () => {
	const prefix = "```md\n<!--\n```\n\n<!--\n```\n-->\n\n";
	expect(rules(prefix + current)).toEqual([]);
	expect(checkThreatLedger(prefix + current).unresolved).toHaveLength(25);
});

test.each(["```\n", "<!--\n"])("unclosed literal block %s fails", (open) => {
	expect(rules(open + current)).toContain("markdown-unclosed");
});

test("raw HTML and inline comments cannot make a rendered table disagree with the checker", () => {
	expect(rules(`<pre>\n${current}\n</pre>`)).toContain("markdown-unsupported");
	expect(rules(replace(current, row("T01"), `<!-- inline --> ${row("T01")}`))).toContain(
		"markdown-comment",
	);
});

test("indented HTML is literal and cannot suppress the ordinary ledger", () => {
	const source = `    <div>literal HTML</div>\n\t<!-- literal unclosed opener\n\n${current}`;
	const result = checkThreatLedger(source);
	expect(result.structure).toEqual([]);
	expect(result.unresolved.map((entry) => entry.id)).toEqual(
		checkThreatLedger(current).unresolved.map((entry) => entry.id),
	);
	expect(result.unresolved.every((entry) => entry.rule === "evidence-unbound")).toBe(true);
});

test.each([0, 8, 11, 31, 127])("visible numeric control code %i is unsupported", (code) => {
	const source = `Visible${String.fromCharCode(code)}prose\n\n${current}`;
	expect(rules(source)).toContain("markdown-unsupported");
});

test("a tab within ordinary prose remains allowed", () => {
	const result = checkThreatLedger(`Ordinary\tprose\n\n${current}`);
	expect(result.structure).toEqual([]);
	expect(result.unresolved.map((entry) => entry.id)).toEqual(
		checkThreatLedger(current).unresolved.map((entry) => entry.id),
	);
	expect(result.unresolved.every((entry) => entry.rule === "evidence-unbound")).toBe(true);
});

test("malformed identity and owner fields are not echoed in JSON diagnostics", () => {
	const marker = "UNTRUSTED_DIAGNOSTIC_MARKER";
	const owner =
		current.split("\n").find((line) => line.startsWith("| M2 hub/challenge/startup owners |")) ??
		"";
	for (const source of [
		changeCell("T17", 0, marker),
		replace(current, owner, owner.replace("M2 hub/challenge/startup owners", marker)),
	]) {
		const result = checkThreatLedger(source);
		expect(result.structure.map((entry) => entry.rule)).toContain("identity-order");
		expect(JSON.stringify(result)).not.toContain(marker);
		expect(result.unresolved).toContainEqual(expect.objectContaining({ id: "T01" }));
		expect(result.unresolved).toContainEqual(expect.objectContaining({ id: "A01" }));
	}
});

test("false PASS fixture and other future binding prose cannot qualify a required row", () => {
	for (const replacement of [
		falsePass,
		row("T01").replace(unbound, "Current source and all tests accepted."),
	]) {
		const result = checkThreatLedger(replace(current, row("T01"), replacement));
		expect(result.structure).toContainEqual(
			expect.objectContaining({ rule: "binding-unsupported", id: "T01" }),
		);
		expect(result.unresolved).toContainEqual(
			expect.objectContaining({ rule: "binding-unqualified", id: "T01" }),
		);
	}
});

test("a postponed feature cannot be called passed", () => {
	const result = checkThreatLedger(changeCell("T03", 5, "PASS"));
	expect(result.structure).toContainEqual(
		expect.objectContaining({ rule: "binding-unsupported", id: "T03" }),
	);
	expect(result.unresolved).toContainEqual(
		expect.objectContaining({ rule: "binding-unqualified", id: "T03" }),
	);
});

test("missing or duplicate A01, owner rows and invariants fail", () => {
	const heading = "## A01 — Postponed surfaces remain absent or refused";
	expect(rules(replace(current, heading, "## Removed absence obligation"))).toContain("section");
	expect(rules(`${current}\n${heading}\n`)).toContain("section");
	const owner =
		current.split("\n").find((line) => line.startsWith("| M2 hub/challenge/startup owners |")) ??
		"";
	expect(rules(replace(current, `${owner}\n`, ""))).toContain("identity-count");
	const invariant = current.split("\n").find((line) => line.startsWith("| I3 credentials")) ?? "";
	expect(rules(replace(current, `${invariant}\n`, ""))).toContain("identity-count");
	expect(rules(replace(current, invariant, invariant.replace("I3", "I2")))).toContain(
		"identity-order",
	);
});

test("false PASS cannot replace A01's unresolved binding", () => {
	const source = replace(current, "**Binding: UNBOUND.**", "**Binding: PASS.**");
	const result = checkThreatLedger(source);
	expect(result.structure).toContainEqual(expect.objectContaining({ rule: "absence-binding" }));
	expect(result.unresolved).toContainEqual(
		expect.objectContaining({ id: "A01", rule: "binding-unqualified" }),
	);
});

test.each([...lazyContainers, "- note\n    continued note"])(
	"A01's binding directly after %j is a lazy line and cannot qualify",
	(container) => {
		const binding = "**Binding: UNBOUND.**";
		const lazy = checkThreatLedger(
			replace(current, `\n\n${binding}`, `\n\n${container}\n${binding}`),
		);
		expect(lazy.structure).toEqual([expect.objectContaining({ rule: "absence-binding" })]);
		expect(lazy.unresolved).toContainEqual(
			expect.objectContaining({ id: "A01", rule: "binding-unqualified" }),
		);
		const separated = checkThreatLedger(
			replace(current, `\n\n${binding}`, `\n\n${container}\n\n${binding}`),
		);
		expect(separated.structure).toEqual([]);
		expectCurrentObligations(separated);
	},
);

test("empty input cannot produce structurally valid or qualified diagnostics", () => {
	const result = checkThreatLedger("");
	expect(result.structure.length).toBeGreaterThan(0);
	expect(result.unresolved).toContainEqual(expect.objectContaining({ id: "A01" }));
});
