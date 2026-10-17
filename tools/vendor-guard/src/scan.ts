import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { evidenceFormat, evidenceSubject, rules } from "../rules/index.ts";
import {
	evidenceHits,
	type Hit,
	lineHits,
	lines,
	type MarkRule,
	markHits,
	type PatternRule,
} from "./rules.ts";

export interface Finding {
	readonly file?: string;
	readonly commit?: string;
	// 0 for the file's path.
	readonly line: number;
	readonly column: number;
	readonly rule: string;
	readonly reason: string;
	// A vendor match in a *.md file: the SHA-256 an allow.json entry for this line needs.
	readonly lineSha256?: string;
}

export interface AllowEntry {
	readonly path: string;
	readonly rule: string;
	readonly sha256: string;
	readonly reason: string;
}

// The literal patterns: only the secret and attribution rules apply here.
const RULES_DIR = "tools/vendor-guard/rules/";
export const ALLOW_FILE = "tools/vendor-guard/allow.json";
// Recorded vendor documents: vendor rules skip them; secret, attribution and other rules don't.
export const DATA_ONLY: readonly string[] = [
	"spikes/s04-oauth-as/fixtures/cimd/",
	"spikes/s07-siwc/notes/sources.md",
];
// spikes/<id>/evidence/ holds only evidence; writeEvidence() may also write *.json into any other
// evidence/ folder under spikes/.
const EVIDENCE_DIR = /^spikes\/[^/]+\/evidence\/(?!(?:.*\/)?\.gitkeep$)/;
const EVIDENCE_JSON = /^spikes\/(?:[^/]+\/)+evidence\/[^/]+\.json$/;
const PROSE = /\.md$/i;
// Larger files are reported, not read.
export const MAX_BYTES: number = 16 * 1024 * 1024;

const ofKind = (kind: PatternRule["kind"]): PatternRule[] =>
	rules.filter((rule): rule is PatternRule => rule.kind === kind && rule !== evidenceFormat);
const vendor = ofKind("vendor");
const shared = [...ofKind("secret"), ...ofKind("attribution")];
const evidence = ofKind("evidence");
const marks = rules.filter((rule): rule is MarkRule => rule.kind === "mark");

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export const sha256 = (text: string): string =>
	createHash("sha256").update(text, "utf8").digest("hex");

// `git rev-parse --local-env-vars` and GIT_NAMESPACE: hooks, `rebase -x` and `bisect run` export
// some of them, and with them git would act on that repository instead of the one at cwd.
const REPO_VARS = new Set([
	...["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY"],
	...["GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_IMPLICIT_WORK_TREE", "GIT_PREFIX", "GIT_NAMESPACE"],
	...["GIT_CONFIG", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_COUNT", "GIT_GRAFT_FILE"],
	...["GIT_NO_REPLACE_OBJECTS", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE"],
]);

export function gitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return Object.fromEntries(
		Object.entries(env).filter(([name]) => !REPO_VARS.has(name.toUpperCase())),
	);
}

function git(cwd: string, args: readonly string[]): string {
	const result = spawnSync("git", [...args], {
		cwd,
		env: gitEnv(),
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = result.stderr.trim() || `exit code ${result.status}`;
		throw new Error(`git ${args.join(" ")}: ${detail}`);
	}
	return result.stdout;
}

export function toplevel(cwd: string): string {
	return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

// Tracked files, plus untracked ones that aren't ignored, so a new file is checked before its commit.
export function listFiles(root: string): string[] {
	const listed = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
	return [...new Set(listed.split("\0").filter((file) => file !== ""))].sort();
}

export interface Content {
	readonly text: string;
	// Valid UTF-8 without a BOM, as writeEvidence() writes it.
	readonly plain: boolean;
}

// UTF-16 without a BOM: in mostly-ASCII text, every other byte is 0.
function utf16Order(head: Uint8Array): "le" | "be" | undefined {
	let even = 0;
	let odd = 0;
	for (let i = 0; i + 1 < head.length; i += 2) {
		if (head[i] === 0) even++;
		if (head[i + 1] === 0) odd++;
	}
	const pairs = head.length >> 1;
	if (odd > pairs / 2 && even * 8 < odd) return "le";
	if (even > pairs / 2 && odd * 8 < even) return "be";
	return undefined;
}

function utf16(bytes: Uint8Array, order: "le" | "be"): string {
	const units = Buffer.from(bytes.subarray(0, bytes.length & ~1));
	return (order === "be" ? units.swap16() : units).toString("utf16le");
}

// UTF-16 by its BOM or its NUL bytes, otherwise UTF-8, decoded as far as it is valid. Binaries are
// read too, so a token stored in one is still found.
function decode(bytes: Buffer): Content {
	const [a, b, c] = bytes;
	if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) {
		return { text: utf16(bytes.subarray(2), a === 0xff ? "le" : "be"), plain: false };
	}
	const order = bytes.includes(0) ? utf16Order(bytes.subarray(0, 8000)) : undefined;
	if (order) return { text: utf16(bytes, order), plain: false };
	const bom = a === 0xef && b === 0xbb && c === 0xbf;
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), plain: !bom };
	} catch {
		return { text: bytes.toString("utf8", bom ? 3 : 0), plain: false };
	}
}

