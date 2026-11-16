import { lstatSync } from "node:fs";
import path from "node:path";
import { readBoundedRegularFile } from "@draftyak/bounded-files";
import { isMigrationDirectoryPath, migrationNumber } from "@draftyak/extensions/validation";
import { parseStrict } from "@draftyak/protocol/jcs";
import { integrityDigest } from "../kernel/integrity.ts";
import { refuse } from "./errors.ts";
import { denseArray, inertRecord, isIdentifier } from "./values.ts";

export const CONFIG_FILE = "config.json";
export const MAX_CONFIG_BYTES: number = 256 * 1024;
export const MAX_MODULES = 16;
export const MAX_MIGRATIONS = 256;

export const SERVICES = [
	"transport",
	"cert",
	"push",
	"backup",
	"identity",
	"sendPolicy",
	"auditSink",
	"workspace",
	"adminOp",
	"deviceRoutes",
] as const;
export type ExtensionService = (typeof SERVICES)[number];

export interface PinnedFile {
	readonly name: string;
	readonly sha512: Buffer;
}
export interface ModuleConfig {
	readonly id: string;
	readonly version: string;
	readonly entry: string;
	readonly sha512: Buffer;
	readonly provides: ReadonlySet<ExtensionService>;
	readonly migrations?: { readonly directory: string; readonly files: readonly PinnedFile[] };
}
export interface ExtensionConfig {
	readonly modules: readonly ModuleConfig[];
}

const VERSION =
	/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function exactVersion(value: unknown): string {
	const match = typeof value === "string" && value.length <= 128 ? VERSION.exec(value) : null;
	if (!match || match[0] !== value || match[4]?.split(".").some((part) => /^0[0-9]+$/.test(part)))
		refuse("config");
	return value as string;
}

/** Subresource-integrity form of an exact 64-byte digest, in its one canonical base64 spelling. */
export function pinDigest(value: unknown): Buffer {
	return integrityDigest(value) ?? refuse("config");
}

function absolutePath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length > 4096 ||
		!value.isWellFormed() ||
		!isMigrationDirectoryPath(value) ||
		path.resolve(value) !== value
	)
		refuse("config");
	return value;
}

function migrations(value: unknown): ModuleConfig["migrations"] {
	const record = inertRecord(value, ["directory", "files"], [], "config");
	const directory = absolutePath(record.directory);
	const files = denseArray(record.files, MAX_MIGRATIONS, "config").map((item) => {
		const file = inertRecord(item, ["name", "sha512"], [], "config");
		if (typeof file.name !== "string" || migrationNumber(file.name) === undefined) refuse("config");
		return Object.freeze({ name: file.name, sha512: pinDigest(file.sha512) });
	});
	if (files.length === 0) refuse("config");
	for (let index = 1; index < files.length; index++) {
		const previous = migrationNumber(files[index - 1]?.name ?? ""),
			current = migrationNumber(files[index]?.name ?? "");
		if (previous === undefined || current === undefined || previous >= current) refuse("config");
	}
	return Object.freeze({ directory, files: Object.freeze(files) });
}

function moduleConfig(value: unknown): ModuleConfig {
	const record = inertRecord(
		value,
		["id", "version", "entry", "sha512", "provides"],
		["migrations"],
		"config",
	);
	if (!isIdentifier(record.id)) refuse("config");
	const entry = absolutePath(record.entry);
	if (!entry.endsWith(".mjs")) refuse("config");
	const provides = new Set<ExtensionService>();
	for (const service of denseArray(record.provides, SERVICES.length, "config")) {
		const known = SERVICES.find((name) => name === service);
		if (known === undefined || provides.has(known)) refuse("config");
		provides.add(known);
	}
	return Object.freeze({
		id: record.id,
		version: exactVersion(record.version),
		entry,
		sha512: pinDigest(record.sha512),
		provides,
		...(record.migrations === undefined ? {} : { migrations: migrations(record.migrations) }),
	});
}

/** Parses the extension section of config.json; exposure and routing are never configured here. */
export function parseExtensionConfig(bytes: Uint8Array): ExtensionConfig {
	let document: unknown;
	try {
		document = parseStrict(bytes);
	} catch {
		refuse("config");
	}
	const record = inertRecord(document, ["modules"], [], "config");
	const modules = denseArray(record.modules, MAX_MODULES, "config").map(moduleConfig);
	const ids = new Set(modules.map((module) => module.id));
	if (ids.size !== modules.length) refuse("config");
	return Object.freeze({ modules: Object.freeze(modules) });
}

/** A missing file configures no modules; every other unreadable or invalid file refuses. */
export function loadExtensionConfig(dataDirectory: string): ExtensionConfig {
	const filename = path.join(dataDirectory, CONFIG_FILE);
	try {
		lstatSync(filename);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT")
			return Object.freeze({ modules: Object.freeze([]) });
		refuse("config");
	}
	let bytes: Buffer;
	try {
		bytes = readBoundedRegularFile(filename, { maximum: MAX_CONFIG_BYTES });
	} catch {
		refuse("config");
	}
	return parseExtensionConfig(bytes);
}
