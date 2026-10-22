// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the samples are module text with templates.
import { describe, expect, it } from "vitest";
import { literals, relativeLiterals, runtimeSpecifiers } from "../lib/imports.ts";

const kinds = (text: string): string[][] => literals(text).map(({ kind, value }) => [kind, value]);
// A backslash, so escapes reach the scanner as source text.
const bs = "\\";

describe("literals", () => {
	const everyKind = [
		'import a from "./static.ts";',
		'import "./bare.ts";',
		'export * from "./star.ts";',
		'export { b } from "./named.ts";',
		'const c = await import("./dynamic.ts");',
		'const d = require("./require.cjs");',
		'const e = require.resolve("./resolve.cjs");',
		'const f = import.meta.resolve("./meta-resolve.ts");',
		'const g = new URL("./url.json", import.meta.url);',
		'const h = createRequire(import.meta.url)("./made.cjs");',
		'/// <reference path="./reference.d.ts" />',
		'const i = "./other.ts";',
		'import type { T } from "./type.ts";',
	].join("\n");

	it("names the kind of code that uses each literal", () => {
		expect(kinds(everyKind)).toEqual([
			["static", "./static.ts"],
			["bare", "./bare.ts"],
			["static", "./star.ts"],
			["static", "./named.ts"],
			["dynamic", "./dynamic.ts"],
			["require", "./require.cjs"],
			["resolve", "./resolve.cjs"],
			["resolve", "./meta-resolve.ts"],
			["url", "./url.json"],
			["create-require", "./made.cjs"],
			["reference", "./reference.d.ts"],
			["other", "./other.ts"],
			["type", "./type.ts"],
		]);
	});

	it("reads type-only imports and exports as type across lines, and import { type x } as runtime", () => {
		const text = [
			"import type {",
			"\tA,",
			"\tB,",
			'} from "./types-a.ts";',
			"export type {",
			"\tC,",
			'} from "./types-c.ts";',
			'import type * as D from "./types-d.ts";',
			'import type E from "./types-e.ts";',
			'export type * from "./types-f.ts";',
			'import type G = require("./types-g.cjs");',
			"import {",
			"\ttype H,",
			"\ttype I,",
			'} from "./runtime-h.ts";',
			'export { type J } from "./runtime-j.ts";',
			'import type, { K } from "./runtime-k.ts";',
			'import type from "./runtime-default.ts";',
			'import L = require("./runtime-l.cjs");',
		].join("\n");
		expect(kinds(text)).toEqual([
			["type", "./types-a.ts"],
			["type", "./types-c.ts"],
			["type", "./types-d.ts"],
			["type", "./types-e.ts"],
			["type", "./types-f.ts"],
			["type", "./types-g.cjs"],
			["static", "./runtime-h.ts"],
			["static", "./runtime-j.ts"],
			["static", "./runtime-k.ts"],
			["static", "./runtime-default.ts"],
			["require", "./runtime-l.cjs"],
		]);
	});

	it("reads a statement's own specifier only, not the strings after it", () => {
		const text = [
			'import data from "./data.json" with { type: "json" };',
			'export const name = "./after-export.ts";',
			'export default { load: () => import("./in-export.ts") };',
		].join("\n");
		expect(kinds(text)).toEqual([
			["static", "./data.json"],
			["other", "json"],
			["other", "./after-export.ts"],
			["dynamic", "./in-export.ts"],
		]);
	});

	it("reads triple-slash references, and nothing from other comments", () => {
		const text = [
			'/// <reference path="./globals.d.ts" />',
			"/// <reference types='node' />",
			'/// <reference lib="es2025" />',
			'// <reference path="./two-slashes.d.ts" />',
			'/* /// <reference path="./in-block.d.ts" /> */',
			'import a from "./a.ts";',
		].join("\n");
		expect(kinds(text)).toEqual([
			["reference", "./globals.d.ts"],
			["reference", "node"],
			["static", "./a.ts"],
		]);
	});

	it("skips samples in comments, regular expressions and templates, and reads the code around them", () => {
		const text = [
			'// import x from "./line-comment.ts";',
			'/* const y = require("./block-comment.cjs"); */',
			'const pattern = /import\\("\\.\\/in-regex"\\)/;',
			'const quote = /["\']/g; const after = await import("./after-regex.ts");',
			'const ratio = total / count; const later = require("./after-division.cjs"); const rest = a / b;',
			'const half = 10 / 2; const next = require("./after-number.cjs"); const part = (a) / 4;',
			'const sample = `import z from "./in-template.ts";`;',
			'const built = `${await import("./in-substitution.ts")}`;',
			'const nested = `a${`b${require("./nested.cjs")}`}`;',
			'const close = `${{ a: 1 }.a}${/["}]/.test(s)}`; import("./after-template.ts");',
		].join("\n");
		expect(kinds(text)).toEqual([
			["dynamic", "./after-regex.ts"],
			["require", "./after-division.cjs"],
			["require", "./after-number.cjs"],
			["other", 'import z from "./in-template.ts";'],
			["other", "${}"],
			["dynamic", "./in-substitution.ts"],
			["other", "a${}"],
			["other", "b${}"],
			["require", "./nested.cjs"],
			["other", "${}${}"],
			["dynamic", "./after-template.ts"],
		]);
	});

	it("reads a module after a hashbang line and through optional chaining", () => {
		const text = [
			"#!/usr/bin/env node",
			'import a from "./a.ts";',
			'const b = require?.resolve?.("./b.cjs");',
		].join("\n");
		expect(kinds(text)).toEqual([
			["static", "./a.ts"],
			["resolve", "./b.cjs"],
		]);
	});

	it("follows createRequire and require through the names they are bound to", () => {
		const text = [
			'import { createRequire as makeRequire } from "node:module";',
			"const load = createRequire(import.meta.url);",
			'load("pkg-made");',
			'load.resolve("pkg-made-resolve");',
			"const local: NodeJS.Require = makeRequire(import.meta.url);",
			'local("pkg-renamed");',
			"const plain = require;",
			'plain("pkg-plain");',
			'createRequire(import.meta.url).resolve("pkg-direct");',
			'createRequire("/abs/base/");',
			'unrelated("pkg-unrelated");',
			"const compared = other === createRequire(import.meta.url);",
			'compared("pkg-compared");',
		].join("\n");
		expect(kinds(text)).toEqual([
			["static", "node:module"],
			["create-require", "pkg-made"],
			["resolve", "pkg-made-resolve"],
			["create-require", "pkg-renamed"],
			["require", "pkg-plain"],
			["resolve", "pkg-direct"],
			["create-require", "/abs/base/"],
			["other", "pkg-unrelated"],
			["other", "pkg-compared"],
		]);
	});

	it("reads new URL as module-relative only against import.meta.url", () => {
		const text = [
			'new URL("data/a.json", import.meta.url);',
			"new URL(`./b-${name}.json`, import.meta.url,);",
			'new URL("/c", location.href);',
			'new URL("https://example.com/d");',
			'URL("./e.json", import.meta.url);',
		].join("\n");
		expect(kinds(text)).toEqual([
			["url", "data/a.json"],
			["url", "./b-${}.json"],
			["other", "/c"],
			["other", "https://example.com/d"],
			["other", "./e.json"],
		]);
	});

	it("cooks escapes, so an escaped specifier or name reads as what it loads", () => {
		const text = [
			`import("${bs}u002e/escaped-u.ts");`,
			`require("${bs}x2e${bs}x2e/escaped-x.cjs");`,
			`import("${bs}u{2e}/escaped-braced.ts");`,
			`requir${bs}u0065("./escaped-name.cjs");`,
			`import("./line-${bs}\ncontinued.ts");`,
			`const quoted = "a${bs}"b";`,
		].join("\n");
		expect(kinds(text)).toEqual([
			["dynamic", "./escaped-u.ts"],
			["require", "../escaped-x.cjs"],
			["dynamic", "./escaped-braced.ts"],
			["require", "./escaped-name.cjs"],
			["dynamic", "./line-continued.ts"],
			["other", 'a"b'],
		]);
	});

	it("reads an import() in a type position as a runtime import", () => {
		const text = 'type T = typeof import("./typed.ts");\nlet u: import("./annotated.ts").U;';
		expect(kinds(text)).toEqual([
			["dynamic", "./typed.ts"],
			["dynamic", "./annotated.ts"],
		]);
	});

	it("ends an unterminated string at its line, and reads the next line", () => {
		expect(kinds('const broken = "./open.ts\nimport("./next.ts");')).toEqual([
			["other", "./open.ts"],
			["dynamic", "./next.ts"],
		]);
	});
});

