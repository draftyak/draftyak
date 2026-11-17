import type { ChildProcess } from "node:child_process";
import type { BigIntStats } from "node:fs";
import { closeSync, fstatSync, fsyncSync, openSync, writeSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

const verify = path.resolve(import.meta.dirname, "..");
const cache = path.join(verify, ".cache", "inventory-native");
const lockFile = path.join(verify, ".inventory-native-ubuntu-inputs-v1.lock");
const lockBytes = Buffer.from("inventory-ubuntu-inputs-bootstrap-v1\n");
const refusal = (): Error => new Error("inventory cache operation ownership is unqualified");
const need = (condition: unknown): void => {
	if (!condition) throw refusal();
};
const canonical = (value: string): string =>
	process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const same = (left: BigIntStats, right: BigIntStats): boolean =>
	left.dev === right.dev && left.ino === right.ino;

interface OwnedFile {
	readonly file: string;
	readonly fd: number;
	readonly dependent: boolean;
	identity?: BigIntStats;
	closeState: "open" | "closed" | "uncertain";
	closeError?: unknown;
}
interface OwnedChild {
	readonly original: ChildProcess;
	readonly parents: readonly OwnedFile[];
	readonly streams: {
		readonly original: Readable;
		closed: boolean;
		completion?: Promise<void>;
	}[];
	registration: "registering" | "qualified" | "debt";
	nativeClosed: boolean;
	nativeCompletion?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	closed: boolean;
	completion?: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	registrationError?: unknown;
}
interface OwnedLock {
	readonly original: FileHandle;
	identity?: BigIntStats;
	ready: boolean;
	closed: boolean;
	closePromise?: Promise<void>;
	closeError?: unknown;
}

// Actual originals and uncertain outcomes remain reachable for this module/process lifetime.
// The fixed on-disk key also excludes other cooperating acquisition writers.
// No stale takeover or parent-liveness claim exists.
let active: InventoryCacheOperation | undefined;

export class InventoryCacheOperation {
	private readonly files: OwnedFile[] = [];
	private readonly children: OwnedChild[] = [];
	private readonly failures: unknown[] = [];
	private lock?: OwnedLock;
	private repositoryIdentity?: BigIntStats;
	private retained = false;
	private finished = false;

	private constructor() {}

	static async begin(): Promise<InventoryCacheOperation> {
		need(active === undefined);
		const operation = new InventoryCacheOperation();
		active = operation; // Reserve before the first await; never implicitly reuse another operation.
		try {
			await operation.repository();
			operation.repositoryIdentity = await lstat(verify, { bigint: true });
			const original = await open(lockFile, "wx", 0o600);
			const lock: OwnedLock = { original, ready: false, closed: false };
			operation.lock = lock; // Own the successful open before fallible stat/write/sync.
			lock.identity = await original.stat({ bigint: true });
			await original.writeFile(lockBytes);
			await original.sync();
			const after = await original.stat({ bigint: true });
			need(
				same(lock.identity, after) &&
					after.isFile() &&
					after.nlink === 1n &&
					after.size === BigInt(lockBytes.length),
			);
			lock.identity = after;
			lock.ready = true;
			await operation.assertLock();
			return operation;
		} catch (error) {
			operation.noteFailure(error);
			await operation.finish(true);
			throw error;
		}
	}

	private async repository(): Promise<void> {
		need(canonical(await realpath(verify)) === canonical(verify));
		for (let current = verify; ; current = path.dirname(current)) {
			const info = await lstat(current, { bigint: true });
			need(info.isDirectory() && !info.isSymbolicLink());
			if (process.platform !== "win32")
				need(
					(info.uid === BigInt(process.getuid?.() ?? -1) || info.uid === 0n) &&
						(info.mode & 0o022n) === 0n,
				);
			if (path.dirname(current) === current) break;
		}
		if (this.repositoryIdentity) {
			const current = await lstat(verify, { bigint: true });
			need(
				same(this.repositoryIdentity, current) &&
					current.uid === this.repositoryIdentity.uid &&
					current.mode === this.repositoryIdentity.mode,
			);
		}
	}

	private async assertLock(): Promise<void> {
		await this.repository();
		const lock = this.lock;
		need(lock?.ready && lock.identity !== undefined);
		if (!lock?.identity) throw refusal();
		const named = await lstat(lockFile, { bigint: true });
		need(
			named.isFile() &&
				!named.isSymbolicLink() &&
				named.nlink === 1n &&
				same(named, lock.identity) &&
				named.size === lock.identity.size &&
				canonical(await realpath(lockFile)) === canonical(lockFile),
		);
		if (process.platform !== "win32")
			need(named.uid === BigInt(process.getuid?.() ?? -1) && (named.mode & 0o077n) === 0n);
	}

	retain(): void {
		this.retained = true;
	}
	noteFailure(error: unknown): void {
		if (this.failures.length < 16) this.failures.push(error);
	}

	openFile(file: string, flags: string): OwnedFile {
		return this.openOriginal(file, flags, false);
	}

	openPreparationLock(): OwnedFile {
		return this.openOriginal(path.join(cache, "prepare.lock"), "wx", true);
	}

	private openOriginal(file: string, flags: string, dependent: boolean): OwnedFile {
		need(!this.finished && !this.retained && this.lock?.ready);
		const relative = path.relative(cache, path.resolve(file));
		need(
			relative !== "" &&
				!path.isAbsolute(relative) &&
				relative !== ".." &&
				!relative.startsWith(`..${path.sep}`),
		);
		const fd = openSync(file, flags, 0o600);
		const original: OwnedFile = { file, fd, dependent, closeState: "open" };
		this.files.push(original); // The exact numeric original is recorded before its first stat.
		try {
			original.identity = fstatSync(fd, { bigint: true });
		} catch (error) {
			this.noteFailure(error);
			this.retained = true;
			throw error;
		}
		return original;
	}

	syncFile(original: OwnedFile): void {
		need(this.files.includes(original) && original.closeState === "open");
		fsyncSync(original.fd);
	}

	closeFile(original: OwnedFile): void {
		need(this.files.includes(original));
		if (original.closeState === "closed") return;
		if (original.closeState === "uncertain") throw refusal();
		// Record uncertainty BEFORE the one original close call. Never retry a thrown close.
		original.closeState = "uncertain";
		try {
			closeSync(original.fd);
			original.closeState = "closed";
		} catch (error) {
			original.closeError = error;
			this.noteFailure(error);
			this.retained = true;
			throw error;
		}
	}

	writeFile(file: string, bytes: Uint8Array | string): void {
		const original = this.openFile(file, "wx");
		let failure: unknown,
			failed = false;
		try {
			const buffer = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
			for (let offset = 0; offset < buffer.length; ) {
				const count = writeSync(original.fd, buffer, offset, buffer.length - offset);
				need(count > 0);
				offset += count;
			}
			this.syncFile(original);
		} catch (error) {
			failed = true;
			failure = error;
		}
		try {
			this.closeFile(original);
		} catch (error) {
			if (!failed) {
				failed = true;
				failure = error;
			}
		}
		if (failed) throw failure;
	}

	watchChild(
		original: ChildProcess,
		parents: readonly OwnedFile[],
	): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
		const record: OwnedChild = {
			original,
			parents: [...parents],
			streams: [],
			registration: "registering",
			nativeClosed: false,
			closed: false,
		};
		this.children.push(record); // Own the actual child and parent fds BEFORE registration work.
		try {
			need(
				!this.finished && !this.retained && parents.every((parent) => this.files.includes(parent)),
			);
			// A later registration refusal must not leave an ordinary spawn error unobserved.
			original.on("error", (error) => this.noteFailure(error));
			let settle:
				| ((value: { code: number | null; signal: NodeJS.Signals | null }) => void)
				| undefined;
			const terminal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
				(resolve) => {
					settle = resolve;
				},
			);
			original.once("close", (code, signal) => {
				record.nativeClosed = true;
				settle?.({ code, signal });
			});
			record.nativeCompletion = terminal; // Only after its actual listener was installed.
			const streams: Promise<void>[] = [];
			for (const stream of [original.stdout, original.stderr]) {
				if (stream === null) throw refusal();
				const owned: OwnedChild["streams"][number] = { original: stream, closed: false };
				record.streams.push(owned);
				let settleStream: (() => void) | undefined;
				const completion = new Promise<void>((resolve) => {
					settleStream = resolve;
				});
				stream.once("close", () => {
					owned.closed = true;
					settleStream?.();
				});
				owned.completion = completion; // An unregistered stream has no close receipt.
				streams.push(completion);
			}
			record.registration = "qualified";
			record.completion = (async () => {
				const ending = await terminal;
				await Promise.all(streams);
				record.closed =
					record.nativeClosed &&
					record.streams.length === 2 &&
					record.streams.every((stream) => stream.closed);
				return ending;
			})();
			return record.completion;
		} catch (error) {
			record.registration = "debt";
			record.registrationError = error;
			this.noteFailure(error);
			this.retained = true;
			throw error;
		}
	}

	childClosed(original: ChildProcess): boolean {
		const record = this.children.find((child) => child.original === original);
		return (
			record?.registration === "qualified" &&
			record.completion !== undefined &&
			record.closed &&
			record.nativeClosed &&
			record.streams.length === 2 &&
			record.streams.every((stream) => stream.closed)
		);
	}

	retainChildRegistration(original: ChildProcess, parents: readonly OwnedFile[]): void {
		let record = this.children.find((child) => child.original === original);
		if (record === undefined) {
			record = {
				original,
				parents: [...parents],
				streams: [],
				registration: "debt",
				nativeClosed: false,
				closed: false,
			};
			this.children.push(record); // Missing registration is retained actual custody, never closure.
		}
		record.registration = "debt";
		this.retained = true;
	}

	async releasePreparationLock(original: OwnedFile, primaryFailed: boolean): Promise<void> {
		let failed = false;
		try {
			await this.drainIndependentFiles();
			need(!this.retained && original.dependent);
			this.syncFile(original);
			this.closeFile(original);
			const named = await lstat(original.file, { bigint: true });
			need(
				original.identity &&
					named.isFile() &&
					!named.isSymbolicLink() &&
					named.nlink === 1n &&
					same(named, original.identity),
			);
			await this.assertLock();
			await unlink(original.file);
		} catch (error) {
			this.noteFailure(error);
			failed = true;
			this.retained = true;
		}
		if (failed && !primaryFailed) throw refusal();
	}

	private async drainIndependentFiles(): Promise<void> {
		// No parent fd may close while its admitted child/pipe can still write to it.
		const qualified = this.children.flatMap((child) =>
			child.registration === "qualified" && child.completion !== undefined
				? [{ child, completion: child.completion }]
				: [],
		);
		const outcomes = await Promise.allSettled(qualified.map((entry) => entry.completion));
		for (const [index, outcome] of outcomes.entries()) {
			if (outcome.status === "rejected") {
				const child = qualified[index]?.child;
				if (child) {
					child.registration = "debt";
					child.registrationError = outcome.reason;
				}
				this.noteFailure(outcome.reason);
				this.retained = true;
			}
		}
		const blocked = new Set<OwnedFile>();
		for (const child of this.children) {
			if (!this.childClosed(child.original)) {
				this.retained = true;
				for (const parent of child.parents) blocked.add(parent);
			}
		}
		for (const original of this.files.filter((file) => !file.dependent)) {
			if (blocked.has(original)) continue;
			try {
				this.closeFile(original);
			} catch {
				this.retained = true;
			}
		}
	}

	async finish(primaryFailed: boolean): Promise<void> {
		if (this.finished) {
			if (this.retained && !primaryFailed) throw refusal();
			return;
		}
		await this.drainIndependentFiles();
		if (this.files.some((file) => file.dependent && file.closeState !== "closed")) {
			// An unreleased preparation key is dependent namespace debt, not a stale key to clear.
			this.retained = true;
		}
		if (this.lock && !this.lock.ready) this.retained = true;
		if (!this.retained && this.lock) {
			try {
				await this.assertLock();
				const lock = this.lock;
				lock.closePromise ??= Promise.resolve()
					.then(() => lock.original.close())
					.then(
						() => {
							lock.closed = true;
						},
						(error: unknown) => {
							lock.closeError = error;
							this.retained = true;
							throw error;
						},
					);
				await lock.closePromise;
				await this.assertLock();
				await unlink(lockFile); // Last mutation; no fallible descriptor work follows release.
			} catch (error) {
				this.noteFailure(error);
				this.retained = true;
			}
		}
		this.finished = true;
		if (!this.retained && active === this) active = undefined;
		if (this.retained && !primaryFailed) throw refusal();
	}
}
