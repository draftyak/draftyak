import { createHash } from "node:crypto";
import {
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rename,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, expect, test, vi } from "vitest";
import { createNativeAppFiles, NativeAppFilesError } from "../../src/installer/native-app-files.ts";

// Fresh temporary content only. The metadata signature is intentionally invalid;
// no release-signature verifier, application admission, key or Native loader runs here.
const selectedReads = vi.hoisted(() => new Map<string, ResourceReadProbe>());
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> => {
			const handle = await actual.open(...args);
			const probe = typeof args[0] === "string" ? selectedReads.get(args[0]) : undefined;
			if (probe) {
				await probe.attach(handle);
				probe.handover(handle);
			}
			return handle;
		},
	};
});

type Files = ReturnType<typeof createNativeAppFiles>;
type ContentRelease = Parameters<Files["verify"]>[0];
const ids = [
	"channel-gmail",
	"channel-slack",
	"ai-messages-api",
	"ai-responses-api",
	"ai-chat-completions",
] as const;
const prefix = "draftyak-files-resource-";
const resourceName = "resources/content.bin";
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface RootIdentity {
	readonly dev: bigint;
	readonly ino: bigint;
}

interface Fixture {
	readonly parent: string;
	readonly root: string;
	readonly rootIdentity: RootIdentity;
	readonly readProbes: Set<ResourceReadProbe>;
	readonly files: Files;
	readonly release: ContentRelease;
	readonly content: Buffer;
}
const retained = new Set<Fixture>();

interface CapturedResourceHandle {
	readonly handle: FileHandle;
	readonly read: FileHandle["read"];
	readonly close: FileHandle["close"];
	returned: boolean;
	closeExits: number;
}
interface ResourceReadProbe {
	readonly entered: Promise<void>;
	readonly opens: number;
	readonly readCalls: number;
	readonly heldReads: number;
	readonly skippedEofs: number;
	readonly closeStarts: number;
	readonly closeExits: number;
	attach(handle: FileHandle): Promise<void>;
	handover(handle: FileHandle): void;
	arm(): void;
	armAfterOneEof(): void;
	release(): void;
	handle(): FileHandle;
	cleanup(): Promise<void>;
}
function readSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function selectedReadProbe(fixture: Fixture): Promise<ResourceReadProbe> {
	const target = join(fixture.root, ...resourceName.split("/"));
	const expected = await lstat(target, { bigint: true });
	if (
		!expected.isFile() ||
		expected.isSymbolicLink() ||
		expected.ino <= 0n ||
		selectedReads.has(target)
	)
		throw new Error("Selected resource identity refused.");
	const entered = readSignal(),
		released = readSignal();
	const allocations: CapturedResourceHandle[] = [];
	let primary: CapturedResourceHandle | undefined;
	let armed = false,
		readCalls = 0,
		heldReads = 0,
		closeStarts = 0,
		closeExits = 0;
	let eofSkips: number | undefined, eofPosition: number | undefined;
	let skippedEofs = 0;
	async function closeOriginal(captured: CapturedResourceHandle): Promise<void> {
		closeStarts++;
		await Reflect.apply(captured.close, captured.handle, []);
		captured.closeExits++;
		closeExits++;
	}
	const probe: ResourceReadProbe = {
		entered: entered.promise,
		get opens() {
			return allocations.length;
		},
		get readCalls() {
			return readCalls;
		},
		get heldReads() {
			return heldReads;
		},
		get skippedEofs() {
			return skippedEofs;
		},
		get closeStarts() {
			return closeStarts;
		},
		get closeExits() {
			return closeExits;
		},
		async attach(handle) {
			const captured: CapturedResourceHandle = {
				handle,
				read: handle.read,
				close: handle.close,
				returned: false,
				closeExits: 0,
			};
			allocations.push(captured);
			if (primary) throw new Error("Selected resource reopened instead of retained.");
			primary = captured;
			const actual = await handle.stat({ bigint: true });
			if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino)
				throw new Error("Selected resource handle identity refused.");
			Object.defineProperty(handle, "close", {
				configurable: true,
				writable: true,
				value: () => closeOriginal(captured),
			});
			Object.defineProperty(handle, "read", {
				configurable: true,
				writable: true,
				value: async (...args: unknown[]) => {
					const hold = armed && eofSkips === undefined;
					if (hold) {
						armed = false;
						heldReads++;
					}
					readCalls++;
					const result = await Reflect.apply(captured.read, handle, args);
					let eofHold = false;
					if (
						armed &&
						eofSkips !== undefined &&
						eofPosition !== undefined &&
						args.length === 4 &&
						Buffer.isBuffer(args[0]) &&
						args[0].length === 1 &&
						args[1] === 0 &&
						args[2] === 1 &&
						args[3] === eofPosition
					) {
						if (result.bytesRead !== 0) throw new Error("Original EOF result refused.");
						if (eofSkips > 0) {
							eofSkips--;
							skippedEofs++;
						} else {
							armed = false;
							heldReads++;
							eofHold = true;
						}
					}
					if (hold || eofHold) {
						entered.resolve();
						await released.promise;
					}
					return result;
				},
			});
		},
		handover(handle) {
			const captured = allocations.find((item) => item.handle === handle);
			if (!captured) throw new Error("Unowned selected handle refused.");
			captured.returned = true;
		},
		arm() {
			if (!primary?.returned || primary.handle.fd < 0 || armed || heldReads !== 0)
				throw new Error("Selected read cannot be armed.");
			armed = true;
		},
		armAfterOneEof() {
			const size = Number(expected.size);
			if (!Number.isSafeInteger(size) || size < 1)
				throw new Error("Positive bounded EOF position required.");
			probe.arm();
			eofPosition = size;
			eofSkips = 1;
		},
		release: released.resolve,
		handle() {
			if (!primary) throw new Error("Selected handle was not allocated.");
			return primary.handle;
		},
		async cleanup() {
			released.resolve();
			const failures: unknown[] = [];
			for (const captured of allocations) {
				try {
					if (!captured.returned && captured.closeExits === 0) await closeOriginal(captured);
					if (captured.closeExits === 0 || captured.handle.fd !== -1)
						throw new Error("Original selected handle close remains unproven.");
					Object.defineProperty(captured.handle, "read", {
						configurable: true,
						writable: true,
						value: captured.read,
					});
					Object.defineProperty(captured.handle, "close", {
						configurable: true,
						writable: true,
						value: captured.close,
					});
				} catch (error) {
					failures.push(error);
				}
			}
			if (failures.length)
				throw new AggregateError(failures, "Selected resources remain retained.");
			if (selectedReads.get(target) === probe) selectedReads.delete(target);
		},
	};
	fixture.readProbes.add(probe);
	selectedReads.set(target, probe);
	return probe;
}

