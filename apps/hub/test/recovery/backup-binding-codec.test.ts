import { createHash, createHmac, randomBytes } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { BackupCapsuleError, captureRecoveryCapsule } from "../../src/recovery/backup-capsule.ts";
import { RECOVERY_FILE, writeRecoveryFile } from "../../src/recovery/recovery-code.ts";

// Observe buffers returned by the real key method, including a captured native method reference.
const originalDerive = MasterKey.prototype.derive;
const derived: Buffer[] = [];
const deriveSpy = vi.spyOn(MasterKey.prototype, "derive").mockImplementation(function (
	this: MasterKey,
	purpose: Parameters<MasterKey["derive"]>[0],
) {
	const value = originalDerive.call(this, purpose);
	derived.push(value);
	return value;
});
const { createRecoveryBinding, verifyRecoveryBinding, RecoveryBindingError } = await import(
	"../../src/recovery/backup-bindings.ts"
);

const temporaryRoot = realpathSync.native(os.tmpdir());
const roots: { folder: string; dev: number; ino: number }[] = [];
const keys: MasterKey[] = [];
const material: Buffer[] = [];
const domain = "draftyak/recovery-capsule-binding/v1";

afterAll(() => deriveSpy.mockRestore());
afterEach(() => {
	for (const key of keys.splice(0)) key.destroy();
	for (const value of [...derived.splice(0), ...material.splice(0)]) value.fill(0);
	for (const root of roots.splice(0)) {
		const current = lstatSync(root.folder);
		expect(path.dirname(root.folder) === temporaryRoot).toBe(true);
		expect(path.basename(root.folder).startsWith("draftyak-backup-codec-")).toBe(true);
		expect(current.dev === root.dev && current.ino === root.ino && !current.isSymbolicLink()).toBe(
			true,
		);
		rmSync(root.folder, { recursive: true, force: true });
	}
});

function keep(value: Buffer): Buffer {
	material.push(value);
	return value;
}
function key(seed = randomBytes(32)): MasterKey {
	try {
		const value = new MasterKey(seed);
		keys.push(value);
		return value;
	} finally {
		seed.fill(0);
	}
}
function capsule(): Buffer {
	const folder = realpathSync.native(
		mkdtempSync(path.join(temporaryRoot, "draftyak-backup-codec-")),
	);
	const { dev, ino } = lstatSync(folder);
	roots.push({ folder, dev, ino });
	const master = randomBytes(32),
		code = randomBytes(20);
	try {
		writeRecoveryFile(folder, master, code);
		return keep(readFileSync(path.join(folder, RECOVERY_FILE)));
	} finally {
		master.fill(0);
		code.fill(0);
	}
}
function refused(action: () => unknown, kind: "capsule" | "binding"): void {
	let caught = false;
	try {
		action();
	} catch (error) {
		caught = true;
		const Expected = kind === "capsule" ? BackupCapsuleError : RecoveryBindingError;
		expect(error instanceof Expected).toBe(true);
		if (!(error instanceof Expected)) return;
		expect(error.code === (kind === "capsule" ? "format" : "binding")).toBe(true);
		expect(
			error.message ===
				(kind === "capsule" ? "Recovery capsule refused" : "Recovery binding refused"),
		).toBe(true);
		expect(Object.hasOwn(error, "cause")).toBe(false);
	}
	expect(caught).toBe(true);
}
function signed(
	master: MasterKey,
	bytes: Uint8Array,
	options: {
		magic?: string;
		version?: number;
		digest?: Buffer;
		domain?: string;
		purpose?: "backup" | "audit";
	} = {},
): Buffer {
	const header = Buffer.concat([
		Buffer.from(options.magic ?? "DYRB", "ascii"),
		Buffer.of(options.version ?? 1),
		options.digest ?? createHash("sha256").update(bytes).digest(),
	]);
	const subkey = originalDerive.call(master, options.purpose ?? "backup");
	try {
		return keep(
			Buffer.concat([
				header,
				createHmac("sha256", subkey)
					.update(options.domain ?? domain, "ascii")
					.update(header)
					.digest(),
			]),
		);
	} finally {
		subkey.fill(0);
		header.fill(0);
	}
}
function erased(action: () => void): void {
	const before = derived.length;
	action();
	const issued = derived.slice(before);
	expect(issued.length > 0).toBe(true);
	expect(issued.every((value) => value.every((byte) => byte === 0))).toBe(true);
}

