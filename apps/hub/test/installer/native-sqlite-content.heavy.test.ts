import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import type { BigIntStats } from "node:fs";
import {
	type FileHandle,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterAll, afterEach, expect, test, vi } from "vitest";
import type {
	NativeAppRelease,
	NativeAppReleaseBundle,
	NativeAppReleaseFile,
} from "../../src/installer/native-app-release.ts";
import type { NativeAppReleaseTrust } from "../../src/installer/native-app-trust.ts";
import {
	createNativeSqliteContentInspection,
	type NativeSqliteContentData,
	type NativeSqliteContentIdentity,
	type NativeSqliteContentInspection,
} from "../../src/installer/native-sqlite-content.ts";

// Only the fixed build constant and the exact registered manifest-handle close
// seam are intercepted. Every open returns the SAME genuine FileHandle; all
// other filesystem exports, reads, verification and signatures stay real.
// Ephemeral fixture keys stay in memory; no application or native module loads.
const physicalCloses = vi.hoisted(() => new Map<string, PhysicalCloseProbe>());
vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>): ReturnType<typeof actual.open> => {
			const handle = await actual.open(...args);
			const probe = typeof args[0] === "string" ? physicalCloses.get(args[0]) : undefined;
			if (probe) {
				await probe.attach(handle);
				probe.returnedToFiles(handle);
			}
			return handle;
		},
	};
});

const fixedTrust = vi.hoisted(() => {
	let current: NativeAppReleaseTrust | undefined;
	return {
		get value() {
			return current;
		},
		set value(next: NativeAppReleaseTrust | undefined) {
			current = next;
		},
	};
});
vi.mock("../../src/installer/native-app-trust.ts", () => ({
	get nativeAppReleaseTrust() {
		return fixedTrust.value;
	},
}));

type ReleaseWire = Omit<
	{
		-readonly [Key in keyof NativeAppRelease]: NativeAppRelease[Key];
	},
	"files" | "bundles"
