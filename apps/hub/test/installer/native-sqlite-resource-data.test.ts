import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	type NativeSqliteResourceExpectation,
	type NativeSqliteResourceFileData,
	selectNativeSqliteResourceData,
} from "../../src/installer/native-sqlite-resource-data.ts";

const integrity =
	"sha512-UYabM82r1J84TLWc/SszoHs6XopWpl/2HCg3Nui1JUaFXg/VLswzkPowYiRhK/4CftI8dgtikwyZQecMldrGxQ==";
const bindingDigest = "ab".repeat(32);
const otherDigest = "cd".repeat(32);
const encoder = new TextEncoder();
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface BundleData {
	schemaVersion: number;
	version: string;
	target: { platform: string; arch: string };
	node: Record<string, unknown>;
	hub: { entry: string };
	native: {
		name: string;
		version: string;
		integrity: string;
		main: string;
		bindings: Record<string, string>;
	};
}

function fixture(
	platform: NativeSqliteResourceExpectation["platform"] = "win32",
	arch: NativeSqliteResourceExpectation["arch"] = "x64",
) {
	const expected: NativeSqliteResourceExpectation = {
		version: "1.2.3",
		platform,
		arch,
		native: { name: "better-sqlite3-multiple-ciphers", version: "13.0.3", integrity },
	};
	const target = `${platform}-${arch}`;
	const path = `native/prebuilds/${target}.node`;
	const bundle: BundleData = {
		schemaVersion: 1,
		version: expected.version,
		target: { platform: platform === "win32" ? "win" : platform, arch },
		// Opaque selector-only DATA; this is not a production Node description or a trusted resource.
		node: {},
		hub: { entry: "hub/hub.mjs" },
		native: { ...expected.native, main: "native/lib/index.js", bindings: { [target]: path } },
	};
	const binding: NativeSqliteResourceFileData = { path, bytes: 4096, sha256: bindingDigest };
	const encode = (value: unknown = bundle) => encoder.encode(JSON.stringify(value));
	const files = (
		bytes: Uint8Array,
	): [
		NativeSqliteResourceFileData,
		NativeSqliteResourceFileData,
		...NativeSqliteResourceFileData[],
	] => [{ path: "bundle.json", bytes: bytes.byteLength, sha256: digest(bytes) }, { ...binding }];
	return { expected, target, path, bundle, binding, encode, files };
}

