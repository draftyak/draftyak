import { createHash } from "node:crypto";
import * as nativeFs from "node:fs";
import {
	appendFile,
	cp,
	link,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	rmdir,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FileDigest, InstalledBundle } from "../../src/artifacts/index.ts";
import {
	canonicalDirectory,
	verifyBundle,
	verifyBundleFile,
} from "../../src/artifacts/inventory.ts";

const control = vi.hoisted(() => ({
	file: "",
	fileMode: "" as "" | "grow" | "shrink" | "eof-growth" | "read-error" | "close-error",
	fileChanged: false,
	descriptors: new Set<number>(),
	lengths: [] as number[],
	closes: 0,
	opens: 0,
	paths: [] as string[],
	directoryReads: new Map<string, number>(),
	directoryCloses: new Map<string, number>(),
	directoryBuffers: [] as number[],
	readError: "",
	closeError: "",
	held: new Map<string, unknown>(),
	afterFileClose: undefined as (() => void) | undefined,
	afterLstat: undefined as ((name: string) => Promise<void>) | undefined,
	afterOpendir: undefined as ((name: string) => Promise<void>) | undefined,
	afterRead: undefined as ((name: string) => Promise<void>) | undefined,
	afterClose: undefined as ((name: string) => Promise<void>) | undefined,
}));

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return {
		...actual,
		openSync(name: string, flags: number) {
			const fd = actual.openSync(name, flags);
			if (name === control.file) {
				control.opens++;
				control.descriptors.add(fd);
			}
			return fd;
		},
		readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
			if (!control.descriptors.has(fd))
				return actual.readSync(fd, buffer, offset, length, position);
			control.lengths.push(length);
			if (control.fileMode === "read-error") throw new Error("DYTEST-read-error");
			const count = actual.readSync(fd, buffer, offset, length, position);
			if (!control.fileChanged) {
				if (control.fileMode === "grow" || (control.fileMode === "eof-growth" && count === 0)) {
					control.fileChanged = true;
					actual.appendFileSync(control.file, "DYTEST-growth");
				} else if (control.fileMode === "shrink") {
					control.fileChanged = true;
					actual.truncateSync(control.file, 0);
				} else if (control.fileMode === "close-error" && count === 0) {
					control.fileChanged = true;
					actual.closeSync(fd);
				}
			}
			return count;
		},
		closeSync(fd: number) {
			const tracked = control.descriptors.delete(fd);
			if (tracked) control.closes++;
			actual.closeSync(fd);
			if (tracked) control.afterFileClose?.();
		},
	};
});

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (...args: Parameters<typeof actual.lstat>) => {
			const name = String(args[0]);
			control.paths.push(name);
			const stat = await actual.lstat(...args);
			const hook = control.afterLstat;
			if (hook) await hook(name);
			// A held name keeps reporting its first stat, as if later changes fell in the same clock tick.
			if (!control.held.has(name)) return stat;
			if (control.held.get(name) === undefined) control.held.set(name, stat);
			return control.held.get(name) as typeof stat;
		},
		realpath: async (...args: Parameters<typeof actual.realpath>) => {
			control.paths.push(String(args[0]));
			return actual.realpath(...args);
		},
		opendir: async (...args: Parameters<typeof actual.opendir>) => {
			const name = String(args[0]);
			const options = args[1] as { bufferSize?: number } | undefined;
			control.directoryBuffers.push(options?.bufferSize ?? 0);
			const handle = await actual.opendir(...args);
			const opened = control.afterOpendir;
			if (opened) await opened(name);
			const read = handle.read.bind(handle);
			const close = handle.close.bind(handle);
			Object.defineProperties(handle, {
				read: {
					value: async () => {
						control.directoryReads.set(name, (control.directoryReads.get(name) ?? 0) + 1);
						if (control.readError === name) throw new Error("DYTEST-directory-read");
						const item = await read();
						const hook = control.afterRead;
						if (hook && item) await hook(name);
						return item;
					},
				},
				close: {
					value: async () => {
						control.directoryCloses.set(name, (control.directoryCloses.get(name) ?? 0) + 1);
						await close();
						if (control.closeError === name) throw new Error("DYTEST-directory-close");
						const hook = control.afterClose;
						if (hook) await hook(name);
					},
				},
			});
			return handle;
		},
	};
});

