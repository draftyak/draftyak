import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { types } from "node:util";
import type { Clock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { flushDirectory, flushFile } from "./durable-file.ts";
import type { SqliteDatabase } from "./open.ts";

export const SNAPSHOT_RETENTION_MS: number = 7 * 24 * 60 * 60_000;

export interface SnapshotOptions {
	/** An existing directory: absolute, canonical, not a link and, on POSIX, owner-only. */
	readonly directory: string;
	readonly clock: Pick<Clock, "wallMs">;
}

export type SnapshotErrorCode =
	| "options"
	| "directory"
	| "busy"
	| "copy"
	| "verify"
	| "flush"
	| "remove";

/** Carries a fixed code only: never a path, file name or SQLite message. */
export class SnapshotError extends Error {
	override name = "SnapshotError";
	readonly code: SnapshotErrorCode;
	constructor(code: SnapshotErrorCode) {
		super(`Database snapshot failed: ${code}`);
		this.code = code;
	}
}

interface Identity {
	readonly dev: bigint;
	readonly ino: bigint;
}
interface FileState extends Identity {
	readonly size: bigint;
	readonly mode: bigint;
}
export interface SnapshotSettings {
	readonly directory: string;
	readonly identity: Identity;
	readonly wallMs: () => unknown;
}

const NAMESPACE = /^[a-z][a-z0-9]*$/;
const NAME = /^pre-migration-[a-z][a-z0-9]*-(0|[1-9][0-9]{0,14})-[0-7][0-9A-HJKMNP-TV-Z]{25}\.db$/;
const MAX_TIME = 0xffffffffffff;
const CHUNK = 1024 * 1024;

function privateDirectory(directory: string): Identity {
	const info = fs.lstatSync(directory, { bigint: true });
	if (
		!info.isDirectory() ||
		fs.realpathSync.native(directory) !== directory ||
		(process.platform !== "win32" && (info.mode & 0o077n) !== 0n)
	)
		throw new Error();
	return Object.freeze({ dev: info.dev, ino: info.ino });
}

/** Captures the options once; the directory must stay this one. */
export function snapshotSettings(options: unknown): SnapshotSettings {
	try {
		if (options === null || typeof options !== "object" || types.isProxy(options))
			throw new Error();
		const { directory, clock } = options as { directory: unknown; clock: unknown };
		if (typeof directory !== "string" || !path.isAbsolute(directory)) throw new Error();
		if (clock === null || typeof clock !== "object" || types.isProxy(clock)) throw new Error();
		const wallMs: unknown = (clock as { wallMs?: unknown }).wallMs;
		if (typeof wallMs !== "function" || types.isProxy(wallMs)) throw new Error();
		const identity = privateDirectory(directory);
		return Object.freeze({ directory, identity, wallMs: () => Reflect.apply(wallMs, clock, []) });
	} catch {
		throw new SnapshotError("options");
	}
}

function assertDirectory(settings: SnapshotSettings): void {
	try {
		const current = privateDirectory(settings.directory);
		if (current.dev !== settings.identity.dev || current.ino !== settings.identity.ino)
			throw new Error();
	} catch {
		throw new SnapshotError("directory");
	}
}

function wallTime(settings: SnapshotSettings): number {
	let now: unknown;
	try {
		now = settings.wallMs();
	} catch {
		throw new SnapshotError("options");
	}
	if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0 || now > MAX_TIME)
		throw new SnapshotError("options");
	return now;
}

function regularFile(filename: string): FileState {
	const info = fs.lstatSync(filename, { bigint: true });
	if (!info.isFile() || info.nlink !== 1n) throw new Error();
	return { dev: info.dev, ino: info.ino, size: info.size, mode: info.mode };
}

function walSize(filename: string): bigint {
	try {
		const info = fs.lstatSync(`${filename}-wal`, { bigint: true });
		if (!info.isFile()) throw new Error();
		return info.size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0n;
		throw error;
	}
}

// Chunked: a database can be larger than any one buffer.
function digest(filename: string, expected: Identity): { size: bigint; hash: string } {
	const descriptor = fs.openSync(filename, "r");
	try {
		const info = fs.fstatSync(descriptor, { bigint: true });
		if (info.dev !== expected.dev || info.ino !== expected.ino) throw new Error();
		const hash = createHash("sha256");
		const chunk = Buffer.alloc(CHUNK);
		let size = 0;
		for (;;) {
			const count = fs.readSync(descriptor, chunk, 0, CHUNK, size);
			if (count === 0) break;
			hash.update(chunk.subarray(0, count));
			size += count;
		}
		return { size: BigInt(size), hash: hash.digest("hex") };
	} finally {
		fs.closeSync(descriptor);
	}
}

