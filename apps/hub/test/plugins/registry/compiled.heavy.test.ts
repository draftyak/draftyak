import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeBinding } from "../../store/helpers.ts";

it("loads the compiled registry root export and delivered migration in a genuine reopened store", () => {
	const hub = path.resolve(import.meta.dirname, "../../.."),
		workspace = path.resolve(hub, "../.."),
		parent = realpathSync(os.tmpdir()),
		directory = realpathSync(mkdtempSync(path.join(parent, "draftyak-registry-built-")));
	const cleanup = (): void => {
		if (
			path.dirname(directory) !== parent ||
			!path.basename(directory).startsWith("draftyak-registry-built-") ||
			lstatSync(directory).isSymbolicLink() ||
			realpathSync(directory) !== directory
		)
			throw new Error("Registry fixture cleanup refused");
		rmSync(directory, { recursive: true, force: true });
		expect(existsSync(directory)).toBe(false);
	};
	try {
		expect(
			readFileSync(path.join(hub, "dist/plugins/registry/migrations/0001_registry.sql")),
		).toEqual(readFileSync(path.join(hub, "src/plugins/registry/migrations/0001_registry.sql")));
		const child = spawnSync(
			process.execPath,
			[
				"--permission",
				"--allow-addons",
				`--allow-fs-read=${workspace}`,
				`--allow-fs-read=${directory}`,
				`--allow-fs-write=${directory}`,
				path.join(import.meta.dirname, "fixtures/compiled.mjs"),
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
			/* Opaque diagnostics never replace a valid receipt. */
		}
		expect(child.error === undefined).toBe(true);
		expect(child.signal).toBe(null);
		expect(child.status).toBe(0);
		expect(receipt).toEqual({ ok: true, network: false, child: false, schemas: 2 });
	} finally {
		cleanup();
	}
});