it("captures an owned exact copy of a capsule produced by the actual legacy writer", () => {
	const bytes = capsule();
	expect(bytes.length).toBe(94);
	expect(bytes.subarray(0, 17).equals(Buffer.from("draftyak-recovery"))).toBe(true);
	expect(bytes[17]).toBe(1);
	const captured = keep(captureRecoveryCapsule(bytes)),
		snapshot = keep(Buffer.from(bytes));
	expect(captured.equals(snapshot)).toBe(true);
	bytes.fill(0);
	expect(captured.equals(snapshot)).toBe(true);
	captured.fill(1);
	expect(snapshot.equals(captured)).toBe(false);
});
it("copies only an offset Uint8Array view and treats encrypted payload bytes as opaque DATA", () => {
	const bytes = capsule(),
		padded = new Uint8Array(100);
	padded.set(bytes, 3);
	const view = padded.subarray(3, 97),
		captured = keep(captureRecoveryCapsule(view));
	expect(captured.length).toBe(94);
	expect(captured.equals(bytes)).toBe(true);
	view.fill(0, 18);
	expect(
		keep(captureRecoveryCapsule(view))
			.subarray(18)
			.every((byte) => byte === 0),
	).toBe(true);
	expect(captured.equals(bytes)).toBe(true);
});
it.each([0, 93, 95, 188])("refuses a capsule with %i bytes", (length) => {
	const bytes = capsule(),
		changed = keep(Buffer.alloc(length));
	bytes.copy(changed, 0, 0, Math.min(length, bytes.length));
	refused(() => captureRecoveryCapsule(changed), "capsule");
});
it("refuses every altered magic or version byte without dumping the input", () => {
	const bytes = capsule();
	for (let offset = 0; offset < 18; offset++) {
		const changed = keep(Buffer.from(bytes));
		changed[offset] = (changed[offset] ?? 0) ^ 1;
		refused(() => captureRecoveryCapsule(changed), "capsule");
	}
});
it.each([
	["null", null],
	["undefined", undefined],
	["array", []],
	["record", {}],
	["text", "capsule"],
	["DataView", new DataView(new ArrayBuffer(94))],
	["wide array", new Uint16Array(47)],
	["ArrayBuffer", new ArrayBuffer(94)],
])("refuses the non-byte capsule input %s", (_label, value) => {
	refused(() => captureRecoveryCapsule(value), "capsule");
});
it("refuses shared, detached and proxied capsule input before caller traps", () => {
	const bytes = capsule(),
		shared = new Uint8Array(new SharedArrayBuffer(94));
	shared.set(bytes);
	refused(() => captureRecoveryCapsule(shared), "capsule");
	const detached = new Uint8Array(bytes);
	structuredClone(detached.buffer, { transfer: [detached.buffer] });
	expect(detached.byteLength).toBe(0);
	refused(() => captureRecoveryCapsule(detached), "capsule");
	let traps = 0;
	const trap = () => {
		traps++;
		throw new Error("Unexpected caller trap");
	};
	refused(
		() => captureRecoveryCapsule(new Proxy(bytes, { get: trap, getPrototypeOf: trap })),
		"capsule",
	);
	expect(traps).toBe(0);
});
it("captures genuine byte-array views without invoking shadowed properties or iterators", () => {
	const bytes = capsule(),
		view = new Uint8Array(bytes);
	let traps = 0;
	const trap = () => {
		traps++;
		throw new Error("Unexpected caller trap");
	};
	Object.defineProperties(view, {
		buffer: { get: trap },
		byteLength: { get: trap },
		subarray: { value: trap },
		[Symbol.iterator]: { value: trap },
	});
	expect(keep(captureRecoveryCapsule(view)).equals(bytes)).toBe(true);
	expect(traps).toBe(0);
});

