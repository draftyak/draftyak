import { createSecretKey, generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	finalizeNativeAppReleaseFromBundle,
	NativeAppReleaseBuilder,
	nativeAppReleaseBytes,
	nativeAppReleaseSigningBytes,
	parseNativeAppRelease,
} from "../src/index.ts";
import { type Fixture, releaseFixture } from "./fixture.ts";

interface Held {
	name: string;
	handle: import("node:fs/promises").FileHandle;
	closed: boolean;
	closes: number;
}
const gate = vi.hoisted(() => ({
	root: "",
	held: [] as Held[],
	onCreate: undefined as ((name: string, handle: Held) => Promise<void>) | undefined,
	writeFault: "" as "" | "zero" | "short" | "throw",
	syncFault: false,
	readFault: false,
	corruptSignature: false,
	closeFault: "",
	closePersistent: false,
	created: [] as string[],
}));
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const open: typeof actual.open = async (...args) => {
		const handle = await actual.open(...args);
		if (typeof args[0] !== "string" || !gate.root || !args[0].startsWith(gate.root + path.sep))
			return handle;
		const name = args[0];
		const held: Held = { name, handle, closed: false, closes: 0 };
		gate.held.push(held);
		const close = handle.close.bind(handle);
		Object.defineProperty(handle, "close", {
			value: async () => {
				held.closes++;
				if (name === gate.closeFault && (gate.closePersistent || held.closes === 1))
					throw new Error("Owned close fault");
				await close();
				held.closed = true;
			},
		});
		if (typeof args[1] === "number" && (args[1] & constants.O_CREAT) !== 0) {
			gate.created.push(name);
			const write = handle.write.bind(handle);
			Object.defineProperty(handle, "write", {
				value: async (bytes: Buffer, offset: number, length: number, position: number) => {
					if (gate.writeFault === "throw") throw new Error("Owned write fault");
					if (gate.writeFault === "zero") return { bytesWritten: 0, buffer: bytes };
					return write(
						bytes,
						offset,
						gate.writeFault === "short" ? Math.min(7, length) : length,
						position,
					);
				},
			});
			const sync = handle.sync.bind(handle);
			Object.defineProperty(handle, "sync", {
				value: async () => {
					if (gate.syncFault) throw new Error("Owned sync fault");
					await sync();
					if (gate.corruptSignature && path.basename(name) === "release.signature")
						await write(Buffer.from("bad"), 0, 3, 0);
				},
			});
			const read = handle.read.bind(handle);
			Object.defineProperty(handle, "read", {
				value: async (bytes: Buffer, offset: number, length: number, position: number) => {
					const result = await read(bytes, offset, length, position);
					if (gate.readFault && result.bytesRead) bytes[offset] = (bytes[offset] ?? 0) ^ 1;
					return result;
				},
			});
			await gate.onCreate?.(name, held);
		}
		return handle;
	};
	return { ...actual, open };
});