function removeCreated(filename: string, created: Identity): void {
	try {
		const info = fs.lstatSync(filename, { bigint: true });
		if (info.isFile() && info.dev === created.dev && info.ino === created.ino)
			fs.unlinkSync(filename);
	} catch {
		/* A missing or replaced copy is not this call's to remove. */
	}
}

/**
 * A byte copy of the store's file, with its key and salt, after a TRUNCATE checkpoint moved every
 * -wal frame into it. It is flushed and compared with the file before migrate() writes anything.
 */
export function takePreMigrationSnapshot(
	db: SqliteDatabase,
	namespace: string,
	settings: SnapshotSettings,
): void {
	if (!NAMESPACE.test(namespace)) throw new SnapshotError("options");
	assertDirectory(settings);
	try {
		const [result] = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
		if (result?.busy !== 0) throw new Error();
	} catch {
		throw new SnapshotError("busy");
	}
	const now = wallTime(settings);
	const source = db.name;
	const target = path.join(
		settings.directory,
		`pre-migration-${namespace}-${now}-${newId(now)}.db`,
	);
	let code: SnapshotErrorCode = "copy";
	let created: FileState | undefined;
	try {
		const before = regularFile(source);
		if (walSize(source) !== 0n) throw new Error();
		// COPYFILE_EXCL never replaces a file; on POSIX the copy keeps the source's 0600 mode.
		fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
		created = regularFile(target);
		code = "flush";
		flushFile(target);
		code = "verify";
		const after = regularFile(source);
		const copy = regularFile(target);
		const original = digest(source, before);
		const copied = digest(target, created);
		if (
			after.dev !== before.dev ||
			after.ino !== before.ino ||
			after.size !== before.size ||
			walSize(source) !== 0n ||
			copy.dev !== created.dev ||
			copy.ino !== created.ino ||
			copy.size !== before.size ||
			original.size !== before.size ||
			copied.size !== before.size ||
			copied.hash !== original.hash ||
			(process.platform !== "win32" && (copy.mode & 0o777n) !== 0o600n)
		)
			throw new Error();
		code = "flush";
		flushDirectory(settings.directory);
	} catch {
		if (created) removeCreated(target, created);
		throw new SnapshotError(code);
	}
}

function snapshotTime(name: string): number | undefined {
	const digits = NAME.exec(name)?.[1];
	const time = digits === undefined ? Number.NaN : Number(digits);
	return time <= MAX_TIME ? time : undefined;
}

// Only regular files with one link and an exact snapshot name; anything else stays.
function removeSnapshotFiles(settings: SnapshotSettings, due: (time: number) => boolean): number {
	assertDirectory(settings);
	let names: string[];
	try {
		names = fs.readdirSync(settings.directory);
	} catch {
		throw new SnapshotError("remove");
	}
	let removed = 0;
	let failed = false;
	for (const name of names) {
		const time = snapshotTime(name);
		if (time === undefined || !due(time)) continue;
		try {
			const filename = path.join(settings.directory, name);
			const info = fs.lstatSync(filename, { bigint: true });
			if (!info.isFile() || info.nlink !== 1n) continue;
			fs.unlinkSync(filename);
			removed++;
		} catch {
			failed = true;
		}
	}
	if (removed > 0) {
		try {
			flushDirectory(settings.directory);
		} catch {
			throw new SnapshotError("flush");
		}
	}
	if (failed) throw new SnapshotError("remove");
	return removed;
}

/** Removes snapshots whose time plus SNAPSHOT_RETENTION_MS is earlier than the clock's time. */
export function expirePreMigrationSnapshots(settings: SnapshotSettings): number {
	const now = wallTime(settings);
	return removeSnapshotFiles(settings, (time) => time + SNAPSHOT_RETENTION_MS < now);
}

/** Removes every snapshot, for the purge paths. */
export function removePreMigrationSnapshots(settings: SnapshotSettings): number {
	return removeSnapshotFiles(settings, () => true);
}
