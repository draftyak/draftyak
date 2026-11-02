import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { directory, localPath, read } from "../../release-guard/src/integrity.ts";
import { noDotComponents, noLinks, regularBytes } from "../src/inventory.ts";

const parent = path.resolve(import.meta.dirname, "../.cache");
fs.mkdirSync(parent, { recursive: true });
const scratch = fs.mkdtempSync(path.join(parent, "path-policy-"));
const identity = fs.lstatSync(scratch, { bigint: true });
const canonical = path.join(scratch, "version.26");
fs.mkdirSync(canonical);
const bytes = Buffer.from("synthetic inert path-policy input");
const file = path.join(canonical, "payload..bin");
fs.writeFileSync(file, bytes);

afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});
afterAll(() => {
	const current = fs.lstatSync(scratch, { bigint: true });
	if (
		path.dirname(scratch) !== parent ||
		!path.basename(scratch).startsWith("path-policy-") ||
		current.isSymbolicLink() ||
		!current.isDirectory() ||
		current.dev !== identity.dev ||
		current.ino !== identity.ino ||
		fs.realpathSync(scratch) !== path.join(fs.realpathSync(parent), path.basename(scratch))
	)
		throw new Error("Unsafe path-policy fixture cleanup");
	fs.rmSync(scratch, { recursive: true, force: true });
});

const aliases = [
	".",
	"..",
	`${canonical}/./payload..bin`,
	`${canonical}/absent/../payload..bin`,
	`${canonical}/.env-not-created/../payload..bin`,
	`${canonical}\\.\\payload..bin`,
	`${canonical}\\absent\\..\\payload..bin`,
	`${canonical}\\.env-not-created\\..\\payload..bin`,
];
const entrypoints: readonly {
	readonly name: string;
	readonly inspect: (raw: string) => unknown;
}[] = [
	{ name: "bundle lexical check", inspect: noDotComponents },
	{ name: "bundle path check", inspect: noLinks },
	{ name: "bundle file reader", inspect: regularBytes },
	{ name: "release local path", inspect: localPath },
	{ name: "release directory check", inspect: directory },
	{ name: "release file reader", inspect: (raw) => read(raw, "payload..bin") },
];

const driveRelative = ["C:", "C:relative", "C:.", "C:..", "C:..\\spec.json", "c:../input"];

describe.each(entrypoints.filter(({ name }) => name.startsWith("bundle")))(
	"$name drive-relative policy",
	({ inspect }) => {
		it.each(driveRelative)("refuses %s before any filesystem lookup", (raw) => {
			const denied = (): never => {
				throw new Error("Unexpected filesystem lookup");
			};
			const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(denied);
			const opened = vi.spyOn(fs, "openSync").mockImplementation(denied);
			const readFile = vi.spyOn(fs, "readFileSync").mockImplementation(denied);
			syncBuiltinESMExports();
			expect(() => inspect(raw)).toThrow("drive-relative paths are refused");
			expect(lstat).not.toHaveBeenCalled();
			expect(opened).not.toHaveBeenCalled();
			expect(readFile).not.toHaveBeenCalled();
		});
	},
);

it("retains drive-absolute syntax and ordinary canonical relative inputs", () => {
	for (const raw of ["C:\\absolute\\payload.bin", "C:/absolute/payload.bin", "inputs/payload..bin"])
		expect(() => noDotComponents(raw)).not.toThrow();
	const relative = path.relative(process.cwd(), file);
	expect(relative.split(/[\\/]/).some((part) => part === "." || part === "..")).toBe(false);
	expect(() => noLinks(relative)).not.toThrow();
	expect(regularBytes(relative)).toEqual(bytes);
});

describe.each(entrypoints)("$name raw component policy", ({ inspect }) => {
	it.each(aliases)("refuses %s before any filesystem lookup", (raw) => {
		const denied = (): never => {
			throw new Error("Unexpected filesystem lookup");
		};
		const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(denied);
		const opened = vi.spyOn(fs, "openSync").mockImplementation(denied);
		const heldRead = vi.spyOn(fs, "readSync").mockImplementation(denied);
		const readFile = vi.spyOn(fs, "readFileSync").mockImplementation(denied);
		const readdir = vi.spyOn(fs, "readdirSync").mockImplementation(denied);
		syncBuiltinESMExports();
		expect(() => inspect(raw)).toThrow("raw dot path components are refused");
		expect(lstat).not.toHaveBeenCalled();
		expect(opened).not.toHaveBeenCalled();
		expect(heldRead).not.toHaveBeenCalled();
		expect(readFile).not.toHaveBeenCalled();
		expect(readdir).not.toHaveBeenCalled();
	});
});

it("retains canonical directories, files and names containing ordinary dots", () => {
	expect(() => noLinks(file)).not.toThrow();
	expect(localPath(canonical)).toBe(canonical);
	expect(directory(canonical)).toBe(canonical);
	expect(regularBytes(file)).toEqual(bytes);
	expect(read(canonical, "payload..bin")).toEqual(bytes);
});

it("retains direct environment-directory and network/device refusals", () => {
	expect(() => noLinks(path.join(canonical, ".env-not-created"))).toThrow("environment");
	for (const raw of ["//invalid.example/share", "\\\\invalid.example\\share"])
		expect(() => noLinks(raw)).toThrow("network shares");
	for (const raw of ["//invalid.example/share", "\\\\invalid.example\\share", "/dev/null"])
		expect(() => localPath(raw)).toThrow();
	expect(() => localPath(path.join(canonical, ".env-not-created"))).toThrow("environment");
});
