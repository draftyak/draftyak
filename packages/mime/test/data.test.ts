import { createHash } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	canonicalAddress,
	MAX_BYTES,
	MimeError,
	type MimeInput,
	normalizeAddresses,
	normalizeSubject,
	renderMime,
	snapshotClaimStamp,
	textSha256,
} from "../src/index.ts";

const stamp = () => ({
	messageId: "<synthetic@example.test>",
	dateMs: 1_800_000_000_000,
	mimeBoundary: "0123456789abcdef01234567",
	uploadBoundary: "synthetic_upload_0123456789",
});
const input = (): MimeInput => ({
	from: { address: "owner@example.test" },
	to: [{ address: "before@example.test" }],
	subject: "Synthetic",
	text: "Synthetic body",
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("single immutable MIME input projection", () => {
	it("refuses the changing address that previously split wire recipients from reconciliation metadata", async () => {
		let reads = 0;
		const box = Object.defineProperty({}, "address", {
			enumerable: true,
			get() {
				return ++reads === 1 ? "before@example.test" : "after@example.test";
			},
		});
		await expect(
			renderMime({ ...input(), to: [box] } as unknown as MimeInput, stamp()),
		).rejects.toEqual(new MimeError("BAD_ADDRESS"));
		expect(reads).toBe(0);
	});
	it("rejects raw input, nested metadata, arrays and list hooks without invoking any", async () => {
		let calls = 0;
		const get = () => {
			calls++;
			throw new Error("PRIVATE_HOOK_CANARY");
		};
		const raw = input(),
			metadata = [
				Object.defineProperty({ ...raw }, "subject", { enumerable: true, get }),
				{ ...raw, from: Object.defineProperty({ ...raw.from }, "name", { enumerable: true, get }) },
				{ ...raw, list: Object.defineProperty({}, "unsubscribe", { enumerable: true, get }) },
				{ ...raw, attachments: [Object.defineProperty({}, "filename", { enumerable: true, get })] },
				{ ...raw, to: Object.defineProperty([raw.from], "0", { enumerable: true, get }) },
				{
					...raw,
					references: Object.defineProperty(["<synthetic@example.test>"], "0", {
						enumerable: true,
						get,
					}),
				},
				new Proxy(raw, { get, ownKeys: get, getPrototypeOf: get }),
				{ ...raw, from: new Proxy(raw.from, { get, ownKeys: get, getPrototypeOf: get }) },
				{ ...raw, to: new Proxy(raw.to, { get, ownKeys: get, getPrototypeOf: get }) },
			];
		for (const value of metadata)
			await expect(renderMime(value as MimeInput, stamp())).rejects.toBeInstanceOf(MimeError);
		expect(calls).toBe(0);
	});
	it("refuses inherited/exotic metadata and sparse/custom/symbol arrays before composition", async () => {
		const raw = input(),
			compile = vi.spyOn(MailComposer.prototype, "compile");
		for (const value of [
			Object.create(raw),
			{ ...raw, from: Object.assign(Object.create({ inherited: true }), raw.from) },
			{ ...raw, to: Array(1) },
			{ ...raw, references: Array(1) },
			{ ...raw, attachments: Array(1) },
			{ ...raw, to: Object.assign([...raw.to], { extra: true }) },
			{ ...raw, to: Object.assign([...raw.to], { [Symbol()]: true }) },
			{ ...raw, list: { constructor: "PRIVATE_CANARY" } },
			Object.defineProperty({ ...raw }, "hidden", { value: true }),
		])
			await expect(renderMime(value as MimeInput, stamp())).rejects.toBeInstanceOf(MimeError);
		expect(compile).not.toHaveBeenCalled();
	});
	it("preserves previously accepted own undefined optional fields without reading prototypes", async () => {
		const raw = input(),
			expected = await renderMime(raw, stamp());
		const value = {
			...raw,
			from: { ...raw.from, name: undefined },
			to: raw.to.map((box) => ({ ...box, name: undefined })),
			cc: undefined,
			bcc: undefined,
			inReplyTo: undefined,
			references: undefined,
			list: undefined,
			attachments: undefined,
		};
		expect(await renderMime(value, stamp())).toEqual(expected);
		expect(Object.hasOwn(value, "cc")).toBe(true);
	});
	it("uses intrinsic byte storage, preserves subarrays and ignores byte/species/iterator hooks", async () => {
		const original = Buffer.from("synthetic attachment"),
			storage = Buffer.concat([Buffer.from("pad"), original, Buffer.from("pad")]),
			content = storage.subarray(3, -3);
		let calls = 0;
		for (const property of [
			"byteLength",
			"byteOffset",
			"buffer",
			"length",
			"subarray",
			Symbol.iterator,
		])
			Object.defineProperty(content, property, {
				get() {
					calls++;
					throw new Error("PRIVATE_BYTE_CANARY");
				},
			});
		const result = await renderMime(
			{
				...input(),
				attachments: [{ filename: "synthetic.txt", contentType: "text/plain", content }],
			},
			stamp(),
		);
		expect(result.raw.toString()).toContain(original.toString("base64"));
		expect(calls).toBe(0);
	});
	it("refuses shared/proxy/subclass attachment bytes without hooks or composer work", async () => {
		let calls = 0;
		class Bytes extends Uint8Array {
			static get [Symbol.species](): Uint8ArrayConstructor {
				calls++;
				throw new Error("PRIVATE_SPECIES_CANARY");
			}
		}
		const proxy = new Proxy(new Uint8Array(1), {
			get() {
				calls++;
				throw new Error("PRIVATE_BYTE_CANARY");
			},
			getPrototypeOf() {
				calls++;
				throw new Error("PRIVATE_BYTE_CANARY");
			},
		});
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		for (const content of [new Uint8Array(new SharedArrayBuffer(1)), new Bytes(1), proxy])
			await expect(
				renderMime(
					{
						...input(),
						attachments: [{ filename: "synthetic.txt", contentType: "text/plain", content }],
					},
					stamp(),
				),
			).rejects.toEqual(new MimeError("BAD_ATTACHMENT"));
		expect(calls).toBe(0);
		expect(compile).not.toHaveBeenCalled();
	});
	it("charges actual attachment length rather than spoofed byteLength before composition", async () => {
		const content = Object.defineProperty(new Uint8Array(MAX_BYTES + 1), "byteLength", {
			value: 0,
		});
		const compile = vi.spyOn(MailComposer.prototype, "compile");
		await expect(
			renderMime(
				{
					...input(),
					attachments: [
						{ filename: "oversized.bin", contentType: "application/octet-stream", content },
					],
				},
				stamp(),
			),
		).rejects.toEqual(new MimeError("TOO_LARGE"));
		expect(compile).not.toHaveBeenCalled();
	});
	it("checks aggregate native byte sizes before copying even the first attachment", async () => {
		const first = new Uint8Array(1),
			second = new Uint8Array(MAX_BYTES),
			ownedBuffers = new Set([first.buffer, second.buffer]);
		const actualSet = Uint8Array.prototype.set;
		let copies = 0;
		vi.spyOn(Uint8Array.prototype, "set").mockImplementation(function (
			this: Uint8Array,
			source,
			offset,
		) {
			if (ArrayBuffer.isView(source) && ownedBuffers.has(source.buffer as ArrayBuffer)) copies++;
			return actualSet.call(this, source, offset);
		});
		vi.resetModules();
		const isolated = await import("../src/index.ts");
		await expect(
			isolated.renderMime(
				{
					...input(),
					attachments: [first, second].map((content) => ({
						filename: "synthetic.bin",
						contentType: "application/octet-stream",
						content,
					})),
				},
				stamp(),
			),
		).rejects.toHaveProperty("code", "TOO_LARGE");
		expect(copies).toBe(0);
	});
	it("returns a validated frozen detached claim stamp and refuses executable stamp fields", () => {
		const raw = stamp(),
			saved = snapshotClaimStamp(raw);
		expect(saved).toEqual(raw);
		expect(Object.isFrozen(saved)).toBe(true);
		raw.uploadBoundary = "changed_upload_boundary";
		expect(saved.uploadBoundary).toBe("synthetic_upload_0123456789");
		let calls = 0;
		const get = () => {
			calls++;
			throw new Error("PRIVATE_STAMP_CANARY");
		};
		for (const value of [
			Object.defineProperty(stamp(), "uploadBoundary", { enumerable: true, get }),
			new Proxy(stamp(), { get, ownKeys: get, getPrototypeOf: get }),
			{ ...stamp(), extra: undefined },
		])
			expect(() => snapshotClaimStamp(value)).toThrow(new MimeError("BAD_STAMP"));
		expect(calls).toBe(0);
	});
});

describe("data-only comparison helpers", () => {
	it("rejects the caller map/replace hooks that previously bypassed normalization", () => {
		let calls = 0;
		const hook = () => {
			calls++;
			return "PRIVATE_HELPER_CANARY";
		};
		const addresses = Object.assign(["before@example.test"], { map: hook });
		expect(() => normalizeAddresses(addresses)).toThrow(new MimeError("BAD_INPUT"));
		const value = { replace: hook } as unknown as string;
		for (const normalize of [normalizeSubject, textSha256, canonicalAddress])
			expect(() => normalize(value)).toThrow(new MimeError("BAD_INPUT"));
		expect(calls).toBe(0);
	});
	it("preserves primitive subject/body whitespace comparison semantics", () => {
		expect(normalizeSubject(" Re:  Café\r\n\t update ")).toBe("Re: Café update");
		expect(textSha256("A\r\nB\r\n\r\n")).toBe(createHash("sha256").update("A\nB").digest("hex"));
		expect(textSha256("A\nB ")).not.toBe(textSha256("A\nB"));
	});
});
