import { reservedWord } from "../../../reserved-tests.ts";
import {
	ALLOWED_DOCS,
	ALLOWED_ROOTS,
	checkLine,
	isObject,
	parseJson,
	STOP_LINE,
	tripwire,
	tripwireLines,
} from "../reserved-tripwire.ts";
import { type ScanCheck, scan, Walks } from "./discovery.ts";
import { type WorkspaceProblem, workspaceProblem } from "./hooks.ts";
import {
	type GitRunner,
	type Listing,
	listCheckout,
	listedSet,
	listingLines,
	packageDirs,
} from "./listing.ts";
import { type ReferenceCheck, type Refusal, references } from "./references.ts";
import { Checkout, type FsOps, fold, type Kind } from "./safe-fs.ts";
import { approvedWorkspace } from "./workspace-policy.ts";

// The input gate: one listing, the kind of every listed path, the tree rules, the references that
// listed files make, the folders that tools scan, the .npmrc paths and the workspace file pnpm
// reads, and the names cmd.exe would run in place of a command, all before anything is built or
// run.

export type GateCheck =
	| "kinds"
	| "tree-rules"
	| "refs-rust"
	| "refs-cargo"
	| "refs-modules"
	| "refs-config"
	| "scan-pnpm"
	| "scan-tsc"
	| "scan-vitest"
	| "scan-cargo"
	| "scan-verify"
	| "scan-prefetch"
	| "npmrc"
	| "command-shadows"
	| "workspace-file";

export const GATE_CHECKS: readonly GateCheck[] = Object.freeze([
	"kinds",
	"tree-rules",
	"refs-rust",
	"refs-cargo",
	"refs-modules",
	"refs-config",
	"scan-pnpm",
	"scan-tsc",
	"scan-vitest",
	"scan-cargo",
	"scan-verify",
	"scan-prefetch",
	"npmrc",
	"command-shadows",
	"workspace-file",
]);

export interface GateOptions {
	readonly root: string;
	readonly names?: boolean;
	readonly env?: NodeJS.ProcessEnv;
	readonly fs?: FsOps;
	readonly git?: GitRunner;
	readonly allowedRoots?: readonly string[];
	readonly allowedDocs?: readonly string[];
}

export interface GateResult {
	readonly ok: boolean;
	// Counts only unless names is set: one check line on a pass; on a refusal, the count lines, then
	// the stop line once.
	readonly lines: readonly string[];
	readonly listing: Listing | null;
	readonly tracked: readonly string[];
}

const TRIPWIRE = "reserved tripwire:";
const UNREAD = "none of them was read";

