import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { emptyDirectoryRecords, exactTree, inventoryOf, treeFiles } from "../src/inventory.ts";

const scratch = fs.mkdtempSync(path.join(import.meta.dirname, ".tmp-directory-inventory-"));
const nativeOpen = fs.opendirSync;
afterEach(() => {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
});
afterAll(() => {
	if (
		path.dirname(path.resolve(scratch)) !== import.meta.dirname ||
		!path.basename(scratch).startsWith(".tmp-directory-inventory-")
	)
		throw new Error("unsafe scratch root");
	fs.rmSync(scratch, { recursive: true, force: true });
});
function payload(): string {
	const root = fs.mkdtempSync(path.join(scratch, "case-"));
	fs.writeFileSync(path.join(root, "main.mjs"), "export {};\n");
	fs.mkdirSync(path.join(root, "doctor/checks"), { recursive: true });
	return root;
}

describe("explicit empty payload directories", () => {
	it("retains the reviewed empty leaf while keeping the complete file inventory", () => {
		const root = payload();
		const inventory = inventoryOf(root, ["doctor/checks"]);
		expect(inventory.emptyDirectories).toEqual(["doctor/checks"]);
		expect(inventory.files.map((file) => file.path)).toEqual(["main.mjs"]);
		expect(() => exactTree(root, inventory.files, inventory.emptyDirectories)).not.toThrow();
		expect(() => inventoryOf(root)).toThrow("empty payload directories are not inventoried");
	});
	it("refuses missing, unlisted and nonempty directory claims", () => {
		const missing = payload();
		fs.rmdirSync(path.join(missing, "doctor/checks"));
		fs.rmdirSync(path.join(missing, "doctor"));
		expect(() => inventoryOf(missing, ["doctor/checks"])).toThrow("empty directory is missing");
		const extra = payload();
		fs.mkdirSync(path.join(extra, "unlisted"));
		expect(() => inventoryOf(extra, ["doctor/checks"])).toThrow(
			"empty payload directories are not inventoried",
		);
		const nonempty = payload();
		fs.writeFileSync(path.join(nonempty, "doctor/checks/added.js"), "export {};\n");
		expect(() => inventoryOf(nonempty, ["doctor/checks"])).toThrow(
			"declared empty directory is not empty",
		);
	});
	it("refuses omitted files and case/file/directory collisions", () => {
		const root = payload();
		const inventory = inventoryOf(root, ["doctor/checks"]);
		expect(() => exactTree(root, [], ["doctor/checks"])).toThrow("missing or unexpected files");
		expect(() => exactTree(root, inventory.files, ["main.mjs"])).toThrow();
		for (const directories of [
			["doctor/checks", "DOCTOR/checks"],
			["doctor", "doctor/checks"],
		])
			expect(() => emptyDirectoryRecords(directories)).toThrow();
	});
	it("refuses malformed directory metadata without invoking getters or proxy hooks", () => {
		const getter = vi.fn(() => "doctor/checks");
		const value = ["doctor/checks"];
		Object.defineProperty(value, "0", { get: getter, enumerable: true });
		expect(() => emptyDirectoryRecords(value)).toThrow("inert empty-directory entries");
		expect(getter).not.toHaveBeenCalled();
		const hook = vi.fn();
		expect(() => emptyDirectoryRecords(new Proxy([], { getPrototypeOf: hook }))).toThrow();
		expect(hook).not.toHaveBeenCalled();
		for (const malformed of [
			null,
			{},
			new Array(1),
			Object.assign([], { extra: true }),
			["../checks"],
			["doctor\\checks"],
			["doctor/checks/"],
		])
			expect(() => emptyDirectoryRecords(malformed)).toThrow();
	});
	it("does not traverse a linked directory even when the reviewed leaf is empty", () => {
		const root = payload();
		const target = fs.mkdtempSync(path.join(scratch, "target-"));
		fs.rmdirSync(path.join(root, "doctor/checks"));
		fs.symlinkSync(
			target,
			path.join(root, "doctor/checks"),
			process.platform === "win32" ? "junction" : "dir",
		);
		const opened = vi.spyOn(fs, "opendirSync");
		syncBuiltinESMExports();
		expect(() => inventoryOf(root, ["doctor/checks"])).toThrow("payload link refused");
		expect(opened.mock.calls.map(([name]) => name)).not.toContain(path.join(root, "doctor/checks"));
		expect(opened.mock.calls.map(([name]) => name)).not.toContain(target);
	});
	it("bounds streaming directory entries and closes the handle on refusal", () => {
		const root = fs.mkdtempSync(path.join(scratch, "bound-"));
		fs.writeFileSync(path.join(root, "a"), "a");
		let reads = 0;
		const close = vi.fn();
		vi.spyOn(fs, "opendirSync").mockReturnValue({
			readSync: () => (++reads <= 20_002 ? { name: "a" } : null),
			closeSync: close,
		} as unknown as fs.Dir);
		syncBuiltinESMExports();
		expect(() => treeFiles(root)).toThrow("payload tree entry limit exceeded");
		expect(reads).toBe(20_001);
		expect(close).toHaveBeenCalledExactlyOnceWith();
	});
	it("detects a directory changed after enumeration and still closes it", () => {
		const root = fs.realpathSync.native(fs.mkdtempSync(path.join(scratch, "changed-")));
		fs.writeFileSync(path.join(root, "a"), "a");
		const initialTime = new Date("2000-01-01T00:00:00.000Z");
		const changedTime = new Date("2000-01-02T00:00:00.000Z");
		fs.utimesSync(root, initialTime, initialTime);
		const before = fs.lstatSync(root, { bigint: true });
		expect(before.mtimeNs).toBe(BigInt(initialTime.getTime()) * 1_000_000n);
		const openedDirectories: string[] = [];
		let eofMutations = 0;
		let changedMtimeNs: bigint | undefined;
		const closed = vi.fn();
		vi.spyOn(fs, "opendirSync").mockImplementation((...args) => {
			const directory = fs.realpathSync.native(args[0]);
			expect(directory).toBe(root);
			openedDirectories.push(directory);
			const opened = nativeOpen(...args);
			const read = opened.readSync.bind(opened);
			opened.readSync = () => {
				const entry = read();
				if (entry === null) {
					eofMutations++;
					fs.mkdirSync(path.join(root, "late"));
					// Make the real mutation observable without relying on timestamp granularity.
					fs.utimesSync(root, changedTime, changedTime);
					changedMtimeNs = fs.lstatSync(root, { bigint: true }).mtimeNs;
				}
				return entry;
			};
			const close = opened.closeSync.bind(opened);
			opened.closeSync = () => {
				close();
				closed();
			};
			return opened;
		});
		syncBuiltinESMExports();
		let failure: unknown;
		try {
			treeFiles(root);
		} catch (error) {
			failure = error;
		}
		expect(openedDirectories).toEqual([root]);
		expect(eofMutations).toBe(1);
		expect(fs.lstatSync(path.join(root, "late")).isDirectory()).toBe(true);
		expect(changedMtimeNs).toBe(BigInt(changedTime.getTime()) * 1_000_000n);
		expect(changedMtimeNs).not.toBe(before.mtimeNs);
		expect(closed).toHaveBeenCalledExactlyOnceWith();
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toBe("payload directory changed");
	});
	it("refuses a failed handle close instead of returning an inventory", () => {
		const root = fs.mkdtempSync(path.join(scratch, "close-"));
		fs.writeFileSync(path.join(root, "a"), "a");
		vi.spyOn(fs, "opendirSync").mockImplementation((...args) => {
			const opened = nativeOpen(...args);
			const close = opened.closeSync.bind(opened);
			opened.closeSync = () => {
				close();
				throw new Error("synthetic close failure");
			};
			return opened;
		});
		syncBuiltinESMExports();
		expect(() => inventoryOf(root)).toThrow("payload directory cleanup refused");
	});
});
