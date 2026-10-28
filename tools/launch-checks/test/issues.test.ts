import { expect, test } from "vitest";
import { checkIssueDrafts } from "../src/issues.ts";

const labels = ["good first issue", "type:docs", "area:docs", "status:triage"].map((name) => ({
	name,
}));
const shared = `# Synthetic pilot draft catalog

## Fields shared by all twelve drafts

- **Classification:** optional nonsecurity pilot documentation. Proposed scopes only.
- **Proposed owner/reviewer:** Proposed maintainer, pending explicit acceptance through M11.12.
- **Status:** not created as a GitHub issue by this catalog; unapproved, unassigned and not ready.
- **Suggested existing labels:** \`good first issue\`, \`type:docs\`, \`area:docs\`, \`status:triage\`, subject to later definition validation and owner triage.
- **Future acceptance:** applicable checks and independent review after implementation.
- **Data boundary:** invented examples only.
- **Inventory boundary:** proposals do not establish current public uniqueness or approval.
`;
const draft = (number: number): string => `
## ${number}. Proposed documentation task ${number}

- **Problem and scope:** explain one optional documentation example.
- **Proposed future path:** \`docs/community/example-${number}.md\`.
- **Deliverable:** one text example.
- **Prerequisites:** unresolved documentation inputs and owner acceptance remain required.
- **Acceptance observations:** verify the example against its actual inputs after implementation.
`;
const ending =
	"\n## Remaining M11.12 and launch gates\n\nPublic inventory and owner approval remain separate.\n";
const catalog =
	shared + Array.from({ length: 12 }, (_, index) => draft(index + 1)).join("") + ending;

function change(before: string, after: string, source = catalog): string {
	if (!source.includes(before)) throw new Error("missing synthetic catalog anchor");
	return source.replace(before, after);
}

function check(source = catalog, definitions: unknown = labels): string[] {
	return checkIssueDrafts({ catalog: source, labels: definitions }).map((problem) => problem.rule);
}

test("complete local draft structures accept LF and CRLF", () => {
	expect(check()).toEqual([]);
	expect(check(catalog.replace(/\r\n|\r|\n/g, "\r\n"))).toEqual([]);
});

test("plain proposals may retain unresolved prerequisites, inline code and unused valid labels", () => {
	expect(check()).toEqual([]);
	expect(
		check(
			change("one text example.", "one invented `example` with [current guidance](../guide.md)."),
			[...labels, { name: "type:maintenance" }],
		),
	).toEqual([]);
	expect(
		check(shared + Array.from({ length: 13 }, (_, index) => draft(index + 1)).join("") + ending),
	).toEqual([]);
});

test.each(["Guidance &amp; examples", "Guidance &AMP; examples"])(
	"plain titles refuse a visible duplicate spelled %s",
	(encodedTitle) => {
		const baseline = change("## 1. Proposed documentation task 1", "## 1. Guidance & examples");
		expect(check(baseline)).toEqual([]);
		const alias = change("## 2. Proposed documentation task 2", `## 2. ${encodedTitle}`, baseline);
		expect(check(alias)).toContain("draft titles must be nonempty plain text");
	},
);

