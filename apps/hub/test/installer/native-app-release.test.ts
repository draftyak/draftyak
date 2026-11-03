import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { canonicalize } from "@draftyak/protocol/jcs";
import { describe, expect, it } from "vitest";
import { verifyNativeAppRelease } from "../../src/installer/native-app-release.ts";
import { BUNDLED_PLUGIN_IDS } from "../../src/plugins/installer/policy.ts";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const domain = Buffer.from("DraftYak native application release v1\0");
const refusal = "Native application release refused.";
const MiB = 1024 * 1024;

function fixture() {
	const bundles = BUNDLED_PLUGIN_IDS.map((id, index) => ({
		id: id as string,
		package: {
			name: `@draftyak/${id}`,
			version: `${index + 1}.2.3`,
			integrity: `sha512-${createHash("sha512").update(`DYTEST-${id}`).digest("base64")}`,
			entry: "dist/main.mjs",
		},
		archive: `bundles/${id}.tgz`,
	}));
	return {
		v: 1,
		application: "draftyak",
		version: "9.8.7-beta.2+release.3",
		platform: "win32",
		arch: "x64",
		executable: "bin/draftyak.exe",
		entry: "app/main.mjs",
		bundles,
		files: ["bin/draftyak.exe", "app/main.mjs", ...bundles.map((bundle) => bundle.archive)].map(
			(path) => ({
				path,
				bytes: 42,
				sha256: createHash("sha256").update(`DYTEST-${path}`).digest("hex"),
			}),
		),
	};
}

type Manifest = ReturnType<typeof fixture>;

function row<T>(values: readonly T[], index = 0): T {
	const value = values[index];
	if (value === undefined) throw new Error("DYTEST missing release fixture row");
	return value;
}

function encode(value: unknown): Buffer {
	return Buffer.from(canonicalize(value));
}

function signature(bytes: Uint8Array, prefix = domain): Buffer {
	return sign(null, Buffer.concat([prefix, bytes]), privateKey);
}

function verify(value: unknown) {
	const bytes = encode(value);
	return verifyNativeAppRelease(bytes, signature(bytes), publicKey);
}

function refused(bytes: Uint8Array, signed: Uint8Array = signature(bytes), key = publicKey): void {
	let failure: unknown;
	try {
		verifyNativeAppRelease(bytes, signed, key);
	} catch (error) {
		failure = error;
	}
	expect(failure instanceof Error).toBe(true);
	const error = failure as Error;
	expect(error.name).toBe("Error");
	expect(error.message).toBe(refusal);
	expect(Object.hasOwn(error, "cause")).toBe(false);
}

function invalid(change: (manifest: Manifest) => void): void {
	const manifest = fixture();
	change(manifest);
	refused(encode(manifest));
}