async function captureRootIdentity(root: string, parent: string): Promise<RootIdentity> {
	const absolute = resolve(root);
	if (dirname(absolute) !== parent || !basename(absolute).startsWith(prefix))
		throw new Error("Temporary resource target refused.");
	const stat = await lstat(absolute, { bigint: true });
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.ino <= 0n ||
		(await realpath(absolute)) !== absolute
	)
		throw new Error("Temporary resource identity refused.");
	return Object.freeze({ dev: stat.dev, ino: stat.ino });
}

async function removeOwnedRoot(
	root: string,
	parent: string,
	original: RootIdentity,
): Promise<void> {
	const current = await captureRootIdentity(root, parent);
	if (current.dev !== original.dev || current.ino !== original.ino)
		throw new Error("Temporary resource identity refused.");
	await rm(root, { recursive: true, force: true });
}

async function finish(fixture: Fixture): Promise<void> {
	for (const probe of fixture.readProbes) probe.release();
	const failures: unknown[] = [];
	try {
		await fixture.files.close();
	} catch (error) {
		failures.push(error);
	}
	for (const probe of fixture.readProbes) {
		try {
			await probe.cleanup();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Genuine resources remain retained.");
	await removeOwnedRoot(fixture.root, fixture.parent, fixture.rootIdentity);
	fixture.readProbes.clear();
	retained.delete(fixture);
}

async function fixture(): Promise<Fixture> {
	const temporary = tmpdir();
	if (!temporary || !isAbsolute(temporary))
		throw new Error("Absolute temporary directory is required.");
	const parent = await realpath(temporary);
	const root = await mkdtemp(join(parent, prefix));
	const rootIdentity = await captureRootIdentity(root, parent);
	const content = Buffer.from("fresh content bytes\n");
	const values = new Map<string, Buffer>([
		["runtime.bin", Buffer.from("synthetic executable content, never executed\n")],
		["hub.mjs", Buffer.from("synthetic module content, never imported\n")],
		[resourceName, content],
	]);
	const bundles = ids.map((id) => {
		const archive = `archives/${id}.tgz`;
		const bytes = Buffer.from(`synthetic archive content for ${id}\n`);
		values.set(archive, bytes);
		return Object.freeze({
			id,
			archive,
			package: Object.freeze({
				name: `@draftyak/${id}`,
				version: "1.0.0",
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
				entry: "index.mjs",
			}),
		});
	});
	const release: ContentRelease = Object.freeze({
		v: 1,
		application: "draftyak",
		version: "1.0.0",
		platform: "linux",
		arch: "x64",
		executable: "runtime.bin",
		entry: "hub.mjs",
		bundles: Object.freeze(bundles),
		files: Object.freeze(
			[...values].map(([path, bytes]) =>
				Object.freeze({ path, bytes: bytes.length, sha256: hash(bytes) }),
			),
		),
	});
	try {
		for (const [name, bytes] of values) {
			const file = join(root, ...name.split("/"));
			await mkdir(dirname(file), { recursive: true });
			await writeFile(file, bytes, { flag: "wx" });
		}
		await writeFile(join(root, "release.manifest.json"), JSON.stringify(release), { flag: "wx" });
		await writeFile(join(root, "release.signature"), Buffer.alloc(64), { flag: "wx" });
		const files = createNativeAppFiles(root);
		const result = Object.freeze({
			parent,
			root,
			rootIdentity,
			files,
			release,
			content,
			readProbes: new Set<ResourceReadProbe>(),
		});
		retained.add(result);
		return result;
	} catch (error) {
		await removeOwnedRoot(root, parent, rootIdentity);
		throw error;
	}
}

async function usingFixture(work: (value: Fixture) => Promise<void>): Promise<void> {
	const value = await fixture();
	try {
		await work(value);
	} finally {
		await finish(value);
	}
}

afterAll(async () => {
	const results = await Promise.allSettled([...retained].map(finish));
	const failures = results.filter(
		(result): result is PromiseRejectedResult => result.status === "rejected",
	);
	if (failures.length)
		throw new AggregateError(
			failures.map((result) => result.reason),
			"Temporary resource cleanup failed.",
		);
});

test("resource content refuses a read before inventory verification", async () => {
	await usingFixture(async (value) => {
		await expect(value.files.resource(resourceName)).rejects.toBeInstanceOf(NativeAppFilesError);
	});
});

test("resource content reads a verified member and returns independent bytes", async () => {
	await usingFixture(async (value) => {
		await value.files.verify(value.release);
		const first = await value.files.resource(resourceName);
		expect(Buffer.isBuffer(first)).toBe(true);
		expect(first.equals(value.content)).toBe(true);
		first.fill(0);
		const second = await value.files.resource(resourceName);
		expect(second).not.toBe(first);
		expect(second.equals(value.content)).toBe(true);
	});
});

test.each([
	["absent", "resources/absent.bin"],
	["traversal", "../content.bin"],
	["backslash alias", "resources\\content.bin"],
	["directory", "resources"],
	["case alias", "RESOURCES/content.bin"],
	["manifest metadata", "release.manifest.json"],
	["signature metadata", "release.signature"],
])("resource content refuses %s outside exact inventory membership", async (_label, name) => {
	await usingFixture(async (value) => {
		await value.files.verify(value.release);
		await expect(value.files.resource(name)).rejects.toBeInstanceOf(NativeAppFilesError);
	});
});

test("resource content refuses an absolute path even for a declared member", async () => {
	await usingFixture(async (value) => {
		await value.files.verify(value.release);
		await expect(
			value.files.resource(join(value.root, "resources", "content.bin")),
		).rejects.toBeInstanceOf(NativeAppFilesError);
	});
});

test.each(["hash", "size"] as const)(
	"resource content cannot establish an inventory with a wrong %s",
	async (changed) => {
		await usingFixture(async (value) => {
			const release: ContentRelease = Object.freeze({
				...value.release,
				files: Object.freeze(
					value.release.files.map((record) =>
						record.path !== resourceName
							? record
							: Object.freeze({
									...record,
									...(changed === "hash"
										? { sha256: "0".repeat(64) }
										: { bytes: record.bytes + 1 }),
								}),
					),
				),
			});
			await writeFile(join(value.root, "release.manifest.json"), JSON.stringify(release));
			await expect(value.files.verify(release)).rejects.toBeInstanceOf(NativeAppFilesError);
			await expect(value.files.resource(resourceName)).rejects.toBeInstanceOf(NativeAppFilesError);
		});
	},
);

test("resource content refuses same-size member tampering after verification", async () => {
	await usingFixture(async (value) => {
		await value.files.verify(value.release);
		await writeFile(
			join(value.root, "resources", "content.bin"),
			Buffer.alloc(value.content.length, 120),
		);
		await expect(value.files.resource(resourceName)).rejects.toBeInstanceOf(NativeAppFilesError);
	});
});

test("resource content refuses a replacement identity even with equal bytes", async () => {
	await usingFixture(async (value) => {
		await value.files.verify(value.release);
		const member = join(value.root, "resources", "content.bin");
		await unlink(member);
		await writeFile(member, value.content, { flag: "wx" });
		await expect(value.files.resource(resourceName)).rejects.toBeInstanceOf(NativeAppFilesError);
	});
});

test("resource content rechecks the closed inventory before returning a member", async () => {
	await usingFixture(async (value) => {
		await value.files.verify(value.release);
		await writeFile(join(value.root, "resources", "unlisted.bin"), "unexpected", { flag: "wx" });
		await expect(value.files.resource(resourceName)).rejects.toBeInstanceOf(NativeAppFilesError);
	});
});

test("resource content refuses a read after close", async () => {
	await usingFixture(async (value) => {
		await value.files.verify(value.release);
		await value.files.close();
		await expect(value.files.resource(resourceName)).rejects.toBeInstanceOf(NativeAppFilesError);
	});
});

test("resource content close fences a queued read", async () => {
	await usingFixture(async (value) => {
		await value.files.verify(value.release);
		const reading = value.files.resource(resourceName);
		const refusal = expect(reading).rejects.toBeInstanceOf(NativeAppFilesError);
		const closing = value.files.close();
		await Promise.all([refusal, closing]);
	});
});

test("retains a replacement directory at the original temporary path", async () => {
	const value = await fixture();
	let custody: { readonly root: string; readonly identity: RootIdentity } | undefined;
	let relocated = false;
	let replacementIdentity: RootIdentity | undefined;
	const failures: unknown[] = [];
	try {
		await value.files.close();
		const root = await mkdtemp(join(value.parent, prefix));
		const identity = await captureRootIdentity(root, value.parent);
		custody = Object.freeze({ root, identity });
		await rename(value.root, join(custody.root, "original"));
		relocated = true;
		await mkdir(value.root);
		replacementIdentity = await captureRootIdentity(value.root, value.parent);
		const marker = join(value.root, "replacement.txt");
		await writeFile(marker, "replacement directory sentinel\n", { flag: "wx" });
		await expect(finish(value)).rejects.toThrow("Temporary resource identity refused.");
		expect(await readFile(marker, "utf8")).toBe("replacement directory sentinel\n");
		expect(retained.has(value)).toBe(true);
	} catch (error) {
		failures.push(error);
	}
	try {
		if (relocated) {
			if (!custody || !replacementIdentity)
				throw new Error("Temporary replacement identity is unknown; original retained.");
			let replacementPresent = true;
			try {
				await lstat(value.root);
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
				replacementPresent = false;
			}
			if (replacementPresent) await removeOwnedRoot(value.root, value.parent, replacementIdentity);
			await rename(join(custody.root, "original"), value.root);
		}
		await finish(value);
		if (custody) await removeOwnedRoot(custody.root, value.parent, custody.identity);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Temporary root restoration failed.");
});

test("close joins an already-running original resource read before retiring its handle", async () => {
	const value = await fixture();
	let probe: ResourceReadProbe | undefined;
	let positive: Buffer | undefined;
	const returnedData: { value?: Buffer } = {};
	let operation: Promise<Buffer> | undefined, closing: Promise<void> | undefined;
	let resourceSettled = false,
		resourceSuccessful = false,
		closeSettled = false;
	const failures: unknown[] = [];
	type ResourceOutcome =
		| { readonly ok: true; readonly data: Buffer }
		| { readonly ok: false; readonly error: unknown };
	type CloseOutcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };
	let outcome: Promise<ResourceOutcome> | undefined,
		closeOutcome: Promise<CloseOutcome> | undefined;
	try {
		probe = await selectedReadProbe(value);
		await value.files.verify(value.release);
		positive = await value.files.resource(resourceName);
		expect(positive).toEqual(value.content);
		positive.fill(0);
		positive = undefined;
		expect(probe.opens).toBe(1);
		expect(probe.readCalls).toBeGreaterThan(0);
		probe.arm();
		operation = value.files.resource(resourceName);
		outcome = operation.then(
			(data): ResourceOutcome => {
				resourceSettled = true;
				resourceSuccessful = true;
				returnedData.value = data;
				return { ok: true, data };
			},
			(error: unknown): ResourceOutcome => {
				resourceSettled = true;
				return { ok: false, error };
			},
		);
		await Promise.race([
			probe.entered,
			outcome.then(() => {
				throw new Error("Resource settled before original read entry.");
			}),
		]);
		expect(probe.heldReads).toBe(1);
		closing = value.files.close();
		expect(probe.closeStarts).toBe(0);
		closeOutcome = closing.then(
			(): CloseOutcome => {
				closeSettled = true;
				return { ok: true };
			},
			(error: unknown): CloseOutcome => {
				closeSettled = true;
				return { ok: false, error };
			},
		);
		await expect(value.files.resource(resourceName)).rejects.toThrow(NativeAppFilesError);
		await nextTurn();
		expect(resourceSettled).toBe(false);
		expect(resourceSuccessful).toBe(false);
		expect(closeSettled).toBe(false);
		expect(probe.handle().fd).toBeGreaterThanOrEqual(0);
		expect(probe.closeStarts).toBe(0);
		probe.release();
		const refused = await outcome;
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("Resource DATA escaped its close fence.");
		expect(refused.error).toBeInstanceOf(NativeAppFilesError);
		expect(refused.error).toHaveProperty("message", "Native application files unavailable.");
		const closed = await closeOutcome;
		if (!closed.ok) throw closed.error;
		expect(probe.opens).toBe(1);
		expect(probe.closeStarts).toBe(1);
		expect(probe.closeExits).toBe(1);
		expect(probe.handle().fd).toBe(-1);
		expect(resourceSuccessful).toBe(false);
		await expect(value.files.resource(resourceName)).rejects.toThrow(NativeAppFilesError);
	} catch (error) {
		failures.push(error);
	}
	try {
		probe?.release();
		await Promise.allSettled([...(operation ? [operation] : []), ...(closing ? [closing] : [])]);
		positive?.fill(0);
		returnedData.value?.fill(0);
		await finish(value);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "Resource read and cleanup failed.");
});

test("resource rechecks unrelated inventory after the selected native read", async () => {
	const value = await fixture();
	let probe: ResourceReadProbe | undefined;
	let operation: Promise<Buffer> | undefined;
	let originalArchive: Buffer | undefined, changedArchive: Buffer | undefined;
	const returnedData: { value?: Buffer } = {};
	let resourceSettled = false;
	const failures: unknown[] = [];
	type Outcome = { readonly ok: true } | { readonly ok: false; readonly error: unknown };
	try {
		const archive = join(value.root, "archives", `${ids[0]}.tgz`);
		const original = await lstat(archive, { bigint: true });
		if (
			!original.isFile() ||
			original.isSymbolicLink() ||
			original.ino <= 0n ||
			(await realpath(archive)) !== archive
		)
			throw new Error("Original archive identity refused.");
		originalArchive = await readFile(archive);
		changedArchive = Buffer.from(originalArchive);
		const first = changedArchive[0];
		if (first === undefined) throw new Error("Nonempty archive content required.");
		changedArchive[0] = first ^ 1;
		expect(hash(changedArchive)).not.toBe(hash(originalArchive));
		probe = await selectedReadProbe(value);
		await value.files.verify(value.release);
		probe.armAfterOneEof();
		operation = value.files.resource(resourceName);
		const outcome = operation.then(
			(data): Outcome => {
				resourceSettled = true;
				returnedData.value = data;
				return { ok: true };
			},
			(error: unknown): Outcome => {
				resourceSettled = true;
				return { ok: false, error };
			},
		);
		await Promise.race([
			probe.entered,
			outcome.then(() => {
				throw new Error("Resource settled before selected read EOF entry.");
			}),
		]);
		expect(probe.skippedEofs).toBe(1);
		expect(probe.heldReads).toBe(1);
		expect(probe.opens).toBe(1);
		await nextTurn();
		expect(resourceSettled).toBe(false);
		expect(returnedData.value).toBeUndefined();
		expect(probe.handle().fd).toBeGreaterThanOrEqual(0);
		await writeFile(archive, changedArchive, { flag: "r+" });
		const changed = await lstat(archive, { bigint: true });
		expect(changed.isFile()).toBe(true);
		expect(changed.isSymbolicLink()).toBe(false);
		expect(changed.dev).toBe(original.dev);
		expect(changed.ino).toBe(original.ino);
		expect(changed.size).toBe(original.size);
		probe.release();
		const result = await outcome;
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("Resource DATA escaped the final inventory verification.");
		expect(result.error).toBeInstanceOf(NativeAppFilesError);
		expect(result.error).toHaveProperty("message", "Native application files unavailable.");
		expect(returnedData.value).toBeUndefined();
	} catch (error) {
		failures.push(error);
	}
	try {
		probe?.release();
		await Promise.allSettled(operation ? [operation] : []);
		originalArchive?.fill(0);
		changedArchive?.fill(0);
		returnedData.value?.fill(0);
		await finish(value);
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1)
		throw new AggregateError(failures, "Late inventory verification and cleanup failed.");
});
