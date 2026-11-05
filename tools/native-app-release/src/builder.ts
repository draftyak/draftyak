import { createHash, createPublicKey, KeyObject, sign, timingSafeEqual, verify } from "node:crypto";
import { type BigIntStats, constants, type Dir } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { assertPortableFileTree } from "@draftyak/bounded-files";
import { assertNativeAppReleaseBundle, captureNativeAppReleaseBundle } from "./bundle.ts";
import {
	integrityDigest,
	MAX_FILE_BYTES,
	MAX_FILES,
	MAX_MANIFEST_BYTES,
	MAX_TOTAL_BYTES,
	type NativeAppReleaseFile,
	type NativeAppReleaseManifest,
	nativeAppReleaseBytes,
	nativeAppReleaseSigningBytes,
	parseNativeAppRelease,
	releaseDescriptor,
} from "./manifest.ts";
import {
	MANIFEST_FILE,
	NativeAppReleaseError,
	refuse,
	releasePath,
	releaseRoot,
	SIGNATURE_FILE,
} from "./paths.ts";

type Resource = FileHandle | Dir;
type Snapshot = ReadonlyMap<string, BigIntStats>;
interface Tree {
	readonly files: Snapshot;
	readonly directories: Snapshot;
}
interface Finalization {
	readonly metadata: unknown;
	readonly bundles: unknown;
	readonly privateKey: KeyObject;
}
interface OwnedMetadata {
	readonly name: string;
	readonly handle: FileHandle;
	readonly bytes: Buffer;
	identity?: BigIntStats;
}
const chunkSize = 64 * 1024;
const maximumEntries = MAX_FILES * 16 + 2;
const exclusiveSharing = process.platform === "win32" ? 0x10000000 : 0;
const keyType = Object.getOwnPropertyDescriptor(KeyObject.prototype, "type")?.get;

function signingPublicKey(key: KeyObject): KeyObject {
	if (
		types.isProxy(key) ||
		!types.isKeyObject(key) ||
		!keyType ||
		Reflect.apply(keyType, key, []) !== "private" ||
		["type", "asymmetricKeyType", "export"].some((name) => Object.hasOwn(key, name))
	)
		refuse("manifest");
	const prototype = Object.getPrototypeOf(key);
	if (!prototype || types.isProxy(prototype)) refuse("manifest");
	const publicKey = createPublicKey(key);
	if (publicKey.asymmetricKeyType !== "ed25519") refuse("manifest");
	return publicKey;
}

function same(a: BigIntStats, b: BigIntStats): boolean {
	return (
		a.ino !== 0n &&
		a.ino === b.ino &&
		a.dev === b.dev &&
		a.mode === b.mode &&
		a.nlink === b.nlink &&
		a.size === b.size &&
		a.mtimeNs === b.mtimeNs &&
		a.ctimeNs === b.ctimeNs
	);
}

function regular(stat: BigIntStats): void {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino === 0n)
		refuse("file");
}

function directory(stat: BigIntStats): void {
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) refuse("path");
}

function metadata(name: string): boolean {
	return name === MANIFEST_FILE || name === SIGNATURE_FILE;
}

function sameTree(before: Tree, after: Tree): boolean {
	for (const key of ["files", "directories"] as const) {
		if (before[key].size !== after[key].size) return false;
		for (const [name, stat] of before[key]) {
			const next = after[key].get(name);
			if (!next || !same(stat, next)) return false;
		}
	}
	return true;
}

/** Measures explicit release candidates; it grants no load or install authority. */
export class NativeAppReleaseBuilder {
	readonly #root: string;
	readonly #resources = new Set<Resource>();
	readonly #failedClose = new Set<Resource>();
	readonly #pending = new Set<Promise<unknown>>();
	readonly #measured = new Map<FileHandle, { readonly name: string; readonly stat: BigIntStats }>();
	readonly #metadata: OwnedMetadata[] = [];
	#committed = false;
	#state: "ready" | "building" | "spent" | "closing" | "closed" = "ready";
	#buildJob: Promise<NativeAppReleaseManifest> | undefined;
	#closeJob: Promise<void> | undefined;

