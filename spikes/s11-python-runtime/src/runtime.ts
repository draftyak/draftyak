// The runtime dir a python plugin runs from (plan §4 Python runtime): Pyodide's core files, ws under
// node_modules/ (Pyodide imports it as a bare specifier) and the shim bundle. The hub copies it
// link-free before spawning and re-hashes the copy against the hash list (runtime.lock.json's files,
// the shim included): any missing, extra, changed or linked file refuses the spawn. Imports only
// node: built-ins, so it also runs inside containers.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SHIM = "shim.mjs";
const WS_PREFIX = "node_modules/ws/";

export interface RuntimeSources {
	// The installed pyodide and ws packages (realpaths) and the built shim bundle.
	readonly pyodideDir: string;
	readonly wsDir: string;
	readonly shim: string;
}

export interface RuntimeFinding {
	readonly path: string;
	readonly kind:
		| "missing"
		| "extra"
		| "modified"
		| "symlink"
		| "hardlink"
		| "irregular"
		| "unreadable";
}

export class RuntimeRefusedError extends Error {
	override name = "RuntimeRefusedError";
	readonly code = "DY_REFUSED_SPAWN";
	readonly finding: RuntimeFinding;
	constructor(finding: RuntimeFinding) {
		super(`refusing to spawn: ${finding.kind} runtime file (${finding.path})`);
		this.finding = finding;
	}
}

export function sha256File(file: string): string {
	return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Relative paths in the hash list are POSIX, inside the dir, and never hidden or parent segments.
function segments(rel: string): string[] {
	const parts = rel.split("/");
	if (parts.some((part) => part === "" || part.startsWith(".") || /[\\:*?"<>|]/.test(part))) {
		throw new Error(`not a runtime path: ${JSON.stringify(rel)}`);
	}
	return parts;
}

export function sourceOf(rel: string, sources: RuntimeSources): string {
	if (rel === SHIM) return sources.shim;
	if (rel.startsWith(WS_PREFIX)) {
		return path.join(sources.wsDir, ...segments(rel.slice(WS_PREFIX.length)));
	}
	return path.join(sources.pyodideDir, ...segments(rel));
}

// A fresh link-free copy: copyFile writes new files, so nothing in the copy is a link to the
// package store, and target must not exist yet.
export function copyRuntime(
	target: string,
	expected: Readonly<Record<string, string>>,
	sources: RuntimeSources,
): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.mkdirSync(target);
	for (const rel of Object.keys(expected).toSorted()) {
		const to = path.join(target, ...segments(rel));
		fs.mkdirSync(path.dirname(to), { recursive: true });
		fs.copyFileSync(sourceOf(rel, sources), to, fs.constants.COPYFILE_EXCL);
	}
}

const fold = (p: string): string => (process.platform === "win32" ? p.toLowerCase() : p);

// Walks the copy without following links and compares it with the hash list. Fails closed: the root
// must be a real directory that is its own realpath, and anything unlistable or unusual refuses.
export function verifyRuntime(
	dir: string,
	expected: Readonly<Record<string, string>>,
): RuntimeFinding | null {
	const root = path.resolve(dir);
	try {
		const stats = fs.lstatSync(root);
		if (stats.isSymbolicLink()) return { path: root, kind: "symlink" };
		if (!stats.isDirectory()) return { path: root, kind: "irregular" };
		if (fold(fs.realpathSync(root)) !== fold(root)) return { path: root, kind: "symlink" };
	} catch {
		return { path: root, kind: "unreadable" };
	}
	const seen = new Set<string>();
	const stack = [""];
	while (stack.length > 0) {
		const rel = stack.pop() as string;
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
		} catch {
			return { path: rel || ".", kind: "unreadable" };
		}
		for (const entry of entries) {
			const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
			if (entry.isSymbolicLink()) return { path: child, kind: "symlink" };
			if (entry.isDirectory()) {
				stack.push(child);
				continue;
			}
			if (!entry.isFile()) return { path: child, kind: "irregular" };
			const want = expected[child];
			if (want === undefined) return { path: child, kind: "extra" };
			const full = path.join(root, child);
			const stats = fs.lstatSync(full, { throwIfNoEntry: false });
			if (stats === undefined) return { path: child, kind: "unreadable" };
			if (stats.nlink > 1) return { path: child, kind: "hardlink" };
			if (sha256File(full) !== want) return { path: child, kind: "modified" };
			seen.add(child);
		}
	}
	const missing = Object.keys(expected).find((rel) => !seen.has(rel));
	return missing === undefined ? null : { path: missing, kind: "missing" };
}
