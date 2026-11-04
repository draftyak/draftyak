import { createHash } from "node:crypto";
import { type BigIntStats, constants, type Dir, type Dirent } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { isProxy } from "node:util/types";
import {
	assertPortableFileTree,
	checkedFileRecord,
	portableRelativePath,
} from "@draftyak/bounded-files";
import type { NativeReleaseV2 } from "../plugins/installer/native-release-v2.ts";
import type { NativeAppRelease } from "./native-app-release.ts";

type FileRelease = NativeAppRelease | NativeReleaseV2;

const manifestName = "release.manifest.json";
const signatureName = "release.signature";
const maximumFileBytes = 256 * 1024 * 1024;
const maximumTotalBytes = 512 * 1024 * 1024;
const maximumFiles = 4096;
const chunkBytes = 64 * 1024;
const nativeLstat = lstat;
const nativeOpen = open;
const nativeOpendir = opendir;
const nativeRealpath = realpath;
const windows = process.platform === "win32";
// Retained resources stay readable; identity and content are revalidated below.
const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export class NativeAppFilesError extends Error {
	constructor() {
		super("Native application files unavailable.");
		this.name = "NativeAppFilesError";
	}
}

/** Content and owned resources only; this is not native application authority. */
export interface NativeAppFiles {
	/** Retained closed/failed flags only; this performs no fresh file identity or hash check. */
	assertAvailable(): void;
	readRelease(): Promise<Readonly<{ manifest: Buffer; signature: Buffer }>>;
	verify(release: FileRelease): Promise<void>;
	archive(name: string): Promise<Buffer>;
	close(): Promise<void>;
}

type Resource = {
	handle?: FileHandle | Dir;
	close?: () => Promise<void>;
};
type HeldFile = {
	readonly relative: string;
	readonly name: string;
	readonly initial: BigIntStats;
	readonly stat: () => Promise<BigIntStats>;
	readonly read: (
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	) => Promise<{ bytesRead: number }>;
	readonly maximum: number;
	digest?: string;
};
type FileRecord = Readonly<{ path: string; bytes: number; sha256: string }>;
type Inventory = {
	readonly files: ReadonlyMap<string, FileRecord>;
	readonly archives: ReadonlySet<string>;
	readonly children: ReadonlyMap<string, ReadonlySet<string>>;
};

function refuse(): never {
	throw new NativeAppFilesError();
}

function field(raw: unknown, name: string): unknown {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) refuse();
	if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) refuse();
	const descriptor = Object.getOwnPropertyDescriptor(raw, name);
	if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
	return descriptor.value;
}

function array(raw: unknown, minimum: number, maximum: number): readonly unknown[] {
	if (
		raw === null ||
		typeof raw !== "object" ||
		isProxy(raw) ||
		!Array.isArray(raw) ||
		Object.getPrototypeOf(raw) !== Array.prototype
	)
		refuse();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < minimum ||
		length > maximum ||
		Reflect.ownKeys(raw).length !== length + 1
	)
		refuse();
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
		if (!descriptor?.enumerable || !("value" in descriptor)) refuse();
		result.push(descriptor.value);
	}
	return result;
}

function inventory(release: FileRelease): Inventory {
	const files = new Map<string, FileRecord>();
	let bytes = 0;
	for (const raw of array(field(release, "files"), 1, maximumFiles)) {
		const record = checkedFileRecord(raw, {
			byteField: "bytes",
			minimum: 0,
			maximum: maximumFileBytes,
		});
		const name = portableName(record.path);
		if ([manifestName, signatureName].includes(name.toLowerCase())) refuse();
		bytes += record.byteLength;
		if (bytes > maximumTotalBytes || files.has(name)) refuse();
		files.set(name, Object.freeze({ path: name, bytes: record.byteLength, sha256: record.sha256 }));
	}
	assertPortableFileTree([...files.keys(), manifestName, signatureName]);
	const archives = new Set<string>();
	const version = field(release, "v");
	if (version !== 1 && version !== 2) refuse();
	const selected = array(field(release, "bundles"), 5, 5);
	const candidates = version === 2 ? array(field(release, "candidates"), 0, 5) : [];
	for (const raw of [...selected, ...candidates]) {
		const name = portableName(field(raw, "archive"));
		if (!files.has(name) || archives.has(name)) refuse();
		archives.add(name);
	}
	const children = new Map<string, Set<string>>();
	for (const name of [...files.keys(), manifestName, signatureName]) {
		const components = name.split("/");
		for (let index = 0; index < components.length; index++) {
			const parent = components.slice(0, index).join("/");
			let names = children.get(parent);
			if (!names) {
				names = new Set();
				children.set(parent, names);
			}
			const component = components[index];
			if (component === undefined) refuse();
			names.add(component);
		}
	}
	return { files, archives, children };
}