> & {
	files: NativeAppReleaseFile[];
	bundles: NativeAppReleaseBundle[];
};
interface BundleWire {
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
interface Fixture {
	readonly parent: string;
	readonly parentIdentity: BigIntStats;
	readonly root: string;
	rootIdentity: BigIntStats | undefined;
	readonly privateKey: KeyObject;
	readonly trust: NativeAppReleaseTrust;
	readonly expected: NativeSqliteContentIdentity;
	readonly release: ReleaseWire;
	readonly bundle: BundleWire;
	readonly values: Map<string, Buffer>;
	readonly owners: Set<Readonly<NativeSqliteContentInspection>>;
	readonly closeProbes: Set<PhysicalCloseProbe>;
}
const ids = [
	"channel-gmail",
	"channel-slack",
	"ai-messages-api",
	"ai-responses-api",
	"ai-chat-completions",
] as const;
const prefix = "draftyak-sqlite-content-";
const bindingPath = "native/prebuilds/win32-x64.node";
const modulePath = "hub/inspection-module.mjs";
const unavailable = "Native SQLite content inspection unavailable.";
const domain = Buffer.from("DraftYak native application release v1\0");
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const retained = new Set<Fixture>();

interface CapturedHandle {
	readonly handle: FileHandle;
	readonly close: () => Promise<void>;
	readonly stat: FileHandle["stat"];
	returned: boolean;
}
interface PhysicalCloseProbe {
	readonly target: string;
	readonly entered: Promise<void>;
	readonly physicalClosed: Promise<void>;
	readonly opens: number;
	readonly calls: number;
	readonly delegates: number;
	readonly exits: number;
	attach(handle: FileHandle): Promise<void>;
	returnedToFiles(handle: FileHandle): void;
	release(): void;
	handle(): FileHandle;
	stat(): Promise<BigIntStats>;
	cleanup(): Promise<void>;
}
type InspectionOutcome =
	| { readonly ok: true; readonly data: Readonly<NativeSqliteContentData> }
	| { readonly ok: false; readonly error: unknown };
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function armPhysicalClose(
	fixture: Fixture,
	mode: "hold" | "refuse-once",
): Promise<PhysicalCloseProbe> {
	const target = local(fixture, "release.manifest.json");
	const expected = await lstat(target, { bigint: true });
	if (
		!expected.isFile() ||
		expected.isSymbolicLink() ||
		expected.ino <= 0n ||
		physicalCloses.has(target)
	)
		throw new Error("Physical-close fixture identity refused.");
	const entered = deferred(),
		released = deferred(),
		physicalClosed = deferred();
	const allocations: CapturedHandle[] = [];
	let primary: CapturedHandle | undefined,
		calls = 0,
		delegates = 0,
		exits = 0;
	const probe: PhysicalCloseProbe = {
		target,
		entered: entered.promise,
		physicalClosed: physicalClosed.promise,
		get opens() {
			return allocations.length;
		},
		get calls() {
			return calls;
		},
		get delegates() {
			return delegates;
		},
		get exits() {
			return exits;
		},
		async attach(handle) {
			// Retain ownership before stat/descriptor changes can throw. This is
			// the actual object allocated by the original fs.open, never a facade.
			const captured: CapturedHandle = {
				handle,
				close: handle.close.bind(handle),
				stat: handle.stat.bind(handle),
				returned: false,
			};
			allocations.push(captured);
			if (primary) throw new Error("Manifest reopened instead of retained.");
			primary = captured;
			const actual = await captured.stat({ bigint: true });
			if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino)
				throw new Error("Physical-close handle identity refused.");
			Object.defineProperty(handle, "close", {
				configurable: true,
				writable: true,
				value: async () => {
					calls++;
					entered.resolve();
					if (mode === "hold") await released.promise;
					if (mode === "refuse-once" && calls === 1)
						throw new Error("Controlled pre-close refusal.");
					delegates++;
					await captured.close();
					exits++;
					physicalClosed.resolve();
				},
			});
		},
		returnedToFiles(handle) {
			const captured = allocations.find((item) => item.handle === handle);
			if (!captured) throw new Error("Unowned handle return refused.");
			captured.returned = true;
		},
		release: released.resolve,
		handle() {
			if (!primary) throw new Error("Physical-close handle was not allocated.");
			return primary.handle;
		},
		stat() {
			if (!primary) return Promise.reject(new Error("Physical-close handle was not allocated."));
			return primary.stat({ bigint: true });
		},
		async cleanup() {
			released.resolve();
			for (const captured of allocations) {
				// Only a hook failure BEFORE return leaves test-owned cleanup.
				// Once delivered, the same production owner must perform the close.
				if (!captured.returned && captured.handle.fd >= 0) await captured.close();
			}
			for (const captured of allocations) {
				if (captured.returned && exits === 0)
					throw new Error("Original physical close completion remains unproven.");
				if (captured.handle.fd !== -1)
					throw new Error("Genuine handle remains retained for cleanup retry.");
			}
			if (physicalCloses.get(target) === probe) physicalCloses.delete(target);
		},
	};
	fixture.closeProbes.add(probe);
	physicalCloses.set(target, probe);
	return probe;
}
function observeInspection(owner: Readonly<NativeSqliteContentInspection>) {
	let settled = false,
		successful = false;
	const outcome: Promise<InspectionOutcome> = owner.inspect().then(
		(data): InspectionOutcome => {
			settled = true;
			successful = true;
			return { ok: true, data };
		},
		(error: unknown): InspectionOutcome => {
			settled = true;
			return { ok: false, error };
		},
	);
	return {
		outcome,
		get settled() {
			return settled;
		},
		get successful() {
			return successful;
		},
	};
}
async function requireCloseEntry(
	probe: PhysicalCloseProbe,
	outcome: Promise<InspectionOutcome>,
): Promise<void> {
	await Promise.race([
		probe.entered,
		outcome.then((result) => {
			if (!result.ok) {
				throw result.error;
			}
			throw new Error("Inspection settled without entering physical close.");
		}),
	]);
}

