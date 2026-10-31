import type { Listing } from "./listing.ts";
import type { Checkout, Kind } from "./safe-fs.ts";

// The script names pnpm runs on its own, shared by the proof (the wiring rule of reserved-only
// packages), the inputs the pre-install check (tools/verify/preinstall.ts) checks before an install
// can run any of them, and the workspace file's rule, which the input gate applies too. This file
// loads nothing at runtime, so the entries that load it after their start checks load no file beyond
// their checked sets.

// Scripts pnpm runs unasked: around install and prepare, before or after another script, and its
// own pnpm: hooks.
export const INSTALL_HOOKS: readonly string[] = Object.freeze([
	"preinstall",
	"install",
	"postinstall",
	"preprepare",
	"prepare",
	"postprepare",
	"dependencies",
]);

export function hookKey(key: string): boolean {
	return INSTALL_HOOKS.includes(key) || /^(?:pre|post)/.test(key) || key.startsWith("pnpm:");
}

// The scripts an install runs in an ordinary package: the install and prepare hooks and pnpm:
// hooks. A pre or post script runs only with the script it belongs to, so ordinary names such as
// preview and postcss pass.
export function ordinaryHookKey(key: string): boolean {
	return INSTALL_HOOKS.includes(key) || key.startsWith("pnpm:");
}

// The only script names the allowed root's manifest may hold, none of them a hook.
export const ALLOWED_ROOT_SCRIPTS: readonly string[] = Object.freeze([
	"typecheck",
	"test",
	"test:heavy",
	"test:live",
	"test:device",
]);

export type InstallRule =
	| "workspace-file"
	| "no-npmrc"
	| "no-pnpmfile"
	| "no-binding-gyp"
	| "manifests"
	| "no-pnpm-field"
	| "ordinary-hooks"
	| "allowed-root-scripts";

// Every rule, in the order their lines print.
export const INSTALL_RULES: readonly InstallRule[] = Object.freeze([
	"workspace-file",
	"no-npmrc",
	"no-pnpmfile",
	"no-binding-gyp",
	"manifests",
	"no-pnpm-field",
	"ordinary-hooks",
	"allowed-root-scripts",
]);

export interface InstallDeps {
	// The workspace's package folders, and the <parent>/* children refused as package folders.
	readonly packageDirs: (
		checkout: Checkout,
		listing: Listing,
	) => {
		readonly dirs: readonly string[];
		readonly refused: readonly { rel: string; kind: Kind | "unlisted" }[];
	};
	// lib/workspace-policy.ts's approved workspace grammar, passed in so this file loads nothing.
	readonly approvedWorkspace: (text: string) => boolean;
}

const SAY = "pre-install check:";
export const INSTALL_STOP_LINE: string = `${SAY} stopped before anything was installed; don't run the install, send this log's path to the reserved files' maintainer`;

const WORKSPACE = "pnpm-workspace.yaml";
const MANIFEST = "package.json";
const PNPMFILES: readonly string[] = [".pnpmfile.cjs", ".pnpmfile.mjs"];
const REGULAR = new Set(["100644", "100755"]);

// Each rule's count line: `count` things found, in `files` manifests.
const COUNTED: Readonly<Record<InstallRule, (count: number, files: number) => string>> = {
	"workspace-file": () => "the workspace file isn't a listed regular file in the approved form",
	"no-npmrc": (count) =>
		`${count} .npmrc path(s) in the root or a package folder; pnpm reads its settings from them`,
	"no-pnpmfile": (count) =>
		`${count} .pnpmfile.cjs or .pnpmfile.mjs path(s) in the root; pnpm runs them during an install`,
	"no-binding-gyp": (count) =>
		`${count} binding.gyp path(s) in the root or a package folder; an install builds them`,
	manifests: (count) =>
		`${count} manifest(s) or package folder(s) aren't listed regular files whose script names can be read`,
	"no-pnpm-field": () =>
		"the root manifest has a pnpm field, whose settings can change what an install runs",
	"ordinary-hooks": (count, files) => `${count} install hook script(s) in ${files} manifest(s)`,
	"allowed-root-scripts": (count, files) =>
		`${count} script name(s) in ${files} allowed root manifest(s) are install hooks or not on the allowed list`,
};

// Why the workspace file fails its rule: its kind, "unlisted", or "unapproved" for a text outside the
// approved form.
export type WorkspaceProblem = Kind | "unlisted" | "unapproved";

