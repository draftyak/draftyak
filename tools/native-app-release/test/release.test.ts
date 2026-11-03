import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { link, mkdir, rename, rm, symlink, truncate } from "node:fs/promises";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NativeAppReleaseBuilder,
	type NativeAppReleaseManifest,
	nativeAppReleaseBytes,
	nativeAppReleaseSigningBytes,
	parseNativeAppRelease,
} from "../src/index.ts";
import { type Fixture, IDS, releaseFixture } from "./fixture.ts";

// Only a named owned fixture path is gated; the handle itself remains the actual Node handle.
const gate = vi.hoisted(() => ({
	path: "",
	phase: "before" as "before" | "after",
	entered: undefined as (() => void) | undefined,
	release: undefined as (() => void) | undefined,
	wait: undefined as Promise<void> | undefined,
	closeRoot: "",
	directories: [] as { attempts: number; closed: boolean; realClose: () => Promise<void> }[],
	retryEntered: undefined as (() => void) | undefined,
	retryRelease: undefined as (() => void) | undefined,
	retryWait: undefined as Promise<void> | undefined,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const open: typeof actual.open = async (...args) => {
		const held = args[0] === gate.path;
		if (held && gate.phase === "before") {
			gate.entered?.();
			await gate.wait;
		}
		const handle = await actual.open(...args);
		if (held && gate.phase === "after") {
			gate.entered?.();
			await gate.wait;
		}
		return handle;
	};
	const opendir: typeof actual.opendir = async (...args) => {
		const resource = await actual.opendir(...args);
		const name = args[0];
		if (
			typeof name === "string" &&
			gate.closeRoot &&
			(name === gate.closeRoot ||
				name.startsWith(`${gate.closeRoot}/`) ||
				name.startsWith(`${gate.closeRoot}\\`))
		) {
			const original = resource.close.bind(resource);
			const state = { attempts: 0, closed: false, realClose: (): Promise<void> => original() };
			gate.directories.push(state);
			Object.defineProperty(resource, "close", {
				value: async () => {
					state.attempts++;
					if (state.attempts === 1) throw new Error("Owned directory close fault");
					gate.retryEntered?.();
					await gate.retryWait;
					await state.realClose();
					state.closed = true;
				},
			});
		}
		return resource;
	};
	return { ...actual, open, opendir };
});

const fixtures: Fixture[] = [];
const builders: NativeAppReleaseBuilder[] = [];
const REFUSAL = "Native application release operation refused.";
const MIB = 1024 * 1024;

async function fixture(): Promise<Fixture> {
	const result = await releaseFixture();
	fixtures.push(result);
	return result;
}
function builder(root: string): NativeAppReleaseBuilder {
	const result = new NativeAppReleaseBuilder(root);
	builders.push(result);
	return result;
}
function hold(target: string, phase: "before" | "after" = "before") {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	gate.path = target;
	gate.phase = phase;
	gate.entered = () => entered.resolve();
	gate.release = () => release.resolve();
	gate.wait = release.promise;
	return { entered: entered.promise, release: () => release.resolve() };
}
afterEach(async () => {
	gate.release?.();
	gate.retryRelease?.();
	gate.path = "";
	gate.entered = undefined;
	gate.release = undefined;
	gate.wait = undefined;
	const closed = await Promise.allSettled(builders.splice(0).map((item) => item.close()));
	const rescued = await Promise.allSettled(
		gate.directories
			.filter((item) => !item.closed)
			.map(async (item) => {
				await item.realClose();
				item.closed = true;
			}),
	);
	gate.closeRoot = "";
	gate.directories = [];
	gate.retryEntered = undefined;
	gate.retryRelease = undefined;
	gate.retryWait = undefined;
	if (closed.some((result) => result.status === "rejected"))
		throw new Error("Release fixture builder cleanup incomplete");
	if (rescued.some((result) => result.status === "rejected"))
		throw new Error("Release fixture directory cleanup incomplete");
	const removed = await Promise.allSettled(fixtures.splice(0).map((item) => item.remove()));
	if (removed.some((result) => result.status === "rejected"))
		throw new Error("Release fixture file cleanup incomplete");
});

const sorted = (files: NativeAppReleaseManifest["files"]) =>
	[...files].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
function encoded(value: unknown): Uint8Array {
	return Buffer.from(canonicalize(value), "utf8");
}
/** Canonical manifest DATA only: these extra records do not claim physical fixture files. */
function manifestAtSize(
	base: NativeAppReleaseManifest,
	targetBytes: number,
): NativeAppReleaseManifest {
	const files = base.files.map((file) => ({ ...file }));
	for (let i = files.length; i < 4096; i++) {
		files.push({
			path: `data/vector-${String(i).padStart(4, "0")}`,
			bytes: 0,
			sha256: "0".repeat(64),
		});
	}
	let remaining = targetBytes - encoded({ ...base, files: sorted(files) }).byteLength;
	if (remaining < 0) throw new Error("Canonical size vector is too small");
	for (let i = base.files.length; i < files.length && remaining > 0; i++) {
		const file = files[i];
		if (!file) throw new Error("Canonical size vector member missing");
		const padding = Math.min(200 - file.path.length, remaining);
		file.path += "x".repeat(padding);
		remaining -= padding;
	}
	if (remaining !== 0) throw new Error("Canonical size vector capacity exhausted");
	const result = { ...base, files: sorted(files) };
	expect(result.files).toHaveLength(4096);
	expect(result.files.every((file) => file.path.length <= 200)).toBe(true);
	expect(result.files.every((file) => file.path.split("/").length <= 16)).toBe(true);
	expect(result.files.reduce((sum, file) => sum + file.bytes, 0)).toBeLessThan(128 * MIB);
	expect(encoded(result).byteLength).toBe(targetBytes);
	return result;
}
function withExtraPath(base: NativeAppReleaseManifest, file: string): NativeAppReleaseManifest {
	return {
		...base,
		files: sorted([...base.files, { path: file, bytes: 0, sha256: "0".repeat(64) }]),
	};
}
async function refused(operation: Promise<unknown>): Promise<void> {
	await expect(operation).rejects.toMatchObject({ message: REFUSAL });
}

describe("native application release DATA", () => {
	it("derives the complete immutable tree, true archive pins and independent package versions", async () => {
		const f = await fixture();
		f.descriptor.bundles.reverse();
		const expected = f.expected();
		const actual = await builder(f.root).build(f.descriptor);
		expect(actual).toEqual(expected);
		expect(actual.bundles.map((bundle) => bundle.id)).toEqual([...IDS].reverse());
		expect(actual.bundles.every((bundle) => bundle.package.version !== actual.version)).toBe(true);
		for (const bundle of actual.bundles) {
			const data = f.payloads.get(bundle.archive);
			if (!data) throw new Error("Missing owned archive bytes");
			expect(bundle.package.integrity).toBe(
				`sha512-${createHash("sha512").update(data).digest("base64")}`,
			);
		}
		expect(Object.isFrozen(actual)).toBe(true);
		expect(Object.isFrozen(actual.bundles)).toBe(true);
		expect(Object.isFrozen(actual.bundles[0]?.package)).toBe(true);
		expect(Object.isFrozen(actual.files)).toBe(true);
		expect(actual.files.every(Object.isFrozen)).toBe(true);
		f.descriptor.version = "9.0.0";
		expect(actual.version).toBe("3.0.0");
	});

	it("signs only the exact domain and canonical DATA with an ephemeral in-memory Ed25519 key", async () => {
		const f = await fixture();
		const first = builder(f.root);
		const manifest = await first.build(f.descriptor);
		await first.close();
		expect(manifest).toEqual(f.expected());
		const canonical = Buffer.from(canonicalize(f.expected()), "utf8");
		const bytes = nativeAppReleaseBytes(manifest);
		expect(Buffer.from(bytes)).toEqual(canonical);
		const message = nativeAppReleaseSigningBytes(manifest);
		expect(Buffer.from(message)).toEqual(
			Buffer.concat([Buffer.from("DraftYak native application release v1\0", "utf8"), canonical]),
		);
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const signature = sign(null, message, privateKey);
		expect(signature.byteLength).toBe(64);
		expect(verify(null, message, publicKey, signature)).toBe(true);
		expect(verify(null, canonical, publicKey, signature)).toBe(false);
		expect(
			verify(
				null,
				Buffer.concat([Buffer.from("DraftYak native application release v2\0"), canonical]),
				publicKey,
				signature,
			),
		).toBe(false);
		expect(
			verify(
				null,
				nativeAppReleaseSigningBytes({ ...manifest, version: "3.0.1" }),
				publicKey,
				signature,
			),
		).toBe(false);
		expect(
			verify(
				null,
				nativeAppReleaseSigningBytes({
					...manifest,
					files: manifest.files.map((file, i) => (i ? file : { ...file, sha256: "0".repeat(64) })),
				}),
				publicKey,
				signature,
			),
		).toBe(false);
		expect(verify(null, message, generateKeyPairSync("ed25519").publicKey, signature)).toBe(false);
		// Public metadata is excluded from the files it describes. No private key is exported or written.
		await f.put("release.manifest.json", canonical);
		await f.put("release.signature", signature);
		expect(await builder(f.root).build(f.descriptor)).toEqual(manifest);
	});

	it("round-trips only canonical bytes and returns detached byte snapshots", async () => {
		const f = await fixture();
		const manifest = f.expected();
		const first = nativeAppReleaseBytes(manifest);
		const original = Buffer.from(first);
		expect(parseNativeAppRelease(first)).toEqual(manifest);
		first.fill(0);
		expect(Buffer.from(nativeAppReleaseBytes(manifest))).toEqual(original);
		const parsed = parseNativeAppRelease(original);
		original.fill(0);
		expect(parsed).toEqual(manifest);
		expect(Object.isFrozen(parsed)).toBe(true);
		expect(Object.isFrozen(parsed.files[0])).toBe(true);
	});

	it.each(["newline", "whitespace", "duplicate", "bom", "invalid-utf8"])(
		"refuses %s parser encodings rather than normalizing signed input",
		async (fault) => {
			const f = await fixture();
			const text = canonicalize(f.expected());
			const bad =
				fault === "newline"
					? Buffer.from(`${text}\n`)
					: fault === "whitespace"
						? Buffer.from(` ${text}`)
						: fault === "duplicate"
							? Buffer.from(`{"v":1,${text.slice(1)}`)
							: fault === "bom"
								? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
								: Buffer.concat([Buffer.from(text), Buffer.from([0xff])]);
			expect(() => parseNativeAppRelease(bad)).toThrow(REFUSAL);
		},
	);

	it("refuses an input above the one-MiB manifest bound before decoding", () => {
		expect(() => parseNativeAppRelease(new Uint8Array(MIB + 1))).toThrow(REFUSAL);
	});

	it("refuses accessor manifest fields without invoking the getter", async () => {
		const f = await fixture();
		const read = vi.fn(() => {
			throw new Error("Untrusted manifest detail");
		});
		const value = Object.defineProperty(f.expected(), "version", { enumerable: true, get: read });
		expect(() => nativeAppReleaseBytes(value)).toThrow(REFUSAL);
		expect(read).not.toHaveBeenCalled();
	});
});

const manifestFaults: { name: string; change: (value: NativeAppReleaseManifest) => unknown }[] = [
	{ name: "version tag", change: (m) => ({ ...m, v: 2 }) },
	{ name: "application", change: (m) => ({ ...m, application: "other" }) },
	{ name: "platform", change: (m) => ({ ...m, platform: "android" }) },
	{ name: "architecture", change: (m) => ({ ...m, arch: "ia32" }) },
	{ name: "nonexact version", change: (m) => ({ ...m, version: "01.0.0" }) },
	{ name: "numeric prerelease", change: (m) => ({ ...m, version: "1.0.0-01" }) },
	{ name: "extra authority field", change: (m) => ({ ...m, approved: true }) },
	{ name: "missing fixed plugin", change: (m) => ({ ...m, bundles: m.bundles.slice(1) }) },
	{
		name: "duplicate fixed plugin",
		change: (m) => ({ ...m, bundles: [m.bundles[0], ...m.bundles.slice(0, 4)] }),
	},
	{
		name: "wrong package identity",
		change: (m) => ({
			...m,
			bundles: m.bundles.map((b, i) =>
				i ? b : { ...b, package: { ...b.package, name: "@draftyak/other" } },
			),
		}),
	},
	{
		name: "floating package version",
		change: (m) => ({
			...m,
			bundles: m.bundles.map((b, i) =>
				i ? b : { ...b, package: { ...b.package, version: "latest" } },
			),
		}),
	},
	{
		name: "non-sha512 integrity",
		change: (m) => ({
			...m,
			bundles: m.bundles.map((b, i) =>
				i ? b : { ...b, package: { ...b.package, integrity: "sha256-AAAA" } },
			),
		}),
	},
	{
		name: "package entry escape",
		change: (m) => ({
			...m,
			bundles: m.bundles.map((b, i) =>
				i ? b : { ...b, package: { ...b.package, entry: "../entry.mjs" } },
			),
		}),
	},
	{ name: "entry escape", change: (m) => ({ ...m, entry: "../outside.mjs" }) },
	{ name: "backslash path", change: (m) => ({ ...m, entry: "app\\main.mjs" }) },
	{ name: "reserved device path", change: (m) => ({ ...m, entry: "CON" }) },
	{ name: "duplicate executable and entry", change: (m) => ({ ...m, executable: m.entry }) },
	{
		name: "archive role collision",
		change: (m) => ({
			...m,
			bundles: m.bundles.map((b, i) => (i ? b : { ...b, archive: m.entry })),
		}),
	},
	{
		name: "unlisted entry",
		change: (m) => ({ ...m, files: m.files.filter((file) => file.path !== m.entry) }),
	},
	{ name: "unsorted file inventory", change: (m) => ({ ...m, files: [...m.files].reverse() }) },
	{
		name: "case collision",
		change: (m) => ({
			...m,
			files: sorted([
				...m.files,
				{ path: m.entry.toUpperCase(), bytes: 1, sha256: "0".repeat(64) },
			]),
		}),
	},
	{
		name: "reserved metadata file",
		change: (m) => ({
			...m,
			files: sorted([...m.files, { path: "Release.Signature", bytes: 64, sha256: "0".repeat(64) }]),
		}),
	},
	{
		name: "metadata prefix collision",
		change: (m) => ({
			...m,
			files: sorted([
				...m.files,
				{ path: "release.signature/child.dat", bytes: 1, sha256: "0".repeat(64) },
			]),
		}),
	},
	{
		name: "noncanonical hash",
		change: (m) => ({
			...m,
			files: m.files.map((file, i) => (i ? file : { ...file, sha256: "A".repeat(64) })),
		}),
	},
	{
		name: "fractional byte count",
		change: (m) => ({
			...m,
			files: m.files.map((file, i) => (i ? file : { ...file, bytes: 1.5 })),
		}),
	},
	{
		name: "negative byte count",
		change: (m) => ({ ...m, files: m.files.map((file, i) => (i ? file : { ...file, bytes: -1 })) }),
	},
	{
		name: "per-file byte bound",
		change: (m) => ({
			...m,
			files: m.files.map((file, i) => (i ? file : { ...file, bytes: 128 * MIB + 1 })),
		}),
	},
	{
		name: "aggregate byte bound",
		change: (m) => ({
			...m,
			files: m.files.map((file, i) => (i < 4 ? { ...file, bytes: 128 * MIB } : file)),
		}),
	},
];
describe("closed release schema", () => {
	it("accepts exactly one MiB of valid canonical manifest DATA", async () => {
		const f = await fixture();
		const manifest = manifestAtSize(f.expected(), MIB);
		const bytes = encoded(manifest);
		expect(parseNativeAppRelease(bytes)).toEqual(manifest);
		const serialized = Buffer.from(nativeAppReleaseBytes(manifest));
		expect(serialized.equals(Buffer.from(bytes))).toBe(true);
	});
	it("refuses one byte above one MiB of otherwise valid canonical manifest DATA", async () => {
		const f = await fixture();
		const manifest = manifestAtSize(f.expected(), MIB + 1);
		// Construct input with the independent protocol JCS primitive, not the serializer under test.
		const bytes = encoded(manifest);
		expect(() => parseNativeAppRelease(bytes)).toThrow(REFUSAL);
		expect(() => nativeAppReleaseBytes(manifest)).toThrow(REFUSAL);
	});
	it("accepts an exact 200-unit portable path and component", async () => {
		const f = await fixture();
		const member = "x".repeat(200);
		const manifest = withExtraPath(f.expected(), member);
		expect(member.length).toBe(200);
		expect(member.split("/")).toHaveLength(1);
		expect(parseNativeAppRelease(encoded(manifest))).toEqual(manifest);
		expect(Buffer.from(nativeAppReleaseBytes(manifest))).toEqual(Buffer.from(encoded(manifest)));
	});
	it("refuses a 201-unit portable path and component", async () => {
		const f = await fixture();
		const member = "x".repeat(201);
		const manifest = withExtraPath(f.expected(), member);
		expect(member.length).toBe(201);
		expect(() => parseNativeAppRelease(encoded(manifest))).toThrow(REFUSAL);
		expect(() => nativeAppReleaseBytes(manifest)).toThrow(REFUSAL);
	});
	it("accepts exactly 16 portable path components below the length limit", async () => {
		const f = await fixture();
		const member = Array.from({ length: 16 }, (_, i) => `p${i}`).join("/");
		const manifest = withExtraPath(f.expected(), member);
		expect(member.split("/")).toHaveLength(16);
		expect(member.length).toBeLessThan(200);
		expect(parseNativeAppRelease(encoded(manifest))).toEqual(manifest);
		expect(Buffer.from(nativeAppReleaseBytes(manifest))).toEqual(Buffer.from(encoded(manifest)));
	});
	it("refuses 17 portable path components below the length limit", async () => {
		const f = await fixture();
		const member = Array.from({ length: 17 }, (_, i) => `p${i}`).join("/");
		const manifest = withExtraPath(f.expected(), member);
		expect(member.split("/")).toHaveLength(17);
		expect(member.length).toBeLessThan(200);
		expect(() => parseNativeAppRelease(encoded(manifest))).toThrow(REFUSAL);
		expect(() => nativeAppReleaseBytes(manifest)).toThrow(REFUSAL);
	});
	it.each(manifestFaults)("refuses $name", async ({ change }) => {
		const f = await fixture();
		const invalid = change(f.expected());
		expect(() => nativeAppReleaseBytes(invalid)).toThrow(REFUSAL);
		expect(() => parseNativeAppRelease(encoded(invalid))).toThrow(REFUSAL);
	});
	it("refuses more than 4096 files independently of encoded-size and per-file limits", async () => {
		const f = await fixture();
		const manifest = f.expected();
		const files = sorted([
			...manifest.files,
			...Array.from({ length: 4097 - manifest.files.length }, (_, i) => ({
				path: `extra/${String(i).padStart(4, "0")}.dat`,
				bytes: 0,
				sha256: "0".repeat(64),
			})),
		]);
		const bytes = encoded({ ...manifest, files });
		expect(files).toHaveLength(4097);
		expect(bytes.byteLength).toBeLessThan(MIB);
		expect(() => parseNativeAppRelease(bytes)).toThrow(REFUSAL);
	});
	it("accepts the exact 512-MiB aggregate DATA bound with no file above 128 MiB", async () => {
		const f = await fixture();
		const value = f.expected();
		const files = value.files.map((file, i) => ({ ...file, bytes: i < 4 ? 128 * MIB : 0 }));
		const manifest = { ...value, files };
		expect(files.reduce((total, file) => total + file.bytes, 0)).toBe(512 * MIB);
		expect(parseNativeAppRelease(encoded(manifest))).toEqual(manifest);
	});
});

describe("owned release file builder", () => {
	it("includes every non-metadata file rather than trusting a caller file inventory", async () => {
		const f = await fixture();
		await f.put("assets/Unicode résumé.txt", "Additional owned bytes\n");
		expect(await builder(f.root).build(f.descriptor)).toEqual(f.expected());
		await refused(builder(f.root).build({ ...f.descriptor, files: [] }));
	});
	it.each(["pin", "archive-bytes", "missing-entry", "role-alias"])(
		"refuses actual %s mismatch",
		async (fault) => {
			const f = await fixture();
			const bundle = f.descriptor.bundles[0];
			if (!bundle) throw new Error("Missing owned bundle");
			if (fault === "pin")
				bundle.package.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
			else if (fault === "archive-bytes") await f.put(bundle.archive, "Changed archive bytes");
			else if (fault === "missing-entry") await rm(path.join(f.root, f.descriptor.entry));
			else f.descriptor.executable = f.descriptor.entry;
			await refused(builder(f.root).build(f.descriptor));
		},
	);
	it.each(["alias", "prefix", "short-signature", "large-manifest"])(
		"refuses %s metadata",
		async (fault) => {
			const f = await fixture();
			if (fault === "alias") await f.put("Release.Signature", new Uint8Array(64));
			else if (fault === "prefix")
				await f.put("release.signature/child.dat", "Owned metadata collision");
			else if (fault === "short-signature") await f.put("release.signature", new Uint8Array(63));
			else await f.put("release.manifest.json", new Uint8Array(MIB + 1));
			await refused(builder(f.root).build(f.descriptor));
		},
	);
	it("refuses an unrepresented empty directory", async () => {
		const f = await fixture();
		await mkdir(path.join(f.root, "empty"));
		await refused(builder(f.root).build(f.descriptor));
	});
	it("refuses a hardlinked file without treating its content hash as unique identity", async () => {
		const f = await fixture();
		await link(path.join(f.root, f.descriptor.entry), path.join(f.root, "linked.mjs"));
		await refused(builder(f.root).build(f.descriptor));
	});
	it("refuses a directory link to another owned fixture directory", async () => {
		const f = await fixture();
		const sibling = path.join(f.container, "sibling");
		await mkdir(sibling);
		await symlink(
			sibling,
			path.join(f.root, "linked"),
			process.platform === "win32" ? "junction" : "dir",
		);
		await refused(builder(f.root).build(f.descriptor));
	});
	it("refuses an oversized actual sparse file before accepting its advertised length", async () => {
		const f = await fixture();
		await truncate(path.join(f.root, f.descriptor.entry), 128 * MIB + 1);
		await refused(builder(f.root).build(f.descriptor));
	});
	it("is one-shot even after the first descriptor is refused", async () => {
		const f = await fixture();
		const tool = builder(f.root);
		await refused(tool.build({ ...f.descriptor, approved: true }));
		await refused(tool.build(f.descriptor));
		await tool.close();
		await tool.close();
	});
	it("captures descriptor DATA before a pending owned file open", async () => {
		const f = await fixture();
		const expected = f.expected();
		const barrier = hold(path.join(f.root, f.descriptor.entry));
		const work = builder(f.root).build(f.descriptor);
		void work.catch(() => {});
		try {
			await barrier.entered;
			f.descriptor.version = "9.0.0";
			const bundle = f.descriptor.bundles[0];
			if (!bundle) throw new Error("Missing owned bundle");
			bundle.package.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
			barrier.release();
			expect(await work).toEqual(expected);
		} finally {
			barrier.release();
			await Promise.allSettled([work]);
		}
	});
	it("refuses a genuine file identity replacement between lstat and open despite equal bytes", async () => {
		const f = await fixture();
		const entry = f.descriptor.entry;
		const original = f.payloads.get(entry);
		if (!original) throw new Error("Missing owned entry");
		const barrier = hold(path.join(f.root, entry));
		const work = builder(f.root).build(f.descriptor);
		void work.catch(() => {});
		try {
			await barrier.entered;
			await rename(path.join(f.root, entry), path.join(f.container, "original-entry.mjs"));
			await f.put(entry, original);
			barrier.release();
			await refused(work);
		} finally {
			barrier.release();
			await Promise.allSettled([work]);
		}
	});
	it("fences close immediately and drains a genuinely opened handle before close completes", async () => {
		const f = await fixture();
		const tool = builder(f.root);
		const barrier = hold(path.join(f.root, f.descriptor.entry), "after");
		const work = tool.build(f.descriptor);
		void work.catch(() => {});
		let closed = false;
		let closing: Promise<void> | undefined;
		try {
			await barrier.entered;
			closing = tool.close().then(() => {
				closed = true;
			});
			await refused(tool.build(f.descriptor));
			expect(closed).toBe(false);
			barrier.release();
			await refused(work);
			await closing;
			expect(closed).toBe(true);
			await refused(tool.build(f.descriptor));
			await tool.close();
		} finally {
			barrier.release();
			await Promise.allSettled([work, ...(closing ? [closing] : [])]);
		}
	});
	it("starts every retained close retry before waiting and never revives a failed builder", async () => {
		const f = await fixture();
		const tool = builder(f.root);
		const firstRetry = Promise.withResolvers<void>();
		const releaseRetries = Promise.withResolvers<void>();
		gate.closeRoot = f.root;
		gate.retryEntered = () => firstRetry.resolve();
		gate.retryWait = releaseRetries.promise;
		gate.retryRelease = () => releaseRetries.resolve();
		let closing: Promise<void> | undefined;
		try {
			// The first child-directory close fails, then the root-directory close fails too.
			// Both real directory handles must remain owned for the explicit retry.
			await refused(tool.build(f.descriptor));
			expect(gate.directories).toHaveLength(2);
			expect(gate.directories.every((item) => item.attempts === 1 && !item.closed)).toBe(true);
			closing = tool.close();
			void closing.catch(() => {});
			await firstRetry.promise;
			expect(gate.directories.every((item) => item.attempts === 2 && !item.closed)).toBe(true);
			await refused(tool.build(f.descriptor));
			releaseRetries.resolve();
			await closing;
			expect(gate.directories.every((item) => item.attempts === 2 && item.closed)).toBe(true);
			await tool.close();
			expect(gate.directories.every((item) => item.attempts === 2)).toBe(true);
		} finally {
			releaseRetries.resolve();
			if (closing) await Promise.allSettled([closing]);
		}
	});
});
