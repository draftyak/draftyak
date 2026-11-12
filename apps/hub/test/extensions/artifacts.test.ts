import {
	existsSync,
	linkSync,
	mkdirSync,
	readFileSync,
	renameSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	MAX_ENTRY_BYTES,
	MAX_MIGRATION_BYTES,
	MAX_MIGRATION_TOTAL_BYTES,
	moduleUrl,
	reverifyModule,
	verifyModule,
} from "../../src/extensions/artifacts.ts";
import { parseExtensionConfig } from "../../src/extensions/config.ts";
import {
	type Fixture,
	fixture,
	type ModuleEntry,
	pin,
	refused,
	refusedNow,
	resetTrace,
	trace,
} from "./helpers.ts";

let f: Fixture;
beforeEach(() => {
	resetTrace();
	f = fixture();
});
afterEach(() => f.remove());

const rows = { "0001_rows.sql": "CREATE TABLE ext_beta_rows(id TEXT PRIMARY KEY) STRICT;" };
const swap = (file: string, text: string): string =>
	`(await import("node:fs")).writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)});`;
const configOf = (...modules: ModuleEntry[]) =>
	parseExtensionConfig(
		Buffer.from(
			JSON.stringify({ modules: modules.map((module) => ({ version: "1.0.0", ...module })) }),
		),
	);

describe("pins before module code", () => {
	it("checks every pin before any configured module runs", async () => {
		const alpha = f.module("alpha");
		const beta = f.module("beta");
		f.config([alpha, { ...beta, sha512: pin("other module") }]);
		await refused("artifact", f.start());
		expect(trace()).toEqual([]);
		expect(existsSync(path.join(f.dir, "ext-alpha.db"))).toBe(false);
	});

	it("refuses an entry whose bytes changed after it was pinned", async () => {
		const alpha = f.module("alpha");
		f.config([alpha]);
		writeFileSync(alpha.entry, `${readFileSync(alpha.entry, "utf8")}\n// changed\n`);
		await refused("artifact", f.start());
		expect(trace()).toEqual([]);
	});

	it("refuses a migration whose bytes do not match its pin", async () => {
		const beta = f.module("beta", "", { migrations: rows });
		const file = path.join(beta.migrations?.directory ?? "", "0001_rows.sql");
		f.config([beta]);
		writeFileSync(file, "CREATE TABLE ext_beta_rows(id TEXT) STRICT;");
		await refused("artifact", f.start());
		expect(trace()).toEqual([]);
		expect(existsSync(path.join(f.dir, "ext-beta.db"))).toBe(false);
	});

	it.each([
		["an entry", MAX_ENTRY_BYTES + 1, "entry"],
		["a migration", MAX_MIGRATION_BYTES + 1, "migration"],
	])("refuses %s over its size bound even with a matching pin", async (_, size, kind) => {
		const alpha = f.module("alpha", "", { migrations: { "0001_rows.sql": "SELECT 1;" } });
		const target =
			kind === "entry"
				? alpha.entry
				: path.join(alpha.migrations?.directory ?? "", "0001_rows.sql");
		const content = Buffer.alloc(size, 0x20);
		writeFileSync(target, content);
		const migrations = alpha.migrations && {
			...alpha.migrations,
			files: [
				{ name: "0001_rows.sql", sha512: kind === "entry" ? pin("SELECT 1;") : pin(content) },
			],
		};
		f.config([{ ...alpha, ...(kind === "entry" ? { sha512: pin(content) } : {}), migrations }]);
		await refused("artifact", f.start());
		expect(trace()).toEqual([]);
	});

	it("refuses migrations whose total size is over the bound", async () => {
		const chunk = `-- ${"x".repeat(MAX_MIGRATION_BYTES - 4)}\n`;
		const count = Math.floor(MAX_MIGRATION_TOTAL_BYTES / chunk.length) + 1;
		const files = Object.fromEntries(
			Array.from({ length: count }, (_, index) => [
				`${String(index + 1).padStart(4, "0")}_part.sql`,
				chunk,
			]),
		);
		f.config([f.module("alpha", "", { migrations: files })]);
		await refused("artifact", f.start());
		expect(trace()).toEqual([]);
	});
});

