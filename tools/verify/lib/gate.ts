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
	"refs-config": `file(s) or folder(s) that package.json specs, scripts, entry points and imports maps (a subpath pattern's matches among them, which must be in the index), tsconfig fields, Biome configs' extends and plugins or HTML src and href values name aren't regular, listed files in real folders of this checkout or lie outside it, or a config names one in a form this check doesn't follow; ${UNREAD}`,
	"scan-pnpm": `workspace package folder(s) or manifest(s) that pnpm and turbo read aren't regular, listed files in real folders; ${UNREAD}`,
	"scan-tsc": `file(s) or folder(s) tsc would pick up from a project's include folders aren't regular, listed files in real folders, or a project's include leaves this checkout; ${UNREAD}`,
	"scan-vitest": `file(s) or folder(s) Vitest would pick up from a package folder aren't regular, listed files in real folders; ${UNREAD}`,
	"scan-cargo": `file(s) or folder(s) Cargo or rustup would pick up from a crate's folders aren't regular, listed files in real folders, or a workspace's glob member leaves this checkout; ${UNREAD}`,
	"scan-verify": `step or profile file(s) verify would load aren't regular, listed files in real folders; ${UNREAD}`,
	"scan-prefetch": `spike folder(s) or prefetch script(s) pnpm m0:prefetch would run aren't regular, listed files in real folders; ${UNREAD}`,
	npmrc: `.npmrc path(s) in the root or a package folder; pnpm takes settings from them, node-options among them, before anything it starts; ${UNREAD}`,
	"command-shadows": `entry(ies) in the root or a package folder are named for a command started there (node, pnpm, npm, git or a script's first word) with an extension cmd.exe runs, which it would run from that folder in place of the tool on PATH, or are a package.json whose script starts a command by a path, which cmd.exe looks up there too, or holds a %, which cmd.exe expands before it splits the line, or a ^ outside double quotes, which cmd.exe uses up before it parses each side of a pipe again; ${UNREAD}`,
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
// A command word cmd.exe looks up by a path: one that holds a separator, or one from a drive's own
// working folder (C:x), which on the checkout's drive is the package folder pnpm runs it in.
const PATH_WORD = /[\\/]|^[A-Za-z]:/;

