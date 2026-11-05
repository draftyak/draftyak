import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, opendirSync, realpathSync } from "node:fs";
import path from "node:path";
import { readBoundedRegularFile } from "@draftyak/bounded-files";
import { namesPragmaFunction, REFUSED_STATEMENTS, statementStarts } from "../store/migrator.ts";
import type { ModuleConfig, PinnedFile } from "./config.ts";
import { refuse } from "./errors.ts";

export const MAX_ENTRY_BYTES: number = 16 * 1024 * 1024;
export const MAX_MIGRATION_BYTES: number = 1024 * 1024;
export const MAX_MIGRATION_TOTAL_BYTES: number = 4 * 1024 * 1024;

export interface VerifiedMigration {
	readonly name: string;
	readonly sql: string;
}
export interface VerifiedModule {
	readonly config: ModuleConfig;
	readonly entry: Buffer;
	readonly files: readonly Buffer[];
	readonly migrations: readonly VerifiedMigration[];
}

function pinned(bytes: Buffer, pin: Buffer): Buffer {
	const digest = createHash("sha512").update(bytes).digest();
	if (!timingSafeEqual(digest, pin)) refuse("artifact");
	return bytes;
}

function read(filename: string, maximum: number): Buffer {
	try {
		return readBoundedRegularFile(filename, { maximum });
	} catch {
		refuse("artifact");
	}
}

/** The configured folder holds exactly the pinned files: no extra, missing, linked or nested entry. */
function exactInventory(directory: string, files: readonly PinnedFile[]): void {
	const wanted = new Set(files.map((file) => file.name));
	const seen = new Set<string>();
	try {
		const info = lstatSync(directory);
		if (!info.isDirectory() || realpathSync.native(directory) !== directory) refuse("artifact");
		const entries = opendirSync(directory);
		try {
			for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
				if (!entry.isFile() || !wanted.has(entry.name) || seen.has(entry.name)) refuse("artifact");
				seen.add(entry.name);
			}
		} finally {
			entries.closeSync();
		}
	} catch {
		refuse("artifact");
	}
	if (seen.size !== wanted.size) refuse("artifact");
}

function migrationFiles(config: ModuleConfig): Buffer[] {
	const migrations = config.migrations;
	if (!migrations) return [];
	exactInventory(migrations.directory, migrations.files);
	let total = 0;
	return migrations.files.map((file) => {
		const bytes = read(path.join(migrations.directory, file.name), MAX_MIGRATION_BYTES);
		total += bytes.length;
		if (total > MAX_MIGRATION_TOTAL_BYTES) refuse("artifact");
		return pinned(bytes, file.sha512);
	});
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Transaction control, settings, attachments and pragma functions belong to the native migrator. */
function migrationSql(bytes: Buffer): string {
	let sql: string;
	try {
		sql = utf8.decode(bytes);
	} catch {
		refuse("database");
	}
	if (namesPragmaFunction(sql) || statementStarts(sql).some((word) => REFUSED_STATEMENTS.has(word)))
		refuse("database");
	return sql;
}

/** Reads and checks every pinned byte before any module code is loaded or executed. */
export function verifyModule(config: ModuleConfig): VerifiedModule {
	const entry = pinned(read(config.entry, MAX_ENTRY_BYTES), config.sha512);
	const files = migrationFiles(config);
	const names = config.migrations?.files ?? [];
	const migrations = files.map((bytes, index) =>
		Object.freeze({ name: names[index]?.name ?? refuse("artifact"), sql: migrationSql(bytes) }),
	);
	return Object.freeze({
		config,
		entry,
		files: Object.freeze(files),
		migrations: Object.freeze(migrations),
	});
}

/** The load boundary: the files must still hold exactly the bytes verified earlier. */
export function reverifyModule(verified: VerifiedModule): void {
	const entry = pinned(read(verified.config.entry, MAX_ENTRY_BYTES), verified.config.sha512);
	const files = migrationFiles(verified.config);
	if (
		!entry.equals(verified.entry) ||
		files.length !== verified.files.length ||
		files.some((bytes, index) => verified.files[index]?.equals(bytes) !== true)
	)
		refuse("artifact");
}

/** The verified bytes themselves become the module source; the loader never reads the file. */
export const moduleUrl = (verified: VerifiedModule): string =>
	`data:text/javascript;base64,${verified.entry.toString("base64")}`;
