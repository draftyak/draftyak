import { createHash, randomBytes } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	BACKUP_ARTIFACT_HEADER_SIZE,
	BackupArtifactError,
	decodeBackupArtifactHeader,
	encodeBackupArtifactHeader,
} from "../../src/recovery/backup-artifact.ts";
import {
	createRecoveryBinding,
	verifyRecoveryBinding,
} from "../../src/recovery/backup-bindings.ts";
import { sealRecoveryCapsule } from "../../src/recovery/backup-capsule.ts";

const keys: MasterKey[] = [];
const buffers: Buffer[] = [];
type Field = "capsule" | "binding" | "header";

afterEach(() => {
	for (const key of keys.splice(0)) key.destroy();
	for (const buffer of buffers.splice(0)) buffer.fill(0);
});

function keep(buffer: Buffer): Buffer {
	buffers.push(buffer);
	return buffer;
}

function data() {
	const seed = keep(randomBytes(32));
	const code = keep(randomBytes(20));
	const master = new MasterKey(seed);
	keys.push(master);
	const capsule = keep(sealRecoveryCapsule(seed, code));
	const binding = keep(createRecoveryBinding(master, capsule));
	const sha256 = createHash("sha256")
		.update(keep(randomBytes(257)))
		.digest("hex");
	return { master, capsule, binding, sha256 };
}
type Data = ReturnType<typeof data>;

function wire(value: Data, length = 1n): Buffer {
	const header = keep(Buffer.alloc(208));
	header.set([0x44, 0x59, 0x42, 0x41, 1], 0);
	header.writeBigUInt64BE(length, 5);
	header.set(Buffer.from(value.sha256, "hex"), 13);
	header.set(value.capsule, 45);
	header.set(value.binding, 139);
	return header;
}

function decode(value: unknown) {
	const result = decodeBackupArtifactHeader(value);
	keep(result.capsule);
	keep(result.binding);
	return result;
}

function input(field: Field, value: unknown, original: Data) {
	if (field === "header") return decode(value);
	return decode(
		keep(
			encodeBackupArtifactHeader(
				field === "capsule" ? value : original.capsule,
				field === "binding" ? value : original.binding,
				1,
				original.sha256,
			),
		),
	);
}

