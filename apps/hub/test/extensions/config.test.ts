import { createHash } from "node:crypto";
import { linkSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	CONFIG_FILE,
	loadExtensionConfig,
	MAX_CONFIG_BYTES,
	MAX_MODULES,
	parseExtensionConfig,
} from "../../src/extensions/config.ts";
import { type Fixture, fixture, pin, refused, refusedNow, resetTrace, trace } from "./helpers.ts";

let f: Fixture;
beforeEach(() => {
	resetTrace();
	f = fixture();
});
afterEach(() => f.remove());

const digest = createHash("sha512").update("module").digest();
const valid = (): Record<string, unknown> => ({
	id: "alpha",
	version: "1.2.3-rc.1+build.5",
	entry: path.join(f.dir, "alpha", "index.mjs"),
	sha512: `sha512-${digest.toString("base64")}`,
	provides: ["sendPolicy", "adminOp"],
	migrations: {
		directory: path.join(f.dir, "alpha", "migrations"),
		files: [
			{ name: "0001_rows.sql", sha512: pin("one") },
			{ name: "0003_more_rows.sql", sha512: pin("three") },
		],
	},
});
const bytes = (document: unknown): Buffer => Buffer.from(JSON.stringify(document));
const parse = (document: unknown) => parseExtensionConfig(bytes(document));
const without = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
	const copy = { ...record };
	delete copy[key];
	return copy;
};
const noncanonical = (): string => {
	const text = digest.toString("base64");
	const last = text.charAt(85);
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	return `sha512-${text.slice(0, 85)}${alphabet.charAt(alphabet.indexOf(last) ^ 1)}==`;
};