// A file's content, a symlink's target (never followed), "large" above MAX_BYTES, or undefined for
// folders (submodules) and files that are gone.
function read(root: string, file: string): Content | "large" | undefined {
	const full = path.join(root, file);
	try {
		const stat = lstatSync(full);
		if (stat.isSymbolicLink()) return { text: readlinkSync(full), plain: false };
		if (!stat.isFile()) return undefined;
		return stat.size > MAX_BYTES ? "large" : decode(readFileSync(full));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`${file}: ${message(error)}`);
	}
}

const isDataOnly = (file: string): boolean =>
	DATA_ONLY.some((entry) => (entry.endsWith("/") ? file.startsWith(entry) : file === entry));

function evidenceFile(file: string, content: Content): Hit[] {
	const format = [{ rule: evidenceFormat, line: 1, column: 1, text: "" }];
	if (!file.endsWith(".json") || !content.plain) return format;
	try {
		return evidenceHits(content.text, evidence, evidenceSubject);
	} catch {
		return format;
	}
}

// Every rule hit in one file, its path included, before allow.json.
export function fileHits(file: string, content: Content): Hit[] {
	const rulesDir = file.startsWith(RULES_DIR);
	const set = rulesDir || isDataOnly(file) ? shared : [...vendor, ...shared];
	const hits = lineHits(`/${file}`, set).map((hit) => ({
		...hit,
		line: 0,
		column: Math.max(1, hit.column - 1),
	}));
	const isEvidence = EVIDENCE_DIR.test(file) || EVIDENCE_JSON.test(file);
	if (isEvidence) hits.push(...evidenceFile(file, content));
	hits.push(...lineHits(content.text, set));
	if (!rulesDir) for (const rule of marks) hits.push(...markHits(rule, file, content.text));
	return hits.sort((a, b) => a.line - b.line || a.column - b.column);
}

const allowKey = (file: string, rule: string, hash: string): string => `${file}\0${rule}\0${hash}`;

function allowProblem(entry: unknown, vendorIds: ReadonlySet<string>): string | undefined {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return "not an object";
	if (Object.keys(entry).sort().join() !== "path,reason,rule,sha256") {
		return "needs exactly path, rule, sha256 and reason";
	}
	const { path: file, rule, sha256: hash, reason } = entry as Record<string, unknown>;
	if (typeof file !== "string" || !PROSE.test(file) || !/^(?!\/)(?!.*\\)[^:]+$/.test(file)) {
		return "path must be a repo-relative *.md file with forward slashes";
	}
	if (typeof rule !== "string" || !vendorIds.has(rule)) {
		return `rule must be one of the vendor rules: ${[...vendorIds].join(", ")}`;
	}
	if (typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
		return "sha256 must be the line's SHA-256 in lower-case hex";
	}
	if (typeof reason !== "string" || reason.trim() === "") return "reason must say why it may stay";
	return undefined;
}

const readAllow = (root: string): string =>
	readFileSync(path.join(root, ALLOW_FILE), "utf8").replace(/^\uFEFF/, "");