	constructor(root: string) {
		this.#root = releaseRoot(root);
	}

	build(descriptor: unknown): Promise<NativeAppReleaseManifest> {
		if (this.#state !== "ready") return Promise.reject(new NativeAppReleaseError("state"));
		// The one-shot fence precedes descriptor inspection and the first I/O await.
		this.#state = "building";
		this.#buildJob = this.#build(descriptor);
		return this.#buildJob;
	}

	/** Finalize only this measured root; the explicit key never becomes runtime configuration. */
	finalizeFromBundle(
		metadata: unknown,
		bundles: unknown,
		privateKey: KeyObject,
	): Promise<NativeAppReleaseManifest> {
		if (this.#state !== "ready") return Promise.reject(new NativeAppReleaseError("state"));
		this.#state = "building";
		this.#buildJob = this.#build(undefined, { metadata, bundles, privateKey });
		return this.#buildJob;
	}

	/** Settle retained handles; failed finalization files remain in the candidate. */
	close(): Promise<void> {
		if (this.#state === "closed") return Promise.resolve();
		this.#state = "closing";
		if (this.#closeJob) return this.#closeJob;
		const job = (async (): Promise<void> => {
			// Build cleanup uses #release, never close(), so this cannot wait on itself.
			await this.#buildJob?.catch(() => {});
			while (this.#pending.size) await Promise.allSettled([...this.#pending]);
			await this.#release(true);
			this.#state = "closed";
		})();
		this.#closeJob = job;
		void job.then(
			() => {
				this.#closeJob = undefined;
			},
			() => {
				this.#closeJob = undefined;
			},
		);
		return job;
	}

	#active(): void {
		if (this.#state !== "building") refuse("state");
	}

	#track<T>(operation: () => Promise<T>): Promise<T> {
		const job = Promise.resolve().then(operation);
		this.#pending.add(job);
		void job.then(
			() => this.#pending.delete(job),
			() => this.#pending.delete(job),
		);
		return job;
	}

	async #step<T>(operation: () => Promise<T>): Promise<T> {
		this.#active();
		const result = await this.#track(() => {
			this.#active();
			return operation();
		});
		this.#active();
		return result;
	}

	async #close(resource: Resource): Promise<void> {
		try {
			await this.#track(() => resource.close());
			this.#resources.delete(resource);
			this.#failedClose.delete(resource);
			if (this.#measured.has(resource as FileHandle)) this.#measured.delete(resource as FileHandle);
		} catch {
			this.#failedClose.add(resource);
			refuse("cleanup");
		}
	}

	async #release(retry = false): Promise<void> {
		// Schedule every attempt before awaiting any one close; a blocked handle cannot starve another.
		const attempts = [...this.#resources]
			.filter((resource) => retry || !this.#failedClose.has(resource))
			.map((resource) => this.#close(resource));
		await Promise.allSettled(attempts);
		if (this.#resources.size) refuse("cleanup");
	}

	async #stat(name: string): Promise<BigIntStats> {
		return this.#step(() => fs.lstat(name, { bigint: true }));
	}

	async #real(name: string): Promise<void> {
		if ((await this.#step(() => fs.realpath(name))) !== name) refuse("path");
	}

	async #chain(): Promise<Snapshot> {
		const root = path.parse(this.#root).root;
		const result = new Map<string, BigIntStats>();
		let name = root;
		for (const part of ["", ...this.#root.slice(root.length).split(path.sep).filter(Boolean)]) {
			if (part) name = path.join(name, part);
			const stat = await this.#stat(name);
			directory(stat);
			await this.#real(name);
			result.set(name, stat);
		}
		return result;
	}

	async #checkChain(chain: Snapshot): Promise<void> {
		for (const [name, before] of chain) {
			const after = await this.#stat(name);
			directory(after);
			if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode)
				refuse("path");
			await this.#real(name);
		}
	}

	async #scan(): Promise<Tree> {
		const files = new Map<string, BigIntStats>();
		const directories = new Map<string, BigIntStats>();
		let count = 0,
			total = 0,
			payloadFiles = 0;
		const walk = async (relative: string): Promise<void> => {
			const name = path.join(this.#root, relative);
			const before = await this.#stat(name);
			directory(before);
			await this.#real(name);
			directories.set(relative, before);
			const opened = await this.#step(() =>
				fs.opendir(name).then((resource) => {
					this.#resources.add(resource);
					return resource;
				}),
			);
			let entries = 0;
			try {
				if (!same(before, await this.#stat(name))) refuse("path");
				for (
					let item = await this.#step(() => opened.read());
					item !== null;
					item = await this.#step(() => opened.read())
				) {
					if (++count > maximumEntries) refuse("bounds");
					entries++;
					const file = releasePath(relative ? `${relative}/${item.name}` : item.name);
					const target = path.join(this.#root, file);
					const stat = await this.#stat(target);
					if (stat.isSymbolicLink()) refuse("path");
					const reserved = [MANIFEST_FILE, SIGNATURE_FILE].find(
						(name) => name.toLowerCase() === file.toLowerCase(),
					);
					if (reserved && reserved !== file) refuse("path");
					if (stat.isDirectory() && !reserved) await walk(file);
					else {
						regular(stat);
						await this.#real(target);
						if (metadata(file)) {
							if (
								file === SIGNATURE_FILE
									? stat.size !== 64n
									: stat.size < 1n || stat.size > BigInt(MAX_MANIFEST_BYTES)
							)
								refuse("bounds");
						} else {
							if (
								++payloadFiles > MAX_FILES ||
								stat.size < 0n ||
								stat.size > BigInt(MAX_FILE_BYTES)
							)
								refuse("bounds");
							total += Number(stat.size);
							if (total > MAX_TOTAL_BYTES) refuse("bounds");
						}
						files.set(file, stat);
					}
				}
				if (!entries) refuse("path");
				if (!same(before, await this.#stat(name))) refuse("path");
				await this.#real(name);
			} finally {
				await this.#close(opened);
			}
		};
		await walk("");
		try {
			assertPortableFileTree([
				...files.keys(),
				...[MANIFEST_FILE, SIGNATURE_FILE].filter((name) => !files.has(name)),
			]);
		} catch {
			refuse("path");
		}
		return { files, directories };
	}

	async #measure(
		relative: string,
		before: BigIntStats,
		expectedIntegrity?: string,
	): Promise<NativeAppReleaseFile> {
		const name = path.join(this.#root, relative);
		regular(before);
		if (!same(before, await this.#stat(name))) refuse("file");
		await this.#real(name);
		const flags =
			constants.O_RDONLY |
			(constants.O_NOFOLLOW ?? 0) |
			(constants.O_NONBLOCK ?? 0) |
			exclusiveSharing;
		const handle = await this.#step(() =>
			fs.open(name, flags).then((resource) => {
				this.#resources.add(resource);
				return resource;
			}),
		);
		const opened = await this.#step(() => handle.stat({ bigint: true }));
		regular(opened);
		if (!same(before, opened)) refuse("file");
		const size = Number(opened.size);
		const buffer = Buffer.alloc(Math.min(chunkSize, Math.max(1, size)));
		const first = createHash("sha256"),
			second = createHash("sha256"),
			sri = createHash("sha512");
		for (let pass = 0; pass < 2; pass++) {
			for (let position = 0; position < size; ) {
				const wanted = Math.min(buffer.length, size - position);
				const { bytesRead } = await this.#step(() => handle.read(buffer, 0, wanted, position));
				if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > wanted) refuse("file");
				const bytes = buffer.subarray(0, bytesRead);
				if (pass === 0) {
					first.update(bytes);
					sri.update(bytes);
				} else second.update(bytes);
				position += bytesRead;
			}
			if ((await this.#step(() => handle.read(buffer, 0, 1, size))).bytesRead !== 0) refuse("file");
		}
		const digest = first.digest("hex");
		if (second.digest("hex") !== digest) refuse("file");
		if (
			expectedIntegrity !== undefined &&
			!timingSafeEqual(sri.digest(), integrityDigest(expectedIntegrity))
		)
			refuse("file");
		const after = await this.#step(() => handle.stat({ bigint: true }));
		const named = await this.#stat(name);
		regular(after);
		regular(named);
		if (!same(opened, after) || !same(after, named)) refuse("file");
		await this.#real(name);
		this.#measured.set(handle, { name, stat: opened });
		return Object.freeze({ path: relative, bytes: size, sha256: digest });
	}

	async #checkMeasured(): Promise<void> {
		for (const [handle, { name, stat }] of this.#measured) {
			const opened = await this.#step(() => handle.stat({ bigint: true }));
			const named = await this.#stat(name);
			regular(opened);
			regular(named);
			if (!same(stat, opened) || !same(opened, named)) refuse("file");
			await this.#real(name);
		}
	}

	async #writeMetadata(name: string, bytes: Uint8Array, chain: Snapshot): Promise<void> {
		await this.#checkChain(chain);
		const file = path.join(this.#root, name);
		const data = Buffer.from(bytes);
		const item = await this.#step(() =>
			fs
				.open(
					file,
					constants.O_RDWR |
						constants.O_CREAT |
						constants.O_EXCL |
						(constants.O_NOFOLLOW ?? 0) |
						(constants.O_NONBLOCK ?? 0) |
						exclusiveSharing,
					0o644,
				)
				.then((handle) => {
					this.#resources.add(handle);
					const owned: OwnedMetadata = { name: file, handle, bytes: data };
					this.#metadata.push(owned);
					return owned;
				}),
		);
		await this.#checkChain(chain);
		item.identity = await this.#step(() => item.handle.stat({ bigint: true }));
		regular(item.identity);
		if (item.identity.size !== 0n) refuse("file");
		for (let position = 0; position < data.length; ) {
			const { bytesWritten } = await this.#step(() =>
				item.handle.write(data, position, data.length - position, position),
			);
			if (
				!Number.isSafeInteger(bytesWritten) ||
				bytesWritten < 1 ||
				bytesWritten > data.length - position
			)
				refuse("file");
			position += bytesWritten;
		}
		await this.#step(() => item.handle.sync());
		await this.#readMetadata(item);
	}

	async #readMetadata(item: OwnedMetadata): Promise<Buffer> {
		const before = await this.#step(() => item.handle.stat({ bigint: true }));
		regular(before);
		if (
			!item.identity ||
			before.dev !== item.identity.dev ||
			before.ino !== item.identity.ino ||
			before.mode !== item.identity.mode ||
			before.size !== BigInt(item.bytes.length)
		)
			refuse("file");
		const bytes = Buffer.alloc(item.bytes.length);
		for (let position = 0; position < bytes.length; ) {
			const { bytesRead } = await this.#step(() =>
				item.handle.read(bytes, position, bytes.length - position, position),
			);
			if (!Number.isSafeInteger(bytesRead) || bytesRead < 1 || bytesRead > bytes.length - position)
				refuse("file");
			position += bytesRead;
		}
		if (
			(await this.#step(() => item.handle.read(Buffer.alloc(1), 0, 1, bytes.length))).bytesRead !==
				0 ||
			!bytes.equals(item.bytes)
		)
			refuse("file");
		const after = await this.#step(() => item.handle.stat({ bigint: true }));
		const named = await this.#stat(item.name);
		regular(after);
		regular(named);
		if (!same(before, after) || !same(after, named)) refuse("file");
		await this.#real(item.name);
		return bytes;
	}

	async #validateFinalization(before: Tree, chain: Snapshot, publicKey: KeyObject): Promise<void> {
		const after = await this.#scan();
		if (
			after.files.size !== before.files.size + 2 ||
			after.directories.size !== before.directories.size
		)
			refuse("file");
		for (const [name, stat] of before.files) {
			const found = after.files.get(name);
			if (!found || !same(stat, found)) refuse("file");
		}
		for (const [name, stat] of before.directories) {
			const found = after.directories.get(name);
			if (
				!found ||
				(name === ""
					? stat.dev !== found.dev ||
						stat.ino !== found.ino ||
						stat.mode !== found.mode ||
						stat.nlink !== found.nlink
					: !same(stat, found))
			)
				refuse("path");
		}
		await this.#checkChain(chain);
		await this.#checkMeasured();
		const [manifest, signature] = await Promise.all(
			this.#metadata.map((item) => this.#readMetadata(item)),
		);
		if (
			!manifest ||
			!signature ||
			!verify(
				null,
				nativeAppReleaseSigningBytes(parseNativeAppRelease(manifest)),
				publicKey,
				signature,
			)
		)
			refuse("manifest");
		if (!sameTree(after, await this.#scan())) refuse("file");
		await this.#checkChain(chain);
		await this.#checkMeasured();
		for (const item of this.#metadata) await this.#readMetadata(item);
	}

	#metadataDisposition(): void {
		// Retain failed candidate files: path-based unlink cannot atomically compare their identities.
		if (!this.#committed && this.#metadata.length) refuse("cleanup");
	}

	async #build(raw: unknown, finalization?: Finalization): Promise<NativeAppReleaseManifest> {
		try {
			const captured = finalization
				? captureNativeAppReleaseBundle(finalization.metadata, finalization.bundles)
				: undefined;
			const descriptor = captured?.descriptor ?? releaseDescriptor(raw);
			const publicKey = finalization ? signingPublicKey(finalization.privateKey) : undefined;
			const chain = await this.#chain();
			const tree = await this.#scan();
			if (finalization && [...tree.files.keys()].some(metadata)) refuse("file");
			const archives = new Map(
				descriptor.bundles.map((bundle) => [bundle.archive, bundle.package.integrity]),
			);
			const files: NativeAppReleaseFile[] = [];
			for (const name of [...tree.files.keys()].filter((name) => !metadata(name)).sort()) {
				const stat = tree.files.get(name);
				if (!stat) refuse("file");
				files.push(await this.#measure(name, stat, archives.get(name)));
			}
			if (!sameTree(tree, await this.#scan())) refuse("file");
			await this.#checkChain(chain);
			await this.#checkMeasured();
			this.#active();
			const manifest = parseNativeAppRelease(
				nativeAppReleaseBytes({ v: 1, application: "draftyak", ...descriptor, files }),
			);
			if (finalization && captured && publicKey) {
				assertNativeAppReleaseBundle(manifest, captured);
				await this.#checkChain(chain);
				await this.#checkMeasured();
				this.#active();
				const signature = sign(
					null,
					nativeAppReleaseSigningBytes(manifest),
					finalization.privateKey,
				);
				if (
					signature.length !== 64 ||
					!verify(null, nativeAppReleaseSigningBytes(manifest), publicKey, signature)
				)
					refuse("manifest");
				await this.#writeMetadata(MANIFEST_FILE, nativeAppReleaseBytes(manifest), chain);
				await this.#writeMetadata(SIGNATURE_FILE, signature, chain);
				await this.#validateFinalization(tree, chain, publicKey);
				this.#committed = true;
			}
			return manifest;
		} catch (error) {
			if (error instanceof NativeAppReleaseError) throw error;
			throw new NativeAppReleaseError("file");
		} finally {
			try {
				try {
					await this.#release();
				} finally {
					this.#metadataDisposition();
				}
			} finally {
				if (this.#state === "building") this.#state = "spent";
			}
		}
	}
}
