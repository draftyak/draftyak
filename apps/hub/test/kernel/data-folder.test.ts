import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { admitDataFolder, type DataFolder } from "../../src/kernel/data-directory.ts";
import { StartupRefusal, type StartupRefusalCode } from "../../src/lifecycle/preflight.ts";
import { nativeBinding } from "../store/helpers.ts";

const temporaryRoot = realpathSync.native(os.tmpdir());
const held: DataFolder[] = [];
let root: string;

beforeEach(() => {
	root = realpathSync.native(mkdtempSync(path.join(temporaryRoot, "draftyak-data-")));
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const folder of held.splice(0)) folder.release();
	rmSync(root, { recursive: true, force: true });
});

/** A private folder below the test root; mode 0700 keeps POSIX ownership checks satisfied. */
function folder(...parts: string[]): string {
	const created = path.join(root, ...parts);
	mkdirSync(created, { recursive: true, mode: 0o700 });
	return created;
}

function admit(spelling: string, binding: string = nativeBinding): DataFolder {
	const admitted = admitDataFolder(spelling, { nativeBinding: binding });
	held.push(admitted);
	return admitted;
}

function refused(spelling: string, code: StartupRefusalCode, binding?: string): StartupRefusal {
	let failure: unknown;
	try {
		admit(spelling, binding);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(StartupRefusal);
	expect((failure as StartupRefusal).code).toBe(code);
	return failure as StartupRefusal;
}

it("admits a canonical folder and holds its lock in a content-free run/hub.lock", () => {
	const stdout = vi.spyOn(process.stdout, "write");
	const data = folder("data");
	const admitted = admit(data);
	const run = path.join(data, "run");
	expect(admitted).toEqual({
		path: data,
		runPath: run,
		assertHeld: expect.any(Function),
		release: expect.any(Function),
	});
	expect(() => admitted.assertHeld()).not.toThrow();
	expect(Object.isFrozen(admitted)).toBe(true);
	expect(readdirSync(data)).toEqual(["run"]);
	expect(lstatSync(run).isDirectory()).toBe(true);
	if (process.platform !== "win32") expect(lstatSync(run).mode & 0o777).toBe(0o700);
	expect(readdirSync(run)).toEqual(["hub.lock"]);
	expect(statSync(path.join(run, "hub.lock")).size).toBe(0);
	admitted.release();
	expect(readdirSync(run)).toEqual(["hub.lock"]);
	expect(statSync(path.join(run, "hub.lock")).size).toBe(0);
	expect(stdout).not.toHaveBeenCalled();
});

it.each([
	["a missing folder", (data: string) => path.join(data, "missing")],
	[
		"a regular file",
		(data: string) => {
			const file = path.join(data, "file");
			writeFileSync(file, "");
			return file;
		},
	],
	["a trailing separator", (data: string) => `${data}${path.sep}`],
	["a dot segment", (data: string) => `${data}${path.sep}.`],
	["a parent segment", (data: string) => `${data}${path.sep}..${path.sep}data`],
	["an empty spelling", () => ""],
	["a non-string", () => 42 as unknown as string],
])("refuses %s with DATA_DIR_INVALID", (_, spell) => {
	const data = folder("data");
	refused(spell(data), "DATA_DIR_INVALID");
	expect(readdirSync(data).filter((name) => name !== "file")).toEqual([]);
});

it("refuses a folder reached through a link, directly or through a parent", () => {
	const data = folder("real", "data");
	const direct = path.join(root, "direct");
	symlinkSync(data, direct, "junction");
	refused(direct, "DATA_DIR_INVALID");
	const parent = path.join(root, "parent");
	symlinkSync(path.join(root, "real"), parent, "junction");
	refused(path.join(parent, "data"), "DATA_DIR_INVALID");
	expect(readdirSync(data)).toEqual([]);
});

it.each([
	["OneDrive", ["OneDrive", "hub"]],
	["Dropbox", ["Dropbox"]],
	["Library/Mobile Documents", ["Library", "Mobile Documents", "hub"]],
])("refuses a folder in %s before writing to it", (_, parts) => {
	const data = folder(...parts);
	refused(data, "DATA_DIR_SYNCED");
	expect(readdirSync(data)).toEqual([]);
});

it.each([
	["a file", (run: string) => writeFileSync(run, "")],
	["a link to a folder", (run: string, target: string) => symlinkSync(target, run, "junction")],
])("refuses a run/ that is %s with DATA_DIR_OWNERSHIP", (_, make) => {
	const data = folder("data");
	const target = folder("target");
	make(path.join(data, "run"), target);
	refused(data, "DATA_DIR_OWNERSHIP");
	expect(readdirSync(target)).toEqual([]);
});

it("refuses a second admission in the same process at once", () => {
	const data = folder("data");
	admit(data);
	const started = performance.now();
	refused(data, "DATA_DIR_LOCKED");
	expect(performance.now() - started).toBeLessThan(2_000);
	refused(data, "DATA_DIR_LOCKED");
});

it("refuses a lock file it cannot open with DATA_DIR_LOCK_IO", () => {
	const data = folder("data");
	folder("data", "run", "hub.lock");
	refused(data, "DATA_DIR_LOCK_IO");
});

it.each([
	["a missing binding", () => path.join(root, "missing.node")],
	["a relative binding", () => path.relative(process.cwd(), nativeBinding)],
	["a binding without its extension", () => nativeBinding.slice(0, -".node".length)],
])("refuses %s with DATA_DIR_LOCK_IO", (_, binding) => {
	const spelling = binding();
	expect(spelling).not.toBe(nativeBinding);
	const data = folder("data");
	refused(data, "DATA_DIR_LOCK_IO", spelling);
	expect(readdirSync(data)).toEqual([]);
});

it.each([undefined, null, 0, {}, Symbol("DYTEST-binding")])(
	"refuses a non-string binding before creating run/",
	(binding) => {
		const data = folder("data");
		const stdout = vi.spyOn(process.stdout, "write");
		expect(() =>
			admitDataFolder(data, { nativeBinding: binding as unknown as string }),
		).toThrowError(new StartupRefusal("DATA_DIR_LOCK_IO"));
		expect(readdirSync(data)).toEqual([]);
		expect(stdout).not.toHaveBeenCalled();
	},
);

it("refuses a throwing binding accessor without keeping its detail or creating run/", () => {
	const data = folder("data");
	const options = {
		get nativeBinding(): string {
			throw new Error(`DYTEST-binding-${data}`);
		},
	};
	let failure: unknown;
	try {
		admitDataFolder(data, options);
	} catch (error) {
		failure = error;
	}
	expect(failure).toBeInstanceOf(StartupRefusal);
	expect((failure as StartupRefusal).code).toBe("DATA_DIR_LOCK_IO");
	expect(inspect(failure, { showHidden: true, depth: null })).not.toContain(data);
	expect(readdirSync(data)).toEqual([]);
});

it("releases idempotently, re-admits, and never releases a later holder", () => {
	const data = folder("data");
	const first = admit(data);
	first.release();
	first.release();
	expect(() => first.assertHeld()).toThrowError(new StartupRefusal("DATA_DIR_LOCK_IO"));
	const second = admit(data);
	first.release();
	refused(data, "DATA_DIR_LOCKED");
	second.release();
	admit(data).release();
});

it("carries only its code in every refusal", () => {
	const linked = path.join(root, "linked");
	symlinkSync(folder("real"), linked, "junction");
	const locked = folder("locked");
	admit(locked);
	const run = folder("run-file");
	writeFileSync(path.join(run, "run"), "");
	const failures = [
		refused(path.join(root, "missing"), "DATA_DIR_INVALID"),
		refused(linked, "DATA_DIR_INVALID"),
		refused(folder("OneDrive"), "DATA_DIR_SYNCED"),
		refused(run, "DATA_DIR_OWNERSHIP"),
		refused(locked, "DATA_DIR_LOCKED"),
		refused(folder("binding"), "DATA_DIR_LOCK_IO", path.join(root, "missing.node")),
	];
	for (const failure of failures) {
		expect(failure.name).toBe("StartupRefusal");
		expect(failure.message).toBe(failure.code);
		expect(failure.cause).toBeUndefined();
		for (const text of [
			inspect(failure, { showHidden: true, depth: null }),
			JSON.stringify(failure),
		])
			expect(text).not.toContain(root);
	}
});
