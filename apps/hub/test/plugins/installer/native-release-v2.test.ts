import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { canonicalize } from "@draftyak/protocol/jcs";
import { beforeAll, describe, expect, it } from "vitest";
import {
	type NativeReleaseV2,
	verifyNativeReleaseV2,
} from "../../../src/plugins/installer/native-release-v2.ts";
import { BUNDLED_PLUGIN_IDS } from "../../../src/plugins/installer/policy.ts";

interface FileInput {
	path: string;
	bytes: number;
	sha256: string;
}
interface BundleInput {
	id: string;
	package: { name: string; version: string; integrity: string; entry: string };
	archive: string;
	expectedSurfaceDigest: string;
}
interface ReleaseInput {
	v: number;
	application: string;
	version: string;
	platform: string;
	arch: string;
	executable: string;
	entry: string;
	bundles: BundleInput[];
	candidates: BundleInput[];
	files: FileInput[];
}

const DOMAIN = "DraftYak native application release v2\0";
const REFUSAL = "Native application release v2 refused.";
const FILE_LIMIT = 256 * 1024 * 1024;
const TOTAL_LIMIT = 512 * 1024 * 1024;
const MANIFEST_LIMIT = 1024 * 1024;
let publicKey: KeyObject;
let privateKey: KeyObject;
let otherPublicKey: KeyObject;
let ecPublicKey: KeyObject;

beforeAll(() => {
	({ publicKey, privateKey } = generateKeyPairSync("ed25519"));
	otherPublicKey = generateKeyPairSync("ed25519").publicKey;
	ecPublicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
});

function at<T>(values: readonly T[], index: number): T {
	const value = values[index];
	if (value === undefined) throw new Error("DYTEST release data missing");
	return value;
}

/** Synthetic signed metadata only: no archive bytes, installed files or trusted native origin. */
function release(candidateCount = 0): ReleaseInput {
	const bundles = BUNDLED_PLUGIN_IDS.map(
		(id): BundleInput => ({
			id,
			package: {
				name: `@draftyak/${id}`,
				version: "1.0.0",
				integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
				entry: "index.mjs",
			},
			archive: `bundles/${id}/selected.tgz`,
			expectedSurfaceDigest: "a".repeat(64),
		}),
	);
	const candidates = bundles.slice(0, candidateCount).map(
		(bundle): BundleInput => ({
			...bundle,
			package: { ...bundle.package, version: "2.0.0" },
			archive: `bundles/${bundle.id}/candidate.tgz`,
			expectedSurfaceDigest: "b".repeat(64),
		}),
	);
	const files = [
		"bin/node",
		"entry.mjs",
		...bundles.map((bundle) => bundle.archive),
		...candidates.map((bundle) => bundle.archive),
	].map(
		(name): FileInput => ({
			path: name,
			bytes: 0,
			sha256: "1".repeat(64),
		}),
	);
	return {
		v: 2,
		application: "draftyak",
		version: "1.0.0",
		platform: "win32",
		arch: "x64",
		executable: "bin/node",
		entry: "entry.mjs",
		bundles,
		candidates,
		files,
	};
}

function signedBytes(bytes: Uint8Array, domain = DOMAIN): { bytes: Buffer; signature: Buffer } {
	const owned = Buffer.from(bytes);
	return {
		bytes: owned,
		signature: sign(null, Buffer.concat([Buffer.from(domain), owned]), privateKey),
	};
}

function packet(data: unknown, domain = DOMAIN): { bytes: Buffer; signature: Buffer } {
	return signedBytes(Buffer.from(canonicalize(data)), domain);
}

function decode(data: unknown): NativeReleaseV2 {
	const { bytes, signature } = packet(data);
	return verifyNativeReleaseV2(bytes, signature, publicKey);
}

function refused(work: () => unknown): boolean {
	try {
		work();
		return false;
	} catch (error) {
		return error instanceof Error && error.message === REFUSAL && !Object.hasOwn(error, "cause");
	}
}

function rawRefused(bytes: unknown, signature: unknown, ...keys: unknown[]): boolean {
	const key = keys.length === 0 ? publicKey : keys[0];
	return refused(() => Reflect.apply(verifyNativeReleaseV2, undefined, [bytes, signature, key]));
}