// Each of the gate's own checks' count line, after the tripwire's.
const COUNTED: Readonly<Record<GateCheck, string>> = {
	kinds: `listed path(s) aren't a regular file in real folders of this checkout (a link, junction, redirect, hard link, folder, special file, or one that couldn't be checked); ${UNREAD}`,
	"tree-rules": "",
	"refs-rust": `file(s) that Rust mod, #[path] or include! declarations name aren't regular, listed files of this checkout, lie outside it or name a reserved word; ${UNREAD}`,
	"refs-cargo": `file(s) or folder(s) that Cargo manifests or .cargo configs name aren't regular, listed files in real folders of this checkout or lie outside it, or a manifest, .cargo config or toolchain file couldn't be parsed or sets a key or form this check doesn't follow; ${UNREAD}`,
	"refs-modules": `file(s) or folder(s) that relative or absolute module specifiers or runner configs name, or the package.json a # specifier resolves through, aren't regular, listed files in real folders of this checkout or lie outside it, or a module names one in a form this check doesn't follow; ${UNREAD}`,
	"refs-config": `file(s) or folder(s) that package.json specs, scripts and imports maps, tsconfig fields, Biome configs' extends and plugins or HTML src and href values name aren't regular, listed files in real folders of this checkout or lie outside it, or a config names one in a form this check doesn't follow; ${UNREAD}`,
	"scan-pnpm": `workspace package folder(s) or manifest(s) that pnpm and turbo read aren't regular, listed files in real folders; ${UNREAD}`,
	"scan-tsc": `file(s) or folder(s) tsc would pick up from a project's include folders aren't regular, listed files in real folders, or a project's include leaves this checkout; ${UNREAD}`,
	"scan-vitest": `file(s) or folder(s) Vitest would pick up from a package folder aren't regular, listed files in real folders; ${UNREAD}`,
	"scan-cargo": `file(s) or folder(s) Cargo or rustup would pick up from a crate's folders aren't regular, listed files in real folders, or a workspace's glob member leaves this checkout; ${UNREAD}`,
	"scan-verify": `step or profile file(s) verify would load aren't regular, listed files in real folders; ${UNREAD}`,
	"scan-prefetch": `spike folder(s) or prefetch script(s) pnpm m0:prefetch would run aren't regular, listed files in real folders; ${UNREAD}`,
	npmrc: `.npmrc path(s) in the root or a package folder; pnpm takes settings from them, node-options among them, before anything it starts; ${UNREAD}`,
	"command-shadows": `entry(ies) in the root or a package folder are named for a command started there (node, pnpm, npm, git or a script's first word) with an extension cmd.exe runs, which it would run from that folder in place of the tool on PATH; ${UNREAD}`,
	"workspace-file":
		"workspace file(s) aren't a listed regular file in the approved form; pnpm takes settings from it, nodeOptions and scriptShell among them, before anything it starts",
};

const WORKSPACE = "pnpm-workspace.yaml";