const roots: string[] = [];
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const lock = {
	name: "@dytest/native-inventory",
	version: "1.2.3",
	integrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`,
	entry: "index.mjs",
};
const content = {
	"index.mjs": Buffer.from("export const DYTEST = true;\n"),
	"nested/empty.bin": Buffer.alloc(0),
	"nested/payload.bin": Buffer.from([0, 255, 10, 13, 128, 7]),
};

function reset(): void {
	control.file = "";
	control.fileMode = "";
	control.fileChanged = false;
	control.descriptors.clear();
	control.lengths.length = 0;
	control.closes = 0;
	control.opens = 0;
	control.paths.length = 0;
	control.directoryReads.clear();
	control.directoryCloses.clear();
	control.directoryBuffers.length = 0;
	control.readError = "";
	control.closeError = "";
	control.held.clear();
	control.afterFileClose = undefined;
	control.afterLstat = undefined;
	control.afterOpendir = undefined;
	control.afterRead = undefined;
	control.afterClose = undefined;
}

async function fixture(files: Record<string, Buffer> = content): Promise<InstalledBundle> {
	const container = await realpath(
		await mkdtemp(path.join(os.tmpdir(), "dy-artifacts-inventory-")),
	);
	roots.push(container);
	const directory = path.join(container, "bundle");
	await mkdir(directory);
	const rows: FileDigest[] = [];
	for (const [name, bytes] of Object.entries(files)) {
		const target = path.join(directory, name);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, bytes);
		rows.push({ path: name, bytes: bytes.byteLength, sha256: digest(bytes) });
	}
	return { directory, inventory: { ...lock, files: rows } };
}

function refused(result: Promise<unknown>) {
	return expect(result).rejects.toMatchObject({
		name: "ArtifactError",
		message: "Artifact verification refused.",
	});
}

/**
 * Directory times use a coarse clock: wait until a write beside the bundle, which changes none of
 * its directories, is stamped after the directory's.
 */
async function waitForLaterStamp(bundle: InstalledBundle, directory: string): Promise<void> {
	const before = await lstat(directory, { bigint: true });
	const probe = path.join(path.dirname(bundle.directory), "clock-probe");
	for (;;) {
		await writeFile(probe, "DYTEST-clock");
		const stamp = await lstat(probe, { bigint: true });
		await unlink(probe);
		if (stamp.mtimeNs > before.mtimeNs && stamp.ctimeNs > before.ctimeNs) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

afterEach(async () => {
	reset();
	const temp = await realpath(os.tmpdir());
	for (const root of roots.splice(0)) {
		expect(path.dirname(root)).toBe(temp);
		expect(path.basename(root).startsWith("dy-artifacts-inventory-")).toBe(true);
		expect(await realpath(root)).toBe(root);
		expect((await lstat(root)).isSymbolicLink()).toBe(false);
		await rm(root, { recursive: true, force: false });
		expect(nativeFs.existsSync(root)).toBe(false);
	}
});

describe("native artifact directory admission", () => {
	it("preserves an existing canonical directory with ordinary comma and equals spelling", async () => {
		const bundle = await fixture();
		const named = path.join(path.dirname(bundle.directory), "DYTEST,a=b");
		await mkdir(named);
		expect(await canonicalDirectory(named)).toBe(named);
	});

	it("refuses raw dot, parent, repeated separator and NUL before native lookup", async () => {
		const { directory } = await fixture();
		for (const raw of [
			`${directory}${path.sep}.`,
			`${directory}${path.sep}..${path.sep}bundle`,
			`${directory}${path.sep}${path.sep}nested`,
			`${directory}\0`,
		]) {
			control.paths.length = 0;
			await refused(canonicalDirectory(raw));
			expect(control.paths).toEqual([]);
		}
		expect(await canonicalDirectory(directory)).toBe(directory);
	});

	it("refuses nonprimitive, malformed UTF16 and overlong native names without coercion or lookup", async () => {
		const { directory } = await fixture();
		let hooks = 0;
		const object = {
			toString() {
				hooks++;
				return directory;
			},
		};
		for (const raw of [
			undefined,
			null,
			object,
			Object(directory),
			new Proxy(object, {
				get() {
					hooks++;
					throw new Error("DYTEST-native-proxy");
				},
			}),
			`${directory}${path.sep}\uD800`,
			`${directory}${path.sep}\uDC00`,
			directory + path.sep + "x".repeat(4097),
		]) {
			control.paths.length = 0;
			await refused(canonicalDirectory(raw));
			expect(control.paths).toEqual([]);
			expect(hooks).toBe(0);
		}
		expect(await canonicalDirectory(directory)).toBe(directory);
	});

	it("preserves native POSIX special names while refusing Windows device/alias spellings", async () => {
		const { directory } = await fixture();
		if (process.platform === "win32") {
			for (const component of ["CON", "NUL.txt", "tail.", "tail ", "a:b", "a?b"]) {
				control.paths.length = 0;
				await refused(canonicalDirectory(path.join(directory, component)));
				expect(control.paths).toEqual([]);
			}
		} else {
			const named = path.join(directory, "CON,question?equals=star*");
			await mkdir(named);
			expect(await canonicalDirectory(named)).toBe(named);
		}
	});

	it("refuses a real file, directory link and link/parent path without following it", async () => {
		const { directory } = await fixture();
		await refused(canonicalDirectory(path.join(directory, "index.mjs")));
		const alias = path.join(path.dirname(directory), "alias");
		await symlink(directory, alias, process.platform === "win32" ? "junction" : "dir");
		await refused(canonicalDirectory(alias));
		control.paths.length = 0;
		await refused(canonicalDirectory(`${alias}${path.sep}..${path.sep}bundle`));
		expect(control.paths).toEqual([]);
		expect(await canonicalDirectory(directory)).toBe(directory);
	});

	it("refuses case-variant spellings of the directory and its ancestors", async () => {
		const { directory } = await fixture();
		const container = path.dirname(directory);
		const variants = [
			path.join(container, "BUNDLE"),
			path.join(path.dirname(container), path.basename(container).toUpperCase(), "bundle"),
		];
		if (process.platform === "win32")
			variants.push(directory.slice(0, 1).toLowerCase() + directory.slice(1));
		const canonical = await lstat(directory, { bigint: true });
		for (const variant of variants) {
			expect(variant).not.toBe(directory);
			// NTFS folds case, so each variant names the same directory and only its spelling differs.
			if (process.platform === "win32")
				expect((await lstat(variant, { bigint: true })).ino).toBe(canonical.ino);
			await refused(canonicalDirectory(variant));
		}
		expect(await canonicalDirectory(directory)).toBe(directory);
	});

	it("detects same-byte root replacement during canonical ancestor validation", async () => {
		const bundle = await fixture();
		const replacement = path.join(path.dirname(bundle.directory), "replacement");
		const retired = path.join(path.dirname(bundle.directory), "retired");
		await cp(bundle.directory, replacement, { recursive: true });
		let changed = false;
		control.afterLstat = async (name) => {
			if (name !== bundle.directory || changed) return;
			changed = true;
			await rename(bundle.directory, retired);
			await rename(replacement, bundle.directory);
		};
		await refused(canonicalDirectory(bundle.directory));
		expect(changed).toBe(true);
		control.afterLstat = undefined;
		expect(await canonicalDirectory(bundle.directory)).toBe(bundle.directory);
	});
});

describe("actual shared bounded-reader integration", () => {
	it("admits an empty file and hashes 131073 native bytes read by the shared reader", async () => {
		const bytes = Buffer.alloc(131_073, 0xa7);
		const bundle = await fixture({ "index.mjs": bytes, "empty.bin": Buffer.alloc(0) });
		const target = path.join(bundle.directory, "index.mjs");
		control.file = target;
		await expect(
			verifyBundleFile(target, bundle.inventory.files[0] as FileDigest),
		).resolves.toBeUndefined();
		// 64 KiB reads, the EOF probe, then the reader's second comparison pass.
		expect(control.lengths).toEqual([65_536, 65_536, 1, 1, 65_536, 65_536, 1]);
		expect(control.closes).toBe(1);
		reset();
		control.file = path.join(bundle.directory, "empty.bin");
		await expect(
			verifyBundleFile(control.file, bundle.inventory.files[1] as FileDigest),
		).resolves.toBeUndefined();
		expect(control.lengths).toEqual([1]);
		expect(control.closes).toBe(1);
	});

	it("binds exact declared size even when a mismatched row has the correct byte digest", async () => {
		const bundle = await fixture();
		const row = bundle.inventory.files[0] as FileDigest;
		control.file = path.join(bundle.directory, row.path);
		await refused(verifyBundleFile(control.file, { ...row, bytes: row.bytes - 1 }));
		expect(control.opens).toBe(0);
		await expect(verifyBundleFile(control.file, row)).resolves.toBeUndefined();
	});

	it("refuses a retained file row above 16 MiB before any native byte access", async () => {
		const bundle = await fixture();
		const row = bundle.inventory.files[0] as FileDigest;
		control.file = path.join(bundle.directory, row.path);
		control.paths.length = 0;
		await refused(verifyBundleFile(control.file, { ...row, bytes: 16 * 1024 * 1024 + 1 }));
		expect(control.opens).toBe(0);
		expect(control.lengths).toEqual([]);
		expect(control.paths).toEqual([]);
		await expect(verifyBundleFile(control.file, row)).resolves.toBeUndefined();
	});

	it("refuses a matching real file one byte above 16 MiB before opening it", async () => {
		const bytes = Buffer.alloc(16 * 1024 * 1024 + 1, 0x46);
		const bundle = await fixture({ "index.mjs": bytes });
		const row = bundle.inventory.files[0] as FileDigest;
		control.file = path.join(bundle.directory, row.path);
		control.paths.length = 0;
		await refused(verifyBundleFile(control.file, row));
		await refused(verifyBundle(bundle));
		expect(control.opens).toBe(0);
		expect(control.paths).toEqual([]);
		const exact = bytes.subarray(0, 16 * 1024 * 1024);
		await writeFile(control.file, exact);
		await expect(
			verifyBundleFile(control.file, { ...row, bytes: exact.length, sha256: digest(exact) }),
		).resolves.toBeUndefined();
	}, 60_000);

	it("refuses same-size changed bytes and later verifies genuinely restored bytes", async () => {
		const bundle = await fixture();
		const row = bundle.inventory.files[0] as FileDigest;
		const target = path.join(bundle.directory, row.path);
		await writeFile(target, Buffer.alloc(row.bytes, 0x61));
		await refused(verifyBundleFile(target, row));
		await writeFile(target, content["index.mjs"]);
		await expect(verifyBundleFile(target, row)).resolves.toBeUndefined();
	});

	it("refuses a real native hardlink without a trusted-stat bypass", async () => {
		const bundle = await fixture();
		const row = bundle.inventory.files[0] as FileDigest;
		const target = path.join(bundle.directory, row.path);
		const alias = path.join(path.dirname(bundle.directory), "hardlink.mjs");
		await link(target, alias);
		await refused(verifyBundleFile(target, row));
		await unlink(alias);
		await expect(verifyBundleFile(target, row)).resolves.toBeUndefined();
	});

	for (const mode of ["grow", "shrink", "eof-growth", "read-error", "close-error"] as const) {
		it(`refuses real ${mode} and closes once without poisoning the next snapshot`, async () => {
			const bytes = Buffer.alloc(131_073, 0xb3);
			const bundle = await fixture({ "index.mjs": bytes });
			const row = bundle.inventory.files[0] as FileDigest;
			control.file = path.join(bundle.directory, row.path);
			control.fileMode = mode;
			await refused(verifyBundleFile(control.file, row));
			expect(control.opens).toBe(1);
			expect(control.closes).toBe(1);
			if (mode !== "read-error") expect(control.fileChanged).toBe(true);
			control.fileMode = "";
			await writeFile(control.file, bytes);
			await expect(verifyBundleFile(control.file, row)).resolves.toBeUndefined();
			expect(control.closes).toBe(2);
		});
	}
});

describe("exact native bundle trees", () => {
	it("verifies independent nested bytes and empty files and returns only the entry path", async () => {
		const bundle = await fixture();
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, "index.mjs"));
		expect(control.directoryBuffers.every((size) => size === 1)).toBe(true);
		// Each directory is listed twice: during the walk and again after it.
		expect(control.directoryCloses.get(bundle.directory)).toBe(2);
		expect(control.directoryCloses.get(path.join(bundle.directory, "nested"))).toBe(2);
		expect(await readFile(path.join(bundle.directory, "nested/payload.bin"))).toEqual(
			content["nested/payload.bin"],
		);
	});

	it("stops at the first unknown member with one native close and bufferSize1", async () => {
		const bundle = await fixture();
		for (let index = 0; index < 32; index++)
			await writeFile(path.join(bundle.directory, `unknown-${index}`), "DYTEST");
		await refused(verifyBundle(bundle));
		expect(control.directoryReads.get(bundle.directory)).toBeLessThanOrEqual(
			bundle.inventory.files.length + 1,
		);
		expect(control.directoryCloses.get(bundle.directory)).toBe(1);
		expect(control.directoryBuffers.every((size) => size === 1)).toBe(true);
	});

	it("refuses extra empty directories, missing files and case-mismatched members", async () => {
		const bundle = await fixture();
		const extra = path.join(bundle.directory, "extra-empty");
		await mkdir(extra);
		await refused(verifyBundle(bundle));
		await rmdir(extra);
		const source = path.join(bundle.directory, "index.mjs");
		await unlink(source);
		await refused(verifyBundle(bundle));
		await writeFile(source, content["index.mjs"]);
		await rename(source, path.join(bundle.directory, "INDEX.mjs"));
		await refused(verifyBundle(bundle));
		await rename(path.join(bundle.directory, "INDEX.mjs"), source);
		expect(await verifyBundle(bundle)).toBe(source);
	});

	it("refuses a native nested junction or directory link", async () => {
		const bundle = await fixture();
		const nested = path.join(bundle.directory, "nested");
		const original = path.join(path.dirname(bundle.directory), "original-nested");
		await rename(nested, original);
		await symlink(original, nested, process.platform === "win32" ? "junction" : "dir");
		await refused(verifyBundle(bundle));
	});

	const members: readonly [string, (directory: string) => Promise<() => Promise<void>>][] = [
		[
			"a same-size change to a root member",
			async (directory) => {
				const target = path.join(directory, "index.mjs");
				await writeFile(target, Buffer.alloc(content["index.mjs"].length, 0x61));
				return () => writeFile(target, content["index.mjs"]);
			},
		],
		[
			"a same-size change to a nested member",
			async (directory) => {
				const target = path.join(directory, "nested", "payload.bin");
				await writeFile(target, Buffer.alloc(content["nested/payload.bin"].length, 0x62));
				return () => writeFile(target, content["nested/payload.bin"]);
			},
		],
		[
			"a member grown by one byte",
			async (directory) => {
				const target = path.join(directory, "nested", "payload.bin");
				await appendFile(target, Buffer.from([0]));
				return () => writeFile(target, content["nested/payload.bin"]);
			},
		],
		[
			"a member hardlinked to a file outside the root",
			async (directory) => {
				const alias = path.join(path.dirname(directory), "outside.mjs");
				await link(path.join(directory, "index.mjs"), alias);
				return () => unlink(alias);
			},
		],
		[
			"two listed members that are hardlinks of one file",
			async (directory) => {
				const copy = path.join(directory, "copy.bin");
				await unlink(copy);
				await link(path.join(directory, "nested", "payload.bin"), copy);
				return async () => {
					await unlink(copy);
					await writeFile(copy, content["nested/payload.bin"]);
				};
			},
		],
	];
	for (const [label, change] of members) {
		it(`reads every member during the walk and refuses ${label}`, async () => {
			const bundle = await fixture({ ...content, "copy.bin": content["nested/payload.bin"] });
			const restore = await change(bundle.directory);
			await refused(verifyBundle(bundle));
			await restore();
			expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
		});
	}

	for (const location of ["root", "nested"] as const) {
		it(`rechecks a same-byte ${location} replacement after traversal`, async () => {
			const bundle = await fixture();
			const target = location === "root" ? bundle.directory : path.join(bundle.directory, "nested");
			const replacement = path.join(path.dirname(bundle.directory), "replacement");
			const retired = path.join(path.dirname(bundle.directory), "retired");
			await cp(target, replacement, { recursive: true });
			let changed = false;
			control.afterClose = async (name) => {
				if (name !== target || changed) return;
				await rename(target, retired);
				await rename(replacement, target);
				changed = true;
			};
			await refused(verifyBundle(bundle));
			expect(changed).toBe(true);
			control.afterClose = undefined;
			expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
		});
	}

	it("rechecks the root's ancestors after the directory rechecks", async () => {
		const original = await fixture();
		const container = path.dirname(original.directory);
		const outer = path.join(container, "outer");
		await mkdir(outer);
		const bundle = { ...original, directory: path.join(outer, "bundle") };
		await rename(original.directory, bundle.directory);
		const copy = path.join(container, "outer-copy");
		const retired = path.join(container, "outer-retired");
		await cp(outer, copy, { recursive: true });
		const nested = path.join(bundle.directory, "nested");
		// The nested directory's second listing is the last; after it only the ancestors remain.
		let closes = 0;
		let changed = false;
		control.afterClose = async (name) => {
			if (name !== nested || ++closes !== 2) return;
			await rename(outer, retired);
			await rename(copy, outer);
			changed = true;
		};
		await refused(verifyBundle(bundle));
		expect(changed).toBe(true);
		control.afterClose = undefined;
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("rechecks the root's identity while its listing is open, not only after it closes", async () => {
		const original = await fixture({
			"index.mjs": content["index.mjs"],
			"other.bin": content["nested/payload.bin"],
		});
		const container = path.dirname(original.directory);
		const outer = path.join(container, "outer");
		await mkdir(outer);
		const bundle = { ...original, directory: path.join(outer, "bundle") };
		await rename(original.directory, bundle.directory);
		// A decoy parent whose root holds only the listed files; the real root also holds another.
		const decoy = path.join(container, "decoy");
		const parked = path.join(container, "parked");
		await cp(outer, decoy, { recursive: true });
		const unlisted = path.join(bundle.directory, "unlisted.mjs");
		await writeFile(unlisted, "DYTEST-unlisted");
		let swaps = 0;
		const swap = async () => {
			const swapped = swaps % 2 === 1;
			await rename(outer, swapped ? decoy : parked);
			await rename(swapped ? parked : decoy, outer);
			swaps++;
		};
		// The decoy replaces the parent just after the root's snapshot and the real parent returns
		// once both root listings have closed, before the ancestors are rechecked.
		let looks = 0;
		let closes = 0;
		control.afterLstat = async (name) => {
			if (name === bundle.directory && ++looks === 2) await swap();
		};
		control.afterClose = async (name) => {
			if (name === bundle.directory && ++closes === 2 && swaps === 1) await swap();
		};
		await refused(verifyBundle(bundle));
		control.afterLstat = undefined;
		control.afterClose = undefined;
		expect(swaps).toBeGreaterThan(0);
		if (swaps === 1) await swap();
		expect((await readdir(bundle.directory)).sort()).toEqual([
			"index.mjs",
			"other.bin",
			"unlisted.mjs",
		]);
		await unlink(unlisted);
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("detects an extra native file added after the root enumeration has closed", async () => {
		const bundle = await fixture();
		const extra = path.join(bundle.directory, "late.bin");
		let changed = false;
		control.afterClose = async (name) => {
			if (name !== bundle.directory || changed) return;
			await waitForLaterStamp(bundle, bundle.directory);
			await writeFile(extra, "DYTEST-late");
			changed = true;
		};
		await refused(verifyBundle(bundle));
		expect(changed).toBe(true);
		expect(await readFile(extra, "utf8")).toBe("DYTEST-late");
		control.afterClose = undefined;
		await unlink(extra);
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("detects an extra native file added after the root was opened for listing", async () => {
		const bundle = await fixture();
		// Windows fetches entries at open and this name sorts first, so a Windows listing omits it.
		const extra = path.join(bundle.directory, "a-late.bin");
		let changed = false;
		control.afterOpendir = async (name) => {
			if (name !== bundle.directory || changed) return;
			await waitForLaterStamp(bundle, bundle.directory);
			await writeFile(extra, "DYTEST-late");
			changed = true;
		};
		await refused(verifyBundle(bundle));
		expect(changed).toBe(true);
		expect(await readFile(extra, "utf8")).toBe("DYTEST-late");
		control.afterOpendir = undefined;
		await unlink(extra);
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("detects an extra native file added after the root's first entry was read", async () => {
		const bundle = await fixture();
		// This name sorts first, so a sorted Windows listing that has started omits it; an unsorted
		// listing elsewhere may still return it, and then it is refused as an unknown member.
		const extra = path.join(bundle.directory, "a-late.bin");
		let changed = false;
		control.afterRead = async (name) => {
			if (name !== bundle.directory || changed) return;
			await waitForLaterStamp(bundle, bundle.directory);
			await writeFile(extra, "DYTEST-late");
			changed = true;
		};
		await refused(verifyBundle(bundle));
		expect(changed).toBe(true);
		expect(await readFile(extra, "utf8")).toBe("DYTEST-late");
		control.afterRead = undefined;
		await unlink(extra);
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("detects an extra native file added to a nested directory after its enumeration has closed", async () => {
		const bundle = await fixture();
		const nested = path.join(bundle.directory, "nested");
		// The root's listing and times stay the same, so only the nested directory's own
		// snapshot and recheck can refuse.
		const extra = path.join(nested, "late.bin");
		let changed = false;
		control.afterClose = async (name) => {
			if (name !== nested || changed) return;
			await waitForLaterStamp(bundle, nested);
			await writeFile(extra, "DYTEST-late");
			changed = true;
		};
		await refused(verifyBundle(bundle));
		expect(changed).toBe(true);
		expect(await readFile(extra, "utf8")).toBe("DYTEST-late");
		control.afterClose = undefined;
		await unlink(extra);
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	for (const location of ["root", "nested"] as const) {
		for (const change of ["added", "removed"] as const) {
			it(`lists the ${location} directory again and refuses a name ${change} after the walk, whatever its times say`, async () => {
				const bundle = await fixture();
				const directory =
					location === "root" ? bundle.directory : path.join(bundle.directory, "nested");
				const member = path.join(directory, location === "root" ? "index.mjs" : "empty.bin");
				const extra = path.join(directory, "late.bin");
				// Holding the directory's stat stands in for a change within the same clock tick, which the
				// times cannot show; only the second listing can.
				control.held.set(directory, undefined);
				let changed = false;
				control.afterClose = async (name) => {
					if (name !== directory || changed) return;
					if (change === "added") await writeFile(extra, "DYTEST-late");
					else await rename(member, path.join(path.dirname(bundle.directory), "moved.bin"));
					changed = true;
				};
				await refused(verifyBundle(bundle));
				expect(changed).toBe(true);
				control.held.clear();
				control.afterClose = undefined;
				if (change === "added") await unlink(extra);
				else await rename(path.join(path.dirname(bundle.directory), "moved.bin"), member);
				expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
			});
		}

		it(`detects a native file added and removed just after the ${location} directory was opened`, async () => {
			const bundle = await fixture();
			const directory =
				location === "root" ? bundle.directory : path.join(bundle.directory, "nested");
			// No listing shows this file, so only the times taken before the directory was opened can.
			const extra = path.join(directory, "a-late.bin");
			let changed = false;
			control.afterOpendir = async (name) => {
				if (name !== directory || changed) return;
				await waitForLaterStamp(bundle, directory);
				await writeFile(extra, "DYTEST-late");
				await unlink(extra);
				changed = true;
			};
			await refused(verifyBundle(bundle));
			expect(changed).toBe(true);
			control.afterOpendir = undefined;
			expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
		});
	}

	it("rechecks each verified file after the walk", async () => {
		const bundle = await fixture();
		// A link made outside the root after the member was read changes only the member's stat.
		const alias = path.join(path.dirname(bundle.directory), "late-link.mjs");
		let changed = false;
		control.afterClose = async (name) => {
			if (name !== bundle.directory || changed) return;
			await link(path.join(bundle.directory, "index.mjs"), alias);
			changed = true;
		};
		await refused(verifyBundle(bundle));
		expect(changed).toBe(true);
		control.afterClose = undefined;
		await unlink(alias);
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("takes each file's stat before reading it", async () => {
		const bundle = await fixture();
		const target = path.join(bundle.directory, "index.mjs");
		const copy = path.join(path.dirname(bundle.directory), "copy.mjs");
		await writeFile(copy, content["index.mjs"]);
		// The same bytes under a new identity arrive just after the member is read; the root's held
		// stat keeps the rename out of its times.
		control.held.set(bundle.directory, undefined);
		control.file = target;
		let changed = false;
		control.afterFileClose = () => {
			control.afterFileClose = undefined;
			nativeFs.renameSync(copy, target);
			changed = true;
		};
		await refused(verifyBundle(bundle));
		expect(changed).toBe(true);
		reset();
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	for (const failure of ["read", "close"] as const) {
		it(
			"sanitizes native directory " +
				failure +
				" failure, closes once and allows later verification",
			async () => {
				const bundle = await fixture();
				if (failure === "read") control.readError = bundle.directory;
				else control.closeError = bundle.directory;
				await refused(verifyBundle(bundle));
				expect(control.directoryCloses.get(bundle.directory)).toBe(1);
				control.readError = "";
				control.closeError = "";
				expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
			},
		);
	}

	it("owns descriptor snapshots before filesystem awaits without invoking input hooks", async () => {
		const bundle = await fixture();
		let hooks = 0;
		const hostile = {
			...bundle,
			get inventory() {
				hooks++;
				return bundle.inventory;
			},
		};
		control.paths.length = 0;
		await refused(verifyBundle(hostile));
		expect(hooks).toBe(0);
		expect(control.paths).toEqual([]);
		const files = [...bundle.inventory.files];
		Object.defineProperty(files, Symbol.iterator, {
			value: () => {
				hooks++;
				throw new Error("DYTEST-iterator");
			},
		});
		await refused(verifyBundle({ ...bundle, inventory: { ...bundle.inventory, files } }));
		expect(hooks).toBe(0);
		expect(control.paths).toEqual([]);
		const mutable = {
			...bundle,
			inventory: { ...bundle.inventory, files: [...bundle.inventory.files] },
		};
		control.afterLstat = async () => {
			control.afterLstat = undefined;
			mutable.directory = path.join(path.dirname(bundle.directory), "changed-directory");
			mutable.inventory.entry = "changed.mjs";
			mutable.inventory.files.length = 0;
		};
		expect(await verifyBundle(mutable)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("refuses proxy and accessor bundle, inventory, array and row data without hooks or lookup", async () => {
		const bundle = await fixture();
		let hooks = 0;
		const hostile = <T extends object>(value: T): T =>
			new Proxy(value, {
				get() {
					hooks++;
					throw new Error("DYTEST-proxy-get");
				},
				ownKeys() {
					hooks++;
					throw new Error("DYTEST-proxy-keys");
				},
				getPrototypeOf() {
					hooks++;
					throw new Error("DYTEST-proxy-prototype");
				},
			});
		const accessorRow = { ...(bundle.inventory.files[0] as FileDigest) };
		Object.defineProperty(accessorRow, "bytes", {
			enumerable: true,
			get() {
				hooks++;
				return 0;
			},
		});
		const accessorFiles = [...bundle.inventory.files];
		Object.defineProperty(accessorFiles, "0", {
			enumerable: true,
			get() {
				hooks++;
				return accessorRow;
			},
		});
		for (const candidate of [
			hostile(bundle),
			{ ...bundle, inventory: hostile(bundle.inventory) },
			{
				...bundle,
				inventory: { ...bundle.inventory, files: hostile([...bundle.inventory.files]) },
			},
			{
				...bundle,
				inventory: {
					...bundle.inventory,
					files: [hostile(bundle.inventory.files[0] as FileDigest)],
				},
			},
			{ ...bundle, inventory: { ...bundle.inventory, files: [accessorRow] } },
			{ ...bundle, inventory: { ...bundle.inventory, files: accessorFiles } },
		]) {
			control.paths.length = 0;
			await refused(verifyBundle(candidate));
			expect(control.paths).toEqual([]);
			expect(hooks).toBe(0);
		}
		const plain = Object.assign(Object.create(null), bundle, {
			inventory: Object.assign(Object.create(null), bundle.inventory, {
				files: bundle.inventory.files.map((row) => Object.assign(Object.create(null), row)),
			}),
		});
		expect(await verifyBundle(plain)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("refuses class instances, array subclasses, array-likes and extra fields before lookup", async () => {
		const bundle = await fixture();
		const rows = bundle.inventory.files;
		class Bundle {
			directory = bundle.directory;
			inventory = bundle.inventory;
		}
		class Inventory {
			name = lock.name;
			version = lock.version;
			integrity = lock.integrity;
			entry = lock.entry;
			files = [...rows];
		}
		class Rows extends Array<FileDigest> {}
		const arrayLike: unknown = Object.setPrototypeOf(
			{ ...rows, length: rows.length },
			Array.prototype,
		);
		const symbol = Symbol("DYTEST");
		for (const candidate of [
			new Bundle(),
			{ ...bundle, inventory: new Inventory() },
			{ ...bundle, inventory: { ...bundle.inventory, files: Rows.from(rows) } },
			{ ...bundle, inventory: { ...bundle.inventory, files: arrayLike } },
			{ ...bundle, extra: "DYTEST" },
			{ ...bundle, [symbol]: "DYTEST" },
			{ ...bundle, inventory: { ...bundle.inventory, extra: "DYTEST" } },
			{ ...bundle, inventory: { ...bundle.inventory, [symbol]: "DYTEST" } },
		]) {
			control.paths.length = 0;
			await refused(verifyBundle(candidate as InstalledBundle));
			expect(control.paths).toEqual([]);
		}
		const accepted = { ...bundle, inventory: { ...bundle.inventory, files: [...rows] } };
		expect(await verifyBundle(accepted)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("refuses invalid inventory lock fields before lookup", async () => {
		const bundle = await fixture();
		for (const field of [
			{ name: "DYTEST invalid" },
			{ version: "1.2" },
			{ integrity: "sha512-DYTEST" },
			{ entry: "../index.mjs" },
		]) {
			control.paths.length = 0;
			await refused(verifyBundle({ ...bundle, inventory: { ...bundle.inventory, ...field } }));
			expect(control.paths).toEqual([]);
		}
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("rejects inconsistent prefix roles, spelling and absent entry before filesystem access", async () => {
		const bundle = await fixture();
		const empty = { bytes: 0, sha256: digest(Buffer.alloc(0)) };
		for (const files of [
			[
				{ ...empty, path: "index.mjs" },
				{ ...empty, path: "index.mjs/child" },
			],
			[
				{ ...empty, path: "index.mjs" },
				{ ...empty, path: "Dir/a" },
				{ ...empty, path: "dir/b" },
			],
			[
				{ ...empty, path: "index.mjs" },
				{ ...empty, path: "INDEX.mjs" },
			],
			[{ ...empty, path: "missing-entry.bin" }],
		]) {
			control.paths.length = 0;
			await refused(verifyBundle({ ...bundle, inventory: { ...bundle.inventory, files } }));
			expect(control.paths).toEqual([]);
		}
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("refuses traversal and absolute retained paths before filesystem access", async () => {
		const bundle = await fixture();
		const row = bundle.inventory.files[0] as FileDigest;
		for (const name of ["../index.mjs", "/index.mjs", "C:/index.mjs", "nested/../index.mjs"]) {
			control.paths.length = 0;
			const files = [...bundle.inventory.files, { ...row, path: name }];
			await refused(verifyBundle({ ...bundle, inventory: { ...bundle.inventory, files } }));
			expect(control.paths).toEqual([]);
		}
		control.file = path.join(bundle.directory, row.path);
		await refused(verifyBundleFile(control.file, { ...row, path: "../index.mjs" }));
		expect(control.opens).toBe(0);
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
	});

	it("admits exactly 64 MiB of real file bytes and refuses a larger retained sum before lookup", async () => {
		const bytes = Buffer.alloc(16 * 1024 * 1024, 0x45);
		const bundle = await fixture({
			"index.mjs": bytes,
			"second.bin": bytes,
			"third.bin": bytes,
			"fourth.bin": bytes,
		});
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
		control.paths.length = 0;
		await refused(
			verifyBundle({
				...bundle,
				inventory: {
					...bundle.inventory,
					files: [
						...bundle.inventory.files,
						{ path: "fifth.bin", bytes: 1, sha256: digest(Buffer.from("x")) },
					],
				},
			}),
		);
		expect(control.paths).toEqual([]);
	}, 60_000);

	it("admits 1024 files plus derived directories and refuses file 1025 before lookup", async () => {
		const files: Record<string, Buffer> = { "index.mjs": Buffer.alloc(0) };
		const prefix = Array.from({ length: 15 }, () => "d").join("/");
		for (let index = 0; index < 1023; index++) files[`${prefix}/f${index}.bin`] = Buffer.alloc(0);
		const bundle = await fixture(files);
		expect(await verifyBundle(bundle)).toBe(path.join(bundle.directory, lock.entry));
		control.paths.length = 0;
		await refused(
			verifyBundle({
				...bundle,
				inventory: {
					...bundle.inventory,
					files: [
						...bundle.inventory.files,
						{ path: "extra.bin", bytes: 0, sha256: digest(Buffer.alloc(0)) },
					],
				},
			}),
		);
		expect(control.paths).toEqual([]);
	}, 120_000);
});
