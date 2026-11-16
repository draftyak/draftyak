import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import { evidenceFormat, evidenceSubject, rules } from "../rules/index.ts";
import {
	type Budget,
	evidenceHits,
	type Hit,
	LINE_COST,
	lineHits,
	lines,
	type MarkRule,
	markHits,
	type PatternRule,
} from "./rules.ts";
import { CAPS, type Part, unpack } from "./unpack.ts";

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

export interface Reading {
	readonly text: string;
	// For findings, such as "read as UTF-16LE" or "in zip entry 2".
	readonly where: string;
}

export interface Content {
	readonly text: string;
	// Valid UTF-8 without a BOM, as writeEvidence() writes it.
	readonly plain: boolean;
	// Other readings of the bytes, which the line rules check too: UTF-16 or UTF-8 where NUL bytes
	// leave the encoding open, and compressed content, decoded as the scan reaches it.
	readonly more?: Iterable<Reading>;
	// Why compressed content wasn't read within the caps.
	readonly problem?: string;
	// What line rules may read of it in all its readings (see Budget): twice the most its compressed
	// content may expand to. A file that needs more fails, with the hits found before that.
	readonly budget?: number;
}

interface Decoded {
	readonly text: string;
	readonly plain: boolean;
	readonly others: readonly Reading[];
}

// UTF-16 without a BOM: in mostly-ASCII text, every other byte is 0.
function utf16Order(bytes: Uint8Array): { order?: "le" | "be"; even: number; odd: number } {
	let even = 0;
	let odd = 0;
	for (let i = 0; i + 1 < bytes.length; i += 2) {
		if (bytes[i] === 0) even++;
		if (bytes[i + 1] === 0) odd++;
	}
	const pairs = bytes.length >> 1;
	if (odd > pairs / 2 && even * 8 < odd) return { order: "le", even, odd };
	if (even > pairs / 2 && odd * 8 < even) return { order: "be", even, odd };
	return { even, odd };
}

function utf16(bytes: Uint8Array, order: "le" | "be"): string {
	const units = Buffer.from(bytes.subarray(0, bytes.length & ~1));
	return (order === "be" ? units.swap16() : units).toString("utf16le");
}

function utf8(bytes: Buffer): { text: string; plain: boolean } {
	const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
	try {
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), plain: !bom };
	} catch {
		return { text: bytes.toString("utf8", bom ? 3 : 0), plain: false };
	}
}

// UTF-16 by its BOM or its NUL bytes over the whole file, otherwise UTF-8, decoded as far as it is
// valid. Binaries are read too, so a token stored in one is still found. Without a BOM, bytes with
// NULs are also read in each other encoding their NULs fit, so UTF-16 with too few NULs to tell,
// such as text that starts in a non-Latin script, can't hide an ASCII token; with a UTF-16 BOM,
// they are also read as UTF-8, so the BOM can't hide UTF-8.
function decode(bytes: Buffer): Decoded {
	const [a, b] = bytes;
	const text = utf8(bytes);
	if ((a === 0xff && b === 0xfe) || (a === 0xfe && b === 0xff)) {
		const others = [{ text: text.text, where: "read as UTF-8" }];
		return { text: utf16(bytes.subarray(2), a === 0xff ? "le" : "be"), plain: false, others };
	}
	if (!bytes.includes(0)) return { ...text, others: [] };
	const { order, even, odd } = utf16Order(bytes);
	const others: Reading[] = order ? [{ text: text.text, where: "read as UTF-8" }] : [];
	if (odd > 0 && order !== "le") {
		others.push({ text: utf16(bytes, "le"), where: "read as UTF-16LE" });
	}
	if (even > 0 && order !== "be") {
		others.push({ text: utf16(bytes, "be"), where: "read as UTF-16BE" });
	}
	return order ? { text: utf16(bytes, order), plain: false, others } : { ...text, others };
}

function* readings(others: readonly Reading[], parts: readonly Part[]): Generator<Reading> {
	yield* others;
	for (const { bytes, label } of parts) {
		const decoded = decode(bytes);
		yield { text: decoded.text, where: `in ${label}` };
		for (const other of decoded.others) {
			yield { text: other.text, where: `in ${label}, ${other.where}` };
		}
	}
}

function contentOf(file: string, bytes: Buffer): Content {
	const { text, plain, others } = decode(bytes);
	const { parts, problem } = unpack(bytes, CAPS, file);
	const more = { [Symbol.iterator]: () => readings(others, parts) };
	const budget = 2 * Math.min(CAPS.max, Math.max(CAPS.min, CAPS.ratio * bytes.length));
	return { text, plain, more, budget, ...(problem ? { problem } : {}) };
}

// A file's content, a symlink's target (never followed), "large" above MAX_BYTES, or undefined for
// folders (submodules) and files that are gone.
function read(root: string, file: string): Content | "large" | undefined {
	const full = path.join(root, file);
	let bytes: Buffer;
	try {
		const stat = lstatSync(full);
		if (stat.isSymbolicLink()) return { text: readlinkSync(full), plain: false };
		if (!stat.isFile()) return undefined;
		if (stat.size > MAX_BYTES) return "large";
		bytes = readFileSync(full);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new Error(`${file}: ${message(error)}`);
	}
	return contentOf(file, bytes);
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

// Every rule hit in one file, its path included, before allow.json. With a budget, its lines are
// read only as far as it pays for them, and no reading after that is decoded.
export function fileHits(file: string, content: Content, budget?: Budget): Hit[] {
	const rulesDir = file.startsWith(RULES_DIR);
	const set = rulesDir || isDataOnly(file) ? shared : [...vendor, ...shared];
	const hits = lineHits(`/${file}`, set).map((hit) => ({
		...hit,
		line: 0,
		column: Math.max(1, hit.column - 1),
	}));
	const isEvidence = EVIDENCE_DIR.test(file) || EVIDENCE_JSON.test(file);
	if (isEvidence) hits.push(...evidenceFile(file, content));
	hits.push(...lineHits(content.text, set, budget));
	const spent = (): boolean => budget !== undefined && budget.left < 0;
	if (!spent()) {
		for (const { text, where } of content.more ?? []) {
			for (const hit of lineHits(text, set, budget)) hits.push({ ...hit, where });
			if (spent()) break;
		}
	}
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

const mib = (count: number): number => Number((count / 2 ** 20).toFixed(1));

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
		if (content.problem !== undefined) {
			findings.push({ file, line: 1, column: 1, rule: "compressed", reason: content.problem });
		}
		const limit = content.budget ?? Number.POSITIVE_INFINITY;
		const budget: Budget = { left: limit };
		const hits = fileHits(file, content, budget);
		if (budget.left < 0) {
			const reason = `its readings and decoded lines come to over ${mib(limit)} Mi characters (each line counting ${LINE_COST} more), too large to scan; keep it out of the repository`;
			findings.push({ file, line: 1, column: 1, rule: "too-large", reason });
		}
		for (const { rule, line, column, text: source, where: inside } of hits) {
			const prose = PROSE.test(file) && rule.kind === "vendor" && line > 0 && inside === undefined;
			const lineSha256 = prose ? sha256(source) : undefined;
			const entry =
				lineSha256 === undefined ? undefined : allowed.get(allowKey(file, rule.id, lineSha256));
			if (entry !== undefined) {
				used.add(entry);
				continue;
			}
			const { id, reason } = rule;
			const where = line === 0 ? "in the file's path" : inside;
			findings.push({
				file,
				line,
				column,
				rule: id,
				reason: where === undefined ? reason : `${reason} (${where})`,
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