function local(fixture: Fixture, name: string): string {
	if (
		!name ||
		name.includes("\\") ||
		name.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("Temporary member refused.");
	const absolute = resolve(fixture.root, ...name.split("/"));
	if (!absolute.startsWith(resolve(fixture.root) + sep))
		throw new Error("Temporary member refused.");
	return absolute;
}
function realDirectory(stat: BigIntStats): boolean {
	return stat.isDirectory() && !stat.isSymbolicLink() && stat.ino > 0n;
}
async function removeOwnedRoot(fixture: Fixture): Promise<void> {
	const absolute = resolve(fixture.root);
	if (dirname(absolute) !== fixture.parent || !basename(absolute).startsWith(prefix))
		throw new Error("Temporary root refused.");
	const identity = fixture.rootIdentity;
	if (!identity || !realDirectory(identity)) throw new Error("Temporary root identity unknown.");
	const parent = await lstat(fixture.parent, { bigint: true });
	const stat = await lstat(absolute, { bigint: true });
	if (
		!realDirectory(parent) ||
		parent.dev !== fixture.parentIdentity.dev ||
		parent.ino !== fixture.parentIdentity.ino ||
		(await realpath(fixture.parent)) !== fixture.parent ||
		!realDirectory(stat) ||
		stat.dev !== identity.dev ||
		stat.ino !== identity.ino ||
		(await realpath(absolute)) !== absolute
	)
		throw new Error("Temporary root identity refused.");
	await rm(absolute, { recursive: true, force: true });
}
async function finish(fixture: Fixture): Promise<void> {
	for (const probe of fixture.closeProbes) probe.release();
	let failed = false;
	for (const owner of fixture.owners) {
		try {
			await owner.close();
		} catch {
			failed = true;
		}
	}
	for (const probe of fixture.closeProbes) {
		try {
			await probe.cleanup();
		} catch {
			failed = true;
		}
	}
	if (failed) throw new Error("Genuine content resources remain retained for cleanup retry.");
	await removeOwnedRoot(fixture);
	fixture.owners.clear();
	fixture.closeProbes.clear();
	retained.delete(fixture);
}
async function writeSigned(
	fixture: Fixture,
	manifest = Buffer.from(canonicalize(fixture.release)),
	signingKey = fixture.privateKey,
): Promise<void> {
	const signature = sign(null, Buffer.concat([domain, manifest]), signingKey);
	await writeFile(local(fixture, "release.manifest.json"), manifest);
	await writeFile(local(fixture, "release.signature"), signature);
}
async function publish(fixture: Fixture): Promise<void> {
	fixture.values.set("bundle.json", Buffer.from(`${JSON.stringify(fixture.bundle, null, 2)}\n`));
	fixture.release.files = [...fixture.values].map(([path, bytes]) => ({
		path,
		bytes: bytes.length,
		sha256: hash(bytes),
	}));
	for (const [name, bytes] of fixture.values) {
		const file = local(fixture, name);
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, bytes, { mode: 0o600 });
	}
	await writeSigned(fixture);
}
async function fresh(): Promise<Fixture> {
	const temporary = tmpdir();
	if (!temporary || !isAbsolute(temporary))
		throw new Error("Absolute temporary directory is required.");
	const parent = await realpath(temporary);
	const parentIdentity = await lstat(parent, { bigint: true });
	if (!realDirectory(parentIdentity) || (await realpath(parent)) !== parent)
		throw new Error("Temporary parent identity refused.");
	const { publicKey, privateKey } = generateKeyPairSync("ed25519");
	const publicKeyDer = publicKey.export({ type: "spki", format: "der" }).toString("base64");
	const expected: NativeSqliteContentIdentity = {
		name: "better-sqlite3-multiple-ciphers",
		version: "13.0.3",
		integrity: `sha512-${createHash("sha512").update("fresh reviewed native identity").digest("base64")}`,
	};
	const bundle: BundleWire = {
		schemaVersion: 1,
		version: "1.2.3",
		target: { platform: "win", arch: "x64" },
		// Opaque selector-only DATA, not a production Node description or grant.
		node: {},
		hub: { entry: "hub/hub.mjs" },
		native: { ...expected, main: "native/lib/index.js", bindings: { "win32-x64": bindingPath } },
	};
	const values = new Map<string, Buffer>([
		["node.exe", Buffer.from("synthetic executable content, never executed\n")],
		["hub/hub.mjs", Buffer.from("export const syntheticEntry = true;\n")],
		[modulePath, Buffer.from("export const syntheticModule = true;\n")],
		[bindingPath, Buffer.from("synthetic selected binding content, never loaded\n")],
	]);
	const bundles = ids.map((id) => {
		const archive = `archives/${id}.tgz`,
			bytes = Buffer.from(`synthetic archive content for ${id}\n`);
		values.set(archive, bytes);
		return {
			id,
			archive,
			package: {
				name: `@draftyak/${id}`,
				version: "1.0.0",
				integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
				entry: "index.mjs",
			},
		};
	});
	const release: ReleaseWire = {
		v: 1,
		application: "draftyak",
		version: "1.2.3",
		platform: "win32",
		arch: "x64",
		executable: "node.exe",
		entry: "hub/hub.mjs",
		bundles,
		files: [],
	};
	const trust: NativeAppReleaseTrust = Object.freeze({
		version: release.version,
		publicKeyDer,
		executable: release.executable,
		entry: release.entry,
		module: modulePath,
	});
	const owners = new Set<Readonly<NativeSqliteContentInspection>>();
	const closeProbes = new Set<PhysicalCloseProbe>();
	const fixture: Fixture = {
		parent,
		parentIdentity,
		root: await mkdtemp(join(parent, prefix)),
		rootIdentity: undefined,
		privateKey,
		trust,
		expected,
		release,
		bundle,
		values,
		owners,
		closeProbes,
	};
	retained.add(fixture);
	try {
		fixture.rootIdentity = await lstat(fixture.root, { bigint: true });
		if (!realDirectory(fixture.rootIdentity)) throw new Error("Temporary root identity refused.");
		await publish(fixture);
		return fixture;
	} catch (error) {
		await finish(fixture);
		throw error;
	}
}
async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
	const fixture = await fresh();
	try {
		await run(fixture);
	} finally {
		await finish(fixture);
	}
}
function open(
	fixture: Fixture,
	expected: Readonly<NativeSqliteContentIdentity> = fixture.expected,
	trust: NativeAppReleaseTrust = fixture.trust,
	root = fixture.root,
): Readonly<NativeSqliteContentInspection> {
	fixedTrust.value = trust;
	const owner = createNativeSqliteContentInspection(root, expected);
	fixture.owners.add(owner);
	return owner;
}
async function refuses(
	fixture: Fixture,
	expected: Readonly<NativeSqliteContentIdentity> = fixture.expected,
	trust: NativeAppReleaseTrust = fixture.trust,
): Promise<void> {
	await expect(open(fixture, expected, trust).inspect()).rejects.toThrow(unavailable);
}
afterEach(() => {
	fixedTrust.value = undefined;
});
afterAll(async () => {
	await Promise.allSettled([...retained].map(finish));
	if (retained.size)
		throw new Error("Temporary content owners remain retained after cleanup failure.");
});

