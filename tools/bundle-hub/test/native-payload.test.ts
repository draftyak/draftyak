import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, expect, it } from "vitest";
import { tar } from "../../fetch-node/test/archives.ts";
import { NATIVE_NAME, NATIVE_REQUIRED, NATIVE_VERSION } from "../src/bundle.ts";
import { digest } from "../src/inventory.ts";
import { selectedNativeTarget, stageNativePackage } from "../src/native-payload.ts";

const root = mkdtempSync(path.join(import.meta.dirname, ".tmp-native-payload-"));
afterAll(() => {
	if (
		path.dirname(path.resolve(root)) !== import.meta.dirname ||
		!path.basename(root).startsWith(".tmp-native-payload-")
	)
		throw new Error("unsafe native fixture cleanup");
	rmSync(root, { recursive: true, force: true });
});
function fixture() {
	const directory = mkdtempSync(path.join(root, "case-"));
	const stage = path.join(directory, "stage");
	mkdirSync(stage);
	const content: Record<string, string> = Object.fromEntries(
		NATIVE_REQUIRED.map((file) => [file, `unit fixture ${file}`]),
	);
	content["package.json"] = JSON.stringify({
		name: NATIVE_NAME,
		version: NATIVE_VERSION,
		main: "lib/index.js",
	});
	content["binding.gyp"] = "NAPI_VERSION=10";
	const packed = gzipSync(
		tar(Object.entries(content).map(([name, data]) => ({ name: `package/${name}`, data }))),
	);
	const archive = path.join(directory, "native.tgz");
	writeFileSync(archive, packed);
	return {
		stage,
		native: {
			archive,
			files: Object.entries(content).map(([name, value]) => ({
				path: name,
				bytes: Buffer.byteLength(value),
				sha256: digest(Buffer.from(value)),
			})),
		},
		integrity: `sha512-${createHash("sha512").update(packed).digest("base64")}`,
	};
}

it.each([
	{ platform: "win", arch: "x64" },
	{ platform: "darwin", arch: "arm64" },
	{ platform: "linux", arch: "x64" },
] as const)("authenticates all source bindings but stages only $platform/$arch", async (target) => {
	const f = fixture();
	const selected = selectedNativeTarget(target);
	const bindings = await stageNativePackage(f.native, target, f.stage, f.integrity);
	expect(bindings).toEqual({ [selected]: `native/prebuilds/${selected}.node` });
	expect(readdirSync(path.join(f.stage, "native/prebuilds"))).toEqual([`${selected}.node`]);
});
it("refuses an unpinned archive before writing any native file", async () => {
	const f = fixture();
	await expect(
		stageNativePackage(f.native, { platform: "win", arch: "x64" }, f.stage),
	).rejects.toThrow("reviewed pin");
	expect(readdirSync(f.stage)).toEqual([]);
});
it("refuses a missing source target even when that target would not be copied", async () => {
	const f = fixture();
	f.native.files = f.native.files.filter((file) => file.path !== "prebuilds/linuxmusl-arm64.node");
	await expect(
		stageNativePackage(f.native, { platform: "win", arch: "x64" }, f.stage, f.integrity),
	).rejects.toThrow("inventory is incomplete");
	expect(readdirSync(f.stage)).toEqual([]);
});
it("checks nonselected source hashes before writing the selected target", async () => {
	const f = fixture();
	f.native.files = f.native.files.map((file) =>
		file.path === "prebuilds/linuxmusl-arm64.node" ? { ...file, sha256: "a".repeat(64) } : file,
	);
	await expect(
		stageNativePackage(f.native, { platform: "win", arch: "x64" }, f.stage, f.integrity),
	).rejects.toThrow("inventory mismatch");
	expect(existsSync(path.join(f.stage, "native"))).toBe(false);
});
it("refuses unlisted prebuild paths and inert-record violations before artifact lookup", async () => {
	const f = fixture();
	f.native.files.push({ path: "prebuilds/unlisted.node", bytes: 1, sha256: "a".repeat(64) });
	await expect(
		stageNativePackage(f.native, { platform: "win", arch: "x64" }, f.stage, f.integrity),
	).rejects.toThrow("unexpected prebuild");
	const getter = Object.defineProperty({}, "path", {
		get: () => {
			throw new Error("getter invoked");
		},
		enumerable: true,
	});
	await expect(
		stageNativePackage(
			{ ...f.native, files: [getter] as never },
			{ platform: "win", arch: "x64" },
			f.stage,
			f.integrity,
		),
	).rejects.toThrow("file record");
	for (const target of [
		{ platform: "linuxmusl", arch: "x64" },
		{ platform: "win", arch: "ia32" },
	])
		expect(() => selectedNativeTarget(target as never)).toThrow("unsupported native target");
});
