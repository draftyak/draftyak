import { afterEach, describe, expect, it, vi } from "vitest";
import { captureNativeSlackConnectCandidate } from "../../src/identity/account-connect-input-values.ts";
import { NativeAdminError } from "../../src/identity/admin-errors.ts";

const pluginLogicalId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const owned = new Set<Buffer>();

function metadata() {
	return {
		alias: "work-slack",
		mode: "read_only",
		historyLimitDays: 30,
		disclosureVersion: 1,
		pluginLogicalId,
	};
}

function capture(rawMetadata: unknown, token: unknown) {
	const candidate = captureNativeSlackConnectCandidate(rawMetadata, token);
	owned.add(candidate.token);
	return candidate;
}

function refused(rawMetadata: unknown, token: unknown) {
	expect(() => capture(rawMetadata, token)).toThrow(NativeAdminError);
}

afterEach(() => {
	for (const token of owned) token.fill(0);
	owned.clear();
});

describe("native account-connect candidate capture", () => {
	it("owns the entered metadata and token before a later await", async () => {
		const entered = metadata();
		const token = Buffer.from("original-token");
		const expected = { ...entered };
		const candidate = capture(entered, token);
		expect(token.toString("ascii")).toBe("original-token");
		entered.alias = "other-slack";
		entered.mode = "full";
		entered.historyLimitDays = 365;
		entered.disclosureVersion = 2;
		entered.pluginLogicalId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
		token.fill(0x7a);
		await Promise.resolve();
		expect(candidate.metadata).toEqual(expected);
		expect(candidate.token.toString("ascii")).toBe("original-token");
		expect(Object.isFrozen(candidate)).toBe(true);
		expect(Object.isFrozen(candidate.metadata)).toBe(true);
		candidate.token.fill(0);
		expect(token.equals(Buffer.alloc(token.length, 0x7a))).toBe(true);
	});

	it("accepts own data fields on a null-prototype record and copies only the token view", () => {
		const entered = Object.assign(Object.create(null), metadata(), {
			alias: "a",
			historyLimitDays: 1,
		});
		Object.defineProperty(entered, "disclosureVersion", { value: 1, enumerable: false });
		const backing = Uint8Array.from([0, 0x21, 0]);
		const candidate = capture(entered, backing.subarray(1, 2));
		expect(candidate.metadata).toEqual({ ...metadata(), alias: "a", historyLimitDays: 1 });
		expect(candidate.token).toEqual(Buffer.from("!"));
		candidate.token[0] = 0x41;
		expect([...backing]).toEqual([0, 0x21, 0]);
	});

	it("accepts the inclusive metadata and token upper bounds", () => {
		const entered = {
			...metadata(),
			alias: "a".repeat(32),
			mode: "full",
			historyLimitDays: 365,
			disclosureVersion: Number.MAX_SAFE_INTEGER,
		};
		const token = Buffer.alloc(8192, 0x7e);
		const candidate = capture(entered, token);
		expect(candidate.metadata).toEqual(entered);
		expect(candidate.token.length).toBe(8192);
		expect(candidate.token.equals(token)).toBe(true);
		candidate.token.fill(0);
		expect(token.equals(Buffer.alloc(8192, 0x7e))).toBe(true);
	});

	it("rejects a metadata proxy without invoking any trap", () => {
		let calls = 0;
		const trap = () => {
			calls++;
			throw new Error("metadata trap invoked");
		};
		const entered = new Proxy(metadata(), {
			get: trap,
			getPrototypeOf: trap,
			ownKeys: trap,
			getOwnPropertyDescriptor: trap,
		});
		refused(entered, Buffer.from("token"));
		expect(calls).toBe(0);
	});

	it("rejects an accessor in every metadata field without calling it", () => {
		let calls = 0;
		for (const key of Object.keys(metadata())) {
			const entered = metadata();
			Object.defineProperty(entered, key, {
				enumerable: true,
				get() {
					calls++;
					throw new Error("metadata getter invoked");
				},
			});
			refused(entered, Buffer.from("token"));
		}
		expect(calls).toBe(0);
	});

	it("rejects missing, unknown and symbol metadata fields", () => {
		const missing: Record<string, unknown> = metadata();
		delete missing.alias;
		for (const entered of [
			missing,
			{ ...metadata(), extra: true },
			{ ...metadata(), [Symbol("extra")]: true },
		]) {
			refused(entered, Buffer.from("token"));
		}
	});

	it("rejects inherited and non-record metadata", () => {
		for (const entered of [
			null,
			"metadata",
			[],
			() => metadata(),
			Object.create(metadata()),
			Object.assign(Object.create({ extra: true }), metadata()),
		]) {
			refused(entered, Buffer.from("token"));
		}
	});

	it("rejects aliases outside the complete lowercase ASCII grammar", () => {
		for (const alias of ["", "a".repeat(33), "Work", "-work", "work_slack", "work\n", "wörk"]) {
			refused({ ...metadata(), alias }, Buffer.from("token"));
		}
	});

	it("rejects unsupported modes and non-integral or out-of-window history limits", () => {
		refused({ ...metadata(), mode: "write_only" }, Buffer.from("token"));
		for (const historyLimitDays of [0, 366, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "30"]) {
			refused({ ...metadata(), historyLimitDays }, Buffer.from("token"));
		}
	});

	it("rejects invalid disclosure versions and logical plugin identifiers", () => {
		for (const disclosureVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "1"]) {
			refused({ ...metadata(), disclosureVersion }, Buffer.from("token"));
		}
		for (const id of ["", "not-a-ulid", `${pluginLogicalId}\n`]) {
			refused({ ...metadata(), pluginLogicalId: id }, Buffer.from("token"));
		}
	});

	it("rejects a token proxy without invoking its traps", () => {
		let calls = 0;
		const trap = () => {
			calls++;
			throw new Error("token trap invoked");
		};
		const token = new Proxy(Buffer.from("token"), {
			get: trap,
			getPrototypeOf: trap,
			getOwnPropertyDescriptor: trap,
		});
		refused(metadata(), token);
		expect(calls).toBe(0);
	});

	it("captures a real typed view without invoking shadowed properties or iteration", () => {
		let calls = 0;
		const token = Uint8Array.from([0x21, 0x41, 0x7e]);
		for (const key of ["buffer", "byteOffset", "byteLength", Symbol.iterator]) {
			Object.defineProperty(token, key, {
				get() {
					calls++;
					throw new Error("token getter invoked");
				},
			});
		}
		expect(capture(metadata(), token).token).toEqual(Buffer.from("!A~"));
		expect(calls).toBe(0);
	});

	it("rejects wrong token types and the empty and oversized byte lengths", () => {
		for (const token of [
			"token",
			[0x41],
			new ArrayBuffer(1),
			new DataView(new ArrayBuffer(1)),
			new Uint16Array([0x41]),
			Buffer.alloc(0),
			Buffer.alloc(8193, 0x41),
		]) {
			refused(metadata(), token);
		}
	});

	it("rejects shared and detached token backing stores", () => {
		const shared = new Uint8Array(new SharedArrayBuffer(4));
		shared.fill(0x41);
		refused(metadata(), shared);
		expect([...shared]).toEqual([0x41, 0x41, 0x41, 0x41]);
		const buffer = new ArrayBuffer(4);
		const detached = new Uint8Array(buffer);
		detached.fill(0x41);
		structuredClone(buffer, { transfer: [buffer] });
		refused(metadata(), detached);
	});

	it("erases failed non-printable token copies while preserving caller bytes", () => {
		const entered = metadata();
		const tokens = [0, 0x0a, 0x20, 0x7f, 0x80, 0xff].map((byte) =>
			Uint8Array.from([0x41, byte, 0x42]),
		);
		const originalAlloc = Buffer.alloc;
		for (const token of tokens) {
			const before = [...token];
			const allocations: Buffer[] = [];
			const observer = vi.spyOn(Buffer, "alloc").mockImplementation((...args) => {
				const bytes = Reflect.apply(originalAlloc, Buffer, args) as ReturnType<typeof Buffer.alloc>;
				allocations.push(bytes);
				return bytes;
			});
			let failure: unknown;
			try {
				capture(entered, token);
			} catch (error) {
				failure = error;
			} finally {
				observer.mockRestore();
			}
			expect(failure).toBeInstanceOf(NativeAdminError);
			expect(allocations.length).toBeGreaterThan(0);
			for (const bytes of allocations) expect([...bytes]).toEqual(Array(bytes.length).fill(0));
			expect([...token]).toEqual(before);
		}
	});
});
