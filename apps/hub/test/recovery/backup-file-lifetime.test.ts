import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	RecoveryCapsuleFileError,
	RecoveryCapsuleFileWrite,
} from "../../src/recovery/backup-file.ts";

interface ObservedHandle {
	readonly handle: FileHandle;
	readonly close: () => Promise<void>;
	readonly stat: () => ReturnType<FileHandle["stat"]>;
}
const actualOpen = fs.open;
let roots: string[];
let handles: ObservedHandle[];
let writers: RecoveryCapsuleFileWrite[];
let pending: Promise<unknown>[];
let releases: (() => void)[];

beforeEach(() => {
	roots = [];
	handles = [];
	writers = [];
	pending = [];
	releases = [];
});

afterEach(async () => {
	for (const release of releases) release();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	await Promise.allSettled(pending);
	await Promise.allSettled(writers.map((writer) => writer.close()));
	const closed = await Promise.allSettled(handles.map((handle) => handle.close()));
	if (closed.some((result) => result.status === "rejected"))
		throw new Error("Recovery fixture retains an unclosed handle");
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function gate() {
	let release!: () => void;
	const promise = new Promise<void>((resolve) => {
		release = resolve;
	});
	releases.push(release);
	return { promise, release };
}

function track<T>(promise: Promise<T>): Promise<T> {
	pending.push(promise);
	void promise.catch(() => undefined);
	return promise;
}

function observe(configure: (handle: ObservedHandle) => void): void {
	vi.spyOn(fs, "open").mockImplementation(async (...args) => {
		const handle = await actualOpen(...args);
		const observed = {
			handle,
			close: handle.close.bind(handle),
			stat: () => handle.stat(),
		};
		handles.push(observed);
		configure(observed);
		return handle;
	});
	syncBuiltinESMExports();
}

function lastHandle(): ObservedHandle {
	const handle = handles.at(-1);
	if (!handle) throw new Error("Recovery fixture did not observe a handle");
	return handle;
}

function fixture() {
	const root = realpathSync.native(
		mkdtempSync(path.join(os.tmpdir(), "draftyak-backup-lifetime-")),
	);
	roots.push(root);
	const created = path.join(root, "data");
	mkdirSync(created, { mode: 0o700 });
	const folder = realpathSync.native(created);
	// Opaque generated ciphertext DATA; these tests make no decryption or ownership claim.
	const capsule = Buffer.alloc(94, 7);
	const writer = new RecoveryCapsuleFileWrite(folder, capsule);
	writers.push(writer);
	return { root, folder, capsule, writer, filename: path.join(folder, "mk.recovery") };
}

function fixed(error: unknown): void {
	expect(error).toBeInstanceOf(RecoveryCapsuleFileError);
	expect(error).toMatchObject({
		code: "RECOVERY_FILE_UNAVAILABLE",
		message: "Recovery file unavailable",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}

async function refused(promise: Promise<void>): Promise<void> {
	const result = await promise.then(
		() => null,
		(error: unknown) => error,
	);
	fixed(result);
}

it.each(["write", "sync"] as const)(
	"close joins the real pending %s and fences later writes",
	async (stage) => {
		const entered = gate(),
			resume = gate();
		observe(({ handle }) => {
			if (stage === "write") {
				const write = handle.write;
				vi.spyOn(handle, "write").mockImplementationOnce((async (...args: unknown[]) => {
					entered.release();
					await resume.promise;
					return Reflect.apply(write, handle, args);
				}) as FileHandle["write"]);
			} else {
				const sync = handle.sync.bind(handle);
				vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
					entered.release();
					await resume.promise;
					return sync();
				});
			}
		});
		const f = fixture(),
			writing = track(f.writer.write());
		await Promise.race([entered.promise, writing]);
		const original = lastHandle();
		expect((await original.stat()).isFile()).toBe(true);
		let closed = false;
		const closing = track(f.writer.close());
		void closing.then(
			() => {
				closed = true;
			},
			() => {
				closed = true;
			},
		);
		const afterClose = track(f.writer.write());
		await Promise.resolve();
		expect(closed).toBe(false);
		expect((await original.stat()).isFile()).toBe(true);
		expect(closed).toBe(false);
		expect(existsSync(f.filename)).toBe(true);
		resume.release();
		await refused(writing);
		await refused(afterClose);
		await closing;
		expect(existsSync(f.filename)).toBe(false);
		await expect(original.stat()).rejects.toMatchObject({ code: "EBADF" });
	},
);

it("retains an actually open handle after close failures and retries that same resource", async () => {
	let blocked = true;
	observe((original) => {
		vi.spyOn(original.handle, "close").mockImplementation(async () => {
			if (blocked) throw new Error("DYTEST recovery close fault");
			await original.close();
		});
	});
	const f = fixture();
	await refused(track(f.writer.write()));
	const original = lastHandle();
	expect((await original.stat()).size).toBe(94);
	await refused(track(f.writer.close()));
	expect((await original.stat()).size).toBe(94);
	expect(existsSync(f.filename)).toBe(true);
	blocked = false;
	await f.writer.close();
	expect(handles).toHaveLength(1);
	await expect(original.stat()).rejects.toMatchObject({ code: "EBADF" });
	expect(existsSync(f.filename)).toBe(false);
});

it.each(["write", "sync"] as const)(
	"does not report success after a real %s operation then fault",
	async (stage) => {
		observe(({ handle }) => {
			if (stage === "write") {
				const write = handle.write;
				vi.spyOn(handle, "write").mockImplementationOnce((async (...args: unknown[]) => {
					await Reflect.apply(write, handle, args);
					throw new Error("DYTEST recovery write fault");
				}) as FileHandle["write"]);
			} else {
				const sync = handle.sync.bind(handle);
				vi.spyOn(handle, "sync").mockImplementationOnce(async () => {
					await sync();
					throw new Error("DYTEST recovery sync fault");
				});
			}
		});
		const f = fixture();
		await refused(track(f.writer.write()));
		await f.writer.close();
		await expect(lastHandle().stat()).rejects.toMatchObject({ code: "EBADF" });
		expect(existsSync(f.filename)).toBe(false);
	},
);

it("does not unlink a replacement at its former file name", async () => {
	const f = fixture();
	await f.writer.write();
	const moved = path.join(f.root, "owned-capsule"),
		foreign = Buffer.from("foreign file DATA");
	renameSync(f.filename, moved);
	writeFileSync(f.filename, foreign, { mode: 0o600 });
	await refused(f.writer.close());
	expect(readFileSync(f.filename)).toEqual(foreign);
	expect(readFileSync(moved)).toEqual(f.capsule);
});

it.each(["directory", "junction"] as const)(
	"does not unlink through a replacement %s",
	async (kind) => {
		const f = fixture();
		await f.writer.write();
		const moved = path.join(f.root, "original-folder"),
			target = path.join(f.root, "foreign-folder");
		renameSync(f.folder, moved);
		const replacement = kind === "directory" ? f.folder : target;
		mkdirSync(replacement, { mode: 0o700 });
		const foreign = Buffer.from("foreign directory DATA");
		writeFileSync(path.join(replacement, "mk.recovery"), foreign, { mode: 0o600 });
		if (kind === "junction") symlinkSync(target, f.folder, "junction");
		await refused(f.writer.close());
		expect(readFileSync(path.join(replacement, "mk.recovery"))).toEqual(foreign);
		expect(readFileSync(path.join(moved, "mk.recovery"))).toEqual(f.capsule);
	},
);
