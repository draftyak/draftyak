import { randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import { type KeyPurpose, MasterKey } from "../../src/kernel/master-key.ts";

const refused = (input: unknown): void => {
	let key: MasterKey | undefined;
	try {
		expect(() => {
			key = new MasterKey(input as Uint8Array);
		}).toThrow("Master key must contain 32 bytes");
	} finally {
		key?.destroy();
	}
};

it.each([0, 1, 16, 31, 33, 64])("refuses a native byte view of length %i", (length) => {
	const input = new Uint8Array(length).fill(0x59);
	try {
		refused(input);
	} finally {
		input.fill(0);
	}
});

it("refuses other runtime types before inspecting their byteLength", () => {
	const buffer = new ArrayBuffer(32),
		shared = new SharedArrayBuffer(32);
	for (const input of [
		buffer,
		shared,
		new DataView(buffer),
		new Uint16Array(16),
		new Int8Array(32),
		{ byteLength: 32, length: 32 },
		null,
		undefined,
	])
		refused(input);
	let calls = 0;
	refused({
		get byteLength() {
			calls++;
			return 32;
		},
	});
	refused(
		new Proxy(new Uint8Array(32), {
			get() {
				calls++;
				return 32;
			},
		}),
	);
	expect(calls).toBe(0);
});

it("uses native view length and refuses detached or spoofed short byte views", () => {
	const short = new Uint8Array(31);
	let calls = 0;
	Object.defineProperty(short, "byteLength", {
		get() {
			calls++;
			return 32;
		},
	});
	refused(short);
	expect(calls).toBe(0);
	const buffer = new ArrayBuffer(32),
		detached = new Uint8Array(buffer);
	structuredClone(buffer, { transfer: [buffer] });
	refused(detached);
});

it("copies exactly an offset view and preserves valid Buffer, shared and cross-realm byte views", () => {
	const backing = Buffer.alloc(64, 0x71),
		view = new Uint8Array(backing.buffer, backing.byteOffset + 8, 32);
	for (let i = 0; i < view.length; i++) view[i] = i + 1;
	const expected = new MasterKey(Buffer.from(view)),
		expectedDb = expected.derive("db"),
		shared = new Uint8Array(new SharedArrayBuffer(32));
	shared.set(view);
	const foreign = runInNewContext("Uint8Array.from({ length: 32 }, (_, i) => i + 1)") as Uint8Array;
	const inputs = [view, Buffer.from(view), shared, foreign];
	try {
		for (const input of inputs) {
			const key = new MasterKey(input);
			let actual: Buffer | undefined;
			try {
				input.fill(0);
				backing.fill(0);
				actual = key.derive("db");
				expect(actual).toEqual(expectedDb);
			} finally {
				actual?.fill(0);
				key.destroy();
			}
		}
	} finally {
		for (const input of inputs) input.fill(0);
		backing.fill(0);
		expectedDb.fill(0);
		expected.destroy();
	}
});

it("separates every subkey, copies intake and locks after destruction", () => {
	const input = randomBytes(32);
	const secret = input.toString("hex");
	const key = new MasterKey(input);
	input.fill(0);
	const db = key.derive("db");
	const audit = key.derive("audit");
	const ext = key.derive("ext/acme");
	expect(db).not.toEqual(audit);
	expect(ext).not.toEqual(db);
	expect(key.derive("db")).toEqual(db);
	expect(inspect(key)).not.toContain(secret);
	expect(JSON.stringify(key)).toBe('"[REDACTED]"');
	expect(() => key.derive("ext/../db")).toThrow("purpose");
	key.destroy();
	expect(() => key.derive("db")).toThrow("locked");
	db.fill(0);
	audit.fill(0);
	ext.fill(0);
});

it("pins the drafts subkey and keeps it apart from handles and every other purpose", () => {
	const key = new MasterKey(new Uint8Array(32).fill(0x0b)),
		others: KeyPurpose[] = [
			"db",
			"secrets",
			"audit",
			"oauth",
			"backup",
			"handles",
			"mcp-state",
			"tool-tokens",
		],
		drafts = key.derive("drafts"),
		derived = others.map((purpose) => key.derive(purpose));
	try {
		expect(drafts.toString("hex")).toBe(
			"25857e00d26aaa369d511272bb299d65f18b0e74ed397347645aaeac4e489f5e",
		);
		for (const other of derived) expect(other).not.toEqual(drafts);
	} finally {
		drafts.fill(0);
		for (const other of derived) other.fill(0);
		key.destroy();
	}
});