interface Candidate {
	f: Fixture;
	metadata: Record<string, unknown>;
	key: { privateKey: KeyObject; publicKey: KeyObject };
}
const fixtures: Fixture[] = [];
const builders: NativeAppReleaseBuilder[] = [];
const controls: readonly [string, string] = ["release.manifest.json", "release.signature"];
async function candidate(): Promise<Candidate> {
	const f = await releaseFixture();
	fixtures.push(f);
	await f.put("node", "Synthetic Node DATA; never executed.\n");
	await f.put("hub/hub.mjs", "export const synthetic = true;\n");
	await f.put("native/prebuilds/linux-x64.node", "Synthetic binding DATA; never loaded.\n");
	const metadata = {
		schemaVersion: 1,
		version: f.descriptor.version,
		target: { platform: "linux", arch: "x64" },
		node: { binary: "node" },
		hub: { entry: "hub/hub.mjs" },
		native: { bindings: { "linux-x64": "native/prebuilds/linux-x64.node" } },
	};
	await f.put("bundle.json", `${JSON.stringify(metadata, null, 2)}\n`);
	gate.root = f.root;
	return { f, metadata, key: generateKeyPairSync("ed25519") };
}
function finalize(c: Candidate, key = c.key.privateKey) {
	const builder = new NativeAppReleaseBuilder(c.f.root);
	builders.push(builder);
	return finalizeNativeAppReleaseFromBundle(builder, c.metadata, c.f.descriptor.bundles, key);
}
async function refused(work: Promise<unknown>, code?: string): Promise<void> {
	await expect(work).rejects.toMatchObject({
		name: "NativeAppReleaseError",
		...(code ? { code } : {}),
	});
}
afterEach(async () => {
	gate.onCreate = undefined;
	gate.writeFault = "";
	gate.syncFault = false;
	gate.readFault = false;
	gate.corruptSignature = false;
	gate.closeFault = "";
	gate.closePersistent = false;
	await Promise.allSettled(builders.splice(0).map((tool) => tool.close()));
	const failures = await Promise.allSettled(
		gate.held.filter((held) => !held.closed).map((held) => held.handle.close()),
	);
	if (failures.some((result) => result.status === "rejected"))
		throw new Error("Owned handle cleanup failed");
	if (gate.held.some((held) => !held.closed)) throw new Error("Owned handle remains open");
	gate.root = "";
	gate.held = [];
	gate.created = [];
	await Promise.all(fixtures.splice(0).map((f) => f.remove()));
});