function refused(action: () => unknown): void {
	let error: unknown;
	try {
		action();
	} catch (caught) {
		error = caught;
	}
	expect(error).toBeInstanceOf(BackupArtifactError);
	expect(error).toMatchObject({
		name: "BackupArtifactError",
		code: "BACKUP_ARTIFACT_UNAVAILABLE",
		message: "Backup artifact unavailable",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}

it("encodes the fixed wire offsets and unsigned big-endian length independently", () => {
	const value = data();
	const length = 0x01_02_03_04_05_06_07;
	const header = keep(
		encodeBackupArtifactHeader(value.capsule, value.binding, length, value.sha256),
	);
	expect(BACKUP_ARTIFACT_HEADER_SIZE).toBe(208);
	expect(header.length).toBe(208);
	expect(header.subarray(0, 5).equals(Buffer.from([0x44, 0x59, 0x42, 0x41, 1]))).toBe(true);
	expect(header.subarray(5, 13).toString("hex")).toBe("0001020304050607");
	expect(header.subarray(13, 45).toString("hex")).toBe(value.sha256);
	expect(header.subarray(45, 139).equals(value.capsule)).toBe(true);
	expect(header.subarray(139, 208).equals(value.binding)).toBe(true);
	expect(header.equals(wire(value, BigInt(length)))).toBe(true);
});

it.each([1, 255, 256, 65_535, 65_536, 2 ** 32 - 1, 2 ** 32, 2 ** 48 + 17, Number.MAX_SAFE_INTEGER])(
	"preserves the independently encoded positive safe-integer boundary %s",
	(length) => {
		const value = data();
		const parsed = decode(wire(value, BigInt(length)));
		expect(parsed.byteLength).toBe(length);
		expect(parsed.sha256).toBe(value.sha256);
		const encoded = keep(
			encodeBackupArtifactHeader(value.capsule, value.binding, length, value.sha256),
		);
		expect(encoded.readBigUInt64BE(5)).toBe(BigInt(length));
	},
);

it("decodes a frozen DATA record and owns every returned buffer", () => {
	const value = data();
	const header = wire(value, 65_537n);
	const before = keep(Buffer.from(header));
	const parsed = decode(header);
	expect(Object.keys(parsed).sort()).toEqual(["binding", "byteLength", "capsule", "sha256"]);
	expect(Object.isFrozen(parsed)).toBe(true);
	expect(Reflect.set(parsed, "byteLength", 7)).toBe(false);
	expect(parsed.byteLength).toBe(65_537);
	expect(parsed.capsule.equals(value.capsule)).toBe(true);
	expect(parsed.binding.equals(value.binding)).toBe(true);
	header.fill(0);
	expect(parsed.capsule.equals(value.capsule)).toBe(true);
	expect(parsed.binding.equals(value.binding)).toBe(true);
	parsed.capsule.fill(1);
	parsed.binding.fill(2);
	expect(before.subarray(45, 139).equals(value.capsule)).toBe(true);
	expect(before.subarray(139).equals(value.binding)).toBe(true);
});

it("captures encoder inputs without aliasing them or later decode results", () => {
	const value = data();
	const capsule = keep(Buffer.from(value.capsule));
	const binding = keep(Buffer.from(value.binding));
	const header = keep(encodeBackupArtifactHeader(capsule, binding, 9, value.sha256));
	capsule.fill(0);
	binding.fill(0);
	const first = decode(header);
	const second = decode(header);
	first.capsule.fill(1);
	first.binding.fill(2);
	expect(second.capsule.equals(value.capsule)).toBe(true);
	expect(second.binding.equals(value.binding)).toBe(true);
	expect(header.equals(wire(value, 9n))).toBe(true);
});

it.each([0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n, 1n << 63n, (1n << 64n) - 1n])(
	"refuses serialized lengths outside the positive safe-integer contract: %s",
	(length) => refused(() => decode(wire(data(), length))),
);

it.each([
	["zero", 0],
	["negative", -1],
	["fraction", 1.5],
	["NaN", Number.NaN],
	["infinite", Number.POSITIVE_INFINITY],
	["negative infinite", Number.NEGATIVE_INFINITY],
	["unsafe", Number.MAX_SAFE_INTEGER + 1],
	["bigint", 1n],
	["text", "1"],
	["boxed", Object(1)],
	["boolean", true],
	["null", null],
	["undefined", undefined],
])("refuses a noncanonical encoder length: %s", (_label, length) => {
	const value = data();
	refused(() => encodeBackupArtifactHeader(value.capsule, value.binding, length, value.sha256));
});

it.each([
	["uppercase", "AB".repeat(32)],
	["short", "a".repeat(63)],
	["long", "a".repeat(65)],
	["nonhex", "g".repeat(64)],
	["whitespace", ` ${"a".repeat(63)}`],
	["newline", `${"a".repeat(64)}\n`],
	["boxed", Object("a".repeat(64))],
	["buffer", Buffer.alloc(64)],
	["null", null],
])("refuses a noncanonical encoder SHA-256: %s", (_label, sha256) => {
	const value = data();
	refused(() => encodeBackupArtifactHeader(value.capsule, value.binding, 1, sha256));
});

it("refuses scalar coercion objects without reading their properties", () => {
	const value = data();
	let traps = 0;
	const trap = () => {
		traps++;
		throw new Error("DYTEST unexpected scalar coercion");
	};
	const scalar = new Proxy(Object.create(null), { get: trap, getPrototypeOf: trap });
	refused(() => encodeBackupArtifactHeader(value.capsule, value.binding, scalar, value.sha256));
	refused(() => encodeBackupArtifactHeader(value.capsule, value.binding, 1, scalar));
	expect(traps).toBe(0);
});

it.each([0, 207, 209, 416])("refuses a header whose exact length is %i", (length) => {
	const valid = wire(data());
	const changed = keep(Buffer.alloc(length));
	valid.copy(changed);
	refused(() => decode(changed));
});

it("refuses altered outer, capsule and binding magic or version bytes", () => {
	const value = data();
	const header = wire(value);
	for (const [start, end] of [
		[0, 5],
		[45, 63],
		[139, 144],
	] as const) {
		for (let offset = start; offset < end; offset++) {
			const changed = keep(Buffer.from(header));
			changed[offset] = (changed[offset] ?? 0) ^ 0x80;
			refused(() => decode(changed));
			if (offset >= 45 && offset < 63) {
				refused(() =>
					encodeBackupArtifactHeader(changed.subarray(45, 139), value.binding, 1, value.sha256),
				);
			}
			if (offset >= 139) {
				refused(() =>
					encodeBackupArtifactHeader(value.capsule, changed.subarray(139), 1, value.sha256),
				);
			}
		}
	}
	expect(header.equals(wire(value))).toBe(true);
});

it("does not treat framing or checksums as cryptographic image or capsule authority", () => {
	const value = data();
	const header = wire(value);
	header[13] = (header[13] ?? 0) ^ 1;
	header[138] = (header[138] ?? 0) ^ 1;
	header[207] = (header[207] ?? 0) ^ 1;
	const parsed = decode(header);
	expect(parsed.sha256).toBe(header.subarray(13, 45).toString("hex"));
	expect(parsed.capsule.equals(header.subarray(45, 139))).toBe(true);
	expect(parsed.binding.equals(header.subarray(139))).toBe(true);
	expect(verifyRecoveryBinding(value.master, parsed.capsule, parsed.binding)).toBe(false);
	expect(
		keep(encodeBackupArtifactHeader(parsed.capsule, parsed.binding, 1, parsed.sha256)).equals(
			header,
		),
	).toBe(true);
});

it.each(["capsule", "binding", "header"] as const)(
	"captures only the offset %s view, ignoring caller properties and iterators",
	(field) => {
		const value = data();
		const expected = field === "header" ? wire(value) : value[field];
		const padded = keep(Buffer.alloc(expected.length + 11, 0xa5));
		padded.set(expected, 7);
		const view = new Uint8Array(padded.buffer, padded.byteOffset + 7, expected.length);
		let traps = 0;
		const trap = () => {
			traps++;
			throw new Error("DYTEST unexpected byte-view property access");
		};
		Object.defineProperties(view, {
			buffer: { get: trap },
			byteOffset: { get: trap },
			byteLength: { get: trap },
			length: { get: trap },
			subarray: { value: trap },
			[Symbol.iterator]: { value: trap },
		});
		const parsed = input(field, view, value);
		expect(parsed.capsule.equals(value.capsule)).toBe(true);
		expect(parsed.binding.equals(value.binding)).toBe(true);
		expect(traps).toBe(0);
		expect(padded[6]).toBe(0xa5);
		expect(padded[7 + expected.length]).toBe(0xa5);
	},
);

it.each(["capsule", "binding", "header"] as const)(
	"refuses malformed, shared, detached and proxy %s inputs without caller traps",
	(field) => {
		const value = data();
		const valid = field === "header" ? wire(value) : value[field];
		const shared = new Uint8Array(new SharedArrayBuffer(valid.length));
		shared.set(valid);
		const detached = new Uint8Array(valid);
		structuredClone(detached.buffer, { transfer: [detached.buffer] });
		let traps = 0;
		const trap = () => {
			traps++;
			throw new Error("DYTEST unexpected malformed byte access");
		};
		for (const bytes of [
			null,
			undefined,
			[],
			"header",
			new ArrayBuffer(valid.length),
			new DataView(new ArrayBuffer(valid.length)),
			new Uint16Array(valid.length),
			shared,
			detached,
			valid.subarray(1),
			keep(Buffer.concat([valid, Buffer.of(0)])),
			new Proxy(valid, { get: trap, getPrototypeOf: trap }),
			Object.create(null, { byteLength: { get: trap }, buffer: { get: trap } }),
		]) {
			refused(() => input(field, bytes, value));
		}
		expect(traps).toBe(0);
		expect(verifyRecoveryBinding(value.master, value.capsule, value.binding)).toBe(true);
	},
);