describe("SQLite resource DATA selection", () => {
	it.each([
		["win32", "x64"],
		["win32", "arm64"],
		["darwin", "x64"],
		["darwin", "arm64"],
		["linux", "x64"],
		["linux", "arm64"],
	] as const)("selects the exact %s/%s producer binding", (platform, arch) => {
		const f = fixture(platform, arch),
			bytes = f.encode();
		const selected = selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes));
		expect(selected).toEqual({ target: f.target, ...f.binding });
		expect(Object.isFrozen(selected)).toBe(true);
	});

	it("keeps known optional profile metadata separate from the binding", () => {
		const f = fixture(),
			bytes = f.encode({ ...f.bundle, profile: "desktop-snapshot" });
		expect(selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes))).toEqual({
			target: f.target,
			...f.binding,
		});
	});

	it("reads only a fixed ordinary subview and leaves caller bytes unchanged", () => {
		const f = fixture(),
			bytes = f.encode(),
			backing = new Uint8Array(bytes.length + 8);
		backing.fill(0x7f);
		backing.set(bytes, 4);
		const view = backing.subarray(4, 4 + bytes.length),
			before = Uint8Array.from(backing);
		expect(selectNativeSqliteResourceData(view, f.expected, f.files(bytes))).toEqual({
			target: f.target,
			...f.binding,
		});
		expect(backing).toEqual(before);
	});

	it("returns declared inventory byte and hash DATA at the binding size limit", () => {
		const f = fixture(),
			bytes = f.encode(),
			files = f.files(bytes);
		files[1] = { ...f.binding, bytes: 256 * 1024 * 1024, sha256: otherDigest };
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toEqual({
			target: f.target,
			...files[1],
		});
	});

	it.each([
		["schema version", (b: BundleData) => ({ ...b, schemaVersion: 2 })],
		["bundle version", (b: BundleData) => ({ ...b, version: "1.2.4" })],
		[
			"producer win32 spelling",
			(b: BundleData) => ({ ...b, target: { ...b.target, platform: "win32" } }),
		],
		[
			"unselectable musl target",
			(b: BundleData) => ({ ...b, target: { ...b.target, platform: "linuxmusl" } }),
		],
		["wrong platform", (b: BundleData) => ({ ...b, target: { ...b.target, platform: "linux" } })],
		["wrong architecture", (b: BundleData) => ({ ...b, target: { ...b.target, arch: "arm64" } })],
		["extra target field", (b: BundleData) => ({ ...b, target: { ...b.target, extra: true } })],
		["native name", (b: BundleData) => ({ ...b, native: { ...b.native, name: "better-sqlite3" } })],
		["native version", (b: BundleData) => ({ ...b, native: { ...b.native, version: "13.0.4" } })],
		[
			"native integrity",
			(b: BundleData) => ({
				...b,
				native: { ...b.native, integrity: `sha512-${"A".repeat(86)}==` },
			}),
		],
		[
			"native main",
			(b: BundleData) => ({
				...b,
				native: { ...b.native, main: "native/prebuilds/win32-x64.node" },
			}),
		],
		["extra native field", (b: BundleData) => ({ ...b, native: { ...b.native, extra: true } })],
		["extra root field", (b: BundleData) => ({ ...b, extra: true })],
	] as const)("refuses a mismatched %s with an otherwise matching inventory", (_name, change) => {
		const f = fixture(),
			bytes = f.encode(change(f.bundle));
		expect(selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes))).toBeUndefined();
	});

	it("requires every producer root field", () => {
		const f = fixture(),
			bundle = { ...f.bundle };
		Reflect.deleteProperty(bundle, "node");
		const bytes = f.encode(bundle);
		expect(selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes))).toBeUndefined();
	});

	it("refuses duplicate JSON keys before selecting a binding", () => {
		const f = fixture();
		const bytes = encoder.encode(
			JSON.stringify(f.bundle).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'),
		);
		expect(selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes))).toBeUndefined();
	});

	it("refuses a second valid binding even when both rows are inventoried", () => {
		const f = fixture();
		f.bundle.native.bindings["win32-arm64"] = "native/prebuilds/win32-arm64.node";
		const bytes = f.encode(),
			files = f.files(bytes);
		files.push({ path: "native/prebuilds/win32-arm64.node", bytes: 4096, sha256: otherDigest });
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toBeUndefined();
	});

	it("refuses an alternate sole target key", () => {
		const f = fixture();
		f.bundle.native.bindings = { "win32-arm64": "native/prebuilds/win32-arm64.node" };
		const bytes = f.encode();
		expect(selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes))).toBeUndefined();
	});

	it.each([
		"native/lib/index.js",
		"hub/native/win32-x64.node",
		"./native/prebuilds/win32-x64.node",
		"native/prebuilds/../win32-x64.node",
		"native\\prebuilds\\win32-x64.node",
		"/native/prebuilds/win32-x64.node",
		"C:/native/prebuilds/win32-x64.node",
		"native/prebuilds/WIN32-x64.node",
	])("refuses noncanonical binding DATA %s", (path) => {
		const f = fixture();
		f.bundle.native.bindings[f.target] = path;
		const bytes = f.encode();
		expect(selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes))).toBeUndefined();
	});

	it.each(["bundle.json", "native/prebuilds/win32-x64.node"])(
		"requires inventory membership for %s",
		(path) => {
			const f = fixture(),
				bytes = f.encode();
			expect(
				selectNativeSqliteResourceData(
					bytes,
					f.expected,
					f.files(bytes).filter((row) => row.path !== path),
				),
			).toBeUndefined();
		},
	);

	it.each(["bytes", "sha256"] as const)("joins the actual bundle.json %s", (field) => {
		const f = fixture(),
			bytes = f.encode(),
			files = f.files(bytes);
		files[0] =
			field === "bytes"
				? { ...files[0], bytes: bytes.length + 1 }
				: { ...files[0], sha256: otherDigest };
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toBeUndefined();
	});

	it("refuses duplicate inventory paths", () => {
		const f = fixture(),
			bytes = f.encode(),
			files = f.files(bytes);
		files.push({ ...files[1] });
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toBeUndefined();
	});

	it.each([
		["empty binding", 0],
		["oversized binding", 256 * 1024 * 1024 + 1],
		["fractional size", 1.5],
		["negative size", -1],
	] as const)("refuses %s inventory DATA", (_name, bytes) => {
		const f = fixture(),
			bundleBytes = f.encode(),
			files = f.files(bundleBytes);
		files[1] = { ...files[1], bytes };
		expect(selectNativeSqliteResourceData(bundleBytes, f.expected, files)).toBeUndefined();
	});

	it.each(["../escape", "native\\extra.node", "C:/extra.node"])(
		"refuses a nonportable inventory path %s",
		(path) => {
			const f = fixture(),
				bytes = f.encode(),
				files = f.files(bytes);
			files.push({ path, bytes: 1, sha256: otherDigest });
			expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toBeUndefined();
		},
	);

	it("refuses an oversized total inventory without allocating file payloads", () => {
		const f = fixture(),
			bytes = f.encode(),
			files = f.files(bytes);
		for (const path of ["payload/one.bin", "payload/two.bin"])
			files.push({ path, bytes: 256 * 1024 * 1024, sha256: otherDigest });
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toBeUndefined();
	});

	it("refuses more than 4096 inventory rows", () => {
		const f = fixture(),
			bytes = f.encode(),
			files = f.files(bytes);
		for (let index = 0; index < 4095; index++)
			files.push({ path: `payload/${index}.bin`, bytes: 0, sha256: otherDigest });
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toBeUndefined();
	});

	it("refuses an otherwise valid bundle beyond the byte cap", () => {
		const f = fixture(),
			bytes = encoder.encode(JSON.stringify(f.bundle) + " ".repeat(1024 * 1024));
		expect(selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes))).toBeUndefined();
	});

	it("refuses shared backing memory", () => {
		const f = fixture(),
			bytes = f.encode(),
			shared = new Uint8Array(new SharedArrayBuffer(bytes.length));
		shared.set(bytes);
		expect(selectNativeSqliteResourceData(shared, f.expected, f.files(bytes))).toBeUndefined();
	});

	it("refuses a Proxy byte view without invoking its hooks", () => {
		const f = fixture(),
			bytes = f.encode();
		let hooks = 0;
		const proxy = new Proxy(bytes, {
			get() {
				hooks++;
				throw new Error("unexpected access");
			},
		});
		expect(selectNativeSqliteResourceData(proxy, f.expected, f.files(bytes))).toBeUndefined();
		expect(hooks).toBe(0);
	});

	it("refuses accessor expectation DATA without calling the getter", () => {
		const f = fixture(),
			bytes = f.encode();
		let reads = 0;
		Object.defineProperty(f.expected, "version", {
			enumerable: true,
			get() {
				reads++;
				return "1.2.3";
			},
		});
		expect(selectNativeSqliteResourceData(bytes, f.expected, f.files(bytes))).toBeUndefined();
		expect(reads).toBe(0);
	});

	it("refuses an accessor inventory row without calling the getter", () => {
		const f = fixture(),
			bytes = f.encode(),
			files = f.files(bytes);
		let reads = 0;
		Object.defineProperty(files[1], "path", {
			enumerable: true,
			get() {
				reads++;
				return f.path;
			},
		});
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toBeUndefined();
		expect(reads).toBe(0);
	});

	it.each([
		["200 characters", "u".repeat(200)],
		[
			"16 components",
			[...Array.from({ length: 15 }, (_, index) => `d${index}`), "unused.bin"].join("/"),
		],
	] as const)("permits a valid unused inventory path at %s", (_name, path) => {
		const f = fixture(),
			bytes = f.encode(),
			files = f.files(bytes);
		files.push({ path, bytes: 1, sha256: otherDigest });
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toEqual({
			target: f.target,
			...f.binding,
		});
	});

	it.each([
		["POSIX absolute", "/unused.bin"],
		["empty component", "unused//file.bin"],
		["dot component", "unused/./file.bin"],
		["201 total characters", `${"u".repeat(199)}/x`],
		["17 components", Array.from({ length: 17 }, (_, index) => `d${index}`).join("/")],
	] as const)("refuses otherwise valid inventory with an unused %s path", (_name, path) => {
		const f = fixture(),
			bytes = f.encode(),
			files = f.files(bytes);
		files.push({ path, bytes: 1, sha256: otherDigest });
		expect(selectNativeSqliteResourceData(bytes, f.expected, files)).toBeUndefined();
	});
});
