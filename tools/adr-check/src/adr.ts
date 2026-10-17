import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const sectionNames: readonly string[] = [
	"Context",
	"Options",
	"Decision",
	"Fallback",
	"Evidence",
	"Kept test",
];
export const decisions: readonly string[] = ["Go", "Go with fallback", "No-go", "Not run"];

// Each header field: what its value must match, and the problem when it doesn't.
const headerRules: Readonly<Record<string, readonly [RegExp, string]>> = {
	Status: [/^(?:proposed|accepted|superseded)$/, "is not proposed, accepted or superseded"],
	Date: [/^\d{4}-\d{2}-\d{2}$/, "is not a YYYY-MM-DD date"],
	Spike: [/^(?:none|S\d{1,2}[a-z]?)(?:\s.*)?$/, 'is not "none" or a spike id such as S1 or S3b'],
	Plan: [/§\d+/, "names no plan section (§n)"],
	"Owner decision": [/^(?:yes|no)$/, "is not yes or no"],
};
const successorFields = ["Superseded by", "Supersedes"];
const keptFields = ["Path", "Command", "Guards", "Destination"];

export interface Line {
	readonly text: string;
	readonly line: number;
	readonly code?: boolean;
}

export interface Field extends Line {
	readonly name: string;
}

export interface Section {
	readonly name: string;
	readonly line: number;
	readonly body: readonly Line[];
}

export interface Adr {
	readonly file: string;
	readonly number: string;
	readonly title?: Line;
	readonly header: readonly Field[];
	readonly sections: readonly Section[];
}

export interface Problem {
	readonly file: string;
	readonly line?: number;
	readonly message: string;
}

// How a kept-test path exists in the checkout, if it does.
type Lookup = (file: string) => "file" | "folder" | undefined;

// "- **Name:** value" or "**Name**: value".
const fieldLine = /^\s*(?:[-*+]\s+)?\*\*([A-Za-z][A-Za-z ]*?)(?::\*\*|\*\*:)\s*(.*?)\s*$/;
const fence = /^\s*(?:```|~~~)/;

function parseField(text: string, line: number): Field | undefined {
	const match = fieldLine.exec(text);
	return match ? { name: match[1] ?? "", text: match[2] ?? "", line } : undefined;
}

export const backticked = (text: string): string[] =>
	[...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");

// The file's lines with HTML comments blanked out, multi-line ones too. Lines of fenced code blocks
// stay as they are and are marked, so they never count as headings or fields.
export function markdownLines(text: string): Line[] {
	const lines: Line[] = [];
	let inFence = false;
	let inComment = false;
	for (const [index, raw] of text.split(/\r?\n/).entries()) {
		const line = index + 1;
		if (!inComment && (inFence || fence.test(raw))) {
			if (fence.test(raw)) inFence = !inFence;
			lines.push({ text: raw, line, code: true });
			continue;
		}
		let kept = "";
		let rest = raw;
		for (;;) {
			const marker = rest.indexOf(inComment ? "-->" : "<!--");
			if (!inComment) kept += marker === -1 ? rest : rest.slice(0, marker);
			if (marker === -1) break;
			rest = rest.slice(marker + (inComment ? 3 : 4));
			inComment = !inComment;
		}
		lines.push({ text: kept, line });
	}
	return lines;
}

export function parseAdr(file: string, text: string): Adr {
	let title: Line | undefined;
	const header: Field[] = [];
	const sections: { name: string; line: number; body: Line[] }[] = [];
	for (const entry of markdownLines(text)) {
		const heading = entry.code ? undefined : /^(#{1,2}) (.+?)\s*$/.exec(entry.text);
		if (heading?.[1] === "#" && title === undefined && sections.length === 0) {
			title = { text: heading[2] ?? "", line: entry.line };
		} else if (heading?.[1] === "##") {
			sections.push({ name: heading[2] ?? "", line: entry.line, body: [] });
		} else if (sections.length > 0) {
			sections.at(-1)?.body.push(entry);
		} else if (title !== undefined && !entry.code) {
			const field = parseField(entry.text, entry.line);
			if (field) header.push(field);
		}
	}
	return { file, number: path.basename(file).slice(0, 4), title, header, sections };
}

export const field = (adr: Adr, name: string): string | undefined =>
	adr.header.find((entry) => entry.name === name)?.text;

export const section = (adr: Adr, name: string): Section | undefined =>
	adr.sections.find((entry) => entry.name === name);

export const content = (lines: readonly Line[]): Line[] =>
	lines.filter((line) => line.text.trim() !== "");

export function decision(adr: Adr): string | undefined {
	const body = section(adr, "Decision")?.body;
	return body && content(body)[0]?.text.trim();
}

// One map per kept test, from its Path field to the next.
export function keptTests(adr: Adr): ReadonlyMap<string, Field>[] {
	const tests: Map<string, Field>[] = [];
	for (const { text, line, code } of section(adr, "Kept test")?.body ?? []) {
		const entry = code ? undefined : parseField(text, line);
		if (entry?.name === "Path") tests.push(new Map());
		if (entry && keptFields.includes(entry.name)) tests.at(-1)?.set(entry.name, entry);
	}
	return tests;
}

function isDate(value: string): boolean {
	const time = Date.parse(`${value}T00:00:00Z`);
	return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value);
}

function keptPathProblem(file: string, lookup: Lookup): string | undefined {
	const target = file.replace(/\/$/, "");
	const plain = path.posix.normalize(target);
	if (file.includes("\\")) return `kept-test path ${file} must use forward slashes`;
	if (path.posix.isAbsolute(file) || /^[a-z]:/i.test(file) || /^\.\.(?:\/|$)/.test(plain)) {
		return `kept-test path ${file} must be relative to the repository root`;
	}
	if (plain !== target) return `kept-test path ${file} should be written ${plain}`;
	const kind = target === "." ? "folder" : lookup(target);
	if (kind === undefined) {
		return `kept-test path ${file} does not exist (case counts; git-ignored files don't)`;
	}
	if (kind === "folder" && !target.includes("/")) {
		return `kept-test path ${file} is the repository root or a top-level folder; name the test`;
	}
	return undefined;
}

