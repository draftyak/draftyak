import { afterEach, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { PinService } from "../../src/identity/pin.ts";
import { newId } from "../../src/kernel/ids.ts";
import { fixture, removeFixture } from "./helpers.ts";

const observed = vi.hoisted(() => ({
	records: [] as { input: NodeJS.ArrayBufferView; salt: NodeJS.ArrayBufferView; output?: Buffer }[],
	digests: [] as Buffer[],
}));
vi.mock("node:crypto", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:crypto")>();
	const argon2: typeof actual.argon2 = (algorithm, params, callback) => {
		const record = {
			input: params.message as NodeJS.ArrayBufferView,
			salt: params.nonce as NodeJS.ArrayBufferView,
			output: undefined as Buffer | undefined,
		};
		observed.records.push(record);
		actual.argon2(algorithm, params, (error, output) => {
			record.output = output;
			callback(error, output);
		});
	};
	const createHash: typeof actual.createHash = (...args) => {
		const hash = actual.createHash(...args);
		const digest = hash.digest.bind(hash);
		hash.digest = ((encoding?: import("node:crypto").BinaryToTextEncoding) => {
			const result = encoding ? digest(encoding) : digest();
			if (Buffer.isBuffer(result)) observed.digests.push(result);
			return result;
		}) as typeof hash.digest;
		return hash;
	};
	return { ...actual, argon2, createHash };
});
afterEach(() => {
	observed.records.length = 0;
	observed.digests.length = 0;
});
const erased = (view: NodeJS.ArrayBufferView | undefined): boolean => {
	if (!view) throw new Error("Missing observed native buffer");
	return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).every((byte) => byte === 0);
};

it("erases the exact real native KDF buffers and proof digests on consume, refusal, discard and lock", async () => {
	const f = await fixture();
	const key = f.key.derive("audit");
	const audit = new AuditChain(key);
	key.fill(0);
	const pins = new PinService(f.store, audit);
	const user = newId();
	try {
		f.store.write((tx) => tx.run("INSERT INTO main.users VALUES(?,?)", [user, Date.now()]));
		await pins.initialize(user, "738294");
		const initialized = observed.records.at(-1);
		expect(initialized).toBeDefined();
		expect(erased(initialized?.input)).toBe(true);
		expect(erased(initialized?.salt)).toBe(true);
		expect(erased(initialized?.output)).toBe(true);
		for (const action of ["consume", "refuse", "discard", "lock"] as const) {
			const proof = await pins.verify(user, "738294", "approval:memory");
			const record = observed.records.at(-1);
			const material = observed.digests.at(-1);
			expect(erased(record?.input)).toBe(true);
			expect(erased(record?.salt)).toBe(true);
			expect(erased(record?.output)).toBe(true);
			expect(erased(material)).toBe(false);
			if (action === "consume")
				f.store.write((tx) => pins.consume(tx, proof, user, "approval:memory"));
			else if (action === "refuse")
				expect(() =>
					f.store.write((tx) => pins.consume(tx, proof, user, "approval:other")),
				).toThrow("PIN_REQUIRED");
			else if (action === "discard") pins.discard(proof);
			else pins.lock();
			expect(erased(material)).toBe(true);
		}
	} finally {
		pins.lock();
		audit.destroy();
		f.store.close();
		f.key.destroy();
		removeFixture(f.dir);
	}
});

it("erases pending initialization material on discard and lock during genuine native hashing", async () => {
	const f = await fixture();
	const key = f.key.derive("audit");
	const audit = new AuditChain(key);
	key.fill(0);
	const pins = new PinService(f.store, audit);
	try {
		const prepared = await pins.prepareInitialization(newId(), "738294");
		const first = observed.records.at(-1);
		expect(erased(first?.input)).toBe(true);
		expect(erased(first?.salt)).toBe(false);
		expect(erased(first?.output)).toBe(false);
		pins.discard(prepared);
		expect(erased(first?.salt)).toBe(true);
		expect(erased(first?.output)).toBe(true);
		const pending = pins.prepareInitialization(newId(), "738294");
		pins.lock();
		await expect(pending).rejects.toThrow("PIN_REQUIRED");
		const failed = observed.records.at(-1);
		expect(erased(failed?.input)).toBe(true);
		expect(erased(failed?.salt)).toBe(true);
		expect(erased(failed?.output)).toBe(true);
	} finally {
		pins.lock();
		audit.destroy();
		f.store.close();
		f.key.destroy();
		removeFixture(f.dir);
	}
});