describe("migration inventory", () => {
	const migrated = (): ModuleEntry =>
		f.module("alpha", "", {
			migrations: {
				"0001_rows.sql": "CREATE TABLE ext_alpha_rows(id TEXT) STRICT;",
				"0002_more.sql": "CREATE TABLE ext_alpha_more(id TEXT) STRICT;",
			},
		});
	const folder = (entry: ModuleEntry): string => entry.migrations?.directory ?? "";

	it("accepts exactly the pinned files", async () => {
		f.config([migrated()]);
		expect((await f.start()).modules).toEqual([{ id: "alpha", version: "1.0.0" }]);
	});

	it.each([
		[
			"an extra file",
			(dir: string) => writeFileSync(path.join(dir, "0003_extra.sql"), "SELECT 1;"),
		],
		["a stray non-SQL file", (dir: string) => writeFileSync(path.join(dir, ".DS_Store"), "")],
		["a nested folder", (dir: string) => mkdirSync(path.join(dir, "nested"))],
		[
			"a missing file",
			(dir: string) =>
				renameSync(path.join(dir, "0002_more.sql"), path.join(dir, "..", "0002_more.sql")),
		],
		[
			"a hard-linked file",
			(dir: string) =>
				linkSync(path.join(dir, "0001_rows.sql"), path.join(dir, "..", "rows-copy.sql")),
		],
	])("refuses %s in the migrations folder", async (_, change) => {
		const alpha = migrated();
		f.config([alpha]);
		change(folder(alpha));
		await refused("artifact", f.start());
		expect(trace()).toEqual([]);
	});

	it("refuses a migrations folder or entry reached through a directory link", async () => {
		const alpha = migrated();
		const alias = path.join(f.dir, "alias");
		symlinkSync(path.dirname(alpha.entry), alias, "junction");
		f.config([
			{ ...alpha, migrations: { ...alpha.migrations, directory: path.join(alias, "migrations") } },
		]);
		await refused("artifact", f.start());
		f.config([{ ...alpha, entry: path.join(alias, "index.mjs") }]);
		await refused("artifact", f.start());
		expect(trace()).toEqual([]);
	});

	it("refuses a hard-linked entry", async () => {
		const alpha = f.module("alpha");
		linkSync(alpha.entry, path.join(f.dir, "entry-copy.mjs"));
		f.config([alpha]);
		await refused("artifact", f.start());
		expect(trace()).toEqual([]);
	});

	it.each([
		["a pragma", "PRAGMA key = 'other';"],
		["an attachment", "ATTACH DATABASE 'other.db' AS other;"],
		["transaction control", "BEGIN; CREATE TABLE ext_alpha_rows(id TEXT); COMMIT;"],
		["a pragma function", "CREATE TABLE ext_alpha_rows AS SELECT * FROM pragma_table_list;"],
		["a vacuum", "VACUUM INTO 'copy.db';"],
	])("refuses a migration with %s before any database opens", async (_, sql) => {
		f.config([f.module("alpha", "", { migrations: { "0001_rows.sql": sql } })]);
		await refused("database", f.start());
		expect(existsSync(path.join(f.dir, "ext-alpha.db"))).toBe(false);
		expect(trace()).toEqual([]);
	});

	it("refuses migration bytes that are not UTF-8", async () => {
		const alpha = f.module("alpha", "", { migrations: { "0001_rows.sql": "SELECT 1;" } });
		const invalid = Buffer.from([0x53, 0x45, 0xff, 0x3b]);
		writeFileSync(path.join(folder(alpha), "0001_rows.sql"), invalid);
		f.config([
			{
				...alpha,
				migrations: {
					...alpha.migrations,
					files: [{ name: "0001_rows.sql", sha512: pin(invalid) }],
				},
			},
		]);
		await refused("database", f.start());
		expect(existsSync(path.join(f.dir, "ext-alpha.db"))).toBe(false);
	});
});

describe("the load boundary", () => {
	it("refuses an entry swapped after verification by a module that ran earlier", async () => {
		const beta = f.module("beta");
		const alpha = f.module(
			"alpha",
			swap(
				beta.entry,
				'globalThis[Symbol.for("draftyak.test.extensions")].push("swapped:ran"); export default {};',
			),
		);
		f.config([alpha, beta]);
		await refused("artifact", f.start());
		expect(trace()).toEqual(["alpha:loaded", "alpha:register"]);
	});

	it("refuses a migration swapped after verification by a module that ran earlier", async () => {
		const beta = f.module("beta", "", { migrations: rows });
		const file = path.join(beta.migrations?.directory ?? "", "0001_rows.sql");
		const alpha = f.module("alpha", swap(file, "CREATE TABLE ext_beta_rows(id TEXT) STRICT;"));
		f.config([alpha, beta]);
		await refused("artifact", f.start());
		expect(trace()).toEqual(["alpha:loaded", "alpha:register"]);
	});

	it("imports the verified bytes rather than reading the file again", async () => {
		const alpha = f.module("alpha", "", { top: "trace.push(import.meta.url.slice(0, 28));" });
		const [configured] = configOf(alpha).modules;
		if (!configured) throw new Error("module missing");
		const verified = verifyModule(configured);
		const original = readFileSync(alpha.entry);
		writeFileSync(alpha.entry, "export default {};");
		refusedNow("artifact", () => reverifyModule(verified));
		const url = moduleUrl(verified);
		expect(url.startsWith("data:text/javascript;base64,")).toBe(true);
		expect(
			Buffer.from(url.slice("data:text/javascript;base64,".length), "base64").equals(original),
		).toBe(true);
		writeFileSync(alpha.entry, original);
		f.config([alpha]);
		await f.start();
		expect(trace()).toEqual(["alpha:loaded", "data:text/javascript;base64,", "alpha:register"]);
	});

	it("never loads an unpinned file next to the entry", async () => {
		const alpha = f.module("alpha", "", { top: 'import "./helper.mjs";' });
		writeFileSync(
			path.join(path.dirname(alpha.entry), "helper.mjs"),
			'globalThis[Symbol.for("draftyak.test.extensions")].push("helper:ran");',
		);
		f.config([alpha]);
		await refused("module", f.start());
		expect(trace()).toEqual([]);
	});
});
