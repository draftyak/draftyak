import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installedCatalog } from "./catalog.ts";
import { CliRefusal } from "./refusal.ts";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const MODULE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const MAX_FILES = 1024;
const MAX_BYTES = 2 * 1024 * 1024;

export function moduleName(value: string): boolean {
	return value.length <= 64 && MODULE_NAME.test(value);
}

// Unlike the JS implementation, native realpath follows volume-path junctions.
function unlinked(filename: string): void {
	if (realpathSync.native(filename) !== filename) throw new CliRefusal();
}

function regular(filename: string): void {
	const stat = lstatSync(filename);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new CliRefusal();
	unlinked(filename);
}

function directory(filename: string): void {
	const stat = lstatSync(filename);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CliRefusal();
	unlinked(filename);
}

// An 8.3 alias may name another entry that lstat reports as a folder but that resolves to the
// same folder. Buffer names also reach entries whose names are not well-formed Unicode.
function linkedSibling(parent: string, resolved: string): boolean {
	const found = Buffer.from(path.basename(resolved));
	const prefix = Buffer.from(path.join(parent, path.sep));
	return readdirSync(parent, { encoding: "buffer" }).some((name) => {
		if (name.equals(found)) return false;
		const sibling = Buffer.concat([prefix, name]);
		try {
			return !lstatSync(sibling).isSymbolicLink() && realpathSync.native(sibling) === resolved;
		} catch {
			return false;
		}
	});
}

// macOS returns the stored name, which may differ from the loaded one in Unicode normalization.
function fold(name: string): string {
	return name.normalize("NFC").toUpperCase();
}

function sameName(loaded: string, resolved: string, parent: string): boolean {
	const found = path.basename(resolved);
	if (loaded === found) return true;
	const listed = readdirSync(parent).filter((entry) => fold(entry) === fold(loaded));
	if (listed.length > 0) return listed.every((entry) => entry === found);
	// A genuine 8.3 alias is not a directory entry; a link merely named CLI~1 is.
	return /~[0-9]/.test(loaded) && !linkedSibling(parent, resolved);
}

// UNC and device paths; a mapped network drive resolves to a UNC path.
function network(name: string): boolean {
	return /^[\\/]{2}/.test(name);
}

// Resolve each ancestor without treating case and genuine short-name spellings as links. Network
// paths are refused first, so nothing on them is listed or imported.
function canonicalRoot(folder = path.resolve(ROOT)): string {
	if (network(folder)) throw new CliRefusal();
	const resolved = realpathSync.native(folder);
	if (network(resolved)) throw new CliRefusal();
	const parent = path.dirname(folder);
	if (parent === folder) return resolved;
	const stat = lstatSync(folder);
	const resolvedParent = canonicalRoot(parent);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		path.dirname(resolved) !== resolvedParent ||
		!sameName(path.basename(folder), resolved, resolvedParent)
	)
		throw new CliRefusal();
	return resolved;
}

function checked<T>(check: () => T): T {
	try {
		return check();
	} catch {
		throw new CliRefusal();
	}
}

function discover(relative: "commands" | "doctor/checks"): readonly string[] {
	const parent = path.join(canonicalRoot(), relative);
	directory(parent);
	const extension = path.extname(fileURLToPath(import.meta.url));
	const files = readdirSync(parent).filter((file) => file !== ".gitkeep");
	if (files.length > 256) throw new CliRefusal();
	const names: string[] = [];
	for (const file of files.sort()) {
		if (!file.endsWith(extension)) throw new CliRefusal();
		const name = file.slice(0, -extension.length);
		if (!moduleName(name)) throw new CliRefusal();
		regular(path.join(parent, file));
		names.push(`${relative}/${file}`);
	}
	return Object.freeze(names);
}

export function verifyInstalled(): void {
	if (!installedCatalog) return;
	checked(() => verifyCatalog());
}

function verifyCatalog(): void {
	if (!installedCatalog) return;
	const root = canonicalRoot();
	const files: string[] = [];
	const directories: string[] = [];
	function visit(relative: string): void {
		const folder = path.join(root, relative);
		directory(folder);
		for (const name of readdirSync(folder).sort()) {
			const child = relative ? `${relative}/${name}` : name;
			if (files.length + directories.length >= MAX_FILES) throw new CliRefusal();
			const filename = path.join(root, child);
			const stat = lstatSync(filename);
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				directories.push(child);
				visit(child);
			} else {
				regular(filename);
				files.push(child);
			}
		}
	}
	visit("");
	const expected = installedCatalog.files.map((file) => file.path).sort();
	if (
		JSON.stringify(files.sort()) !== JSON.stringify(expected) ||
		JSON.stringify(directories.sort()) !== JSON.stringify([...installedCatalog.directories].sort())
	)
		throw new CliRefusal();
	for (const file of installedCatalog.files) {
		if (file.sha256 === null) continue;
		const digest = createHash("sha256")
			.update(readFileSync(path.join(root, file.path)))
			.digest("hex");
		if (digest !== file.sha256) throw new CliRefusal();
	}
}

export function moduleFiles(kind: "commands" | "checks"): readonly string[] {
	return checked(() => {
		verifyInstalled();
		if (installedCatalog)
			return kind === "commands" ? installedCatalog.commands : installedCatalog.checks;
		return discover(kind === "commands" ? "commands" : "doctor/checks");
	});
}

export function moduleUrl(relative: string): URL {
	const extension = path.extname(fileURLToPath(import.meta.url));
	if (
		!new RegExp(`^(?:commands|doctor/checks)/[a-z][a-z0-9-]*\\${extension}$`).test(relative) ||
		!moduleName(path.basename(relative, extension))
	)
		throw new CliRefusal();
	return checked(() => {
		regular(path.join(canonicalRoot(), relative));
		return pathToFileURL(path.join(ROOT, relative));
	});
}
