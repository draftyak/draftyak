import { KeyObject, verify } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
} from "node:fs";
import path from "node:path";
import { types } from "node:util";
import { NativeAppReleaseBuilder } from "../../native-app-release/src/builder.ts";
import { buildNativeAppReleaseFromBundle } from "../../native-app-release/src/bundle.ts";
import {
	MAX_MANIFEST_BYTES,
	type NativeAppReleaseDescriptor,
	type NativeAppReleaseManifest,
	nativeAppReleaseBytes,
	nativeAppReleaseSigningBytes,
	parseNativeAppRelease,
	releaseDescriptor,
} from "../../native-app-release/src/manifest.ts";
import { MANIFEST_FILE, releaseRoot, SIGNATURE_FILE } from "../../native-app-release/src/paths.ts";

export type CandidatePayloadErrorCode =
	| "input"
	| "expectation"
	| "signature"
	| "payload"
	| "cleanup";

export class CandidatePayloadError extends Error {
	readonly code: CandidatePayloadErrorCode;
	constructor(code: CandidatePayloadErrorCode) {
		super("Candidate payload verification refused.");
		this.name = "CandidatePayloadError";
		this.code = code;
	}
}

export interface CandidatePayloadOptions {
	readonly root: string;
	readonly expected: unknown;
	readonly publicKey: KeyObject;
}

interface CapturedFile {
	readonly name: string;
	readonly fd: number;
	readonly stat: BigIntStats;
	readonly bytes: Buffer;
}

type Cleanup = () => Promise<void>;
type DescriptorOwnership = "owned" | "indeterminate";
const failedCleanup = new Set<Cleanup>();
const keyType = Object.getOwnPropertyDescriptor(KeyObject.prototype, "type")?.get;
const fields = [
	"dev",
	"ino",
	"mode",
	"nlink",
	"uid",
	"gid",
	"rdev",
	"size",
	"mtimeNs",
	"ctimeNs",
	"birthtimeNs",
] as const;

function refuse(code: CandidatePayloadErrorCode): never {
	throw new CandidatePayloadError(code);
}

function sameStat(first: BigIntStats, second: BigIntStats): boolean {
	return fields.every((field) => first[field] === second[field]);
}

function regular(stat: BigIntStats): void {
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.ino === 0n)
		refuse("payload");
}

function input(raw: CandidatePayloadOptions): CandidatePayloadOptions {
	try {
		if (
			!raw ||
			typeof raw !== "object" ||
			types.isProxy(raw) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(raw))
		)
			refuse("input");
		const names = Reflect.ownKeys(raw);
		if (names.length !== 3) refuse("input");
		const copy: Record<string, unknown> = Object.create(null);
		for (const name of names) {
			if (typeof name !== "string" || !["root", "expected", "publicKey"].includes(name))
				refuse("input");
			const slot = Object.getOwnPropertyDescriptor(raw, name);
			if (!slot?.enumerable || !("value" in slot)) refuse("input");
			copy[name] = slot.value;
		}
		const key = copy.publicKey;
		if (
			!keyType ||
			types.isProxy(key) ||
			!types.isKeyObject(key) ||
			Reflect.apply(keyType, key, []) !== "public" ||
			["type", "asymmetricKeyType", "export"].some((name) => Object.hasOwn(key, name)) ||
			types.isProxy(Object.getPrototypeOf(key)) ||
			key.asymmetricKeyType !== "ed25519"
		)
			refuse("input");
		return { root: releaseRoot(copy.root), expected: copy.expected, publicKey: key };
	} catch {
		return refuse("input");
	}
}

function expectations(raw: unknown): NativeAppReleaseDescriptor {
	try {
		const expected = releaseDescriptor(raw);
		const target = `${expected.platform}-${expected.arch}`;
		if (
			!["win32-x64", "darwin-arm64", "linux-x64"].includes(target) ||
			expected.executable !== (expected.platform === "win32" ? "node.exe" : "node") ||
			expected.entry !== "hub/hub.mjs" ||
			expected.bundles.some((bundle) => bundle.package.version !== expected.version)
		)
			refuse("expectation");
		return expected;
	} catch {
		return refuse("expectation");
	}
}

function matches(manifest: NativeAppReleaseManifest, expected: NativeAppReleaseDescriptor): void {
	for (const field of ["version", "platform", "arch", "executable", "entry"] as const)
		if (manifest[field] !== expected[field]) refuse("expectation");
	for (const bundle of manifest.bundles) {
		const wanted = expected.bundles.find((item) => item.id === bundle.id);
		if (
			!wanted ||
			bundle.archive !== wanted.archive ||
			(["name", "version", "integrity", "entry"] as const).some(
				(field) => bundle.package[field] !== wanted.package[field],
			)
		)
			refuse("expectation");
	}
}

function decode(bytes: Buffer): string {
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (!Buffer.from(text).equals(bytes)) refuse("payload");
	return text;
}