// Where a script's commands end in the split that ignores quoting: &&, ||, ;, |, & (but a
// redirection's >& or <&), parentheses, backticks and line ends.
const COMMAND_END = /&&|\|\||(?<![<>])&|[;|()`\r\n]/;
// The marks among those that end a command in cmd.exe's own split, outside double quotes and not
// after a caret.
const MARKS = "&|;()`";
// What ends a command's first word outside double quotes, besides a blank.
const WORD_END = "<>,;=";
// A redirection before a command: [n]>, [n]>> or <, with its target or before it.
const REDIRECTION = /^\d?(?:>>?|<)/;
const BARE_REDIRECTION = /^\d?(?:>>?|<)$/;

// A script split into commands as cmd.exe splits it when pnpm runs it (cmd /d /s /c <script>). It
// drops every carriage return, and with `strip`, the first " and the last, as /s does when only
// blanks come before the first. Then each " toggles quoting, a caret outside quotes takes the next
// character as it is, and a mark (MARKS) ends a command only outside both, an & right after a
// redirection's < or > aside. cmd.exe runs nothing after a line feed; here one ends the command and
// any quote, which gives more commands.
function cmdCommands(script: string, strip: boolean): string[] {
	const dropped = script.replaceAll("\r", "");
	const text = strip ? slashS(dropped) : dropped;
	const commands: string[] = [];
	let command = "";
	let quoted = false;
	let redirect = false;
	for (let at = 0; at < text.length; at++) {
		const char = text.charAt(at);
		const next = text.charAt(at + 1);
		if (char === "\n") {
			commands.push(command);
			command = "";
			quoted = false;
			redirect = false;
		} else if (quoted) {
			quoted = char !== '"';
			command += char;
		} else if (char === "^" && next !== "" && next !== "\n") {
			command += `${char}${next}`;
			at++;
			redirect = false;
		} else if (MARKS.includes(char) && !(char === "&" && redirect)) {
			commands.push(command);
			command = "";
			redirect = false;
		} else {
			quoted = char === '"';
			redirect = char === "<" || char === ">";
			command += char;
		}
	}
	commands.push(command);
	return commands;
}

// A script as /s leaves it: without its first " and its last, or its only one.
function slashS(text: string): string {
	const first = text.indexOf('"');
	const last = text.lastIndexOf('"');
	if (first === -1) return text;
	return last > first
		? `${text.slice(0, first)}${text.slice(first + 1, last)}${text.slice(last + 1)}`
		: `${text.slice(0, first)}${text.slice(first + 1)}`;
}

// Whether cmd.exe's /s could drop a script's first " and its last: only blanks, line ends and other
// controls come before the first.
function leadingQuote(script: string): boolean {
	for (const char of script) {
		if (char === '"') return true;
		const code = char.codePointAt(0) ?? 0;
		if (!(code <= 0x20 || (code >= 0x7f && code <= 0xa0) || /\s/u.test(char))) return false;
	}
	return false;
}

// A command's tokens as cmd.exe groups them, at blanks outside double quotes, each past a leading
// comma, ; or =: its text, and the words its name could be. A word ends at the first <, >, comma, ;
// or = outside quotes and drops each ". Outside quotes, a caret takes the next character as it is
// (a last one is dropped), and a blank or one of those marks it takes also ends a word, as cmd.exe
// ends a name at an escaped blank: each piece between them counts too.
function cmdTokens(command: string): { readonly raw: string; readonly words: string[] }[] {
	const tokens: { readonly raw: string; readonly words: string[] }[] = [];
	let raw = "";
	let words: string[] = [];
	let piece = "";
	let full: string | undefined = "";
	let quoted = false;
	const close = (): void => {
		if (raw !== "")
			tokens.push({ raw, words: full === undefined ? words : [...words, piece, full] });
		raw = "";
		words = [];
		piece = "";
		full = "";
	};
	const add = (char: string): void => {
		if (full === undefined) return;
		piece += char;
		full += char;
	};
	for (let at = 0; at < command.length; at++) {
		const char = command.charAt(at);
		if (!quoted && /\s/u.test(char)) {
			close();
		} else if (raw === "" && ",;=".includes(char)) {
			// cmd.exe reads a leading comma, ; or = as a blank.
		} else if (char === '"') {
			raw += char;
			quoted = !quoted;
		} else if (quoted) {
			raw += char;
			add(char);
		} else if (char === "^") {
			if (at + 1 >= command.length) continue;
			const next = command.charAt(++at);
			raw += `${char}${next}`;
			if (full !== undefined && (/\s/u.test(next) || WORD_END.includes(next))) {
				words.push(piece);
				piece = "";
			}
			if (next !== '"') add(next);
		} else if (WORD_END.includes(char)) {
			raw += char;
			if (full !== undefined) words.push(piece, full);
			full = undefined;
		} else {
			raw += char;
			add(char);
		}
	}
	close();
	return tokens;
}

// The names cmd.exe could look a command up by, in lower case, each again without single quotes,
// which cmd.exe keeps in a name: past leading blanks and @, NAME=value assignments and redirections
// (>x, >> x, 2>x, <x), the first token's words (cmdTokens).
function firstWords(command: string): string[] {
	const tokens = cmdTokens(command.replace(/^[\s@]+/u, ""));
	for (let at = 0; at < tokens.length; at++) {
		const { raw, words } = tokens[at] ?? { raw: "", words: [] };
		if (ASSIGNMENT.test(raw)) continue;
		if (REDIRECTION.test(raw)) {
			if (BARE_REDIRECTION.test(raw)) at++;
			continue;
		}
		const found = words.map((word) => word.trim().toLowerCase()).filter((word) => word !== "");
		if (found.length === 0) continue;
		const both = found.flatMap((word) => [word, word.replaceAll("'", "")]);
		return [...new Set(both.filter((word) => word !== ""))];
	}
	return [];
}

// The scripts of a package.json, each as written.
function scriptsOf(text: string): string[] {
	const json = parseJson(text);
	const found: string[] = [];
	for (const [field, scripts] of isObject(json) ? json.object : []) {
		if (field !== "scripts" || !isObject(scripts)) continue;
		for (const [, script] of scripts.object) if (typeof script === "string") found.push(script);
	}
	return found;
}

// The names each command a package.json's scripts start could be looked up by, in lower case
// (firstWords). A word that starts by a path is kept as it is: cmd.exe still looks one up from the
// folder (the part before a / as a command, a \ path or a drive's working folder with each
// extension), so the gate refuses a script that starts a command so. Without `quoting`, each script
// is split at COMMAND_END wherever it stands, which gives more words to look for. With it, each is
// split as cmd.exe splits it (cmdCommands), and again with /s's quotes dropped when it may start
// with one: the words a path refusal goes by.
export function scriptCommands(text: string, quoting = false): string[] {
	const words = new Set<string>();
	for (const script of scriptsOf(text)) {
		const commands = quoting
			? [...cmdCommands(script, false), ...(leadingQuote(script) ? cmdCommands(script, true) : [])]
			: script.split(COMMAND_END);
		for (const command of commands) for (const word of firstWords(command)) words.add(word);
	}
	return [...words];
}

// Whether a package.json's script holds a %: cmd.exe expands %name% before it splits the line,
// from the environment pnpm gives a script, the manifest's config among it.
export function scriptsExpand(text: string): boolean {
	return scriptsOf(text).some((script) => script.includes("%"));
}

// Whether a package.json's script holds a caret outside double quotes, as cmd.exe reads it (a line
// feed ends any quote) or as /s leaves it. The first parse uses the caret up, and cmd.exe parses
// each side of a pipe again, where the & or | it took ends a command.
export function scriptsEscape(text: string): boolean {
	const outside = (reading: string): boolean => {
		let quoted = false;
		for (const char of reading) {
			if (char === "\n") quoted = false;
			else if (char === '"') quoted = !quoted;
			else if (char === "^" && !quoted) return true;
		}
		return false;
	};
	return scriptsOf(text).some(
		(script) => outside(script) || (leadingQuote(script) && outside(slashS(script))),
	);
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
	// only each folder's own package.json is read, for its scripts' first words. A package.json
	// whose script starts a command by a path, as cmd.exe splits it, is refused as unsupported:
	// cmd.exe looks that up from the folder too, in ways no name here covers. So is one whose script
	// holds a %, which cmd.exe expands before it splits the line, or a caret outside double quotes,
	// which its first parse uses up before it parses each side of a pipe again.
	if (enabled.has("command-shadows")) {
		const found: Refusal[] = [];
		for (const dir of new Set(["", ...packagesOf().dirs])) {
			const manifest = dir === "" ? "package.json" : `${dir}/package.json`;
			const own = text(manifest);
			const words = own === null ? [] : scriptCommands(own);
			const byPath = (word: string): boolean => PATH_WORD.test(word);
			const started = own === null ? [] : scriptCommands(own, true);
			if (started.some(byPath) || (own !== null && (scriptsExpand(own) || scriptsEscape(own)))) {
				found.push({ rel: manifest, kind: "unsupported" });
			}
			const names = new Set(
				[...STARTED, ...words, ...started].filter((word) => !byPath(word)).flatMap(shadowNames),
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