describe("native application release data", () => {
	it("authenticates canonical content and freezes every returned row without granting authority", () => {
		const manifest = fixture();
		const result = verify(manifest);
		expect(result).toEqual(manifest);
		expect(result).not.toBe(manifest);
		expect(result.bundles.map((bundle) => bundle.package.version)).toEqual([
			"1.2.3",
			"2.2.3",
			"3.2.3",
			"4.2.3",
			"5.2.3",
		]);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.bundles)).toBe(true);
		expect(Object.isFrozen(result.files)).toBe(true);
		expect(
			result.bundles.every((row) => Object.isFrozen(row) && Object.isFrozen(row.package)),
		).toBe(true);
		expect(result.files.every(Object.isFrozen)).toBe(true);
		expect(Object.values(result).some((value) => typeof value === "function")).toBe(false);
		row(manifest.bundles).package.version = "99.0.0";
		row(manifest.files).bytes = 99;
		expect(row(result.bundles).package.version).toBe("1.2.3");
		expect(row(result.files).bytes).toBe(42);
	});

	it.each([
		["win32", "x64"],
		["darwin", "arm64"],
		["linux", "x64"],
	])("accepts an authenticated %s/%s release", (platform, arch) => {
		const manifest = fixture();
		manifest.platform = platform;
		manifest.arch = arch;
		expect(verify(manifest).platform).toBe(platform);
	});

	it("requires the exact key, signature, domain and signed version, pin and file bytes", () => {
		const manifest = fixture();
		const bytes = encode(manifest);
		const signed = signature(bytes);
		refused(bytes, signed, generateKeyPairSync("ed25519").publicKey);
		const altered = Buffer.from(signed);
		altered.writeUInt8(altered.readUInt8(0) ^ 1, 0);
		refused(bytes, altered);
		refused(bytes, signature(bytes, Buffer.from("DraftYak other release v1\0")));
		refused(bytes, sign(null, bytes, privateKey));
		for (const change of [
			(value: Manifest) => {
				value.version = "9.8.8";
			},
			(value: Manifest) => {
				row(value.bundles).package.version = "1.2.4";
			},
			(value: Manifest) => {
				row(value.files).sha256 = "0".repeat(64);
			},
		]) {
			const changed = fixture();
			change(changed);
			refused(encode(changed), signed);
		}
	});

	it("requires a genuine public Ed25519 key without consulting fake or proxy fields", () => {
		const bytes = encode(fixture());
		const signed = signature(bytes);
		refused(bytes, signed, privateKey);
		refused(bytes, signed, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey);
		const disguised = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
		Object.defineProperty(disguised, "asymmetricKeyType", { value: "ed25519" });
		refused(bytes, signed, disguised);
		let hooks = 0;
		const fake = Object.defineProperty({}, "type", {
			get() {
				hooks++;
				return "public";
			},
		});
		refused(bytes, signed, fake as KeyObject);
		refused(
			bytes,
			signed,
			new Proxy(publicKey, {
				get() {
					hooks++;
					throw new Error("DYTEST unreachable key hook");
				},
			}),
		);
		expect(hooks).toBe(0);
	});

	it.each(["0.0.0", "1.0.0-rc.1", "10.20.30+build.009", "1.0.0-0.alpha+build"])(
		"accepts exact semantic version %s",
		(version) => {
			const manifest = fixture();
			manifest.version = version;
			expect(verify(manifest).version).toBe(version);
		},
	);

	it.each(["1.0", "v1.0.0", "01.0.0", "1.0.0-01", "1.0.0 ", "1.0.0\n"])(
		"refuses non-exact semantic version %#",
		(version) =>
			invalid((manifest) => {
				manifest.version = version;
			}),
	);

	it.each([
		[
			"wrong version marker",
			(value: Manifest): void => {
				value.v = 2;
			},
		],
		[
			"wrong application",
			(value: Manifest): void => {
				value.application = "other";
			},
		],
		[
			"unknown platform",
			(value: Manifest): void => {
				value.platform = "windows";
			},
		],
		[
			"unknown architecture",
			(value: Manifest): void => {
				value.arch = "ia32";
			},
		],
		[
			"missing bundle",
			(value: Manifest): void => {
				value.bundles.pop();
			},
		],
		[
			"extra bundle",
			(value: Manifest): void => {
				value.bundles.push(row(value.bundles));
			},
		],
		[
			"duplicate ID",
			(value: Manifest): void => {
				row(value.bundles, 1).id = row(value.bundles).id;
			},
		],
		[
			"unknown ID",
			(value: Manifest): void => {
				row(value.bundles).id = "third-party";
			},
		],
		[
			"wrong package name",
			(value: Manifest): void => {
				row(value.bundles).package.name = "other";
			},
		],
		[
			"invalid package version",
			(value: Manifest): void => {
				row(value.bundles).package.version = "1";
			},
		],
		[
			"invalid package integrity",
			(value: Manifest): void => {
				row(value.bundles).package.integrity = "";
			},
		],
		[
			"unsafe package entry",
			(value: Manifest): void => {
				row(value.bundles).package.entry = "../x";
			},
		],
		[
			"unlisted executable",
			(value: Manifest): void => {
				value.executable = "other.exe";
			},
		],
		[
			"unlisted entry",
			(value: Manifest): void => {
				value.entry = "other.mjs";
			},
		],
		[
			"same executable and entry",
			(value: Manifest): void => {
				value.entry = value.executable;
			},
		],
		[
			"unlisted archive",
			(value: Manifest): void => {
				row(value.bundles).archive = "other.tgz";
			},
		],
		[
			"same archive",
			(value: Manifest): void => {
				row(value.bundles, 1).archive = row(value.bundles).archive;
			},
		],
		[
			"executable as archive",
			(value: Manifest): void => {
				row(value.bundles).archive = value.executable;
			},
		],
		[
			"entry as archive",
			(value: Manifest): void => {
				row(value.bundles).archive = value.entry;
			},
		],
		[
			"negative size",
			(value: Manifest): void => {
				row(value.files).bytes = -1;
			},
		],
		[
			"fractional size",
			(value: Manifest): void => {
				row(value.files).bytes = 1.5;
			},
		],
		[
			"oversize file",
			(value: Manifest): void => {
				row(value.files).bytes = 256 * MiB + 1;
			},
		],
		[
			"uppercase hash",
			(value: Manifest): void => {
				row(value.files).sha256 = "A".repeat(64);
			},
		],
		[
			"short hash",
			(value: Manifest): void => {
				row(value.files).sha256 = "a".repeat(63);
			},
		],
	] as const)("refuses authenticated %s", (_name, change) => invalid(change));

	it.each(["../escape", "./entry", "/absolute", "a\\b", "a//b", "CON", "a.", "a:b"])(
		"refuses unsafe portable file path %#",
		(path) =>
			invalid((manifest) => {
				row(manifest.files).path = path;
			}),
	);

	it("refuses duplicate files, case aliases, file prefixes and inconsistently cased directories", () => {
		for (const path of ["app/main.mjs", "APP/main.mjs", "app", "APP/other.mjs"]) {
			invalid((manifest) => {
				manifest.files.push({ ...row(manifest.files, 1), path });
			});
		}
	});

	it.each([
		"release.manifest.json",
		"RELEASE.MANIFEST.JSON",
		"release.signature",
		"Release.Signature",
		"release.signature/child",
		"RELEASE.MANIFEST.JSON/child",
	])("refuses metadata file %s in authenticated inventory or roles", (path) => {
		invalid((manifest) => {
			manifest.files.push({ ...row(manifest.files), path });
		});
		invalid((manifest) => {
			row(manifest.bundles).archive = path;
		});
	});

	it("requires exact keys at every schema boundary", () => {
		const candidates: unknown[] = [null, [], { ...fixture(), extra: true }];
		for (const scope of ["root", "bundle", "package", "file"] as const) {
			const manifest = fixture();
			const target =
				scope === "root"
					? manifest
					: scope === "bundle"
						? row(manifest.bundles)
						: scope === "package"
							? row(manifest.bundles).package
							: row(manifest.files);
			Object.defineProperty(target, "extra", { value: "DYTEST", enumerable: true });
			candidates.push(manifest);
		}
		const missing = fixture();
		Reflect.deleteProperty(missing, "application");
		candidates.push(missing);
		for (const value of candidates) refused(encode(value));
	});

	it("enforces file count, per-file and total bounds while permitting empty files", () => {
		const manifest = fixture();
		manifest.files.forEach((file, index) => {
			file.bytes = index < 2 ? 256 * MiB : 0;
		});
		expect(verify(manifest).files.reduce((sum, file) => sum + file.bytes, 0)).toBe(512 * MiB);
		row(manifest.files, 4).bytes = 1;
		refused(encode(manifest));
		manifest.files.forEach((file) => {
			file.bytes = 0;
		});
		for (let index = manifest.files.length; index < 4096; index++)
			manifest.files.push({ path: `extra/file-${index}`, bytes: 0, sha256: "0".repeat(64) });
		expect(verify(manifest).files.length).toBe(4096);
		manifest.files.push({ path: "extra/over-count", bytes: 0, sha256: "0".repeat(64) });
		refused(encode(manifest));
	});

	it("rejects duplicate keys, invalid UTF-8 and noncanonical bytes even with genuine signatures", () => {
		const canonical = encode(fixture());
		const duplicates = Buffer.from(canonical.toString().replace('"v":1', '"v":1,"v":1'));
		for (const bytes of [
			duplicates,
			Buffer.concat([canonical, Buffer.from("\n")]),
			Buffer.from(JSON.stringify(fixture())),
			Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]),
			Buffer.from([0xc3, 0x28]),
		])
			refused(bytes);
	});

	it("snapshots selected subviews without invoking overridden byte accessors or iterators", () => {
		const bytes = encode(fixture());
		const framed = Buffer.concat([Buffer.from("prefix"), bytes, Buffer.from("suffix")]);
		const selected = new Uint8Array(framed.buffer, framed.byteOffset + 6, bytes.length);
		const signed = signature(bytes);
		let hooks = 0;
		for (const name of ["buffer", "byteLength", "byteOffset", "subarray", Symbol.iterator])
			Object.defineProperty(selected, name, {
				get() {
					hooks++;
					throw new Error("DYTEST unreachable byte hook");
				},
			});
		expect(verifyNativeAppRelease(selected, signed, publicKey).application).toBe("draftyak");
		expect(hooks).toBe(0);
	});

	it("refuses proxy, shared, resizable, empty and oversized byte inputs before caller hooks", () => {
		const bytes = encode(fixture());
		const signed = signature(bytes);
		let hooks = 0;
		const proxy = new Proxy(bytes, {
			get() {
				hooks++;
				throw new Error("DYTEST unreachable proxy hook");
			},
		});
		const shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
		shared.set(bytes);
		const resizable = new Uint8Array(
			new ArrayBuffer(bytes.length, { maxByteLength: bytes.length + 1 }),
		);
		resizable.set(bytes);
		for (const input of [proxy, shared, resizable, new Uint8Array(0), new Uint8Array(MiB + 1)])
			refused(input, signed);
		for (const backing of [
			new SharedArrayBuffer(signed.length),
			new ArrayBuffer(signed.length, { maxByteLength: signed.length + 1 }),
		]) {
			const view = new Uint8Array(backing);
			view.set(signed);
			refused(bytes, view);
		}
		for (const size of [0, 63, 65]) refused(bytes, new Uint8Array(size));
		const { proxy: revoked, revoke } = Proxy.revocable(signed, {});
		revoke();
		refused(bytes, revoked);
		expect(hooks).toBe(0);
	});
});
