import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeBinding } from "../store/helpers.ts";

it("loads compiled native admin exports and reopens both delivered migrations", () => {
	const hub = path.resolve(import.meta.dirname, "../.."),
		workspace = path.resolve(hub, "../.."),
		parent = realpathSync(os.tmpdir()),
		directory = realpathSync(mkdtempSync(path.join(parent, "draftyak-admin-built-"))),
		identity = lstatSync(directory);
	const cleanup = (): void => {
		const current = lstatSync(directory);
		if (
			path.dirname(directory) !== parent ||
			!path.basename(directory).startsWith("draftyak-admin-built-") ||
			current.isSymbolicLink() ||
			!current.isDirectory() ||
			realpathSync(directory) !== directory ||
			current.dev !== identity.dev ||
			current.ino !== identity.ino
		)
			throw new Error("Admin fixture cleanup refused");
		rmSync(directory, { recursive: true, force: false });
		expect(existsSync(directory)).toBe(false);
	};
	try {
		const child = spawnSync(
			process.execPath,
			[
				"--permission",
				"--allow-addons",
				`--allow-fs-read=${workspace}`,
				`--allow-fs-read=${directory}`,
				`--allow-fs-write=${directory}`,
				path.join(import.meta.dirname, "fixtures/compiled-admin.mjs"),
				hub,
				nativeBinding,
				directory,
			],
			{
				cwd: hub,
				encoding: "utf8",
				maxBuffer: 1024,
				timeout: 30_000,
				windowsHide: true,
				env: {
					NODE_ENV: "test",
					SystemRoot: "C:\\Windows",
					WINDIR: "C:\\Windows",
					TEMP: directory,
					TMP: directory,
				},
			},
		);
		let receipt: unknown;
		try {
			receipt = JSON.parse(child.stdout);
		} catch {
			/* A fixed receipt is required; raw child output is never substituted. */
		}
		expect(child.error === undefined).toBe(true);
		expect(child.signal).toBe(null);
		expect(child.status).toBe(0);
		expect(receipt).toEqual({
			ok: true,
			network: false,
			child: false,
			migrations: 2,
			reopened: true,
		});
		for (const [source, delivered] of [
			[
				"identity/admin-migrations/0001_operations.sql",
				"identity/admin-migrations/0001_operations.sql",
			],
			[
				"identity/admin-challenge-migrations/0001_admin_challenges.sql",
				"identity/admin-challenge-migrations/0001_admin_challenges.sql",
			],
		]) {
			if (!source || !delivered) throw new Error("Admin migration fixture refused");
			expect(readFileSync(path.join(hub, "dist", delivered))).toEqual(
				readFileSync(path.join(hub, "src", source)),
			);
		}
	} finally {
		cleanup();
	}
});
