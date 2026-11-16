import { createHash } from "node:crypto";
import type { SnapshotAttachment } from "@draftyak/protocol/snapshot";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import {
	NativeAttachmentBytesError,
	readNativeAttachmentBytes,
} from "../../src/outbox/attachment-bytes.ts";
import { MAX_NATIVE_SEND_BODY_BYTES } from "../../src/outbox/renderers/native.ts";
import { fixture, type NativeRawFixture, project } from "./attachment-bytes-fixture.ts";

let f: NativeRawFixture;
let ownedFixture: NativeRawFixture | undefined;
beforeEach(async () => {
	ownedFixture = undefined;
	const created = await fixture();
	ownedFixture = created;
	f = created;
});
afterEach(async () => {
	const current = ownedFixture;
	ownedFixture = undefined;
	await current?.cleanup();
});
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function expected(
	bytes: Uint8Array,
	changes: Partial<SnapshotAttachment> = {},
): SnapshotAttachment {
	return {
		filename: "dytest-attachment.bin",
		contentType: "application/octet-stream",
		size: bytes.length,
		sha256: sha256(bytes),
		...changes,
	};
}
function pattern(length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, index) => (index * 31 + 17) % 256);
}

describe("native frozen attachment bytes", () => {
	it("assembles exact cross-chunk bytes and returns an independent result", async () => {
		const bytes = pattern(65_543);
		const blob = await project(f, bytes);
		const result = readNativeAttachmentBytes(f.model, f.database, f.ref(), blob, expected(bytes));
		expect(result).toEqual(bytes);
		expect(sha256(result)).toBe(sha256(bytes));
		result.fill(0);
		expect(readNativeAttachmentBytes(f.model, f.database, f.ref(), blob, expected(bytes))).toEqual(
			bytes,
		);
	});

	it("reads a genuine committed empty object and refuses an absent object", async () => {
		const bytes = new Uint8Array();
		const blob = await project(f, bytes);
		expect(readNativeAttachmentBytes(f.model, f.database, f.ref(), blob, expected(bytes))).toEqual(
			bytes,
		);
		expect(() =>
			readNativeAttachmentBytes(f.model, f.database, f.ref(), { ref: newId() }, expected(bytes)),
		).toThrow(NativeAttachmentBytesError);
	});

	it("refuses another genuine account and a genuine foreign database", async () => {
		const bytes = Uint8Array.of(7, 0, 255, 9);
		const blob = await project(f, bytes);
		const other = f.email();
		f.database.write((scope) => f.accounts.create(scope, other));
		expect(() =>
			readNativeAttachmentBytes(
				f.model,
				f.database,
				f.ref({ accountId: other.id, pluginInstanceId: other.pluginInstanceId }),
				blob,
				expected(bytes),
			),
		).toThrow(NativeAttachmentBytesError);
		expect(() =>
			readNativeAttachmentBytes(f.model, new WorkDatabase(f.store), f.ref(), blob, expected(bytes)),
		).toThrow(NativeAttachmentBytesError);
	});

	it("rechecks generation and refuses to rebind old bytes to a refreshed reference", async () => {
		const bytes = Uint8Array.of(1, 2, 3);
		const blob = await project(f, bytes);
		const generation = f.database.write((scope) => {
			const current = f.accounts.get(scope, f.account.userId, f.account.id);
			if (!current) throw new Error("Synthetic native account unavailable");
			return f.accounts.replace(
				scope,
				{ ...current.account, alias: "dytest-refreshed-attach" },
				current.generation,
			).generation;
		});
		for (const ref of [f.ref(), f.ref({ generation })])
			expect(() =>
				readNativeAttachmentBytes(f.model, f.database, ref, blob, expected(bytes)),
			).toThrow(NativeAttachmentBytesError);
	});

	it("refuses frozen length and digest mismatches", async () => {
		const bytes = pattern(17);
		const blob = await project(f, bytes);
		for (const changes of [
			{ size: bytes.length - 1 },
			{ size: bytes.length + 1 },
			{ sha256: "0".repeat(64) },
		])
			expect(() =>
				readNativeAttachmentBytes(f.model, f.database, f.ref(), blob, expected(bytes, changes)),
			).toThrow(NativeAttachmentBytesError);
	});

	it("recomputes the complete digest despite coherent changed chunk bytes and chunk digest", async () => {
		const bytes = pattern(65_543);
		const blob = await project(f, bytes);
		const changed = bytes.slice(0, 65_536);
		changed[0] = (changed[0] ?? 0) ^ 255;
		f.store.write((sql) => {
			expect(
				sql.run("UPDATE main.rawcontent_chunks SET bytes=?,sha256=? WHERE object_id=? AND seq=0", [
					changed,
					sha256(changed),
					blob.ref,
				]).changes,
			).toBe(1);
		});
		const slice = f.database.write((scope) => f.model.read(scope, f.ref(), blob));
		expect(slice.bytes).toEqual(changed);
		expect(slice.sha256).toBe(sha256(bytes));
		expect(() =>
			readNativeAttachmentBytes(f.model, f.database, f.ref(), blob, expected(bytes)),
		).toThrow(NativeAttachmentBytesError);
	});

	it("uses the genuine original methods rather than overridden instance methods", async () => {
		const bytes = Uint8Array.of(4, 5, 6);
		const blob = await project(f, bytes);
		let calls = 0;
		const effect = () => {
			calls++;
			throw new Error("Synthetic overridden method invoked");
		};
		Object.defineProperty(f.model, "read", { value: effect, configurable: true });
		Object.defineProperty(f.database, "write", { value: effect, configurable: true });
		try {
			expect(
				readNativeAttachmentBytes(f.model, f.database, f.ref(), blob, expected(bytes)),
			).toEqual(bytes);
			expect(calls).toBe(0);
		} finally {
			Reflect.deleteProperty(f.model, "read");
			Reflect.deleteProperty(f.database, "write");
		}
	});

	it("refuses invalid frozen bounds and effectful records with a fixed error", async () => {
		const bytes = Uint8Array.of(1);
		const blob = await project(f, bytes);
		for (const size of [-1, MAX_NATIVE_SEND_BODY_BYTES + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
			try {
				readNativeAttachmentBytes(f.model, f.database, f.ref(), blob, expected(bytes, { size }));
				throw new Error("Synthetic refusal absent");
			} catch (error) {
				expect(error).toBeInstanceOf(NativeAttachmentBytesError);
				expect((error as NativeAttachmentBytesError).code).toBe("ATTACHMENT_BYTES_UNAVAILABLE");
				expect((error as Error).message).toBe("Attachment bytes unavailable");
				expect(Object.hasOwn(error as object, "cause")).toBe(false);
			}
		}
		let calls = 0;
		const hostile = Object.defineProperty(expected(bytes), "sha256", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("Synthetic getter invoked");
			},
		});
		expect(() => readNativeAttachmentBytes(f.model, f.database, f.ref(), blob, hostile)).toThrow(
			NativeAttachmentBytesError,
		);
		expect(calls).toBe(0);
	});
});