// The extensions Windows' default PATHEXT names: cmd.exe tries each for a command it looks up in its
// current folder before PATH, unless NoDefaultCurrentDirectoryInExePath is set (libuv, behind
// Node's spawn, looks there for .com and .exe too).
const RUNNABLE = "com exe bat cmd vbs vbe js jse wsf wsh msc cpl".split(" ");
// What a gated route's children start in a folder: Node, the package managers and git.
const STARTED = ["node", "pnpm", "pnpx", "npm", "npx", "corepack", "git"];
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The first word of each command a package.json's scripts run, in lower case: each script split at
// &&, ||, ;, |, &, parentheses, backticks and line ends, past leading NAME=value assignments, with
// quotes dropped. A word that holds a separator is a path, which no folder lookup finds.
export function scriptCommands(text: string): string[] {
	const json = parseJson(text);
	const words = new Set<string>();
	for (const [field, scripts] of isObject(json) ? json.object : []) {
		if (field !== "scripts" || !isObject(scripts)) continue;
		for (const [, script] of scripts.object) {
			if (typeof script !== "string") continue;
			for (const command of script.split(/&&|\|\||[;&|()`\r\n]/)) {
				const word = command
					.trim()
					.split(/\s+/)
					.map((part) => part.replace(/^["']+|["']+$/g, ""))
					.find((part) => part !== "" && !ASSIGNMENT.test(part));
				if (word !== undefined && !/[\\/]/.test(word)) words.add(word.toLowerCase());
			}
		}
	}
	return [...words];
}

// The entry names cmd.exe would run for a command word from its current folder: the word with each
// extension, and the word itself when it ends in one.
const shadowNames = (word: string): string[] => [
	...RUNNABLE.map((extension) => `${word}.${extension}`),
	...(RUNNABLE.some((extension) => word.endsWith(`.${extension}`)) ? [word] : []),
];

// A refused path and why: a kind, or the workspace file's problem.
interface Refused {
	readonly rel: string;
	readonly kind: Refusal["kind"] | WorkspaceProblem;
}

const ancestors = (rel: string): string[] => {
	const parts = rel.split("/");
	return parts.slice(0, -1).map((_, end) => parts.slice(0, end + 1).join("/"));
};

// gateWith(GATE_CHECKS, options).
export function runGate(options: GateOptions): Promise<GateResult> {
	return gateWith(GATE_CHECKS, options);
}

// The gate with only `checks`, for the mutation tests. In order: one listing (its problems stop
// everything); the kind of every listed path, before any read (a missing one is counted and never
// read); the tree rules, reading only regular, ordinary, listed files; the references; the scans;
// the .npmrc paths; the command shadows; the workspace file.
export async function gateWith(
	checks: readonly GateCheck[],
	options: GateOptions,
): Promise<GateResult> {
	const names = options.names === true;
	const enabled = new Set(checks);
	const listed = await listCheckout(options.root, {
		...(options.env === undefined ? {} : { env: options.env }),
		...(options.git === undefined ? {} : { git: options.git }),
	});
	const listing = listed.listing;
	if (listing === null) {
		return {
			ok: false,
			lines: [...listingLines(listed.problems, names), STOP_LINE],
			listing: null,
			tracked: [],
		};
	}
	const allowedRoots = options.allowedRoots ?? ALLOWED_ROOTS;
	const allowedDocs = options.allowedDocs ?? ALLOWED_DOCS;
	const checkout = new Checkout(listing.root, options.fs, { allowedRoots });
	const tracked = [...new Set(listing.entries.map((entry) => entry.path))];
	const known = new Set(tracked);
	const paths = [...tracked, ...new Set(listing.untracked.filter((file) => !known.has(file)))];

	// Every listed path's kind first, and the folders on its way.
	const kinds = new Map<string, Kind>();
	const folders = new Set<string>();
	const refused = new Map<GateCheck, readonly Refused[]>();
	const kindRefusals: Refusal[] = [];
	for (const rel of paths) {
		const kind = checkout.kindOf(rel);
		kinds.set(rel, kind);
		for (const folder of ancestors(rel)) folders.add(folder);
		if (kind !== "file" && kind !== "missing") kindRefusals.push({ rel, kind });
	}
	if (enabled.has("kinds")) refused.set("kinds", kindRefusals);

	// Reads: only listed regular files, each once, and never one in an allowed root or reserved-named
	// (Checkout refuses those too). A missing file reads as absent.
	const folded = listedSet(listing);
	const isListed = (rel: string): boolean => folded.has(fold(rel));
	const texts = new Map<string, string | "unreadable" | "absent">();
	const reserved = (rel: string): boolean =>
		reservedWord.test(rel) || allowedRoots.some((root) => fold(`${rel}/`).startsWith(fold(root)));
	const read = (rel: string): string | "unreadable" | "absent" => {
		const done = texts.get(rel);
		if (done !== undefined) return done;
		const kind = kinds.get(rel) ?? "missing";
		let text: string | "unreadable" | "absent";
		if (kind === "missing" || !kinds.has(rel)) text = "absent";
		else if (kind !== "file") text = enabled.has("kinds") ? "absent" : checkout.readText(rel);
		else text = checkout.readText(rel);
		texts.set(rel, text);
		return text;
	};
	const text = (rel: string): string | null => {
		if (!isListed(rel) || reserved(rel)) return null;
		const got = read(rel);
		return got === "unreadable" || got === "absent" ? null : got;
	};

	const problems = enabled.has("tree-rules")
		? tripwire({
				entries: listing.entries,
				untracked: listing.untracked,
				text: read,
				allowedRoots,
				allowedDocs,
			})
		: null;

	const files = paths.filter((rel) => kinds.get(rel) === "file" && !reserved(rel));
	const indexed = new Set(tracked.map((rel) => fold(rel)));
	const isTracked = (rel: string): boolean => indexed.has(fold(rel));
	const input = { checkout, listed: isListed, tracked: isTracked, files, text, allowedRoots };
	let packages: ReturnType<typeof packageDirs> | undefined;
	const packagesOf = (): ReturnType<typeof packageDirs> =>
		(packages ??= packageDirs(checkout, listing));
	for (const check of ["refs-rust", "refs-cargo", "refs-modules", "refs-config"] as const) {
		if (enabled.has(check)) refused.set(check, references(check as ReferenceCheck, input).refused);
	}
	const scans: readonly ScanCheck[] = [
		"scan-pnpm",
		"scan-tsc",
		"scan-vitest",
		"scan-cargo",
		"scan-verify",
		"scan-prefetch",
	];
	if (scans.some((check) => enabled.has(check))) {
		const scanInput = {
			...input,
			allowedRoots,
			packages: packagesOf(),
			walks: new Walks(checkout, allowedRoots),
		};
		for (const check of scans) {
			if (!enabled.has(check)) continue;
			const result = scan(check, scanInput);
			refused.set(check, [...result.refused]);
			for (const folder of result.folders) if (folder !== "") folders.add(folder);
		}
	}

	// An .npmrc of any kind in the root or a package folder, by name and kind alone, as the pre-install
	// check refuses it: the children of a gated entry start pnpm, which would take its settings.
	if (enabled.has("npmrc")) {
		const dirs = new Set(packagesOf().dirs.filter((dir) => dir !== ""));
		const found: Refusal[] = [];
		for (const rel of [".npmrc", ...[...dirs].map((dir) => `${dir}/.npmrc`)]) {
			const kind = checkout.kindOf(rel);
			if (kind !== "missing") found.push({ rel, kind });
		}
		refused.set("npmrc", found);
	}

	// An entry of any kind in the root or a package folder, tracked or not, named for a command
	// started there with an extension cmd.exe runs: pnpm and npm run scripts through cmd.exe on
	// Windows, which would run it in place of the tool. By names and kinds alone, and in any case;
	// only each folder's own package.json is read, for its scripts' first words.
	if (enabled.has("command-shadows")) {
		const found: Refusal[] = [];
		for (const dir of new Set(["", ...packagesOf().dirs])) {
			const own = text(dir === "" ? "package.json" : `${dir}/package.json`);
			const names = new Set(
				[...STARTED, ...(own === null ? [] : scriptCommands(own))].flatMap(shadowNames),
			);
			checkout.walk(dir, (rel, kind) => {
				const name = rel.slice(rel.lastIndexOf("/") + 1).toLowerCase();
				if (names.has(name)) found.push({ rel, kind });
				return false;
			});
		}
		refused.set("command-shadows", found);
	}

	// The workspace file by hooks.ts's rule, the pre-install check's own: the children of a gated
	// entry start pnpm, which would take its settings.
	if (enabled.has("workspace-file")) {
		const problem = workspaceProblem(checkout, listing, approvedWorkspace);
		refused.set("workspace-file", problem === null ? [] : [{ rel: WORKSPACE, kind: problem }]);
	}

	const tripLines =
		problems === null ? [] : tripwireLines(problems, names).filter((line) => line !== STOP_LINE);
	const own: string[] = [];
	for (const check of GATE_CHECKS) {
		const items = refused.get(check) ?? [];
		if (items.length === 0) continue;
		const line = `${TRIPWIRE} ${items.length} ${COUNTED[check]}`;
		own.push(
			names ? `${line}: ${items.map(({ rel, kind }) => `${rel} (${kind})`).join(", ")}` : line,
		);
	}
	if (tripLines.length + own.length > 0) {
		return { ok: false, lines: [...tripLines, ...own, STOP_LINE], listing, tracked };
	}
	const checked = problems?.checked ?? { paths: 0, untracked: 0, cargo: 0, rust: 0, modules: 0 };
	return {
		ok: true,
		lines: [checkLine({ ...checked, folders: folders.size })],
		listing,
		tracked,
	};
}

// Set for an entry's children, to the listing's root, only after a passing gate (lib/bootstrap.ts
// holds it, for the entries that never load this file).
export { GATE_ROOT_ENV } from "./bootstrap.ts";
