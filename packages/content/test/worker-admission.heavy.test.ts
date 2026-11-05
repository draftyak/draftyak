import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_MAIL_BYTES } from "../src/limits.ts";
import type { MailEvidence } from "../src/mail.ts";
import { parseMailInWorker } from "../src/worker.ts";

const raw = Buffer.from(
	"From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Snapshot\r\n\r\nVisible snapshot.",
);
const evidence: MailEvidence = { provider: "generic", ownerAddresses: ["owner@example.test"] };
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

describe("native byte admission before content worker allocation", () => {
	it("refuses the actual oversized view before copying or reading evidence, ignoring a spoofed size", async () => {
		const input = new Uint8Array(MAX_MAIL_BYTES + 1);
		let sizeReads = 0;
		let evidenceReads = 0;
		Object.defineProperty(input, "byteLength", {
			get: () => {
				sizeReads++;
				return 1;
			},
		});
		const unneeded: MailEvidence = {
			get provider(): "generic" {
				evidenceReads++;
				throw Error("PRIVATE_EVIDENCE_CANARY");
			},
			ownerAddresses: [],
		};
		await expect(parseMailInWorker(input, unneeded)).rejects.toMatchObject({
			code: "INPUT_LIMIT",
			message: "Content exceeds the input limit.",
		});
		expect(sizeReads).toBe(0);
		expect(evidenceReads).toBe(0);
	});

	it.each(["Uint8Array", "Buffer"])(
		"keeps valid %s bytes while ignoring caller-owned metadata and iteration hooks",
		async (kind) => {
			const input = kind === "Buffer" ? Buffer.from(raw) : new Uint8Array(raw);
			const hash = sha256(input);
			let reads = 0;
			for (const key of [
				"byteLength",
				"byteOffset",
				"buffer",
				"length",
				"subarray",
				Symbol.iterator,
			])
				Object.defineProperty(input, key, {
					get: () => {
						reads++;
						throw Error("PRIVATE_BYTE_HOOK_CANARY");
					},
				});
			const result = await parseMailInWorker(input, evidence);
			expect(result.rawSha256).toBe(hash);
			expect(result.body.text).toBe("Visible snapshot.");
			expect(reads).toBe(0);
		},
	);

	it("copies a Buffer subview rather than its larger backing allocation", async () => {
		const backing = Buffer.alloc(MAX_MAIL_BYTES + 100);
		raw.copy(backing, 100);
		const input = backing.subarray(100, 100 + raw.length);
		const result = await parseMailInWorker(input, evidence);
		expect(result.rawSha256).toBe(sha256(raw));
		expect(result.body.text).toBe("Visible snapshot.");
	});

	it.each([false, true])(
		"refuses shared storage, growable=%s, before evidence",
		async (growable) => {
			const buffer = growable
				? new SharedArrayBuffer(raw.length, { maxByteLength: MAX_MAIL_BYTES + 1 })
				: new SharedArrayBuffer(raw.length);
			const input = new Uint8Array(buffer);
			input.set(raw);
			let reads = 0;
			await expect(
				parseMailInWorker(input, {
					get provider(): "generic" {
						reads++;
						return "generic";
					},
					ownerAddresses: [],
				}),
			).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Content is invalid." });
			expect(reads).toBe(0);
		},
	);

	it("refuses proxies without executing their prototype or property traps", async () => {
		let reads = 0;
		const input = new Proxy(new Uint8Array(raw), {
			get: () => {
				reads++;
				throw Error("PRIVATE_PROXY_CANARY");
			},
			getPrototypeOf: () => {
				reads++;
				throw Error("PRIVATE_PROXY_CANARY");
			},
		});
		await expect(parseMailInWorker(input, evidence)).rejects.toMatchObject({
			code: "INVALID_INPUT",
			message: "Content is invalid.",
		});
		expect(reads).toBe(0);
	});

	it("refuses detached storage with the fixed content error", async () => {
		const input = new Uint8Array(raw);
		structuredClone(input.buffer, { transfer: [input.buffer] });
		await expect(parseMailInWorker(input, evidence)).rejects.toMatchObject({
			code: "INVALID_INPUT",
			message: "Content is invalid.",
		});
	});

	it("refuses an exotic typed-array subclass without calling its iterator", async () => {
		let reads = 0;
		class Exotic extends Uint8Array {
			override [Symbol.iterator](): never {
				reads++;
				throw Error("PRIVATE_ITERATOR_CANARY");
			}
		}
		await expect(parseMailInWorker(new Exotic(raw), evidence)).rejects.toMatchObject({
			code: "INVALID_INPUT",
			message: "Content is invalid.",
		});
		expect(reads).toBe(0);
	});

	it("captures a resizable unshared view before later evidence processing mutates its storage", async () => {
		const buffer = new ArrayBuffer(raw.length, { maxByteLength: MAX_MAIL_BYTES + 1 });
		const input = new Uint8Array(buffer);
		input.set(raw);
		const result = await parseMailInWorker(input, {
			get provider(): "generic" {
				buffer.resize(0);
				return "generic";
			},
			ownerAddresses: evidence.ownerAddresses,
		});
		expect(buffer.byteLength).toBe(0);
		expect(result.rawSha256).toBe(sha256(raw));
		expect(result.body.text).toBe("Visible snapshot.");
	});
});