describe("native application candidate finalizer", () => {
	it("commits the exact canonical root and domain with a genuine ephemeral key", async () => {
		const c = await candidate();
		let measured = 0;
		gate.onCreate = async () => {
			const payloads = gate.held.filter((held) => !controls.includes(path.basename(held.name)));
			measured = payloads.length;
			expect(payloads.every((held) => !held.closed)).toBe(true);
		};
		const manifest = await finalize(c);
		expect(measured).toBe(c.f.payloads.size);
		const bytes = await readFile(path.join(c.f.root, controls[0]));
		const signature = await readFile(path.join(c.f.root, controls[1]));
		expect(bytes).toEqual(Buffer.from(nativeAppReleaseBytes(manifest)));
		expect(parseNativeAppRelease(bytes)).toEqual(manifest);
		expect(signature).toHaveLength(64);
		expect(verify(null, nativeAppReleaseSigningBytes(manifest), c.key.publicKey, signature)).toBe(
			true,
		);
		expect(verify(null, bytes, c.key.publicKey, signature)).toBe(false);
		expect(
			verify(
				null,
				nativeAppReleaseSigningBytes(manifest),
				generateKeyPairSync("ed25519").publicKey,
				signature,
			),
		).toBe(false);
		expect(
			verify(
				null,
				nativeAppReleaseSigningBytes({ ...manifest, version: "9.0.0" }),
				c.key.publicKey,
				signature,
			),
		).toBe(false);
		for (const [name, data] of c.f.payloads)
			expect(await readFile(path.join(c.f.root, name))).toEqual(data);
		expect(gate.held.every((held) => held.closed && held.closes === 1)).toBe(true);
		expect(manifest.files.some((file) => controls.includes(file.path))).toBe(false);
	});
	it("does not serialize a genuine private key", async () => {
		const c = await candidate();
		const prototype = Object.create(Object.getPrototypeOf(c.key.privateKey));
		const getter = vi.fn(() => {
			throw new Error("Private export must not run");
		});
		Object.defineProperty(prototype, "export", { get: getter });
		Object.setPrototypeOf(c.key.privateKey, prototype);
		await finalize(c);
		expect(getter).not.toHaveBeenCalled();
	});
	it.each(["public", "ec", "secret", "spoof", "proxy", "shadow"])(
		"refuses %s keys without exporting private material",
		async (kind) => {
			const c = await candidate();
			let key: unknown = c.key.privateKey;
			const getter = vi.fn(() => {
				throw new Error("Private accessor must not run");
			});
			if (kind === "public") key = c.key.publicKey;
			if (kind === "ec") key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
			if (kind === "secret") key = createSecretKey(new Uint8Array(32));
			if (kind === "spoof") key = {};
			if (kind === "proxy") key = new Proxy(c.key.privateKey, { get: getter });
			if (kind === "shadow") Object.defineProperty(c.key.privateKey, "export", { get: getter });
			await refused(finalize(c, key as KeyObject), "manifest");
			expect(getter).not.toHaveBeenCalled();
			expect(gate.held).toHaveLength(0);
			expect(gate.created).toHaveLength(0);
		},
	);
	it.each(controls)("preserves an existing %s", async (name) => {
		const c = await candidate();
		const original =
			name === controls[1] ? Buffer.alloc(64, 3) : Buffer.from("Existing metadata\n");
		await c.f.put(name, original);
		await refused(finalize(c), "file");
		expect(await readFile(path.join(c.f.root, name))).toEqual(original);
		expect(gate.created).toHaveLength(0);
	});
	it("refuses a metadata symlink without changing its target", async () => {
		const c = await candidate();
		const target = path.join(c.f.container, "outside.txt");
		await writeFile(target, "Owned outside DATA\n");
		await symlink(target, path.join(c.f.root, controls[0]));
		await refused(finalize(c));
		expect(await readFile(target, "utf8")).toBe("Owned outside DATA\n");
	});
	it.each(["metadata", "binding", "tuple"])(
		"refuses a mismatched same-root %s before metadata creation",
		async (fault) => {
			const c = await candidate();
			if (fault === "metadata") c.metadata.version = "9.0.0";
			if (fault === "binding") await c.f.put("native/prebuilds/linux-x64.node", new Uint8Array());
			if (fault === "tuple") c.f.descriptor.bundles.pop();
			await refused(finalize(c));
			expect(gate.created).toHaveLength(0);
		},
	);
	it("fully writes metadata across genuine short writes", async () => {
		const c = await candidate();
		gate.writeFault = "short";
		const manifest = await finalize(c);
		expect(await readFile(path.join(c.f.root, controls[0]))).toEqual(
			Buffer.from(nativeAppReleaseBytes(manifest)),
		);
	});
	it.each(["zero", "throw", "sync", "read"])(
		"reports retained partial metadata and closes handles after a %s fault",
		async (fault) => {
			const c = await candidate();
			if (fault === "zero" || fault === "throw") gate.writeFault = fault;
			if (fault === "sync") gate.syncFault = true;
			if (fault === "read") gate.readFault = true;
			await refused(finalize(c), "cleanup");
			expect(gate.created).toEqual([path.join(c.f.root, controls[0])]);
			expect((await readdir(c.f.root)).includes(controls[0])).toBe(true);
			expect(gate.held.every((held) => held.closed)).toBe(true);
			for (const [name, bytes] of c.f.payloads)
				expect(await readFile(path.join(c.f.root, name))).toEqual(bytes);
		},
	);
	it("preserves an unknown replacement of a partial metadata file", async () => {
		const c = await candidate();
		gate.onCreate = async (name, held) => {
			await held.handle.close();
			await rename(name, path.join(c.f.container, "original-metadata"));
			await writeFile(name, "Replacement DATA\n");
		};
		await refused(finalize(c), "cleanup");
		expect(await readFile(path.join(c.f.root, controls[0]), "utf8")).toBe("Replacement DATA\n");
	});
	it("refuses a real signature-byte mutation after fsync", async () => {
		const c = await candidate();
		gate.corruptSignature = true;
		await refused(finalize(c), "cleanup");
		expect((await readFile(path.join(c.f.root, controls[1]))).subarray(0, 3)).toEqual(
			Buffer.from("bad"),
		);
	});
	it("refuses a newly added payload during metadata creation", async () => {
		const c = await candidate();
		let changed = false;
		gate.onCreate = async () => {
			if (changed) return;
			changed = true;
			await c.f.put("assets/additional.txt", "Additional synthetic DATA\n");
		};
		await refused(finalize(c), "cleanup");
		expect(await readFile(path.join(c.f.root, "assets/additional.txt"), "utf8")).toBe(
			"Additional synthetic DATA\n",
		);
	});
	it.each(["node", "hub/hub.mjs", "native/prebuilds/linux-x64.node"])(
		"refuses equal-byte %s replacement during metadata creation after a retained handle is lost",
		async (member) => {
			const c = await candidate();
			const target = path.join(c.f.root, member);
			const original = await lstat(target, { bigint: true });
			let changed = false;
			gate.onCreate = async () => {
				if (changed) return;
				changed = true;
				const held = gate.held.find((row) => row.name === target);
				if (!held) throw new Error("Missing genuine measured handle");
				// Losing the actual handle permits the real replacement even on Windows exclusive sharing.
				await held.handle.close();
				await rename(target, path.join(c.f.container, "original-member"));
				const bytes = c.f.payloads.get(member);
				if (!bytes) throw new Error("Missing original fixture bytes");
				await c.f.put(member, bytes);
				expect((await lstat(target, { bigint: true })).ino).not.toBe(original.ino);
			};
			await refused(finalize(c), "cleanup");
			expect(changed).toBe(true);
			expect(await readFile(target)).toEqual(c.f.payloads.get(member));
		},
	);
	it("retries a failed retained close without returning a successful finalization", async () => {
		const c = await candidate();
		const tool = new NativeAppReleaseBuilder(c.f.root);
		builders.push(tool);
		gate.closeFault = path.join(c.f.root, controls[1]);
		await refused(
			tool.finalizeFromBundle(c.metadata, c.f.descriptor.bundles, c.key.privateKey),
			"cleanup",
		);
		const held = gate.held.find((row) => row.name === gate.closeFault);
		expect(held).toMatchObject({ closed: false, closes: 1 });
		await tool.close();
		expect(held).toMatchObject({ closed: true, closes: 2 });
		await tool.close();
		expect(held?.closes).toBe(2);
		await refused(tool.build(c.f.descriptor), "state");
	});
	it("retains public-path retry custody after persistent close failure", async () => {
		const c = await candidate();
		const tool = new NativeAppReleaseBuilder(c.f.root);
		builders.push(tool);
		gate.closeFault = path.join(c.f.root, controls[1]);
		gate.closePersistent = true;
		await refused(
			finalizeNativeAppReleaseFromBundle(
				tool,
				c.metadata,
				c.f.descriptor.bundles,
				c.key.privateKey,
			),
			"cleanup",
		);
		await refused(tool.close(), "cleanup");
		const held = gate.held.find((row) => row.name === gate.closeFault);
		expect(held).toMatchObject({ closed: false, closes: 2 });
		gate.closeFault = "";
		gate.closePersistent = false;
		await tool.close();
		expect(held).toMatchObject({ closed: true, closes: 3 });
		await tool.close();
		expect(held?.closes).toBe(3);
	});
	it("settles caller-owned handles while retaining failed candidate files", async () => {
		const c = await candidate();
		const tool = new NativeAppReleaseBuilder(c.f.root);
		builders.push(tool);
		gate.writeFault = "zero";
		await refused(
			finalizeNativeAppReleaseFromBundle(
				tool,
				c.metadata,
				c.f.descriptor.bundles,
				c.key.privateKey,
			),
			"cleanup",
		);
		await tool.close();
		expect(gate.held.every((held) => held.closed)).toBe(true);
		expect(await readFile(path.join(c.f.root, controls[0]))).toHaveLength(0);
		await tool.close();
	});
	it("requires the genuine Builder rather than a caller-supplied finalizer method", async () => {
		const c = await candidate();
		const fake = { finalizeFromBundle: vi.fn(() => Promise.resolve({})) };
		await refused(
			finalizeNativeAppReleaseFromBundle(
				fake as unknown as NativeAppReleaseBuilder,
				c.metadata,
				c.f.descriptor.bundles,
				c.key.privateKey,
			),
			"state",
		);
		expect(fake.finalizeFromBundle).not.toHaveBeenCalled();
	});
	it("keeps existing DATA-only build behavior without creating metadata", async () => {
		const c = await candidate();
		const tool = new NativeAppReleaseBuilder(c.f.root);
		builders.push(tool);
		await tool.build(c.f.descriptor);
		expect(gate.created).toHaveLength(0);
		expect(gate.held.every((held) => held.closed)).toBe(true);
		await expect(readFile(path.join(c.f.root, controls[0]))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});
});