describe("runtimeSpecifiers", () => {
	it("keeps every kind but type and other", () => {
		const text = [
			'import a from "./static.ts";',
			'import "./bare.ts";',
			'const c = import("./dynamic.ts");',
			'const d = require("./require.cjs");',
			'const e = require.resolve("./resolve.cjs");',
			'const f = new URL("./url.json", import.meta.url);',
			'const g = createRequire(import.meta.url)("./made.cjs");',
			'/// <reference path="./reference.d.ts" />',
			'const h = "./other.ts";',
			'import type { T } from "./type.ts";',
		].join("\n");
		expect(runtimeSpecifiers(text).map(({ kind }) => kind)).toEqual([
			"static",
			"bare",
			"dynamic",
			"require",
			"resolve",
			"url",
			"create-require",
			"reference",
		]);
	});
});

describe("relativeLiterals", () => {
	it("keeps every literal that starts with ./ or ../, whatever its kind", () => {
		const text = [
			'import type { T } from "../type.ts";',
			'const data = "./data.json";',
			'import "pkg";',
			'const here = ".";',
			'const up = "..";',
			'const absolute = "/abs/x.ts";',
			'const hidden = ".hidden/x.ts";',
			'const loaded = require("../up.cjs");',
		].join("\n");
		expect(relativeLiterals(text).map(({ kind, value }) => [kind, value])).toEqual([
			["type", "../type.ts"],
			["other", "./data.json"],
			["require", "../up.cjs"],
		]);
	});
});