describe("parsing", () => {
	it("returns a frozen module list with decoded pins and declared services", () => {
		const config = parse({ modules: [valid()] });
		const [module] = config.modules;
		expect(Object.isFrozen(config)).toBe(true);
		expect(Object.isFrozen(config.modules)).toBe(true);
		expect(module?.id).toBe("alpha");
		expect(module?.version).toBe("1.2.3-rc.1+build.5");
		expect(module?.sha512.equals(digest)).toBe(true);
		expect([...(module?.provides ?? [])]).toEqual(["sendPolicy", "adminOp"]);
		expect(module?.migrations?.files.map((file) => file.name)).toEqual([
			"0001_rows.sql",
			"0003_more_rows.sql",
		]);
		expect(parse({ modules: [] }).modules).toEqual([]);
		expect(parseExtensionConfig(Buffer.from(` {\n "modules" : [ ] }\n`)).modules).toEqual([]);
	});

	const module = (change: (record: Record<string, unknown>) => unknown) => ({
		modules: [change(valid())],
	});
	const migrations = (change: (record: Record<string, unknown>) => unknown) =>
		module((record) => ({
			...record,
			migrations: change(record.migrations as Record<string, unknown>),
		}));
	const refusals: [string, () => unknown][] = [
		["a top level that is not an object", () => [valid()]],
		["a missing module list", () => ({})],
		["an exposure setting", () => ({ modules: [], publicBaseUrl: "https://example.test" })],
		["a bind address", () => ({ modules: [], bind: ["0.0.0.0:47614"] })],
		["a module list that is not an array", () => ({ modules: { alpha: valid() } })],
		[
			"too many modules",
			() => ({
				modules: Array.from({ length: MAX_MODULES + 1 }, (_, index) => ({
					...valid(),
					id: `m${index}`,
				})),
			}),
		],
		[
			"a repeated module id",
			() => ({ modules: [valid(), { ...valid(), entry: path.join(f.dir, "b.mjs") }] }),
		],
		["a module that is not an object", () => ({ modules: ["alpha"] })],
		["a missing id", () => module((record) => without(record, "id"))],
		["a missing pin", () => module((record) => without(record, "sha512"))],
		["missing provides", () => module((record) => without(record, "provides"))],
		["a missing version", () => module((record) => without(record, "version"))],
		["an unknown module field", () => module((record) => ({ ...record, routing: "all" }))],
		["an uppercase id", () => module((record) => ({ ...record, id: "Alpha" }))],
		["an id starting with a digit", () => module((record) => ({ ...record, id: "1alpha" }))],
		["an overlong id", () => module((record) => ({ ...record, id: `a${"b".repeat(64)}` }))],
		["a version range", () => module((record) => ({ ...record, version: "^1.2.3" }))],
		["a partial version", () => module((record) => ({ ...record, version: "1.2" }))],
		["a leading-zero version", () => module((record) => ({ ...record, version: "01.2.3" }))],
		["a leading-zero prerelease", () => module((record) => ({ ...record, version: "1.2.3-01" }))],
		["a relative entry", () => module((record) => ({ ...record, entry: "alpha/index.mjs" }))],
		[
			"a non-canonical entry",
			() =>
				module((record) => ({
					...record,
					entry: `${f.dir}${path.sep}x${path.sep}..${path.sep}index.mjs`,
				})),
		],
		[
			"a CommonJS entry",
			() => module((record) => ({ ...record, entry: path.join(f.dir, "index.js") })),
		],
		[
			"an entry with a NUL",
			() => module((record) => ({ ...record, entry: path.join(f.dir, "a\u0000.mjs") })),
		],
		[
			"a sha256 pin",
			() =>
				module((record) => ({
					...record,
					sha512: `sha256-${createHash("sha256").update("m").digest("base64")}`,
				})),
		],
		["a hex pin", () => module((record) => ({ ...record, sha512: digest.toString("hex") }))],
		[
			"a non-canonical base64 pin",
			() => module((record) => ({ ...record, sha512: noncanonical() })),
		],
		[
			"a truncated pin",
			() =>
				module((record) => ({
					...record,
					sha512: `sha512-${digest.subarray(0, 63).toString("base64")}`,
				})),
		],
		[
			"an unpadded pin",
			() =>
				module((record) => ({
					...record,
					sha512: `sha512-${digest.toString("base64").slice(0, -2)}`,
				})),
		],
		["an unknown service", () => module((record) => ({ ...record, provides: ["onEvent"] }))],
		["a repeated service", () => module((record) => ({ ...record, provides: ["push", "push"] }))],
		["services that are not an array", () => module((record) => ({ ...record, provides: "push" }))],
		["an empty migration list", () => migrations((record) => ({ ...record, files: [] }))],
		[
			"a migration name outside the grammar",
			() =>
				migrations((record) => ({
					...record,
					files: [{ name: "0001_Rows.sql", sha512: pin("x") }],
				})),
		],
		[
			"a migration numbered zero",
			() =>
				migrations((record) => ({
					...record,
					files: [{ name: "0000_rows.sql", sha512: pin("x") }],
				})),
		],
		[
			"migrations out of order",
			() =>
				migrations((record) => ({ ...record, files: [...(record.files as unknown[])].reverse() })),
		],
		[
			"a repeated migration number",
			() =>
				migrations((record) => ({
					...record,
					files: [
						{ name: "0001_a.sql", sha512: pin("a") },
						{ name: "0001_b.sql", sha512: pin("b") },
					],
				})),
		],
		[
			"a migration without its pin",
			() => migrations((record) => ({ ...record, files: [{ name: "0001_rows.sql" }] })),
		],
		[
			"a relative migrations folder",
			() => migrations((record) => ({ ...record, directory: "migrations" })),
		],
		["an unknown migrations field", () => migrations((record) => ({ ...record, apply: true }))],
	];
	it.each(refusals)("refuses %s", (_, document) => {
		refusedNow("config", () => parse(document()));
	});

	it.each([
		["text after the document", '{"modules":[]} {}'],
		["a repeated member name", '{"modules":[],"modules":[]}'],
		["a byte-order mark", '\ufeff{"modules":[]}'],
		["invalid UTF-8", Buffer.from([0x7b, 0xff, 0x7d])],
		["a lone surrogate", '{"modules":[],"x":"\\ud800"}'],
	])("refuses %s", (_, text) => {
		refusedNow("config", () => parseExtensionConfig(Buffer.from(text as string)));
	});
});

describe("loading", () => {
	it("treats a missing config.json as no modules", () => {
		expect(loadExtensionConfig(f.dir).modules).toEqual([]);
	});

	it("refuses an oversized, linked or non-file config.json before any module code runs", async () => {
		const configured = f.module("alpha");
		const file = path.join(f.dir, CONFIG_FILE);
		writeFileSync(
			file,
			`${JSON.stringify({ modules: [{ ...configured, version: "1.0.0" }] })}${" ".repeat(MAX_CONFIG_BYTES)}`,
		);
		await refused("config", f.start());
		f.config([configured]);
		linkSync(file, path.join(f.dir, "config-copy.json"));
		await refused("config", f.start());
		const directory = fixture();
		try {
			mkdirSync(path.join(directory.dir, CONFIG_FILE));
			await refused("config", directory.start());
		} finally {
			directory.remove();
		}
		expect(trace()).toEqual([]);
	});

	it("refuses a configured module list holding an exposure setting", async () => {
		writeFileSync(
			path.join(f.dir, CONFIG_FILE),
			JSON.stringify({ modules: [], trustedProxies: ["127.0.0.1"] }),
		);
		await refused("config", f.start());
	});
});
