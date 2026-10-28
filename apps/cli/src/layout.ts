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

function regular(filename: string): void {
	const stat = lstatSync(filename);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new CliRefusal();
}

function directory(filename: string): void {
	const stat = lstatSync(filename);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CliRefusal();
	if (realpathSync(filename) !== path.resolve(filename)) throw new CliRefusal();
}

function discover(relative: "commands" | "doctor/checks"): readonly string[] {
	const parent = path.join(ROOT, relative);
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
	directory(ROOT);
	const files: string[] = [];
	const directories: string[] = [];
	function visit(relative: string): void {
		const folder = path.join(ROOT, relative);
		directory(folder);
		for (const name of readdirSync(folder).sort()) {
			const child = relative ? `${relative}/${name}` : name;
			if (files.length + directories.length >= MAX_FILES) throw new CliRefusal();
			const filename = path.join(ROOT, child);
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
			.update(readFileSync(path.join(ROOT, file.path)))
			.digest("hex");
		if (digest !== file.sha256) throw new CliRefusal();
	}
}

export function moduleFiles(kind: "commands" | "checks"): readonly string[] {
	verifyInstalled();
	if (installedCatalog)
		return kind === "commands" ? installedCatalog.commands : installedCatalog.checks;
	return discover(kind === "commands" ? "commands" : "doctor/checks");
}

export function moduleUrl(relative: string): URL {
	const extension = path.extname(fileURLToPath(import.meta.url));
	if (
		!new RegExp(`^(?:commands|doctor/checks)/[a-z][a-z0-9-]*\\${extension}$`).test(relative) ||
		!moduleName(path.basename(relative, extension))
	)
		throw new CliRefusal();
	const filename = path.join(ROOT, relative);
	regular(filename);
	if (realpathSync(filename) !== path.resolve(filename)) throw new CliRefusal();
	return pathToFileURL(filename);
}
