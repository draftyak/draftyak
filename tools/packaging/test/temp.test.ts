import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { removeFixture } from "./temp.ts";

it("removes only the intended canonical fixture directory", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "draftyak-portable-cleanup-"));
	removeFixture(root, os.tmpdir(), "draftyak-portable-cleanup-");
	expect(existsSync(root)).toBe(false);
});

it("refuses parent and prefix escapes without deleting their contents", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "draftyak-portable-cleanup-"));
	const kept = path.join(root, "kept");
	mkdirSync(kept);
	try {
		expect(() => removeFixture(root, root, "draftyak-portable-cleanup-")).toThrow("cleanup path");
		expect(() => removeFixture(root, os.tmpdir(), "unrelated-")).toThrow("cleanup path");
		expect(existsSync(kept)).toBe(true);
	} finally {
		removeFixture(root, os.tmpdir(), "draftyak-portable-cleanup-");
	}
});

it("refuses a linked root even when its lexical parent and prefix match", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "draftyak-portable-cleanup-"));
	const target = path.join(root, "target");
	const alias = path.join(root, "fixture-alias");
	mkdirSync(target);
	try {
		symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
		expect(realpathSync(alias)).toBe(realpathSync(target));
		expect(() => removeFixture(alias, root, "fixture-")).toThrow("cleanup identity");
		expect(existsSync(target)).toBe(true);
	} finally {
		removeFixture(root, os.tmpdir(), "draftyak-portable-cleanup-");
	}
});
