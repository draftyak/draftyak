import { createHash, timingSafeEqual } from "node:crypto";
import { type BigIntStats, constants, type Dir } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import { assertPortableFileTree } from "@draftyak/bounded-files";
import {
	integrityDigest,
	MAX_FILE_BYTES,
	MAX_FILES,
	MAX_MANIFEST_BYTES,
	MAX_TOTAL_BYTES,
	type NativeAppReleaseFile,
	type NativeAppReleaseManifest,
	nativeAppReleaseBytes,
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
const chunkSize = 64 * 1024;
const maximumEntries = MAX_FILES * 16 + 2;
const exclusiveSharing = process.platform === "win32" ? 0x10000000 : 0;

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

/** Builds release DATA from one closed source tree; it grants no load or install authority. */
export class NativeAppReleaseBuilder {
	readonly #root: string;
	readonly #resources = new Set<Resource>();
	readonly #failedClose = new Set<Resource>();
	readonly #pending = new Set<Promise<unknown>>();
	readonly #measured = new Map<FileHandle, { readonly name: string; readonly stat: BigIntStats }>();
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

	async #build(raw: unknown): Promise<NativeAppReleaseManifest> {
		try {
			const descriptor = releaseDescriptor(raw);
			const chain = await this.#chain();
			const tree = await this.#scan();
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
			return parseNativeAppRelease(
				nativeAppReleaseBytes({ v: 1, application: "draftyak", ...descriptor, files }),
			);
		} catch (error) {
			if (error instanceof NativeAppReleaseError) throw error;
			throw new NativeAppReleaseError("file");
		} finally {
			try {
				await this.#release();
			} finally {
				if (this.#state === "building") this.#state = "spent";
			}
		}
	}
}