test("authenticates the closed flat tree and returns frozen scalar DATA only", async () => {
	await withFixture(async (fixture) => {
		const expectedBytes = fixture.values.get(bindingPath);
		if (!expectedBytes) throw new Error("Binding fixture missing.");
		const owner = open(fixture),
			result = await owner.inspect();
		expect(Object.isFrozen(owner)).toBe(true);
		expect(Object.keys(owner).sort()).toEqual(["close", "inspect"]);
		expect(Object.isFrozen(result)).toBe(true);
		expect(result).toEqual({
			version: "1.2.3",
			platform: "win32",
			arch: "x64",
			target: "win32-x64",
			path: bindingPath,
			bytes: expectedBytes.length,
			sha256: hash(expectedBytes),
		});
		expect(Reflect.set(result, "path", "changed")).toBe(false);
		expect(await readFile(local(fixture, bindingPath))).toEqual(expectedBytes);
		await owner.close();
	});
});
test("snapshots expected native identity before the caller changes its DATA", async () => {
	await withFixture(async (fixture) => {
		const expected = { ...fixture.expected },
			owner = open(fixture, expected);
		expected.name = "changed-after-construction";
		expect((await owner.inspect()).path).toBe(bindingPath);
	});
});
test("refuses development trust synchronously before reading expected identity", () => {
	fixedTrust.value = undefined;
	let reads = 0;
	const expected = {
		get name() {
			reads++;
			return "unread";
		},
		version: "13.0.3",
		integrity: "unread",
	};
	expect(() =>
		createNativeSqliteContentInspection(resolve("unaccessed-content-root"), expected),
	).toThrow(unavailable);
	expect(reads).toBe(0);
});
test("close before inspection fences admission without opening the root", async () => {
	await withFixture(async (fixture) => {
		const owner = open(fixture, fixture.expected, fixture.trust, local(fixture, "absent-root"));
		await owner.close();
		await expect(owner.inspect()).rejects.toThrow(unavailable);
	});
});
test("memoizes queued inspection and cleanup while close fences further work", async () => {
	await withFixture(async (fixture) => {
		const owner = open(fixture),
			pending = owner.inspect();
		expect(owner.inspect()).toBe(pending);
		const refused = expect(pending).rejects.toThrow(unavailable);
		const closing = owner.close();
		expect(owner.close()).toBe(closing);
		await refused;
		await closing;
		await expect(owner.inspect()).rejects.toThrow(unavailable);
	});
});
test("retains an owner for cleanup after genuine missing-root refusal", async () => {
	await withFixture(async (fixture) => {
		const owner = open(fixture, fixture.expected, fixture.trust, local(fixture, "absent-root"));
		await expect(owner.inspect()).rejects.toThrow(unavailable);
		await owner.close();
	});
});
test.each(["whitespace", "unpadded", "foreign canonical key"])(
	"refuses %s in the fixed public key",
	async (kind) => {
		await withFixture(async (fixture) => {
			let publicKeyDer = fixture.trust.publicKeyDer;
			if (kind === "whitespace") publicKeyDer = ` ${publicKeyDer}`;
			else if (kind === "unpadded") publicKeyDer = publicKeyDer.replace(/=+$/, "");
			else
				publicKeyDer = generateKeyPairSync("ed25519")
					.publicKey.export({ type: "spki", format: "der" })
					.toString("base64");
			await refuses(fixture, fixture.expected, { ...fixture.trust, publicKeyDer });
		});
	},
);
test.each(["version", "executable", "entry", "module"])(
	"requires the exact fixed %s binding",
	async (field) => {
		await withFixture(async (fixture) => {
			const trust = { ...fixture.trust };
			if (field === "version") trust.version = "2.0.0";
			else if (field === "executable") trust.executable = "other-node.exe";
			else if (field === "entry") trust.entry = "hub/other-entry.mjs";
			else trust.module = "hub/missing-module.mjs";
			await refuses(fixture, fixture.expected, trust);
		});
	},
);
test("refuses a modified signature over otherwise valid canonical content", async () => {
	await withFixture(async (fixture) => {
		const signature = await readFile(local(fixture, "release.signature"));
		signature[0] = (signature[0] ?? 0) ^ 1;
		await writeFile(local(fixture, "release.signature"), signature);
		await refuses(fixture);
	});
});
test("refuses validly signed noncanonical release bytes", async () => {
	await withFixture(async (fixture) => {
		await writeSigned(fixture, Buffer.from(`${canonicalize(fixture.release)}\n`));
		await refuses(fixture);
	});
});
test("refuses a descriptor target inconsistent with its authenticated release", async () => {
	await withFixture(async (fixture) => {
		fixture.bundle.target.platform = "linux";
		await publish(fixture);
		await refuses(fixture);
	});
});
test.each(["name", "version", "integrity"])(
	"compares the descriptor against expected native %s DATA",
	async (field) => {
		await withFixture(async (fixture) => {
			const expected = { ...fixture.expected };
			if (field === "name") expected.name = "other-native-package";
			else if (field === "version") expected.version = "13.0.4";
			else
				expected.integrity = `sha512-${createHash("sha512").update("other reviewed identity").digest("base64")}`;
			await refuses(fixture, expected);
		});
	},
);
test("refuses an extra binding even when both members are signed and present", async () => {
	await withFixture(async (fixture) => {
		fixture.bundle.native.bindings["linux-x64"] = "native/prebuilds/linux-x64.node";
		fixture.values.set(
			"native/prebuilds/linux-x64.node",
			Buffer.from("second synthetic binding\n"),
		);
		await publish(fixture);
		await refuses(fixture);
	});
});
test("checks the descriptor's signed hash against the real file bytes", async () => {
	await withFixture(async (fixture) => {
		fixture.release.files = fixture.release.files.map((file) =>
			file.path === "bundle.json" ? { ...file, sha256: "cd".repeat(32) } : file,
		);
		await writeSigned(fixture);
		await refuses(fixture);
	});
});
test.each(["hash", "size"])("refuses real binding %s tampering after signing", async (kind) => {
	await withFixture(async (fixture) => {
		const bytes = await readFile(local(fixture, bindingPath));
		if (kind === "hash") bytes[0] = (bytes[0] ?? 0) ^ 1;
		await writeFile(
			local(fixture, bindingPath),
			kind === "hash" ? bytes : Buffer.concat([bytes, Buffer.from("x")]),
		);
		await refuses(fixture);
	});
});
test.each(["bundle.json", bindingPath])("requires the signed %s member", async (name) => {
	await withFixture(async (fixture) => {
		fixture.release.files = fixture.release.files.filter((file) => file.path !== name);
		await unlink(local(fixture, name));
		await writeSigned(fixture);
		await refuses(fixture);
	});
});
test.each([
	["empty descriptor", "bundle.json", 0],
	["oversize descriptor", "bundle.json", 1024 * 1024 + 1],
	["empty binding", bindingPath, 0],
	["oversize binding", bindingPath, 256 * 1024 * 1024 + 1],
] as const)("refuses a genuinely signed %s row", async (_name, path, bytes) => {
	await withFixture(async (fixture) => {
		fixture.release.files = fixture.release.files.map((file) =>
			file.path === path ? { ...file, bytes } : file,
		);
		await writeSigned(fixture);
		// The physical member remains tiny. This proves generic denial, not the
		// ordering of private verification/content calls without an observer.
		await refuses(fixture);
	});
});
test.each([63, 65])("refuses a %s-byte signature", async (size) => {
	await withFixture(async (fixture) => {
		await writeFile(local(fixture, "release.signature"), Buffer.alloc(size));
		await refuses(fixture);
	});
});
test("refuses release metadata beyond the one MiB intake bound", async () => {
	await withFixture(async (fixture) => {
		await writeSigned(fixture, Buffer.alloc(1024 * 1024 + 1, 0x20));
		await refuses(fixture);
	});
});

