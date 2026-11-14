import { describe, expect, it } from "vitest";
import { verifyBrowserBundle } from "../scripts/verify-build.ts";

const runtimeImports = ["react", "react/compiler-runtime", "react/jsx-runtime"];
const validSource = "export const value = 1;";
const blocked = "Browser bundle contains a Node dependency or unresolved dynamic import";
const external = "Browser bundle contains an unexpected external import";
const missingRuntime = "Browser bundle is missing the React, compiler or JSX runtime";

// Every import-policy fixture is valid JS so a parser failure cannot satisfy that axis.
describe("browser build verification", () => {
	it("accepts the actual React, compiler and JSX runtime edges independent of code formatting", () => {
		expect(() => verifyBrowserBundle(validSource, runtimeImports, [])).not.toThrow();
	});
	it.each([
		["Node crypto", "import 'node:crypto';"],
		["hash implementation", "const createHash = () => 1;"],
		["browser external stub", "__vite-browser-external"],
	])("refuses %s in the output", (_name, source) => {
		expect(() => verifyBrowserBundle(source, runtimeImports, [])).toThrowError(new Error(blocked));
	});
	it.each(["unexpected", "fs", "react-dom", "react/unknown", "./extra-chunk.js"])(
		"refuses an unexpected static edge to %s, including re-exports",
		(name) => {
			expect(() => verifyBrowserBundle(validSource, [...runtimeImports, name], [])).toThrowError(
				new Error(external),
			);
		},
	);
	it("refuses dynamic imports", () => {
		expect(() => verifyBrowserBundle(validSource, runtimeImports, ["unknown"])).toThrowError(
			new Error(blocked),
		);
	});
	it.each(runtimeImports)("requires the %s runtime edge", (missing) => {
		expect(() =>
			verifyBrowserBundle(
				validSource,
				runtimeImports.filter((name) => name !== missing),
				[],
			),
		).toThrowError(new Error(missingRuntime));
	});

	it.each([
		["one property", "export const route = { node: 1 };"],
		["nested properties", "export const route = { node: { child: { node: 1 } } };"],
		["function value", "export const route = { node: () => 1 };"],
		["destructured property", "const source = {}; const { node: value } = source;"],
		[
			"nested destructured property",
			"const source = {}; const { nested: { node: value } } = source;",
		],
		[
			"twelve independently parsed properties",
			`export const routes = [${Array.from({ length: 12 }, (_, index) => `{node:${index}}`).join(",")}];`,
		],
	])("accepts ordinary Identifier node keys: %s", (_name, source) => {
		expect(() => verifyBrowserBundle(source, runtimeImports, [])).not.toThrow();
	});

	it.each([
		["double-quoted import", 'import fs from "node:fs";'],
		["single-quoted import", "import 'node:fs';"],
		["dynamic import string", 'const pending = import("node:fs");'],
		["require string", 'const fs = require("node:fs");'],
		["string prefix", 'const value = "node:fs";'],
		["prefixed string", 'const value = "prefix node:fs";'],
		["template prefix", "const value = `node:fs`;"],
		["prefixed template", "const value = `prefix node:fs`;"],
		["interpolated template", "const suffix = 'fs'; const value = `node:${suffix}`;"],
		["quoted property", 'const value = { "node:fs": true };'],
		["computed property", 'const value = { ["node:fs"]: true };'],
		["computed destructuring property", 'const { ["node:fs"]: value } = source;'],
		["destructuring default string", 'const { node: value = "prefix node:fs" } = source;'],
		["line comment", "// node:fs\nexport const value = 1;"],
		["block comment", "/* node:fs */ export const value = 1;"],
		["label", "node: for (;;) { break node; }"],
		["regex", "const value = /node:fs/;"],
		["suffix Identifier key", "const value = { anode: 1 };"],
		["ordinary key plus string", 'const value = { node: 0 }; const name = "prefix node:fs";'],
		["ordinary key plus comment", "const value = { node: 0 }; // node:fs"],
		["ordinary key plus label", "const value = { node: 0 }; node: for (;;) { break node; }"],
	])("retains the raw node: refusal for %s", (_name, source) => {
		expect(() => verifyBrowserBundle(source, runtimeImports, [])).toThrowError(new Error(blocked));
	});

	it.each([
		"export const value =",
		"const value = { node: };",
		'const value = "node:fs;',
		"/* unterminated",
	])("fails closed on malformed source %s", (source) => {
		expect(() => verifyBrowserBundle(source, runtimeImports, [])).toThrowError(new Error(blocked));
	});

	it("does not keep regex or exemption state between calls", () => {
		const ordinary = "export const value = { node: 0 };";
		for (let index = 0; index < 3; index++) {
			expect(() => verifyBrowserBundle(ordinary, runtimeImports, [])).not.toThrow();
			expect(() =>
				verifyBrowserBundle('const value = "prefix node:fs";', runtimeImports, []),
			).toThrowError(new Error(blocked));
		}
	});

	it("keeps every other refusal after an ordinary node-key exemption", () => {
		const ordinary = "export const value = { node: 0 };";
		expect(() =>
			verifyBrowserBundle(`${ordinary} const createHash = () => 1;`, runtimeImports, []),
		).toThrowError(new Error(blocked));
		expect(() =>
			verifyBrowserBundle(`${ordinary} __vite-browser-external;`, runtimeImports, []),
		).toThrowError(new Error(blocked));
		expect(() => verifyBrowserBundle(ordinary, runtimeImports, ["unknown"])).toThrowError(
			new Error(blocked),
		);
		expect(() => verifyBrowserBundle(ordinary, [...runtimeImports, "fs"], [])).toThrowError(
			new Error(external),
		);
		for (const missing of runtimeImports) {
			expect(() =>
				verifyBrowserBundle(
					ordinary,
					runtimeImports.filter((name) => name !== missing),
					[],
				),
			).toThrowError(new Error(missingRuntime));
		}
	});
});
