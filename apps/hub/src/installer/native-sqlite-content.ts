import { createHash, createPublicKey, type KeyObject } from "node:crypto";
import { isProxy } from "node:util/types";
import { createNativeAppFiles, type NativeAppFiles } from "./native-app-files.ts";
import { type NativeAppRelease, verifyNativeAppRelease } from "./native-app-release.ts";
import { type NativeAppReleaseTrust, nativeAppReleaseTrust } from "./native-app-trust.ts";
import { selectNativeSqliteResourceData } from "./native-sqlite-resource-data.ts";

export interface NativeSqliteContentIdentity {
	readonly name: string;
	readonly version: string;
	readonly integrity: string;
}

/** Inspection DATA only. This does not authorize loading a native module. */
export interface NativeSqliteContentData {
	readonly version: string;
	readonly platform: "win32" | "darwin" | "linux";
	readonly arch: "x64" | "arm64";
	readonly target: string;
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export interface NativeSqliteContentInspection {
	inspect(): Promise<Readonly<NativeSqliteContentData>>;
	close(): Promise<void>;
}

const manifestLimit = 1024 * 1024;
const memberLimit = 256 * 1024 * 1024;
const identityKeys = ["name", "version", "integrity"] as const;
const unavailable = () => new Error("Native SQLite content inspection unavailable.");

function refuse(): never {
	throw unavailable();
}

function rootData(root: unknown): string {
	if (
		typeof root !== "string" ||
		root.length === 0 ||
		root.length > 4096 ||
		!root.isWellFormed() ||
		root.includes("\0")
	)
		refuse();
	return root;
}

function identityData(raw: unknown): Readonly<NativeSqliteContentIdentity> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) refuse();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) refuse();
	const keys = Reflect.ownKeys(raw);
	if (
		keys.length !== identityKeys.length ||
		keys.some(
			(key) => typeof key !== "string" || !identityKeys.some((expected) => expected === key),
		)
	)
		refuse();
	const read = (key: (typeof identityKeys)[number], maximum: number): string => {
		const slot = Object.getOwnPropertyDescriptor(raw, key);
		if (
			!slot?.enumerable ||
			!("value" in slot) ||
			typeof slot.value !== "string" ||
			slot.value.length === 0 ||
			slot.value.length > maximum
		)
			refuse();
		return slot.value;
	};
	const name = read("name", 200),
		version = read("version", 128),
		integrity = read("integrity", 256);
	if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(integrity)) refuse();
	return Object.freeze({ name, version, integrity });
}

function releaseKey(trust: Readonly<NativeAppReleaseTrust>): KeyObject {
	// The fixed build producer emits canonical standard-base64 Ed25519 SPKI DER.
	const der = Buffer.from(trust.publicKeyDer, "base64");
	let canonical: Buffer | undefined;
	try {
		if (der.length !== 44 || der.toString("base64") !== trust.publicKeyDer) refuse();
		const key = createPublicKey({ key: der, format: "der", type: "spki" });
		if (key.asymmetricKeyType !== "ed25519") refuse();
		canonical = key.export({ format: "der", type: "spki" });
		if (!canonical.equals(der)) refuse();
		return key;
	} finally {
		der.fill(0);
		canonical?.fill(0);
	}
}

function signedFile(
	release: NativeAppRelease,
	name: string,
	maximum: number,
): NativeAppRelease["files"][number] {
	const matches = release.files.filter((file) => file.path === name);
	const file = matches[0];
	if (
		matches.length !== 1 ||
		!file ||
		!Number.isSafeInteger(file.bytes) ||
		file.bytes <= 0 ||
		file.bytes > maximum ||
		!/^[a-f0-9]{64}$/.test(file.sha256)
	)
		refuse();
	return file;
}

function matchesFile(bytes: Buffer, file: NativeAppRelease["files"][number]): void {
	if (
		bytes.length !== file.bytes ||
		createHash("sha256").update(bytes).digest("hex") !== file.sha256
	)
		refuse();
}

class Inspection {
	readonly #root: string;
	readonly #identity: Readonly<NativeSqliteContentIdentity>;
	readonly #trust: Readonly<NativeAppReleaseTrust>;
	#fenced = false;
	#task: Promise<Readonly<NativeSqliteContentData>> | undefined;
	#files: NativeAppFiles | undefined;
	#filesClosing: Promise<void> | undefined;
	#drain: Promise<void> | undefined;

	constructor(
		root: string,
		identity: Readonly<NativeSqliteContentIdentity>,
		trust: Readonly<NativeAppReleaseTrust>,
	) {
		this.#root = root;
		this.#identity = identity;
		this.#trust = trust;
	}