test("keeps DATA pending until the retained genuine manifest handle physically closes", async () => {
	await withFixture(async (fixture) => {
		const probe = await armPhysicalClose(fixture, "hold"),
			owner = open(fixture);
		const observed = observeInspection(owner);
		try {
			await requireCloseEntry(probe, observed.outcome);
			await nextTurn();
			expect(probe.calls).toBe(1);
			expect(probe.opens).toBe(1);
			expect(probe.exits).toBe(0);
			expect(probe.delegates).toBe(0);
			expect(observed.settled).toBe(false);
			expect(observed.successful).toBe(false);
			expect(probe.handle().fd).toBeGreaterThanOrEqual(0);
			expect((await probe.stat()).isFile()).toBe(true);
			probe.release();
			await Promise.race([
				probe.physicalClosed,
				observed.outcome.then((result) => {
					if (!result.ok) throw result.error;
					if (probe.exits !== 1) throw new Error("DATA resolved before physical close exited.");
				}),
			]);
			const result = await observed.outcome;
			if (!result.ok) throw result.error;
			expect(probe.delegates).toBe(1);
			expect(probe.exits).toBe(1);
			expect(probe.handle().fd).toBe(-1);
			const binding = fixture.values.get(bindingPath);
			if (!binding) throw new Error("Binding fixture missing.");
			expect(result.data).toEqual({
				version: "1.2.3",
				platform: "win32",
				arch: "x64",
				target: "win32-x64",
				path: bindingPath,
				bytes: binding.length,
				sha256: hash(binding),
			});
		} finally {
			probe.release();
			await observed.outcome;
			await owner.close();
		}
	});
});
test("rejects DATA on pre-close refusal and retries cleanup on the same genuine handle", async () => {
	await withFixture(async (fixture) => {
		const probe = await armPhysicalClose(fixture, "refuse-once"),
			owner = open(fixture);
		const observed = observeInspection(owner);
		try {
			await requireCloseEntry(probe, observed.outcome);
			const result = await observed.outcome;
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error("DATA escaped a refused physical close.");
			expect(result.error).toHaveProperty("message", unavailable);
			expect(observed.successful).toBe(false);
			const retainedHandle = probe.handle();
			expect(probe.opens).toBe(1);
			expect(probe.calls).toBe(1);
			expect(probe.delegates).toBe(0);
			expect(probe.exits).toBe(0);
			expect(retainedHandle.fd).toBeGreaterThanOrEqual(0);
			expect((await probe.stat()).isFile()).toBe(true);
			fixedTrust.value = undefined;
			await owner.close();
			expect(probe.handle()).toBe(retainedHandle);
			expect(probe.opens).toBe(1);
			expect(probe.calls).toBe(2);
			expect(probe.delegates).toBe(1);
			expect(probe.exits).toBe(1);
			expect(retainedHandle.fd).toBe(-1);
			await expect(probe.stat()).rejects.toThrow();
			await expect(owner.inspect()).rejects.toThrow(unavailable);
			expect(observed.successful).toBe(false);
		} finally {
			probe.release();
			await observed.outcome;
			await owner.close();
		}
	});
});
