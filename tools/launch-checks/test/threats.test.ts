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

test("empty input cannot produce structurally valid or qualified diagnostics", () => {
	const result = checkThreatLedger("");
	expect(result.structure.length).toBeGreaterThan(0);
	expect(result.unresolved).toContainEqual(expect.objectContaining({ id: "A01" }));
});
