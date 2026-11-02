import { type BigIntStats, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { readBoundedRegularFile } from "@draftyak/bounded-files";
import { flushDirectory } from "../store/durable-file.ts";
import { RECOVERY_FILE, RECOVERY_FILE_SIZE } from "./recovery-code.ts";

/** A fixed DATA-file refusal, carrying no path, capsule or underlying cause. */
export class RecoveryCapsuleFileError extends Error {
	override name: string = "RecoveryCapsuleFileError";
	readonly code: "RECOVERY_FILE_UNAVAILABLE" = "RECOVERY_FILE_UNAVAILABLE";
	constructor() {
		super("Recovery file unavailable");
	}
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const backing = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const setBytes = Uint8Array.prototype.set;
const same = (a: BigIntStats, b: BigIntStats): boolean =>
	a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;

function folderName(value: unknown): string {
	if (
		typeof value !== "string" ||
		!value.isWellFormed() ||
		value.length > 4096 ||
		!path.isAbsolute(value) ||
		path.resolve(value) !== value ||
		/^[/\\]{2}/.test(value) ||
		(process.platform === "win32" && value.slice(2).includes(":"))
	)
		throw new RecoveryCapsuleFileError();
	return value;
}

function privateMode(info: BigIntStats, mode: bigint): boolean {
	return (
		process.platform === "win32" ||
		(info.uid === BigInt(process.geteuid?.() ?? -1) && (info.mode & 0o777n) === mode)
	);
}

function directory(folder: string, previous?: BigIntStats): BigIntStats {
	const info = lstatSync(folder, { bigint: true });
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		info.ino === 0n ||
		(process.platform !== "win32" &&
			(info.uid !== BigInt(process.geteuid?.() ?? -1) || (info.mode & 0o022n) !== 0n)) ||
		realpathSync.native(folder) !== folder ||
		(previous !== undefined && !same(info, previous))
	)
		throw new RecoveryCapsuleFileError();
	return info;
}

function regular(info: BigIntStats): void {
	if (
		!info.isFile() ||
		info.isSymbolicLink() ||
		info.ino === 0n ||
		info.nlink !== 1n ||
		!privateMode(info, 0o600n)
	)
		throw new RecoveryCapsuleFileError();
}

function absent(filename: string): void {
	try {
		lstatSync(filename);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
	}
	throw new RecoveryCapsuleFileError();
}

function capture(value: unknown): Buffer {
	if (
		!types.isUint8Array(value) ||
		byteLength?.call(value) !== RECOVERY_FILE_SIZE ||
		!backing ||
		types.isSharedArrayBuffer(backing.call(value))
	)
		throw new RecoveryCapsuleFileError();
	const bytes = Buffer.alloc(RECOVERY_FILE_SIZE);
	try {
		setBytes.call(bytes, value);
		return bytes;
	} catch {
		bytes.fill(0);
		throw new RecoveryCapsuleFileError();
	}
}

/** Reads encrypted DATA only; neither its structure nor its key binding is authenticated here. */
export function readRecoveryCapsuleFile(folder: unknown): Buffer {
	try {
		const name = folderName(folder),
			initial = directory(name);
		const filename = path.join(name, RECOVERY_FILE);
		const before = lstatSync(filename, { bigint: true });
		regular(before);
		const bytes = readBoundedRegularFile(filename, {
			maximum: RECOVERY_FILE_SIZE,
			expectedSize: RECOVERY_FILE_SIZE,
		});
		const after = lstatSync(filename, { bigint: true });
		regular(after);
		directory(name, initial);
		if (!same(before, after)) throw new RecoveryCapsuleFileError();
		return bytes;
	} catch {
		throw new RecoveryCapsuleFileError();
	}
}

/** Owns one exclusive encrypted DATA-file write and its complete cleanup lifetime. */
export class RecoveryCapsuleFileWrite {
	readonly #folder: string;
	readonly #filename: string;
	readonly #bytes: Buffer;
	#folderInfo: BigIntStats | undefined;
	#fileInfo: BigIntStats | undefined;
	#handle: FileHandle | undefined;
	#writing: Promise<void> | undefined;
	#closing: Promise<void> | undefined;
	#fenced = false;
	#written = false;
	#preserved = false;
	#directoryDirty = false;

	constructor(folder: unknown, capsule: unknown) {
		try {
			this.#folder = folderName(folder);
			this.#filename = path.join(this.#folder, RECOVERY_FILE);
			this.#bytes = capture(capsule);
		} catch {
			throw new RecoveryCapsuleFileError();
		}
	}

	write(): Promise<void> {
		try {
			if (this.#fenced) throw new RecoveryCapsuleFileError();
			this.#writing ??= Promise.resolve().then(() => this.#write());
			return this.#writing;
		} catch {
			return Promise.reject(new RecoveryCapsuleFileError());
		}
	}

	preserve(): void {
		try {
			if (this.#fenced || !this.#written) throw new RecoveryCapsuleFileError();
			this.#preserved = true;
		} catch {
			throw new RecoveryCapsuleFileError();
		}
	}

	#check(size: number): void {
		if (this.#fenced || !this.#folderInfo || !this.#fileInfo) throw new RecoveryCapsuleFileError();
		directory(this.#folder, this.#folderInfo);
		const named = lstatSync(this.#filename, { bigint: true });
		regular(named);
		if (!same(named, this.#fileInfo) || named.size !== BigInt(size))
			throw new RecoveryCapsuleFileError();
	}

	async #closeHandle(): Promise<void> {
		const handle = this.#handle;
		if (!handle) return;
		// A failed first fstat retains the actual handle for an explicit cleanup retry.
		this.#fileInfo ??= await handle.stat({ bigint: true });
		await handle.close();
		this.#handle = undefined;
	}

	async #write(): Promise<void> {
		let failed = false;
		try {
			if (this.#fenced) throw new RecoveryCapsuleFileError();
			this.#folderInfo = directory(this.#folder);
			// A dangling Windows link must not turn an exclusive create into a foreign create.
			absent(this.#filename);
			this.#handle = await open(this.#filename, "wx", 0o600);
			directory(this.#folder, this.#folderInfo);
			this.#fileInfo = await this.#handle.stat({ bigint: true });
			regular(this.#fileInfo);
			this.#check(0);
			for (let offset = 0; offset < this.#bytes.length; ) {
				this.#check(offset);
				const { bytesWritten } = await this.#handle.write(
					this.#bytes,
					offset,
					this.#bytes.length - offset,
					offset,
				);
				if (
					!Number.isSafeInteger(bytesWritten) ||
					bytesWritten < 1 ||
					bytesWritten > this.#bytes.length - offset
				)
					throw new RecoveryCapsuleFileError();
				offset += bytesWritten;
				this.#check(offset);
			}
			await this.#handle.sync();
			this.#check(RECOVERY_FILE_SIZE);
			flushDirectory(this.#folder);
			this.#check(RECOVERY_FILE_SIZE);
		} catch {
			failed = true;
		} finally {
			try {
				await this.#closeHandle();
			} catch {
				failed = true;
			} finally {
				this.#bytes.fill(0);
			}
		}
		if (failed || this.#fenced) throw new RecoveryCapsuleFileError();
		try {
			this.#check(RECOVERY_FILE_SIZE);
			this.#written = true;
		} catch {
			throw new RecoveryCapsuleFileError();
		}
	}

	async #cleanup(): Promise<void> {
		try {
			await this.#writing;
		} catch {
			/* Cleanup owns any retained resource. */
		}
		await this.#closeHandle();
		if (this.#fileInfo && !this.#preserved) {
			directory(this.#folder, this.#folderInfo);
			let named: BigIntStats | undefined;
			try {
				named = lstatSync(this.#filename, { bigint: true });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (named) {
				regular(named);
				if (!same(named, this.#fileInfo)) throw new RecoveryCapsuleFileError();
				unlinkSync(this.#filename);
				this.#directoryDirty = true;
			}
			this.#fileInfo = undefined;
		}
		if (this.#directoryDirty) {
			directory(this.#folder, this.#folderInfo);
			flushDirectory(this.#folder);
			this.#directoryDirty = false;
		}
	}

	close(): Promise<void> {
		try {
			this.#fenced = true;
			if (!this.#closing) {
				const closing = Promise.resolve()
					.then(() => this.#cleanup())
					.catch(() => {
						throw new RecoveryCapsuleFileError();
					})
					.finally(() => {
						this.#bytes.fill(0);
					});
				this.#closing = closing;
				void closing.catch(() => {
					this.#closing = undefined;
				});
			}
			return this.#closing;
		} catch {
			return Promise.reject(new RecoveryCapsuleFileError());
		}
	}
}
