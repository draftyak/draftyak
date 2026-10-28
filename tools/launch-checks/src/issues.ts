export interface IssueDraftInputs {
	catalog: string;
	labels: unknown;
}

export interface IssueDraftProblem {
	file: string;
	rule: string;
	line?: number;
}

const catalogFile = "docs/community/good-first-issues.md";
const sharedHeading = "## Fields shared by all twelve drafts";
const gatesHeading = "## Remaining M11.12 and launch gates";
const sharedFields = [
	"Classification",
	"Proposed owner/reviewer",
	"Status",
	"Suggested existing labels",
	"Future acceptance",
	"Data boundary",
	"Inventory boundary",
] as const;
const draftFields = [
	"Problem and scope",
	"Proposed future path",
	"Deliverable",
	"Prerequisites",
	"Acceptance observations",
] as const;

interface Draft {
	title: string;
	line: number;
	fields: Map<string, string>;
}

// This deliberately accepts the catalog's one-line fields, plain paragraphs and inline links/code,
// rather than attempting to interpret arbitrary Markdown containers or multiline inline markup.
function supportedLine(line: string): boolean {
	for (const character of line) {
		const code = character.codePointAt(0) ?? 0;
		if (
			(code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
			code === 0x7f ||
			code === 0x85 ||
			code === 0x2028 ||
			code === 0x2029
		)
			return false;
	}
	if (
		/^[ \t]+\S|[<>\\]/.test(line) ||
		/^(?:>|:::|`{3,}|~{3,}|[0-9]+[.)] |[+*] |\[[^\]]+\]:|(?:=+|-+)\s*$)/.test(line) ||
		line.includes("``")
	)
		return false;
	const plain = line.replace(/`[^`]*`/g, "");
	if (plain.includes("`") || (plain.match(/\*\*/g)?.length ?? 0) % 2 !== 0) return false;
	const withoutLinks = plain.replace(/\[[^[\]]+\]\([^()\s]+\)/g, "");
	return !/[[\]]/.test(withoutLinks);
}

/** Local structure only: declarations do not prove safe scope, resolved inputs or public approval. */
export function checkIssueDrafts({ catalog, labels }: IssueDraftInputs): IssueDraftProblem[] {
	const problems: IssueDraftProblem[] = [];
	const report = (rule: string, line?: number): void => {
		problems.push({ file: catalogFile, rule, ...(line === undefined ? {} : { line }) });
	};
	const definedLabels = new Set<string>();
	let validLabels = Array.isArray(labels) && labels.length > 0;
	for (const entry of Array.isArray(labels) ? labels : []) {
		const name =
			entry !== null && typeof entry === "object" && Object.hasOwn(entry, "name")
				? (entry as { name?: unknown }).name
				: undefined;
		if (
			typeof name !== "string" ||
			name.trim() === "" ||
			name !== name.trim() ||
			definedLabels.has(name)
		) {
			validLabels = false;
		} else definedLabels.add(name);
	}
	if (!validLabels)
		problems.push({
			file: ".github/labels.yml",
			rule: "label definitions must be a nonempty sequence of unique nonempty names",
		});

	const shared = new Map<string, string>();
	const drafts: Draft[] = [];
	let phase: "intro" | "shared" | "draft" | "gates" = "intro";
	let titles = 0;
	let sharedSections = 0;
	let gateSections = 0;
	for (const [index, line] of catalog.split(/\r\n|\r|\n/).entries()) {
		const at = index + 1;
		if (line.trim() === "") continue;
		if (!supportedLine(line)) {
			report("unsupported catalog Markdown; use top-level one-line fields", at);
			continue;
		}
		if (/^# [^#]/.test(line)) {
			titles++;
			if (phase !== "intro" || titles !== 1) report("expected one catalog title before fields", at);
			continue;
		}
		if (line === sharedHeading) {
			sharedSections++;
			if (phase !== "intro" || sharedSections !== 1)
				report("shared fields must appear once before numbered drafts", at);
			phase = "shared";
			continue;
		}
		if (line === gatesHeading) {
			gateSections++;
			if (phase !== "draft" || gateSections !== 1)
				report("remaining gates must appear once after numbered drafts", at);
			phase = "gates";
			continue;
		}
		const heading = /^## ([1-9][0-9]*)\. ([^#]+)$/.exec(line);
		if (heading) {
			if (phase !== "shared" && phase !== "draft")
				report("numbered drafts must follow shared fields and precede remaining gates", at);
			if (heading[1] !== String(drafts.length + 1))
				report("draft headings must use consecutive numbers starting at 1", at);
			const title = heading[2]?.trim() ?? "";
			// Character references can hide duplicates after Markdown renders the title.
			if (!title || /[`*_[\]{}|]/.test(title) || /&[A-Za-z][A-Za-z0-9]*;/.test(title))
				report("draft titles must be nonempty plain text", at);
			drafts.push({ title, line: at, fields: new Map() });
			phase = "draft";
			continue;
		}
		if (line.startsWith("#")) {
			report("unsupported catalog heading", at);
			continue;
		}
		const field = /^- \*\*([^*]+):\*\* (.*)$/.exec(line);
		if (field) {
			const name = field[1] ?? "";
			const value = field[2]?.trim() ?? "";
			const fields =
				phase === "shared" ? shared : phase === "draft" ? drafts.at(-1)?.fields : undefined;
			const allowed: readonly string[] = phase === "shared" ? sharedFields : draftFields;
			if (!fields || !allowed.includes(name)) report("field is not allowed in this section", at);
			else if (fields.has(name)) report("fields must appear exactly once in their section", at);
			else fields.set(name, value);
			if (!value) report("fields must have a nonempty one-line value", at);
		} else if (line.startsWith("-") || phase === "draft") {
			report("expected a top-level one-line catalog field", at);
		}
	}
	if (titles !== 1) report("expected one catalog title before fields");
	if (sharedSections !== 1) report("shared fields must appear once before numbered drafts");
	if (gateSections !== 1) report("remaining gates must appear once after numbered drafts");
	for (const field of sharedFields)
		if (!shared.get(field)) report(`missing shared field: ${field}`);
	if (!shared.get("Classification")?.startsWith("optional nonsecurity pilot documentation."))
		report("shared classification must declare optional nonsecurity pilot documentation");
	if (
		!/^[^`,]+, pending [^.]*\bexplicit acceptance\b/.test(
			shared.get("Proposed owner/reviewer") ?? "",
		)
	)
		report("shared proposed owner must remain pending explicit acceptance");
	if (
		!shared
			.get("Status")
			?.startsWith(
				"not created as a GitHub issue by this catalog; unapproved, unassigned and not ready.",
			)
	)
		report("shared status must declare uncreated, unapproved, unassigned and not ready proposals");
	const suggested = /^(`[^`]+`(?:, `[^`]+`)*), subject to /.exec(
		shared.get("Suggested existing labels") ?? "",
	)?.[1];
	const names = suggested
		? [...suggested.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "")
		: [];
	if (
		!names.includes("good first issue") ||
		new Set(names).size !== names.length ||
		names.some((name) => !definedLabels.has(name))
	)
		report("suggested labels must name distinct defined labels and include good first issue");
	if (drafts.length < 12) report("catalog must contain at least twelve numbered drafts");
	const seenTitles = new Set<string>();
	const seenPaths = new Set<string>();
	for (const draft of drafts) {
		const title = draft.title.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
		if (seenTitles.has(title))
			report("draft titles must be unique after normalization", draft.line);
		seenTitles.add(title);
		for (const field of draftFields)
			if (!draft.fields.get(field)) report(`missing draft field: ${field}`, draft.line);
		const path = /^`(docs\/(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)*[a-z0-9]+(?:-[a-z0-9]+)*\.md)`\.$/.exec(
			draft.fields.get("Proposed future path") ?? "",
		)?.[1];
		if (!path)
			report(
				"future paths must be canonical lowercase docs Markdown paths in backticks",
				draft.line,
			);
		else if (seenPaths.has(path)) report("future paths must be unique", draft.line);
		else seenPaths.add(path);
	}
	return problems;
}