test.each([
	["too few drafts", change(draft(12), ""), "catalog must contain at least twelve numbered drafts"],
	[
		"missing record field",
		change("- **Deliverable:** one text example.\n", ""),
		"missing draft field: Deliverable",
	],
	[
		"empty field",
		change("- **Deliverable:** one text example.", "- **Deliverable:** "),
		"fields must have a nonempty one-line value",
	],
	[
		"duplicate field",
		change(
			"- **Deliverable:** one text example.",
			"- **Deliverable:** one text example.\n- **Deliverable:** another example.",
		),
		"fields must appear exactly once in their section",
	],
	[
		"malformed field",
		change("- **Deliverable:**", "- **Deliverable**:"),
		"expected a top-level one-line catalog field",
	],
	[
		"duplicate heading number",
		change("## 2. Proposed documentation task 2", "## 1. A different second proposal"),
		"draft headings must use consecutive numbers starting at 1",
	],
	[
		"malformed numbered heading",
		change("## 2. Proposed documentation task 2", "## 2 Proposed documentation task 2"),
		"unsupported catalog heading",
	],
	[
		"normalized duplicate title",
		change("## 2. Proposed documentation task 2", "## 2. ＰＲＯＰＯＳＥＤ  documentation task 1"),
		"draft titles must be unique after normalization",
	],
	[
		"duplicate path",
		change("`docs/community/example-2.md`", "`docs/community/example-1.md`"),
		"future paths must be unique",
	],
	[
		"path alias",
		change("`docs/community/example-2.md`", "`docs/community/../community/example-2.md`"),
		"future paths must be canonical lowercase docs Markdown paths in backticks",
	],
	[
		"absolute future path",
		change("`docs/community/example-2.md`", "`/docs/community/example-2.md`"),
		"future paths must be canonical lowercase docs Markdown paths in backticks",
	],
	[
		"classification removed",
		change("optional nonsecurity pilot documentation.", "required product implementation."),
		"shared classification must declare optional nonsecurity pilot documentation",
	],
	[
		"owner accepted prematurely",
		change(
			"Proposed maintainer, pending explicit acceptance through M11.12.",
			"Appointed maintainer.",
		),
		"shared proposed owner must remain pending explicit acceptance",
	],
	[
		"ready status",
		change("unapproved, unassigned and not ready.", "approved and ready."),
		"shared status must declare uncreated, unapproved, unassigned and not ready proposals",
	],
	[
		"unknown suggested label",
		change("`status:triage`", "`status:unknown`"),
		"suggested labels must name distinct defined labels and include good first issue",
	],
	[
		"repeated suggested label",
		change("`status:triage`", "`area:docs`"),
		"suggested labels must name distinct defined labels and include good first issue",
	],
] as const)("refuses %s", (_name, source, expected) => {
	expect(check(source)).toContain(expected);
});

test.each([
	"Classification",
	"Proposed owner/reviewer",
	"Status",
	"Suggested existing labels",
	"Future acceptance",
	"Data boundary",
	"Inventory boundary",
])("shared %s cannot be missing or moved into just one record", (name) => {
	const field = catalog.split("\n").find((line) => line.startsWith(`- **${name}:**`));
	if (!field) throw new Error("missing synthetic shared field");
	const missing = change(`${field}\n`, "");
	expect(check(missing)).toContain(`missing shared field: ${name}`);
	expect(
		check(
			change(
				"## 1. Proposed documentation task 1",
				`## 1. Proposed documentation task 1\n\n${field}`,
				missing,
			),
		),
	).toContain(`missing shared field: ${name}`);
});

test.each([
	["backtick fence", "```markdown\n", "\n```"],
	["tilde fence", "~~~markdown\n", "\n~~~"],
	["HTML comment", "<!--\n", "\n-->"],
	["HTML container", "<details>\n", "\n</details>"],
	["directive container", ":::note\n", "\n:::"],
] as const)(
	"%s cannot hide a complete catalog or supply one missing field",
	(_kind, start, end) => {
		const rule = "unsupported catalog Markdown; use top-level one-line fields";
		expect(check(start + catalog + end)).toContain(rule);
		const field =
			"- **Acceptance observations:** verify the example against its actual inputs after implementation.";
		expect(check(change(field, `${start}${field}${end}`))).toContain(rule);
	},
);

test.each(["> ", "    ", "- "])("a %j container cannot impersonate a record field", (prefix) => {
	const field =
		"- **Acceptance observations:** verify the example against its actual inputs after implementation.";
	expect(check(change(field, prefix + field))).not.toEqual([]);
});

test("an unclosed inline code span cannot carry apparent field declarations across lines", () => {
	expect(
		check(
			change(
				"## 1. Proposed documentation task 1",
				"`unclosed\n## 1. Proposed documentation task 1",
			),
		),
	).toContain("unsupported catalog Markdown; use top-level one-line fields");
});

test.each([undefined, {}, [], [{ name: "" }], [...labels, { name: "good first issue" }]])(
	"malformed or duplicate label definitions are refused: %j",
	(definitions) => {
		expect(
			checkIssueDrafts({ catalog, labels: definitions }).map((problem) => problem.rule),
		).toContain("label definitions must be a nonempty sequence of unique nonempty names");
	},
);

test("removing a referenced definition is refused without printing catalog or label text", () => {
	const problems = checkIssueDrafts({
		catalog,
		labels: labels.filter((label) => label.name !== "status:triage"),
	});
	expect(problems).toContainEqual({
		file: "docs/community/good-first-issues.md",
		rule: "suggested labels must name distinct defined labels and include good first issue",
	});
});