function portableName(raw: unknown): string {
	return portableRelativePath(raw, {
		maximumLength: 200,
		maximumComponents: 16,
		maximumComponentLength: 200,
	});
}

function nativeName(raw: string): string {
	if (
		typeof raw !== "string" ||
		!raw.isWellFormed() ||
		raw.length === 0 ||
		raw.length > 4096 ||
		raw.includes("\0") ||
		!path.isAbsolute(raw) ||
		/^[/\\]{2}/.test(raw)
	)
		refuse();
	const root = path.parse(raw).root;
	if (windows && (!/^[A-Za-z]:\\$/.test(root) || raw.includes("/"))) refuse();
	const components = raw.slice(root.length).split(path.sep);
	if (components.length > 64) refuse();
	for (const component of components) {
		if (component === "" && raw === root) continue;
		if (
			component === "" ||
			component === "." ||
			component === ".." ||
			(windows &&
				(/[. ]$/.test(component) ||
					/[\p{Cc}<>:"|?*]/u.test(component) ||
					/^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(component)))
		)
			refuse();
	}
	if (path.resolve(raw) !== raw) refuse();
	return raw;
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.ino !== 0n;
}

function unchanged(a: BigIntStats, b: BigIntStats): boolean {
	return (
		sameIdentity(a, b) &&
		a.mode === b.mode &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

function regular(stat: BigIntStats, maximum: number): void {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		stat.nlink !== 1n ||
		stat.size < 0n ||
		stat.size > BigInt(maximum)
	)
		refuse();
}

class Files {
	readonly #root: string;
	readonly #resources = new Set<Resource>();
	readonly #files = new Map<string, HeldFile>();
	readonly #directories = new Map<string, BigIntStats>();
	#ancestors: readonly { name: string; stat: BigIntStats }[] | undefined;
	#metadata: { manifest: Buffer; signature: Buffer } | undefined;
	#release: FileRelease | undefined;
	#inventory: Inventory | undefined;
	#tail: Promise<void> = Promise.resolve();
	readonly #pending = new Set<Promise<unknown>>();
	#closed = false;
	#failed = false;
	#closing: Promise<void> | undefined;

	constructor(root: string) {
		this.#root = nativeName(root);
	}

	#available(): void {
		if (this.#closed || this.#failed) refuse();
	}

	assertAvailable(): void {
		this.#available();
	}

	#run<T>(operation: () => Promise<T>): Promise<T> {
		try {
			this.#available();
		} catch {
			return Promise.reject(new NativeAppFilesError());
		}
		// Register the operation before the first callback or allocation can run.
		const task = this.#tail.then(async () => {
			try {
				this.#available();
				const result = await operation();
				this.#available();
				return result;
			} catch {
				this.#failed = true;
				throw new NativeAppFilesError();
			}
		});
		this.#tail = task.then(
			() => {},
			() => {},
		);
		this.#pending.add(task);
		void task.then(
			() => this.#pending.delete(task),
			() => this.#pending.delete(task),
		);
		return task;
	}

	async #own<T extends FileHandle | Dir>(allocate: () => Promise<T>): Promise<[T, Resource]> {
		this.#available();
		const resource: Resource = {};
		this.#resources.add(resource);
		try {
			const handle = await allocate();
			resource.handle = handle;
			const close = handle.close;
			resource.close = async () => {
				await Reflect.apply(close, handle, []);
			};
			this.#available();
			return [handle, resource];
		} catch {
			if (!resource.handle) this.#resources.delete(resource);
			refuse();
		}
	}

	async #retire(resource: Resource): Promise<void> {
		if (resource.handle) {
			if (resource.close) await resource.close();
			else await resource.handle.close();
		}
		this.#resources.delete(resource);
	}

	async #directory(name: string): Promise<BigIntStats> {
		this.#available();
		const stat = await nativeLstat(name, { bigint: true });
		if (
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			stat.ino === 0n ||
			(await nativeRealpath(name)) !== name
		)
			refuse();
		this.#available();
		return stat;
	}

	async #chain(relative?: string): Promise<void> {
		if (!this.#ancestors) {
			const root = path.parse(this.#root).root;
			const names = [root];
			let name = root;
			for (const component of this.#root.slice(root.length).split(path.sep).filter(Boolean)) {
				name = path.join(name, component);
				names.push(name);
			}
			const result: { name: string; stat: BigIntStats }[] = [];
			for (const name of names) result.push({ name, stat: await this.#directory(name) });
			this.#ancestors = result;
		}
		for (const before of this.#ancestors)
			if (!sameIdentity(before.stat, await this.#directory(before.name))) refuse();
		if (relative === undefined) {
			for (const [name, before] of this.#directories)
				if (!unchanged(before, await this.#directory(name))) refuse();
		} else {
			const components = relative.split("/");
			for (let end = 0; end < components.length; end++) {
				const name = path.join(this.#root, ...components.slice(0, end));
				const before = this.#directories.get(name);
				if (before && !unchanged(before, await this.#directory(name))) refuse();
			}
		}
		this.#available();
	}

	async #file(relative: string, maximum: number): Promise<HeldFile> {
		const existing = this.#files.get(relative);
		if (existing) return existing;
		await this.#chain(relative);
		const name = path.join(this.#root, ...relative.split("/"));
		const before = await nativeLstat(name, { bigint: true });
		regular(before, maximum);
		if ((await nativeRealpath(name)) !== name) refuse();
		const [handle] = await this.#own(() => nativeOpen(name, readFlags));
		const capturedStat = handle.stat;
		const stat = (): Promise<BigIntStats> =>
			Reflect.apply(capturedStat, handle, [{ bigint: true }]) as Promise<BigIntStats>;
		const opened = await stat();
		regular(opened, maximum);
		if (!unchanged(before, opened)) refuse();
		const capturedRead = handle.read;
		const file: HeldFile = {
			relative,
			name,
			initial: opened,
			stat,
			read: (buffer, offset, length, position) =>
				Reflect.apply(capturedRead, handle, [buffer, offset, length, position]),
			maximum,
		};
		this.#files.set(relative, file);
		return file;
	}

	async #checkFile(file: HeldFile): Promise<void> {
		const held = await file.stat();
		this.#available();
		const named = await nativeLstat(file.name, { bigint: true });
		regular(held, file.maximum);
		regular(named, file.maximum);
		if (
			!unchanged(file.initial, held) ||
			!unchanged(held, named) ||
			(await nativeRealpath(file.name)) !== file.name
		)
			refuse();
		this.#available();
	}

	async #read(file: HeldFile): Promise<Buffer> {
		await this.#checkFile(file);
		const before = file.initial;
		const size = Number(before.size);
		const bytes = Buffer.alloc(size);
		const read = async (target: Buffer, at: number, position: number, wanted: number) => {
			const { bytesRead } = await file.read(target, at, wanted, position);
			this.#available();
			if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > wanted) refuse();
			return bytesRead;
		};
		for (let offset = 0; offset < size; )
			offset += await read(bytes, offset, offset, Math.min(chunkBytes, size - offset));
		if ((await file.read(Buffer.alloc(1), 0, 1, size)).bytesRead !== 0) refuse();
		this.#available();
		const again = Buffer.alloc(Math.min(chunkBytes, size));
		for (let offset = 0; offset < size; ) {
			const count = await read(again, 0, offset, Math.min(chunkBytes, size - offset));
			if (!again.subarray(0, count).equals(bytes.subarray(offset, offset + count))) refuse();
			offset += count;
		}
		await this.#checkFile(file);
		await this.#chain(file.relative);
		const digest = createHash("sha256").update(bytes).digest("hex");
		if (file.digest !== undefined && file.digest !== digest) refuse();
		file.digest = digest;
		return bytes;
	}

	async #readRelease(): Promise<{ manifest: Buffer; signature: Buffer }> {
		const manifest = await this.#read(await this.#file(manifestName, 1024 * 1024));
		const signature = await this.#read(await this.#file(signatureName, 64));
		if (manifest.length === 0 || signature.length !== 64) refuse();
		this.#metadata ??= { manifest, signature };
		if (!this.#metadata.manifest.equals(manifest) || !this.#metadata.signature.equals(signature))
			refuse();
		return {
			manifest: Buffer.from(this.#metadata.manifest),
			signature: Buffer.from(this.#metadata.signature),
		};
	}

	readRelease(): Promise<Readonly<{ manifest: Buffer; signature: Buffer }>> {
		return this.#run(async () => Object.freeze(await this.#readRelease()));
	}

	async #list(prefix: string, expected: ReadonlySet<string>): Promise<void> {
		const name = prefix ? path.join(this.#root, ...prefix.split("/")) : this.#root;
		const before = await this.#directory(name);
		const previous = this.#directories.get(name);
		if (previous && !unchanged(previous, before)) refuse();
		this.#directories.set(name, before);
		const [handle, resource] = await this.#own(() => nativeOpendir(name, { bufferSize: 1 }));
		const capturedRead = handle.read;
		const read = (): Promise<Dirent | null> => Reflect.apply(capturedRead, handle, []);
		try {
			const remaining = new Set(expected);
			for (;;) {
				const item = await read();
				this.#available();
				if (item === null) break;
				const descriptor = Object.getOwnPropertyDescriptor(item, "name");
				const child = descriptor && "value" in descriptor ? descriptor.value : undefined;
				if (typeof child !== "string" || !remaining.delete(child)) refuse();
			}
			if (remaining.size !== 0 || !unchanged(before, await this.#directory(name))) refuse();
		} finally {
			await this.#retire(resource);
		}
	}

	async #verify(release: FileRelease): Promise<void> {
		if (this.#release === undefined) {
			this.#inventory = inventory(release);
			this.#release = release;
		} else if (release !== this.#release) refuse();
		const wanted = this.#inventory;
		if (!wanted) refuse();
		await this.#readRelease();
		for (const [directory, names] of wanted.children) await this.#list(directory, names);
		for (const record of wanted.files.values()) {
			const bytes = await this.#read(await this.#file(record.path, maximumFileBytes));
			if (
				bytes.length !== record.bytes ||
				createHash("sha256").update(bytes).digest("hex") !== record.sha256
			)
				refuse();
		}
		for (const [directory, names] of wanted.children) await this.#list(directory, names);
		await this.#readRelease();
		for (const file of this.#files.values()) await this.#checkFile(file);
		await this.#chain();
	}

	verify(release: FileRelease): Promise<void> {
		return this.#run(() => this.#verify(release));
	}

	archive(name: string): Promise<Buffer> {
		return this.#run(async () => {
			const release = this.#release;
			if (!release || typeof name !== "string" || !this.#inventory?.archives.has(name)) refuse();
			await this.#verify(release);
			const file = this.#files.get(name);
			if (!file) refuse();
			const bytes = await this.#read(file);
			return Buffer.from(bytes);
		});
	}

	close(): Promise<void> {
		this.#closed = true;
		if (this.#closing) return this.#closing;
		let resolve!: () => void;
		let reject!: (error: NativeAppFilesError) => void;
		const closing = new Promise<void>((success, failure) => {
			resolve = success;
			reject = failure;
		});
		this.#closing = closing;
		void (async () => {
			await Promise.allSettled([...this.#pending]);
			const results = await Promise.allSettled(
				[...this.#resources].map((resource) => this.#retire(resource)),
			);
			if (results.some((result) => result.status === "rejected")) refuse();
		})().then(
			() => resolve(),
			() => {
				this.#closing = undefined;
				reject(new NativeAppFilesError());
			},
		);
		return closing;
	}
}

/** Retain this owner before its first asynchronous operation, including failed initialization. */
export function createNativeAppFiles(root: string): NativeAppFiles {
	try {
		const files = new Files(root);
		return Object.freeze({
			assertAvailable: () => files.assertAvailable(),
			readRelease: () => files.readRelease(),
			verify: (release: FileRelease) => files.verify(release),
			archive: (name: string) => files.archive(name),
			close: () => files.close(),
		});
	} catch {
		throw new NativeAppFilesError();
	}
}