	#available(): void {
		if (this.#fenced) refuse();
	}

	inspect(): Promise<Readonly<NativeSqliteContentData>> {
		if (this.#fenced) return Promise.reject(unavailable());
		if (this.#task) return this.#task;
		// Keep the pending operation before its first callback can create a receiver.
		const task = Promise.resolve().then(() => this.#inspect());
		this.#task = task;
		return task;
	}

	#closeFiles(): Promise<void> {
		const files = this.#files;
		if (!files) return Promise.resolve();
		if (this.#filesClosing) return this.#filesClosing;
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const closing = new Promise<void>((success, failure) => {
			resolve = success;
			reject = failure;
		});
		this.#filesClosing = closing;
		void Promise.resolve()
			.then(() => files.close())
			.then(
				() => {
					if (this.#files === files) this.#files = undefined;
					resolve();
				},
				() => {
					// Genuine Files retains failed resources and permits cleanup-only retry.
					this.#filesClosing = undefined;
					reject(unavailable());
				},
			);
		return closing;
	}

	async #inspect(): Promise<Readonly<NativeSqliteContentData>> {
		let manifest: Buffer | undefined, signature: Buffer | undefined;
		let descriptor: Buffer | undefined, member: Buffer | undefined;
		try {
			this.#available();
			const files = createNativeAppFiles(this.#root);
			// Retain the genuine receiver before any asynchronous initialization.
			this.#files = files;
			const metadata = await files.readRelease();
			manifest = metadata.manifest;
			signature = metadata.signature;
			this.#available();
			if (manifest.length === 0 || manifest.length > manifestLimit || signature.length !== 64)
				refuse();
			const release = verifyNativeAppRelease(manifest, signature, releaseKey(this.#trust));
			if (
				release.version !== this.#trust.version ||
				release.executable !== this.#trust.executable ||
				release.entry !== this.#trust.entry
			)
				refuse();
			// This is the fixed Hub-JS layout membership, independent of SQLite selection.
			if (!release.files.some((file) => file.path === this.#trust.module)) refuse();
			const target = `${release.platform}-${release.arch}`;
			const bindingPath = `native/prebuilds/${target}.node`;
			const descriptorFile = signedFile(release, "bundle.json", manifestLimit);
			const bindingFile = signedFile(release, bindingPath, memberLimit);
			await files.verify(release);
			this.#available();
			descriptor = await files.resource("bundle.json");
			this.#available();
			matchesFile(descriptor, descriptorFile);
			const selected = selectNativeSqliteResourceData(
				descriptor,
				{
					version: release.version,
					platform: release.platform,
					arch: release.arch,
					native: this.#identity,
				},
				release.files,
			);
			if (
				!selected ||
				selected.target !== target ||
				selected.path !== bindingPath ||
				selected.bytes !== bindingFile.bytes ||
				selected.sha256 !== bindingFile.sha256
			)
				refuse();
			member = await files.resource(bindingPath);
			this.#available();
			matchesFile(member, bindingFile);
			return Object.freeze({
				version: release.version,
				platform: release.platform,
				arch: release.arch,
				target,
				path: selected.path,
				bytes: selected.bytes,
				sha256: selected.sha256,
			});
		} catch {
			throw unavailable();
		} finally {
			this.#fenced = true;
			try {
				// A failed close overrides success and retains the receiver for close().
				await this.#closeFiles();
			} finally {
				manifest?.fill(0);
				signature?.fill(0);
				descriptor?.fill(0);
				member?.fill(0);
			}
		}
	}

	close(): Promise<void> {
		this.#fenced = true;
		if (this.#drain) return this.#drain;
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const drain = new Promise<void>((success, failure) => {
			resolve = success;
			reject = failure;
		});
		this.#drain = drain;
		void (async () => {
			if (this.#task) await Promise.allSettled([this.#task]);
			await this.#closeFiles();
		})().then(
			() => resolve(),
			() => {
				this.#drain = undefined;
				reject(unavailable());
			},
		);
		return drain;
	}
}

/** Retain this opaque owner before its first inspect(), including rejected work. */
export function createNativeSqliteContentInspection(
	root: string,
	expectedNative: Readonly<NativeSqliteContentIdentity>,
): Readonly<NativeSqliteContentInspection> {
	const trust = nativeAppReleaseTrust;
	// No development trust means no receiver construction or filesystem access.
	if (!trust) refuse();
	const owner = new Inspection(rootData(root), identityData(expectedNative), trust);
	return Object.freeze({ inspect: () => owner.inspect(), close: () => owner.close() });
}
