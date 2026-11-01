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

it("runs compiled native jobs/events using only staged SQL with distinct migration directories", () => {
	const hub = path.resolve(import.meta.dirname, "../..");
	// Below the package's real node_modules so native external dependencies resolve without links.
	const parent = realpathSync(path.join(hub, "node_modules"));
	const stage = realpathSync(mkdtempSync(path.join(parent, ".jobs-compiled-test-")));
	const cleanup = (): void => {
		if (
			path.dirname(stage) !== parent ||
			!path.basename(stage).startsWith(".jobs-compiled-test-") ||
			lstatSync(stage).isSymbolicLink() ||
			realpathSync(stage) !== stage
		)
			throw new Error("Compiled fixture cleanup target refused");
		rmSync(stage, { recursive: true, force: true });
		expect(existsSync(stage)).toBe(false);
	};
	try {
		copyFileSync(path.join(hub, "dist/index.mjs"), path.join(stage, "index.mjs"));
		copyFileSync(
			path.join(import.meta.dirname, "fixtures/compiled-child.mjs"),
			path.join(stage, "smoke.mjs"),
		);
		for (const [source, built] of [
			["jobs/jobs-migrations/0001_jobs.sql", "jobs-migrations/0001_jobs.sql"],
			["events/events-migrations/0001_events.sql", "events-migrations/0001_events.sql"],
			["store/migrations/audit/0001_chain.sql", "store/migrations/audit/0001_chain.sql"],
		]) {
			const file = path.join(hub, "dist", built as string);
			expect(readFileSync(file)).toEqual(readFileSync(path.join(hub, "src", source as string)));
			const target = path.join(stage, built as string);
			mkdirSync(path.dirname(target), { recursive: true });
			copyFileSync(file, target);
		}
		const child = spawnSync(process.execPath, [path.join(stage, "smoke.mjs"), nativeBinding], {
			cwd: stage,
			encoding: "utf8",
			timeout: 30_000,
			windowsHide: true,
		});
		expect(child.error).toBeUndefined();
		expect(child.status, child.stderr).toBe(0);
		expect(child.stderr).toBe("");
		expect(JSON.parse(child.stdout)).toEqual({ ok: true, state: "SUCCEEDED", events: 3 });
	} finally {
		cleanup();
	}
});