export function checkAdr(adr: Adr, numbers: ReadonlySet<string>, lookup: Lookup): Problem[] {
	const problems: Problem[] = [];
	const at = (line: number | undefined, message: string): void => {
		problems.push({ file: adr.file, line, message });
	};
	const top = adr.title?.line;
	const titled = /^ADR (\d{4}): \S/.exec(adr.title?.text ?? "");
	if (!titled) at(top, 'title must be "# ADR NNNN: Title"');
	else if (titled[1] !== adr.number)
		at(top, `title number ${titled[1]} differs from the file number ${adr.number}`);

	for (const entry of adr.header) {
		if (!(entry.name in headerRules) && !successorFields.includes(entry.name)) {
			at(entry.line, `unknown header field "${entry.name}"`);
		} else if (adr.header.filter((other) => other.name === entry.name).length > 1) {
			at(entry.line, `header field "${entry.name}" appears more than once`);
		}
	}
	for (const [name, [pattern, problem]] of Object.entries(headerRules)) {
		const value = field(adr, name);
		if (value === undefined) at(top, `header field "${name}" is missing`);
		else if (!pattern.test(value) || (name === "Date" && !isDate(value))) {
			at(top, `${name} "${value}" ${problem}`);
		}
	}
	const superseded = field(adr, "Status") === "superseded";
	if (superseded !== (field(adr, "Superseded by") !== undefined)) {
		at(top, 'Status superseded and a "Superseded by" field naming the successor go together');
	}
	for (const name of successorFields) {
		const value = field(adr, name);
		const target = value && /^(?:ADR )?(\d{4})$/.exec(value)?.[1];
		if (value !== undefined && (!target || target === adr.number || !numbers.has(target))) {
			at(top, `${name} "${value}" doesn't name another ADR in docs/adr`);
		}
	}

	const names = adr.sections.map((entry) => entry.name).join(", ");
	if (names !== sectionNames.join(", ")) {
		at(
			adr.sections[0]?.line,
			`sections must be ${sectionNames.join(", ")} in that order (found: ${names || "none"})`,
		);
	}
	for (const entry of adr.sections) {
		if (content(entry.body).length === 0) at(entry.line, `${entry.name} is empty`);
	}
	const outcome = decision(adr);
	if (outcome !== undefined && !decisions.includes(outcome)) {
		at(
			section(adr, "Decision")?.line,
			`Decision must start with one of: ${decisions.join(", ")} (found "${outcome}")`,
		);
	}

	const kept = section(adr, "Kept test");
	const tests = keptTests(adr);
	if (kept && tests.length === 0) at(kept.line, "Kept test has no Path field");
	for (const test of tests) {
		const entry = test.get("Path");
		if (entry === undefined) continue;
		if (/^none\b/i.test(entry.text)) {
			if (outcome !== "No-go" && outcome !== "Not run") {
				at(entry.line, 'Path "none" needs the Decision No-go or Not run');
			}
			continue;
		}
		const paths = backticked(entry.text);
		if (paths.length === 0) at(entry.line, "Path names no `path`");
		for (const file of paths) {
			const problem = keptPathProblem(file, lookup);
			if (problem) at(entry.line, problem);
		}
		for (const name of keptFields.slice(1)) {
			if (!test.get(name)?.text) at(entry.line, `kept test ${name} is missing`);
		}
		const destination = test.get("Destination");
		if (destination?.text && !/\bM\d{1,2}[a-z]?\b/.test(destination.text)) {
			at(destination.line, "Destination names no milestone (e.g. M2a)");
		}
		if (destination?.text && !backticked(destination.text).some((token) => token.includes("/"))) {
			at(
				destination.line,
				"Destination names no `path` with a folder (e.g. `plugins/channel-slack/`)",
			);
		}
	}
	return problems;
}