it("matches the independent fixed binary binding layout, hash, purpose and HMAC domain", () => {
	const master = key(),
		bytes = capsule(),
		binding = keep(createRecoveryBinding(master, bytes));
	expect(binding.length).toBe(69);
	expect(binding.subarray(0, 4).equals(Buffer.from("DYRB"))).toBe(true);
	expect(binding[4]).toBe(1);
	expect(binding.subarray(5, 37).equals(createHash("sha256").update(bytes).digest())).toBe(true);
	expect(binding.equals(signed(master, bytes))).toBe(true);
	expect(verifyRecoveryBinding(master, bytes, signed(master, bytes))).toBe(true);
});
it("authenticates capsule DATA without claiming it wraps the binding master key", () => {
	const master = key(),
		unrelatedCapsule = capsule();
	const binding = keep(createRecoveryBinding(master, unrelatedCapsule));
	expect(verifyRecoveryBinding(master, unrelatedCapsule, binding)).toBe(true);
	expect(verifyRecoveryBinding(key(), unrelatedCapsule, binding)).toBe(false);
});
it("owns binding bytes and preserves both caller buffers during valid and failed verification", () => {
	const master = key(),
		bytes = capsule(),
		before = keep(Buffer.from(bytes));
	const binding = keep(createRecoveryBinding(master, bytes)),
		record = keep(Buffer.from(binding));
	expect(verifyRecoveryBinding(master, bytes, binding)).toBe(true);
	expect(bytes.equals(before) && binding.equals(record)).toBe(true);
	binding[68] = (binding[68] ?? 0) ^ 1;
	const changed = keep(Buffer.from(binding));
	expect(verifyRecoveryBinding(master, bytes, binding)).toBe(false);
	expect(bytes.equals(before) && binding.equals(changed)).toBe(true);
	bytes.fill(0);
	expect(record.equals(keep(createRecoveryBinding(master, before)))).toBe(true);
});
it("accepts exact offset byte views for both capsule and binding", () => {
	const master = key(),
		bytes = capsule(),
		binding = keep(createRecoveryBinding(master, bytes));
	const a = new Uint8Array(100),
		b = new Uint8Array(75);
	a.set(bytes, 3);
	b.set(binding, 2);
	expect(verifyRecoveryBinding(master, a.subarray(3, 97), b.subarray(2, 71))).toBe(true);
});
it("refuses a change to every serialized binding byte and every encrypted capsule byte", () => {
	const master = key(),
		bytes = capsule(),
		binding = keep(createRecoveryBinding(master, bytes));
	for (let offset = 0; offset < 69; offset++) {
		const changed = keep(Buffer.from(binding));
		changed[offset] = (changed[offset] ?? 0) ^ 1;
		expect(verifyRecoveryBinding(master, bytes, changed)).toBe(false);
	}
	for (let offset = 18; offset < 94; offset++) {
		const changed = keep(Buffer.from(bytes));
		changed[offset] = (changed[offset] ?? 0) ^ 1;
		expect(verifyRecoveryBinding(master, changed, binding)).toBe(false);
	}
});
it("refuses correctly re-MACed wrong magic, version and capsule digest", () => {
	const master = key(),
		bytes = capsule();
	const changes: NonNullable<Parameters<typeof signed>[2]>[] = [
		{ magic: "DYRX" },
		{ version: 2 },
		{ digest: createHash("sha256").update("different capsule DATA").digest() },
	];
	for (const options of changes)
		expect(verifyRecoveryBinding(master, bytes, signed(master, bytes, options))).toBe(false);
});
it("refuses a valid HMAC from another domain or actual master-key purpose", () => {
	const master = key(),
		bytes = capsule();
	expect(
		verifyRecoveryBinding(master, bytes, signed(master, bytes, { domain: `${domain}/other` })),
	).toBe(false);
	expect(verifyRecoveryBinding(master, bytes, signed(master, bytes, { purpose: "audit" }))).toBe(
		false,
	);
});
it.each([0, 68, 70, 138])("refuses a binding with %i bytes", (length) => {
	const master = key(),
		bytes = capsule(),
		binding = keep(createRecoveryBinding(master, bytes));
	const changed = keep(Buffer.alloc(length));
	binding.copy(changed, 0, 0, Math.min(length, binding.length));
	expect(verifyRecoveryBinding(master, bytes, changed)).toBe(false);
});
it("refuses invalid, shared, detached and proxied binding data with no input mutation", () => {
	const master = key(),
		bytes = capsule(),
		binding = keep(createRecoveryBinding(master, bytes));
	const shared = new Uint8Array(new SharedArrayBuffer(69));
	shared.set(binding);
	const detached = new Uint8Array(binding);
	structuredClone(detached.buffer, { transfer: [detached.buffer] });
	for (const input of [
		null,
		[],
		{},
		"binding",
		new DataView(new ArrayBuffer(69)),
		new Uint16Array(35),
		shared,
		detached,
	])
		expect(verifyRecoveryBinding(master, bytes, input)).toBe(false);
	let traps = 0;
	const proxy = new Proxy(binding, {
		get() {
			traps++;
			throw new Error("Unexpected caller trap");
		},
	});
	expect(verifyRecoveryBinding(master, bytes, proxy)).toBe(false);
	expect(traps).toBe(0);
});
it("turns invalid capsule creation into a fixed refusal and verification into false", () => {
	const master = key(),
		bytes = capsule(),
		binding = keep(createRecoveryBinding(master, bytes));
	const changed = keep(Buffer.from(bytes));
	changed[17] = 2;
	for (const input of [
		null,
		[],
		Buffer.alloc(93),
		changed,
		new Uint8Array(new SharedArrayBuffer(94)),
	]) {
		refused(() => createRecoveryBinding(master, input), "binding");
		expect(verifyRecoveryBinding(master, input, binding)).toBe(false);
	}
});
it("refuses destroyed, forged and proxy keys without disclosing a cause or running traps", () => {
	const master = key(),
		bytes = capsule(),
		binding = keep(createRecoveryBinding(master, bytes));
	master.destroy();
	for (const invalid of [master, Object.create(MasterKey.prototype), {}, null]) {
		refused(() => createRecoveryBinding(invalid as MasterKey, bytes), "binding");
		expect(verifyRecoveryBinding(invalid as MasterKey, bytes, binding)).toBe(false);
	}
	let traps = 0;
	const proxy = new Proxy(key(), {
		get() {
			traps++;
			throw new Error("Unexpected caller trap");
		},
	});
	refused(() => createRecoveryBinding(proxy, bytes), "binding");
	expect(verifyRecoveryBinding(proxy, bytes, binding)).toBe(false);
	expect(traps).toBe(0);
});
it("erases every observed real derived subkey on creation and successful or failed MAC verification", () => {
	const master = key(),
		bytes = capsule();
	let binding: Buffer | undefined;
	erased(() => {
		binding = keep(createRecoveryBinding(master, bytes));
	});
	if (!binding) throw new Error("Binding was not created");
	const record = binding;
	erased(() => {
		expect(verifyRecoveryBinding(master, bytes, record)).toBe(true);
	});
	record[68] = (record[68] ?? 0) ^ 1;
	erased(() => {
		expect(verifyRecoveryBinding(master, bytes, record)).toBe(false);
	});
});