// tools/vendor-guard/allow.json: reviewed exceptions for vendor matches in *.md files only.
export function loadAllow(root: string): AllowEntry[] {
	if (!existsSync(path.join(root, ALLOW_FILE))) return [];
	let entries: unknown;
	try {
		entries = JSON.parse(readAllow(root));
	} catch (error) {
		throw new Error(`${ALLOW_FILE}: ${message(error)}`);
	}
	if (!Array.isArray(entries)) throw new Error(`${ALLOW_FILE} must be a JSON array`);
	const vendorIds = new Set(vendor.map((rule) => rule.id));
	const seen = new Set<string>();
	return entries.map((entry: unknown, index) => {
		const problem = allowProblem(entry, vendorIds);
		if (problem !== undefined) throw new Error(`${ALLOW_FILE} entry ${index + 1}: ${problem}`);
		const valid = entry as AllowEntry;
		const key = allowKey(valid.path, valid.rule, valid.sha256);
		if (seen.has(key)) throw new Error(`${ALLOW_FILE} entry ${index + 1} repeats an earlier one`);
		seen.add(key);
		return valid;
	});
}

function staleEntries(root: string, stale: readonly AllowEntry[]): Finding[] {
	if (stale.length === 0) return [];
	const text = lines(readAllow(root));
	return stale.map((entry) => ({
		file: ALLOW_FILE,
		line: Math.max(1, text.findIndex((line) => line.includes(entry.sha256)) + 1),
		column: 1,
		rule: "allow-json",
		reason: `the entry for ${entry.path} (${entry.rule}) matches no line: update its sha256 after review, or remove it`,
	}));
}

export interface FileScan {
	readonly findings: Finding[];
	readonly files: number;
}

export function scanFiles(
	root: string,
	files: readonly string[],
	allow: readonly AllowEntry[] = [],
): FileScan {
	const allowed = new Map(
		allow.map((entry) => [allowKey(entry.path, entry.rule, entry.sha256), entry]),
	);
	const used = new Set<AllowEntry>();
	const findings: Finding[] = [];
	let scanned = 0;
	for (const file of files) {
		let content = read(root, file);
		if (content === undefined) continue;
		scanned++;
		if (content === "large") {
			const reason = `over ${MAX_BYTES / 2 ** 20} MiB, too large to scan; keep it out of the repository`;
			findings.push({ file, line: 1, column: 1, rule: "too-large", reason });
			content = { text: "", plain: false };
		}
		for (const { rule, line, column, text: source } of fileHits(file, content)) {
			const prose = PROSE.test(file) && rule.kind === "vendor" && line > 0;
			const lineSha256 = prose ? sha256(source) : undefined;
			const entry =
				lineSha256 === undefined ? undefined : allowed.get(allowKey(file, rule.id, lineSha256));
			if (entry !== undefined) {
				used.add(entry);
				continue;
			}
			const { id, reason } = rule;
			const where = line === 0 ? " (in the file's path)" : "";
			findings.push({
				file,
				line,
				column,
				rule: id,
				reason: `${reason}${where}`,
				...(lineSha256 ? { lineSha256 } : {}),
			});
		}
	}
	const stale = allow.filter((entry) => !used.has(entry));
	return { findings: [...findings, ...staleEntries(root, stale)], files: scanned };
}

const RANGE = /^(?!-)[\w./@^~{}-]+$/;

// Commit messages in `range` against the secret and attribution rules.
export function scanCommits(root: string, range: string): { findings: Finding[]; commits: number } {
	if (!RANGE.test(range)) {
		throw new Error(
			`--commits takes a revision range such as origin/m0..HEAD, not ${JSON.stringify(range)}`,
		);
	}
	const log = git(root, [
		"log",
		"-z",
		"--no-show-signature",
		"--encoding=UTF-8",
		"--format=%H%n%B",
		"--end-of-options",
		range,
		"--",
	]);
	const records = log.split("\0").filter((record) => record.trim() !== "");
	const findings: Finding[] = [];
	for (const record of records) {
		const [commit = "", ...body] = lines(record.replace(/^\n+/, ""));
		for (const { rule, line, column } of lineHits(body.join("\n"), shared)) {
			findings.push({ commit, line, column, rule: rule.id, reason: rule.reason });
		}
	}
	return { findings, commits: records.length };
}
