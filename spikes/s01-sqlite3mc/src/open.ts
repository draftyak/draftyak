import { realpathSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3-multiple-ciphers";
import { packageDir, processReport, sha256File, type Target, targetFor } from "./prebuilds.ts";

export type SqliteDatabase = Database.Database;

export class NativeBindingError extends Error {
	override name = "NativeBindingError";
	readonly code = "ERR_NATIVE_BINDING_PATH";
}

// Only the package's main entry takes nativeBinding; its per-platform subpath exports refuse it.
// The package appends .node to a path without it, so only an absolute .node path is accepted.
export function openDatabase(
	filename: string,
	nativeBinding: string,
	options: Omit<Database.Options, "nativeBinding"> = {},
): SqliteDatabase {
	if (!path.isAbsolute(nativeBinding) || path.extname(nativeBinding) !== ".node") {
		throw new NativeBindingError(
			`nativeBinding is an absolute path to a .node file: ${nativeBinding}`,
		);
	}
	return new Database(filename, { ...options, nativeBinding });
}

export interface LoadReport {
	readonly target: Target;
	readonly nodeVersion: string;
	readonly napiVersion: number;
	readonly libc: string | null;
	readonly sqliteVersion: string;
	readonly sqlite3mcVersion: string;
	readonly fromBundle: boolean;
	readonly sha256: string;
	readonly openMs: number;
}

// Windows reports loaded modules as \\?\C:\…, in any letter case.
function samePath(file: string): string {
	const resolved = path.resolve(file.replace(/^\\\\\?\\/, ""));
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// Opens an in-memory database through nativeBinding and runs a statement. fromBundle: the process
// mapped that file and nothing from the package's own prebuilds/ folder; sha256: that file's bytes.
export function loadReport(nativeBinding: string): LoadReport {
	const started = performance.now();
	const db = openDatabase(":memory:", nativeBinding);
	const openMs = Math.round((performance.now() - started) * 10) / 10;
	let versions: { sqlite: string; mc: string };
	try {
		db.exec("create table t (x integer); insert into t values (42)");
		if (db.prepare("select x from t").pluck().get() !== 42) throw new Error("round trip failed");
		versions = db.prepare("select sqlite_version() as sqlite, sqlite3mc_version() as mc").get() as {
			sqlite: string;
			mc: string;
		};
	} finally {
		db.close();
	}
	const { header, sharedObjects } = processReport();
	const loaded = sharedObjects.map(samePath);
	const own = samePath(path.join(packageDir(), "prebuilds")) + path.sep;
	const binding = realpathSync(nativeBinding);
	const glibc = header.glibcVersionRuntime;
	return {
		target: targetFor(process.platform, process.arch, glibc),
		nodeVersion: process.versions.node,
		napiVersion: Number(process.versions.napi),
		libc: process.platform !== "linux" ? null : glibc ? `glibc ${glibc}` : "musl",
		sqliteVersion: versions.sqlite,
		sqlite3mcVersion: versions.mc,
		fromBundle: loaded.includes(samePath(binding)) && !loaded.some((file) => file.startsWith(own)),
		sha256: sha256File(binding),
		openMs,
	};
}