/** Remeasure a signed payload against independent DATA; this does not evaluate the release gate. */
export async function checkCandidatePayload(
	options: CandidatePayloadOptions,
): Promise<NativeAppReleaseManifest> {
	const selected = input(options);
	const expected = expectations(selected.expected);
	const builder = new NativeAppReleaseBuilder(selected.root);
	const descriptors = new Map<number, DescriptorOwnership>();
	const closeDescriptor = (fd: number): void => {
		if (descriptors.get(fd) !== "owned") refuse("cleanup");
		// A throwing close may already have released this number for another resource.
		descriptors.set(fd, "indeterminate");
		try {
			closeSync(fd);
		} catch {
			refuse("cleanup");
		}
		descriptors.delete(fd);
	};
	let closeJob: Promise<void> | undefined;
	const cleanup: Cleanup = () => {
		if (closeJob) return closeJob;
		const job = (async (): Promise<void> => {
			let failed = false;
			let closingBuilder: Promise<void> | undefined;
			try {
				closingBuilder = builder.close();
			} catch {
				failed = true;
			}
			for (const [fd, ownership] of [...descriptors]) {
				if (ownership === "indeterminate") {
					failed = true;
					continue;
				}
				try {
					closeDescriptor(fd);
				} catch {
					failed = true;
				}
			}
			try {
				await closingBuilder;
			} catch {
				failed = true;
			}
			if (failed || descriptors.size) {
				failedCleanup.add(cleanup);
				refuse("cleanup");
			}
			failedCleanup.delete(cleanup);
		})();
		closeJob = job;
		void job.then(
			() => {
				closeJob = undefined;
			},
			() => {
				closeJob = undefined;
			},
		);
		return job;
	};
	const chain = new Map<string, BigIntStats>();
	const checkChain = (capture = false): void => {
		const volume = path.parse(selected.root).root;
		let name = volume;
		for (const part of [
			"",
			...selected.root.slice(volume.length).split(path.sep).filter(Boolean),
		]) {
			if (part) name = path.join(name, part);
			const stat = lstatSync(name, { bigint: true });
			if (
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				stat.ino === 0n ||
				realpathSync(name) !== name
			)
				refuse("payload");
			if (capture) chain.set(name, stat);
			else {
				const before = chain.get(name);
				if (
					!before ||
					before.dev !== stat.dev ||
					before.ino !== stat.ino ||
					before.mode !== stat.mode
				)
					refuse("payload");
			}
		}
	};
	const read = (fd: number, size: number): Buffer => {
		const bytes = Buffer.alloc(size);
		for (let at = 0; at < size; ) {
			const count = readSync(fd, bytes, at, size - at, at);
			if (count < 1 || count > size - at) refuse("payload");
			at += count;
		}
		if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) refuse("payload");
		return bytes;
	};
	const capture = (
		relative: string,
		maximum: number,
		exact?: number,
		sizeCode: CandidatePayloadErrorCode = "payload",
	): CapturedFile => {
		checkChain();
		const name = path.join(selected.root, relative);
		const named = lstatSync(name, { bigint: true });
		regular(named);
		if (
			named.size < 1n ||
			named.size > BigInt(maximum) ||
			(exact !== undefined && named.size !== BigInt(exact))
		)
			refuse(sizeCode);
		if (realpathSync(name) !== name) refuse("payload");
		const fd = openSync(
			name,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
		);
		descriptors.set(fd, "owned");
		const stat = fstatSync(fd, { bigint: true });
		regular(stat);
		if (!sameStat(named, stat)) refuse("payload");
		const bytes = read(fd, Number(stat.size));
		if (
			!read(fd, Number(stat.size)).equals(bytes) ||
			!sameStat(stat, fstatSync(fd, { bigint: true })) ||
			!sameStat(stat, lstatSync(name, { bigint: true })) ||
			realpathSync(name) !== name
		)
			refuse("payload");
		checkChain();
		return { name, fd, stat, bytes };
	};
	const current = (file: CapturedFile): void => {
		checkChain();
		if (
			!sameStat(file.stat, fstatSync(file.fd, { bigint: true })) ||
			!sameStat(file.stat, lstatSync(file.name, { bigint: true })) ||
			realpathSync(file.name) !== file.name ||
			!read(file.fd, file.bytes.length).equals(file.bytes) ||
			!sameStat(file.stat, fstatSync(file.fd, { bigint: true })) ||
			!sameStat(file.stat, lstatSync(file.name, { bigint: true }))
		)
			refuse("payload");
		checkChain();
	};
	try {
		checkChain(true);
		const manifestFile = capture(MANIFEST_FILE, MAX_MANIFEST_BYTES);
		const signature = capture(SIGNATURE_FILE, 64, 64, "signature");
		const manifest = parseNativeAppRelease(manifestFile.bytes);
		matches(manifest, expected);
		if (!verify(null, nativeAppReleaseSigningBytes(manifest), selected.publicKey, signature.bytes))
			refuse("signature");
		const bundle = capture("bundle.json", MAX_MANIFEST_BYTES);
		const metadata: unknown = JSON.parse(decode(bundle.bytes));
		if (metadata && typeof metadata === "object" && Object.hasOwn(metadata, "profile"))
			refuse("payload");
		closeDescriptor(bundle.fd);
		const ordered = manifest.bundles.map((bundle) => {
			const wanted = expected.bundles.find((item) => item.id === bundle.id);
			if (!wanted) return refuse("expectation");
			return wanted;
		});
		const measured = await buildNativeAppReleaseFromBundle(builder, metadata, ordered);
		if (!Buffer.from(nativeAppReleaseBytes(measured)).equals(manifestFile.bytes)) refuse("payload");
		current(manifestFile);
		current(signature);
		const bundleAfter = capture("bundle.json", MAX_MANIFEST_BYTES);
		if (!sameStat(bundle.stat, bundleAfter.stat) || !bundle.bytes.equals(bundleAfter.bytes))
			refuse("payload");
		current(bundleAfter);
		return measured;
	} catch (error) {
		let known = false;
		try {
			known = !types.isProxy(error) && error instanceof CandidatePayloadError;
		} catch {
			/* Fixed refusal below. */
		}
		if (known) throw error;
		throw new CandidatePayloadError("payload");
	} finally {
		await cleanup();
	}
}

/** Complete safe cleanup and refuse while descriptor ownership remains indeterminate. */
export async function closeCandidatePayloadChecks(): Promise<void> {
	const outcomes = await Promise.allSettled([...failedCleanup].map((cleanup) => cleanup()));
	if (outcomes.some((outcome) => outcome.status === "rejected")) refuse("cleanup");
}
