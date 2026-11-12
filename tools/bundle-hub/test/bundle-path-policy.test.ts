import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as bundleModule from "../src/bundle.ts";
import { type BundleSpec, bundle, NATIVE_REQUIRED, parseSpec } from "../src/bundle.ts";
import { main } from "../src/cli.ts";
import * as inventoryModule from "../src/inventory.ts";
import { hubMigrationFixture } from "./helpers/hub-migrations-fixture.ts";

const base = path.resolve(import.meta.dirname, "../.cache/bundle-path-policy-input");
const output = path.join(base, "new-output");
const record = (file: string) => ({ path: file, bytes: 1, sha256: "a".repeat(64) });
function spec(): BundleSpec {
	return {
		schemaVersion: 1,
		version: "0.1.0",
		target: { platform: "linux", arch: "x64" },
		hub: {
			root: path.join(base, "hub"),
			files: [
				"hub.mjs",
				"spa/index.html",
				"plugins/fixture.mjs",
				...Object.keys(hubMigrationFixture()),
			]
				.sort()
				.map(record),
		},
		cli: {
			root: path.join(base, "cli"),
			files: ["main.mjs", "package.json"].map(record),
		},
		native: {
			archive: path.join(base, "native.tgz"),
			files: NATIVE_REQUIRED.toSorted().map(record),
		},
		node: { root: path.join(base, "node") },
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});

function denyFilesystem(): readonly ReturnType<typeof vi.spyOn>[] {
	const denied = (): never => {
		throw new Error("Unexpected filesystem lookup or creation");
	};
	const spies = [
		vi.spyOn(fs, "lstatSync").mockImplementation(denied),
		vi.spyOn(fs, "openSync").mockImplementation(denied),
		vi.spyOn(fs, "readSync").mockImplementation(denied),
		vi.spyOn(fs, "readFileSync").mockImplementation(denied),
		vi.spyOn(fs, "readdirSync").mockImplementation(denied),
		vi.spyOn(fs, "mkdirSync").mockImplementation(denied),
		vi.spyOn(fs, "mkdtempSync").mockImplementation(denied),
		vi.spyOn(fs, "writeFileSync").mockImplementation(denied),
		vi.spyOn(fs, "renameSync").mockImplementation(denied),
	];
	syncBuiltinESMExports();
	return spies;
}

describe.each(["C:", "C:relative", "C:.", "C:..", "C:..\\spec.json", "c:../input"])(
	"public bundle drive-relative admission %s",
	(raw) => {
		it.each(["hub", "cli", "native", "node"] as const)(
			"refuses a drive-relative %s input before lookup or creation",
			async (input) => {
				const value = spec();
				const altered =
					input === "native"
						? { ...value, native: { ...value.native, archive: raw } }
						: { ...value, [input]: { ...value[input], root: raw } };
				const spies = denyFilesystem();
				await expect(bundle(altered, output)).rejects.toThrow("drive-relative paths are refused");
				for (const spy of spies) expect(spy).not.toHaveBeenCalled();
			},
		);
		it("refuses a drive-relative output before lookup or creation", async () => {
			const value = spec();
			const spies = denyFilesystem();
			await expect(bundle(value, raw)).rejects.toThrow("drive-relative paths are refused");
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		});
		it("refuses a drive-relative parse base before normalization", () => {
			const value = spec();
			const spies = denyFilesystem();
			expect(() => parseSpec(value, raw)).toThrow("drive-relative paths are refused");
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		});
		it.each(["--spec", "--out"])("CLI refuses drive-relative %s before reading", async (flag) => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const spies = denyFilesystem();
			expect(
				await main([
					"--spec",
					flag === "--spec" ? raw : path.join(base, "spec.json"),
					"--out",
					flag === "--out" ? raw : output,
				]),
			).toBe(1);
			expect(errors).toHaveBeenCalledExactlyOnceWith(
				"bundle-hub: drive-relative paths are refused",
			);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		});
	},
);

describe.each(["/./", "/.env-not-created/../", "\\.env-not-created\\..\\"])(
	"public bundle admission with raw alias %s",
	(alias) => {
		it.each(["hub", "cli", "native", "node"] as const)(
			"refuses a raw %s input before any lookup or creation",
			async (input) => {
				const value = spec();
				const raw = `${base}${alias}input`;
				const altered =
					input === "native"
						? { ...value, native: { ...value.native, archive: raw } }
						: { ...value, [input]: { ...value[input], root: raw } };
				const spies = denyFilesystem();
				await expect(bundle(altered, output)).rejects.toThrow(
					"raw dot path components are refused",
				);
				for (const spy of spies) expect(spy).not.toHaveBeenCalled();
			},
		);
		it("refuses raw output before any lookup or creation", async () => {
			const value = spec();
			const spies = denyFilesystem();
			await expect(bundle(value, `${base}${alias}new-output`)).rejects.toThrow(
				"raw dot path components are refused",
			);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		});
		it("refuses a raw parse base before normalization", () => {
			const value = spec();
			const spies = denyFilesystem();
			expect(() => parseSpec(value, `${base}${alias}base`)).toThrow(
				"raw dot path components are refused",
			);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		});
		it.each(["--spec", "--out"])("CLI refuses raw %s before reading its spec", async (flag) => {
			const specFile = path.join(base, "spec.json");
			const raw = `${base}${alias}input`;
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const spies = denyFilesystem();
			const result = await main([
				"--spec",
				flag === "--spec" ? raw : specFile,
				"--out",
				flag === "--out" ? raw : output,
			]);
			expect(result).toBe(1);
			expect(errors).toHaveBeenCalledExactlyOnceWith(
				"bundle-hub: raw dot path components are refused",
			);
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		});
	},
);

it("parses canonical source inputs without filesystem lookups", () => {
	const value = spec();
	const spies = denyFilesystem();
	expect(parseSpec(value, base)).toEqual(value);
	for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it("passes canonical explicit CLI paths to the existing reader and bundler", async () => {
	const value = spec();
	const specFile = path.join(base, "spec.json");
	const reads = vi
		.spyOn(inventoryModule, "regularBytes")
		.mockReturnValue(Buffer.from(JSON.stringify(value)));
	const bundled = vi.spyOn(bundleModule, "bundle").mockResolvedValue();
	const messages = vi.spyOn(console, "log").mockImplementation(() => {});
	const spies = denyFilesystem();
	expect(await main(["--spec", specFile, "--out", output])).toBe(0);
	expect(reads).toHaveBeenCalledExactlyOnceWith(specFile);
	expect(bundled).toHaveBeenCalledExactlyOnceWith(value, output);
	expect(messages).toHaveBeenCalledExactlyOnceWith("bundle-hub: candidate staged and inventoried");
	for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});

it("retains CLI help and missing-argument refusal without filesystem lookups", async () => {
	const messages = vi.spyOn(console, "log").mockImplementation(() => {});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const spies = denyFilesystem();
	expect(await main(["--help"])).toBe(0);
	expect(messages).toHaveBeenCalledExactlyOnceWith(
		"usage: bundle-hub --spec <reviewed-input.json> --out <new-directory>",
	);
	expect(await main([])).toBe(1);
	expect(errors).toHaveBeenCalledExactlyOnceWith("bundle-hub: --spec and --out are required");
	for (const spy of spies) expect(spy).not.toHaveBeenCalled();
});