function mutationsRefused(
	mutations: readonly ((data: ReleaseInput) => void)[],
	candidateCount = 1,
): boolean {
	return mutations.every((change) => {
		const data = release(candidateCount);
		change(data);
		return refused(() => decode(data));
	});
}

function withFileCount(count: number): ReleaseInput {
	const data = release();
	while (data.files.length < count) {
		data.files.push({ path: `extra/item-${data.files.length}`, bytes: 0, sha256: "1".repeat(64) });
	}
	return data;
}

function withManifestBytes(target: number): ReleaseInput {
	const data = withFileCount(4096);
	let remaining = target - Buffer.byteLength(canonicalize(data));
	for (const file of data.files.slice(7)) {
		if (remaining <= 0) break;
		const extra = Math.min(remaining, 200 - file.path.length);
		file.path += "x".repeat(extra);
		remaining -= extra;
	}
	if (remaining !== 0) throw new Error("DYTEST release byte target unavailable");
	return data;
}

describe("signed native release v2 DATA", { concurrent: false }, () => {
	it("authenticates exactly five selected bundles and an explicitly empty candidate set", () => {
		const result = decode(release());
		expect(result.v).toBe(2);
		expect(result.application === "draftyak").toBe(true);
		expect(result.bundles.length).toBe(5);
		expect(result.candidates.length).toBe(0);
		expect(result.files.length).toBe(7);
		expect(result.bundles.every((bundle) => bundle.expectedSurfaceDigest === "a".repeat(64))).toBe(
			true,
		);
	});

	it("snapshots one candidate per retained id with frozen independent metadata", () => {
		const data = release(5);
		const wire = packet(data);
		const result = verifyNativeReleaseV2(wire.bytes, wire.signature, publicKey);
		at(data.bundles, 0).package.version = "9.0.0";
		data.candidates.length = 0;
		at(data.files, 0).sha256 = "f".repeat(64);
		wire.bytes.fill(0);
		wire.signature.fill(0);
		expect(result.bundles.length).toBe(5);
		expect(result.candidates.length).toBe(5);
		expect(result.files.length).toBe(12);
		expect(result.bundles.every((bundle) => bundle.package.version === "1.0.0")).toBe(true);
		expect(result.candidates.every((bundle) => bundle.package.version === "2.0.0")).toBe(true);
		expect(
			Object.isFrozen(result) &&
				Object.isFrozen(result.bundles) &&
				Object.isFrozen(result.candidates) &&
				Object.isFrozen(result.files),
		).toBe(true);
		expect(
			[...result.bundles, ...result.candidates].every(
				(bundle) => Object.isFrozen(bundle) && Object.isFrozen(bundle.package),
			),
		).toBe(true);
		expect(result.files.every(Object.isFrozen)).toBe(true);
		expect(Reflect.set(at(result.candidates, 0).package, "version", "9.0.0")).toBe(false);
	});

	it("refuses a canonical release authenticated with a different public key", () => {
		const wire = packet(release(1));
		expect(rawRefused(wire.bytes, wire.signature, otherPublicKey)).toBe(true);
	});

	it("refuses altered signatures and canonical content tampered after signing", () => {
		const data = release(1);
		const wire = packet(data);
		const changedSignature = Buffer.from(wire.signature);
		changedSignature[0] = (changedSignature[0] ?? 0) ^ 1;
		data.version = "1.0.1";
		expect(rawRefused(wire.bytes, changedSignature)).toBe(true);
		expect(rawRefused(Buffer.from(canonicalize(data)), wire.signature)).toBe(true);
		expect(
			[Buffer.alloc(0), Buffer.alloc(63), Buffer.alloc(65)].every((signature) =>
				rawRefused(wire.bytes, signature),
			),
		).toBe(true);
	});

	it("refuses the v1 signature domain even for otherwise valid v2 content", () => {
		const wire = packet(release(), "DraftYak native application release v1\0");
		expect(rawRefused(wire.bytes, wire.signature)).toBe(true);
	});

	it("refuses v1 grammar without a version or descriptor fallback", () => {
		const tagOnly = release();
		tagOnly.v = 1;
		expect(refused(() => decode(tagOnly))).toBe(true);
		const legacy = release();
		legacy.v = 1;
		Reflect.deleteProperty(legacy, "candidates");
		for (const bundle of legacy.bundles) Reflect.deleteProperty(bundle, "expectedSurfaceDigest");
		const v2Signed = packet(legacy);
		const v1Signed = packet(legacy, "DraftYak native application release v1\0");
		expect(rawRefused(v2Signed.bytes, v2Signed.signature)).toBe(true);
		expect(rawRefused(v1Signed.bytes, v1Signed.signature)).toBe(true);
	});

	it("requires exact canonical JSON bytes and refuses duplicate JSON members", () => {
		const canonical = canonicalize(release());
		const texts = [` ${canonical}`, `${canonical}\n`, canonical.replace('"v":2', '"v":2,"v":2')];
		expect(
			texts.every((text) => {
				const wire = signedBytes(Buffer.from(text));
				return rawRefused(wire.bytes, wire.signature);
			}),
		).toBe(true);
	});

	it("refuses wrong top-level shapes and unknown or prototype-named members", () => {
		expect([null, [], true, 2, "release"].every((data) => refused(() => decode(data)))).toBe(true);
		expect(
			mutationsRefused([
				(data) => {
					Object.assign(data, { unexpected: true });
				},
				(data) => {
					Object.assign(data, { files: null });
				},
				(data) => {
					Object.assign(data, { bundles: {} });
				},
				(data) => {
					Object.defineProperty(data, "__proto__", { value: {}, enumerable: true });
				},
				(data) => {
					Object.assign(at(data.bundles, 0), { unexpected: true });
				},
			]),
		).toBe(true);
	});

	it("refuses missing duplicate and non-retained selected bundle identities", () => {
		expect(
			mutationsRefused([
				(data) => {
					data.bundles.pop();
				},
				(data) => {
					data.bundles.push({ ...at(data.bundles, 0) });
				},
				(data) => {
					const first = at(data.bundles, 0),
						second = at(data.bundles, 1);
					second.id = first.id;
					second.package = { ...first.package };
				},
				(data) => {
					at(data.bundles, 0).id = "tool-hello";
				},
			]),
		).toBe(true);
	});

	it("refuses a non-retained candidate with its matching signed package name", () => {
		const data = release(1);
		const candidate = at(data.candidates, 0);
		candidate.id = "tool-hello";
		candidate.package.name = "@draftyak/tool-hello";
		expect(refused(() => decode(data))).toBe(true);
	});

	it("requires the bounded candidate section with no duplicate or foreign candidate id", () => {
		expect(
			mutationsRefused([
				(data) => {
					Reflect.deleteProperty(data, "candidates");
				},
				(data) => {
					Object.assign(data, { candidates: null });
				},
				(data) => {
					Object.assign(data, { candidates: {} });
				},
				(data) => {
					at(data.candidates, 0).id = "tool-hello";
				},
			]),
		).toBe(true);
		const duplicate = release(1);
		const first = at(duplicate.candidates, 0);
		const repeated = {
			...first,
			package: { ...first.package, version: "3.0.0" },
			archive: `bundles/${first.id}/another-candidate.tgz`,
		};
		duplicate.candidates.push(repeated);
		duplicate.files.push({ path: repeated.archive, bytes: 0, sha256: "1".repeat(64) });
		expect(refused(() => decode(duplicate))).toBe(true);
		const tooMany = release(5);
		tooMany.candidates.push({ ...at(tooMany.candidates, 0) });
		expect(refused(() => decode(tooMany))).toBe(true);
	});

	it("refuses a candidate version equal to the selected version", () => {
		const data = release(1);
		at(data.candidates, 0).package.version = at(data.bundles, 0).package.version;
		expect(refused(() => decode(data))).toBe(true);
	});

	it("keeps exact package identity lock fields integrity and portable entry bounds", () => {
		expect(
			mutationsRefused([
				(data) => {
					at(data.candidates, 0).package.name = "@draftyak/channel-slack";
				},
				(data) => {
					at(data.bundles, 0).package.name = "@draftyak/tool-hello";
				},
				(data) => {
					Object.assign(at(data.candidates, 0).package, { extra: true });
				},
				(data) => {
					at(data.candidates, 0).package.version = "01.0.0";
				},
				(data) => {
					at(data.candidates, 0).package.version = "1.0.0-01";
				},
				(data) => {
					at(data.candidates, 0).package.version = "1".repeat(129);
				},
				(data) => {
					at(data.candidates, 0).package.integrity = "sha512-invalid";
				},
				(data) => {
					at(data.candidates, 0).package.entry = "../index.mjs";
				},
			]),
		).toBe(true);
	});

	it("requires a strict expected surface digest on every selected and candidate descriptor", () => {
		expect(
			mutationsRefused([
				(data) => {
					Reflect.deleteProperty(at(data.bundles, 0), "expectedSurfaceDigest");
				},
				(data) => {
					Reflect.deleteProperty(at(data.candidates, 0), "expectedSurfaceDigest");
				},
				(data) => {
					Object.assign(at(data.bundles, 0), { expectedSurfaceDigest: null });
				},
				(data) => {
					at(data.bundles, 0).expectedSurfaceDigest = "A".repeat(64);
				},
				(data) => {
					at(data.candidates, 0).expectedSurfaceDigest = "a".repeat(63);
				},
				(data) => {
					at(data.candidates, 0).expectedSurfaceDigest = `${"a".repeat(64)}\n`;
				},
				(data) => {
					at(data.candidates, 0).expectedSurfaceDigest = "g".repeat(64);
				},
			]),
		).toBe(true);
	});

	it("binds all archives to the same file map with no cross-descriptor aliases", () => {
		expect(
			mutationsRefused([
				(data) => {
					at(data.candidates, 0).archive = "bundles/missing.tgz";
				},
				(data) => {
					at(data.candidates, 0).archive = at(data.bundles, 0).archive;
				},
				(data) => {
					at(data.bundles, 1).archive = at(data.bundles, 0).archive;
				},
				(data) => {
					at(data.candidates, 0).archive = data.executable;
				},
				(data) => {
					at(data.bundles, 0).archive = data.entry;
				},
				(data) => {
					at(data.candidates, 0).archive = "../candidate.tgz";
				},
			]),
		).toBe(true);
		const two = release(2);
		at(two.candidates, 1).archive = at(two.candidates, 0).archive;
		expect(refused(() => decode(two))).toBe(true);
	});

	it("preserves portable tree metadata-name and exact file-record refusal", () => {
		expect(
			mutationsRefused([
				(data) => {
					data.files.push({ ...at(data.files, 0) });
				},
				(data) => {
					data.files.push({ path: "ENTRY.MJS", bytes: 0, sha256: "1".repeat(64) });
				},
				(data) => {
					data.files.push({ path: "release.manifest.json", bytes: 0, sha256: "1".repeat(64) });
				},
				(data) => {
					data.files.push({ path: "RELEASE.SIGNATURE", bytes: 0, sha256: "1".repeat(64) });
				},
				(data) => {
					at(data.files, 0).path = "../node";
				},
				(data) => {
					at(data.files, 0).path = "a/".repeat(16) + "node";
				},
				(data) => {
					at(data.files, 0).path = "a".repeat(201);
				},
				(data) => {
					Object.assign(at(data.files, 0), { type: "symlink" });
				},
				(data) => {
					at(data.files, 0).sha256 = "invalid";
				},
			]),
		).toBe(true);
	});

	it("retains inclusive per-file and combined selected-candidate byte limits", () => {
		const data = release(1);
		at(data.files, 0).bytes = FILE_LIMIT;
		at(data.files, 1).bytes = FILE_LIMIT;
		const result = decode(data);
		expect(result.files.reduce((total, file) => total + file.bytes, 0)).toBe(TOTAL_LIMIT);
		at(data.files, data.files.length - 1).bytes = 1;
		expect(refused(() => decode(data))).toBe(true);
		expect(
			mutationsRefused([
				(input) => {
					at(input.files, 0).bytes = FILE_LIMIT + 1;
				},
				(input) => {
					at(input.files, 0).bytes = -1;
				},
				(input) => {
					at(input.files, 0).bytes = 0.5;
				},
				(input) => {
					at(input.files, 0).bytes = Number.MAX_SAFE_INTEGER + 1;
				},
			]),
		).toBe(true);
	});

	it("accepts exactly 4096 file records and refuses one additional record", () => {
		expect(decode(withFileCount(4096)).files.length).toBe(4096);
		expect(refused(() => decode(withFileCount(4097)))).toBe(true);
	});

	it("accepts a canonical one-MiB manifest and refuses one additional signed byte", () => {
		const exact = packet(withManifestBytes(MANIFEST_LIMIT));
		const excess = packet(withManifestBytes(MANIFEST_LIMIT + 1));
		expect(exact.bytes.byteLength).toBe(MANIFEST_LIMIT);
		expect(excess.bytes.byteLength).toBe(MANIFEST_LIMIT + 1);
		expect(verifyNativeReleaseV2(exact.bytes, exact.signature, publicKey).files.length).toBe(4096);
		expect(rawRefused(excess.bytes, excess.signature)).toBe(true);
	});

	it("uses selected fixed byte views without consulting overridden getters or iterators", () => {
		const wire = packet(release());
		const bytes = Buffer.alloc(wire.bytes.length + 8);
		bytes.set(wire.bytes, 4);
		const view = new Uint8Array(bytes.buffer, bytes.byteOffset + 4, wire.bytes.length);
		let hits = 0;
		for (const name of ["byteLength", "byteOffset", "buffer"])
			Object.defineProperty(view, name, {
				get() {
					hits++;
					throw new Error("DYTEST view hook");
				},
			});
		Object.defineProperty(view, Symbol.iterator, {
			value() {
				hits++;
				throw new Error("DYTEST iterator hook");
			},
		});
		const result = verifyNativeReleaseV2(view, wire.signature, publicKey);
		expect(hits).toBe(0);
		expect(result.bundles.length).toBe(5);
	});

	it("refuses proxy forged shared and resizable byte or key inputs without traps", () => {
		const wire = packet(release());
		let hits = 0;
		const trap = {
			get() {
				hits++;
				throw new Error("DYTEST proxy hook");
			},
		};
		const shared = new Uint8Array(new SharedArrayBuffer(wire.bytes.length));
		shared.set(wire.bytes);
		const flexible = new Uint8Array(
			new ArrayBuffer(wire.bytes.length, { maxByteLength: wire.bytes.length + 1 }),
		);
		flexible.set(wire.bytes);
		const malformed = [
			undefined,
			{},
			Object.create(Uint8Array.prototype),
			Buffer.alloc(0),
			new Proxy(wire.bytes, trap),
			shared,
			flexible,
		];
		expect(malformed.every((bytes) => rawRefused(bytes, wire.signature))).toBe(true);
		expect(rawRefused(wire.bytes, new Proxy(wire.signature, trap))).toBe(true);
		expect(
			[
				undefined,
				{},
				Object.create(Object.getPrototypeOf(publicKey)),
				privateKey,
				new Proxy(publicKey, trap),
				ecPublicKey,
			].every((key) => rawRefused(wire.bytes, wire.signature, key)),
		).toBe(true);
		expect(hits).toBe(0);
	});

	it("normalizes deeply nested and malformed wire failures without retaining diagnostics", () => {
		const texts = ["[".repeat(2048) + "0" + "]".repeat(2048), "{", "null"];
		expect(
			texts.every((text) => {
				const wire = signedBytes(Buffer.from(text));
				return rawRefused(wire.bytes, wire.signature);
			}),
		).toBe(true);
	});

	it("keeps application version platform architecture and entry identity closed", () => {
		expect(
			mutationsRefused([
				(data) => {
					data.v = 3;
				},
				(data) => {
					data.application = "other";
				},
				(data) => {
					data.version = "01.0.0";
				},
				(data) => {
					data.version = "1.0.0-01";
				},
				(data) => {
					data.version = "1".repeat(129);
				},
				(data) => {
					data.platform = "unknown";
				},
				(data) => {
					data.arch = "unknown";
				},
				(data) => {
					data.entry = data.executable;
				},
				(data) => {
					data.executable = "missing-node";
				},
				(data) => {
					data.entry = "missing-entry.mjs";
				},
			]),
		).toBe(true);
	});
});
