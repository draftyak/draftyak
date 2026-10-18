import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildShim } from "../scripts/build-shim.ts";
import { installedDir, readRuntimeLock } from "../scripts/fetch-runtime.ts";
import {
	copyRuntime,
	type RuntimeSources,
	SHIM,
	sha256File,
	sourceOf,
	verifyRuntime,
} from "../src/runtime.ts";

// Made in beforeAll, so a filtered run that skips this file leaves no temp dir behind.
let root = "";
beforeAll(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dy-s11-runtime-")));
});
afterAll(() => {
	if (root !== "") fs.rmSync(root, { recursive: true, force: true });
});

// A small stand-in for the installed packages; the core files sit beside a pnpm-style hard link.
function fakeSources(name: string): { sources: RuntimeSources; expected: Record<string, string> } {
	const base = path.join(root, name);
	const pyodideDir = path.join(base, "pyodide");
	const wsDir = path.join(base, "ws");
	fs.mkdirSync(path.join(wsDir, "lib"), { recursive: true });
	fs.mkdirSync(pyodideDir, { recursive: true });
	fs.writeFileSync(path.join(base, "store.mjs"), "export const core = 1;\n");
	fs.linkSync(path.join(base, "store.mjs"), path.join(pyodideDir, "pyodide.mjs"));
	fs.writeFileSync(path.join(wsDir, "package.json"), "{}\n");
	fs.writeFileSync(path.join(wsDir, "lib", "sender.js"), "module.exports = 1;\n");
	const shim = path.join(base, "shim.mjs");
	fs.writeFileSync(shim, "export {};\n");
	const sources = { pyodideDir, wsDir, shim };
	const expected = {
		"pyodide.mjs": sha256File(path.join(pyodideDir, "pyodide.mjs")),
		"node_modules/ws/package.json": sha256File(path.join(wsDir, "package.json")),
		"node_modules/ws/lib/sender.js": sha256File(path.join(wsDir, "lib", "sender.js")),
		[SHIM]: sha256File(shim),
	};
	return { sources, expected };
}

function copied(name: string) {
	const { sources, expected } = fakeSources(name);
	const dir = path.join(root, name, "runtime");
	copyRuntime(dir, expected, sources);
	return { dir, expected };
}

describe("copyRuntime and verifyRuntime", () => {
	it("maps each runtime path to its package and the shim", () => {
		const sources = { pyodideDir: "/p", wsDir: "/w", shim: "/s/shim.mjs" };
		expect(sourceOf(SHIM, sources)).toBe("/s/shim.mjs");
		expect(sourceOf("node_modules/ws/lib/x.js", sources)).toBe(path.join("/w", "lib", "x.js"));
		expect(sourceOf("pyodide.asm.wasm", sources)).toBe(path.join("/p", "pyodide.asm.wasm"));
		for (const bad of ["../x", "a//b", ".hidden", "node_modules/ws/../../x", "a\\b"]) {
			expect(() => sourceOf(bad, sources), bad).toThrow(/not a runtime path/);
		}
	});

	it("copies link-free, even from a hard-linked package store, and the copy verifies", () => {
		const { dir, expected } = copied("clean");
		expect(fs.statSync(path.join(root, "clean", "pyodide", "pyodide.mjs")).nlink).toBe(2);
		for (const rel of Object.keys(expected)) {
			expect(fs.lstatSync(path.join(dir, ...rel.split("/"))).nlink, rel).toBe(1);
		}
		expect(verifyRuntime(dir, expected)).toBeNull();
	});

	it("refuses to copy over an existing dir", () => {
		const { sources, expected } = fakeSources("twice");
		const dir = path.join(root, "twice", "runtime");
		copyRuntime(dir, expected, sources);
		expect(() => copyRuntime(dir, expected, sources)).toThrow();
	});

	it("finds a modified, missing or extra file", () => {
		const modified = copied("modified");
		fs.appendFileSync(path.join(modified.dir, "node_modules", "ws", "lib", "sender.js"), "//\n");
		expect(verifyRuntime(modified.dir, modified.expected)).toEqual({
			path: "node_modules/ws/lib/sender.js",
			kind: "modified",
		});
		const missing = copied("missing");
		fs.rmSync(path.join(missing.dir, SHIM));
		expect(verifyRuntime(missing.dir, missing.expected)).toEqual({ path: SHIM, kind: "missing" });
		const extra = copied("extra");
		fs.writeFileSync(path.join(extra.dir, "node_modules", "ws", "extra.js"), "1;\n");
		expect(verifyRuntime(extra.dir, extra.expected)).toEqual({
			path: "node_modules/ws/extra.js",
			kind: "extra",
		});
	});

	it("finds a hard link inside the copy", () => {
		const { dir, expected } = copied("hard");
		fs.linkSync(path.join(dir, SHIM), path.join(root, "hard", "outside.mjs"));
		expect(verifyRuntime(dir, expected)).toEqual({ path: SHIM, kind: "hardlink" });
	});

	it("finds a junction", { tags: ["requires:windows"] }, () => {
		const { dir, expected } = copied("junction");
		fs.symlinkSync(
			path.join(root, "junction", "ws"),
			path.join(dir, "node_modules", "j"),
			"junction",
		);
		expect(verifyRuntime(dir, expected)?.kind).toBe("symlink");
	});

	it("finds a symlink, and a root reached through one", {
		tags: ["requires:symlink-privilege"],
	}, () => {
		const { dir, expected } = copied("symlink");
		const link = path.join(root, "symlink", "via");
		fs.symlinkSync(dir, link, "dir");
		expect(verifyRuntime(link, expected)).toEqual({ path: link, kind: "symlink" });
		fs.symlinkSync(path.join(dir, SHIM), path.join(dir, "node_modules", "s.mjs"), "file");
		expect(verifyRuntime(dir, expected)?.kind).toBe("symlink");
	});

	it("fails closed on a missing root", () => {
		expect(verifyRuntime(path.join(root, "nowhere"), {})?.kind).toBe("unreadable");
	});

	it("copies the installed Pyodide, ws and the shim bundle exactly as runtime.lock.json records them", async () => {
		const lock = readRuntimeLock();
		const shim = path.join(root, "built-shim.mjs");
		fs.writeFileSync(shim, await buildShim());
		const sources = { pyodideDir: installedDir("pyodide"), wsDir: installedDir("ws"), shim };
		const dir = path.join(root, "real");
		copyRuntime(dir, lock.files, sources);
		expect(verifyRuntime(dir, lock.files)).toBeNull();
		expect(fs.readdirSync(dir).toSorted()).toEqual([
			"node_modules",
			"pyodide.asm.mjs",
			"pyodide.asm.wasm",
			"pyodide.mjs",
			"python_stdlib.zip",
			SHIM,
		]);
	});
});