// The workspace file's rule, which the input gate and the pre-install check both apply: pnpm takes
// settings from it, nodeOptions and scriptShell among them, for everything it starts, so it must be
// a listed regular file whose text `approved` accepts. Only such a file is read. null when it
// passes.
export function workspaceProblem(
	checkout: Checkout,
	listing: Listing,
	approved: (text: string) => boolean,
): WorkspaceProblem | null {
	const kind = checkout.kindOf(WORKSPACE);
	if (kind !== "file") return kind;
	const listed =
		listing.untracked.includes(WORKSPACE) ||
		listing.entries.some((entry) => entry.path === WORKSPACE && REGULAR.has(entry.mode));
	if (!listed) return "unlisted";
	const text = checkout.readText(WORKSPACE);
	if (text === "unreadable") return "unreadable";
	return approved(text) ? null : "unapproved";
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

interface Manifest {
	// "allowed" for an allowed root's own manifest: readText refuses it without opening it, and only
	// openAllowedManifest reads it.
	readonly via: "ordinary" | "allowed";
	readonly scripts: readonly string[];
	readonly pnpm: boolean;
}

// A listed manifest's script names, and whether it has a pnpm field; null unless it reads as a JSON
// object whose scripts, if it has any, are one. Script values are never looked at.
function readManifest(checkout: Checkout, rel: string): Manifest | null {
	let via: Manifest["via"] = "ordinary";
	let text = checkout.readText(rel);
	if (text === "unreadable") {
		via = "allowed";
		text = checkout.openAllowedManifest(rel);
	}
	if (text === "unreadable") return null;
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isRecord(value)) return null;
	const scripts = value.scripts === undefined ? {} : value.scripts;
	if (!isRecord(scripts)) return null;
	return { via, scripts: Object.keys(scripts), pnpm: Object.hasOwn(value, "pnpm") };
}

interface Found {
	count: number;
	readonly items: string[];
}

// What an install reads or runs before any package code is checked: the workspace file, .npmrc, the
// pnpmfile, binding.gyp and the manifests' script names. Names and kinds come from the Checkout;
// only listed regular files are read, and the allowed root's manifest only through
// openAllowedManifest. Lines are counts only; names adds paths and ordinary hook names, never the
// allowed root's script names.
export function checkInstallInputs(
	input: {
		readonly checkout: Checkout;
		readonly listing: Listing;
		readonly names?: boolean;
		readonly rules?: readonly InstallRule[];
	},
	deps: InstallDeps,
): { readonly ok: boolean; readonly lines: readonly string[] } {
	const { checkout, listing } = input;
	const rules = new Set(input.rules ?? INSTALL_RULES);
	const listed = new Set([
		...listing.entries.filter((entry) => REGULAR.has(entry.mode)).map((entry) => entry.path),
		...listing.untracked,
	]);
	const plain = (rel: string): boolean => listed.has(rel) && checkout.kindOf(rel) === "file";
	const found = new Map<InstallRule, Found>(
		INSTALL_RULES.map((rule) => [rule, { count: 0, items: [] }]),
	);
	const add = (rule: InstallRule, item: string, count = 1): void => {
		const entry = found.get(rule);
		if (entry === undefined || !rules.has(rule)) return;
		entry.count += count;
		entry.items.push(item);
	};
	const at = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

	let packages: ReturnType<InstallDeps["packageDirs"]> | null;
	try {
		packages = deps.packageDirs(checkout, listing);
	} catch {
		packages = null;
	}
	const dirs = [...new Set(packages?.dirs ?? [])].filter((dir) => dir !== "").toSorted();
	const folders = ["", ...dirs];

	if (rules.has("workspace-file")) {
		if (workspaceProblem(checkout, listing, deps.approvedWorkspace) !== null) {
			add("workspace-file", WORKSPACE);
		}
	}
	// By name and kind only: anything there but a missing path is refused.
	const present = (rule: InstallRule, name: string, places: readonly string[]): void => {
		if (!rules.has(rule)) return;
		for (const rel of places.map((dir) => at(dir, name))) {
			if (checkout.kindOf(rel) !== "missing") add(rule, rel);
		}
	};
	present("no-npmrc", ".npmrc", folders);
	for (const name of PNPMFILES) present("no-pnpmfile", name, [""]);
	present("no-binding-gyp", "binding.gyp", folders);

	if (packages === null) add("manifests", `the package folders of ${WORKSPACE}`);
	for (const { rel } of packages?.refused ?? []) add("manifests", rel);
	const manifests = folders.map((dir) => at(dir, MANIFEST));
	for (const rel of manifests) {
		const manifest = plain(rel) ? readManifest(checkout, rel) : null;
		if (manifest === null) {
			add("manifests", rel);
			continue;
		}
		if (manifest.via === "allowed") {
			const refused = manifest.scripts.filter(
				(key) => hookKey(key) || !ALLOWED_ROOT_SCRIPTS.includes(key),
			);
			if (refused.length > 0) add("allowed-root-scripts", rel, refused.length);
			continue;
		}
		if (rel === MANIFEST && manifest.pnpm) add("no-pnpm-field", rel);
		const hooks = manifest.scripts.filter(ordinaryHookKey);
		if (hooks.length > 0) add("ordinary-hooks", `${rel} (${hooks.join(", ")})`, hooks.length);
	}

	const lines: string[] = [];
	for (const rule of INSTALL_RULES) {
		const { count, items } = found.get(rule) ?? { count: 0, items: [] };
		if (items.length === 0) continue;
		const line = `${SAY} ${COUNTED[rule](count, items.length)}`;
		lines.push(input.names === true ? `${line}: ${items.join(", ")}` : line);
	}
	if (lines.length > 0) return { ok: false, lines: [...lines, INSTALL_STOP_LINE] };
	return {
		ok: true,
		lines: [
			`${SAY} ${manifests.length} manifest(s) and the workspace file checked; no install hook found`,
		],
	};
}
