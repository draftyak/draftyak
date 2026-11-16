import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeBinding } from "../store/helpers.ts";

const hub = path.resolve(import.meta.dirname, "../..");

function response(text: string): {
	version: number;
	ok: boolean;
	exported: boolean;
	bareReopen: boolean;
	assetBytes: number;
	assetSha256: string;
	inserted: number;
	reopened: number;
} {
	const refused = (): never => {
		throw new Error("Compiled content response refused");
	};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return refused();
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return refused();
	const row = parsed as Record<string, unknown>;
	const keys = [
		"version",
		"ok",
		"exported",
		"bareReopen",
		"assetBytes",
		"assetSha256",
		"inserted",
		"reopened",
	];
	if (Object.keys(row).sort().join() !== keys.sort().join()) return refused();
	if (
		row.version !== 1 ||
		typeof row.ok !== "boolean" ||
		typeof row.exported !== "boolean" ||
		typeof row.bareReopen !== "boolean" ||
		typeof row.assetSha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(row.assetSha256)
	)
		return refused();
	for (const field of ["assetBytes", "inserted", "reopened"])
		if (
			typeof row[field] !== "number" ||
			!Number.isSafeInteger(row[field]) ||
			(row[field] as number) < 0 ||
			(row[field] as number) > 65_536
		)
			return refused();
	return row as ReturnType<typeof response>;
}

it("reopens the compiled content namespace through the delivered catalog without registration", () => {
	const parent = realpathSync(tmpdir());
	const directory = realpathSync(mkdtempSync(path.join(parent, "draftyak-compiled-content-")));
	const owned = lstatSync(directory);
	const safe = (): boolean => {
		const current = lstatSync(directory);
		return (
			path.dirname(directory) === parent &&
			path.basename(directory).startsWith("draftyak-compiled-content-") &&
			current.isDirectory() &&
			!current.isSymbolicLink() &&
			current.dev === owned.dev &&
			current.ino === owned.ino
		);
	};
	const cleanup = (): void => {
		if (!safe()) throw new Error("Compiled content cleanup refused");
		rmSync(directory, { recursive: true, force: true });
	};
	try {
		if (!safe()) throw new Error("Compiled content temporary directory refused");
		const result = spawnSync(
			process.execPath,
			[path.join(import.meta.dirname, "compiled-content.mjs"), nativeBinding, directory],
			{
				cwd: hub,
				shell: false,
				windowsHide: true,
				encoding: "utf8",
				timeout: 20_000,
				maxBuffer: 65_536,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		// Child stderr stays private; failures expose only fixed status/count metadata.
		expect(Boolean(result.error)).toBe(false);
		expect(result.status).toBe(0);
		expect(result.signal).toBeNull();
		if (result.stdout.length > 4096) throw new Error("Compiled content response refused");
		const actual = response(result.stdout);
		const sql = readFileSync(path.join(hub, "src/sync/migrations/0001_content.sql"));
		expect(actual).toEqual({
			version: 1,
			ok: true,
			exported: true,
			bareReopen: true,
			assetBytes: sql.length,
			assetSha256: createHash("sha256").update(sql).digest("hex"),
			inserted: 1,
			reopened: 1,
		});
	} finally {
		cleanup();
	}
});
