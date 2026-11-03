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

it("runs corrected draft flags, clock transitions and applicability through the built root", () => {
	const hub = path.resolve(import.meta.dirname, "../..");
	const parent = realpathSync(path.join(hub, "node_modules"));
	const stage = realpathSync(mkdtempSync(path.join(parent, ".draft-corrections-")));
	const cleanup = (): void => {
		if (
			path.dirname(stage) !== parent ||
			!path.basename(stage).startsWith(".draft-corrections-") ||
			lstatSync(stage).isSymbolicLink() ||
			realpathSync(stage) !== stage
		)
			throw new Error("Draft corrections cleanup target refused");
		rmSync(stage, { recursive: true, force: true });
		expect(existsSync(stage)).toBe(false);
	};
	try {
		const index = path.join(hub, "dist/index.mjs");
		expect(lstatSync(index).isFile() && !lstatSync(index).isSymbolicLink()).toBe(true);
		copyFileSync(index, path.join(stage, "index.mjs"));
		for (const relative of [
			"store/migrations/audit/0001_chain.sql",
			"store/migrations/core/0001_identity.sql",
			"drafts/migrations/0001_native_revisions.sql",
			"drafts/migrations/0002_immutable_revisions.sql",
		]) {
			const built = path.join(hub, "dist", relative);
			expect(lstatSync(built).isFile() && !lstatSync(built).isSymbolicLink()).toBe(true);
			expect(readFileSync(built)).toEqual(readFileSync(path.join(hub, "src", relative)));
			const target = path.join(stage, relative);
			mkdirSync(path.dirname(target), { recursive: true });
			copyFileSync(built, target);
		}
		const child = spawnSync(
			process.execPath,
			[
				path.join(import.meta.dirname, "fixtures/compiled-draft-corrections.mjs"),
				stage,
				nativeBinding,
			],
			{
				cwd: stage,
				env: {},
				windowsHide: true,
				timeout: 30_000,
				maxBuffer: 16_384,
				encoding: "utf8",
			},
		);
		let receipt: unknown;
		try {
			receipt = JSON.parse(child.stdout);
		} catch {
			// Child output stays opaque unless it is the exact structured result below.
		}
		expect(child.error === undefined).toBe(true);
		expect(child.signal).toBeNull();
		expect(child.status).toBe(0);
		expect(receipt).toEqual({
			ok: true,
			channels: 2,
			refused: 5,
			modelFlags: "current",
			clock: "clamped",
			skew: "signed-id-only",
			reopened: true,
		});
	} finally {
		cleanup();
	}
});
