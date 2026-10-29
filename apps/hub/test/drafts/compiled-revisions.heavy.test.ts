import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { nativeBinding } from "../store/helpers.ts";

it("runs compiled revisions and one-use freeze using only actual staged exports and SQL", () => {
	const hub = path.resolve(import.meta.dirname, "../.."),
		workspace = path.resolve(hub, "../..");
	const parent = realpathSync(path.join(hub, "node_modules"));
	const stage = realpathSync(mkdtempSync(path.join(parent, ".revisions-compiled-test-")));
	const cleanup = (): void => {
		if (
			path.dirname(stage) !== parent ||
			!path.basename(stage).startsWith(".revisions-compiled-test-") ||
			lstatSync(stage).isSymbolicLink() ||
			realpathSync(stage) !== stage
		)
			throw new Error("Compiled revision fixture cleanup target refused");
		rmSync(stage, { recursive: true, force: true });
		expect(existsSync(stage)).toBe(false);
	};
	try {
		copyFileSync(path.join(hub, "dist/index.mjs"), path.join(stage, "index.mjs"));
		copyFileSync(
			path.join(import.meta.dirname, "fixtures/compiled-revisions.mjs"),
			path.join(stage, "smoke.mjs"),
		);
		for (const relative of [
			"drafts/migrations/0001_native_revisions.sql",
			"store/migrations/audit/0001_chain.sql",
		]) {
			const built = path.join(hub, "dist", relative);
			expect(readFileSync(built)).toEqual(readFileSync(path.join(hub, "src", relative)));
			const target = path.join(stage, relative);
			mkdirSync(path.dirname(target), { recursive: true });
			copyFileSync(built, target);
		}
		const child = spawnSync(
			process.execPath,
			[
				"--permission",
				"--allow-addons",
				`--allow-fs-read=${workspace}`,
				`--allow-fs-write=${stage}`,
				path.join(stage, "smoke.mjs"),
				nativeBinding,
			],
			{ cwd: stage, env: {}, encoding: "utf8", timeout: 30_000, windowsHide: true },
		);
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		// Native SQLite is explicitly admitted. Keep its Node warning visible and
		// refuse every other diagnostic rather than suppressing warnings globally.
		expect(child.stderr).toMatch(
			/^\(node:\d+\) \[PERM0001\] SecurityWarning: The flag --allow-addons must be used with extreme caution\. It could invalidate the permission model\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n$/,
		);
		expect(JSON.parse(child.stdout)).toEqual({
			ok: true,
			revisions: 2,
			consumed: true,
			network: false,
		});
	} finally {
		cleanup();
	}
});