function templateProblems(root: string): Problem[] {
	const file = "docs/adr/template.md";
	if (!existsSync(path.join(root, file))) return [{ file, message: "the ADR template is missing" }];
	const template = parseAdr(file, readFileSync(path.join(root, file), "utf8"));
	const names = template.sections.map((entry) => entry.name).join(", ");
	const fields = [...template.header, ...keptTests(template).flatMap((test) => [...test.values()])];
	return [
		...(names === sectionNames.join(", ") ? [] : [`sections are ${names}`]),
		...[...Object.keys(headerRules), ...keptFields]
			.filter((name) => !fields.some((entry) => entry.name === name))
			.map((name) => `no "${name}" field`),
	].map((message) => ({ file, message: `the template has ${message}` }));
}

// Inside a git checkout, kept-test paths must be tracked or new, unignored files (or folders holding
// some), spelled with git's case, so a path that only Windows resolves fails here and not in CI.
function lookupFor(root: string): Lookup {
	const args = ["ls-files", "-z", "--cached", "--others", "--exclude-standard"];
	const git = spawnSync("git", args, {
		cwd: root,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		windowsHide: true,
	});
	const onDisk = (file: string): boolean => existsSync(path.join(root, file));
	if (git.status === 0) {
		const files = git.stdout.split("\0").filter((file) => file !== "");
		const tracked = new Set(files);
		return (file) => {
			if (tracked.has(file) && onDisk(file)) return "file";
			return files.some((entry) => entry.startsWith(`${file}/`) && onDisk(entry))
				? "folder"
				: undefined;
		};
	}
	return (file) => {
		const stat = statSync(path.join(root, file), { throwIfNoEntry: false });
		return stat?.isFile() ? "file" : stat?.isDirectory() ? "folder" : undefined;
	};
}

export function check(root: string): { adrs: Adr[]; problems: Problem[] } {
	const dir = path.join(root, "docs", "adr");
	if (!existsSync(dir)) return { adrs: [], problems: [{ file: "docs/adr", message: "not found" }] };
	const adrs: Adr[] = [];
	const problems = templateProblems(root);
	for (const name of readdirSync(dir).toSorted()) {
		if (name === "README.md" || name === "template.md" || name.startsWith(".")) continue;
		const file = `docs/adr/${name}`;
		if (/^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name)) {
			adrs.push(parseAdr(file, readFileSync(path.join(dir, name), "utf8")));
		} else {
			problems.push({ file, message: "ADR file names are NNNN-slug.md (lower-case slug)" });
		}
	}
	const numbers = new Set(adrs.map((adr) => adr.number));
	const lookup = lookupFor(root);
	for (const adr of adrs) {
		if (adrs.find((other) => other.number === adr.number) !== adr) {
			problems.push({ file: adr.file, message: `ADR number ${adr.number} is used twice` });
		}
		problems.push(...checkAdr(adr, numbers, lookup));
	}
	return { adrs, problems };
}

export const formatProblem = (problem: Problem): string =>
	`${problem.file}${problem.line === undefined ? "" : `:${problem.line}`}: ${problem.message}`;
