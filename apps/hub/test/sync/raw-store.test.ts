import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { systemClock } from "../../src/kernel/clock.ts";
import {
	NativeRawStore,
	RAW_CONTENT_MAX_BYTES,
	RawContentError,
} from "../../src/sync/raw-store.ts";
import { fixture, type NativeRawFixture, project, readAll } from "./raw-fixture.ts";

let f: NativeRawFixture;
beforeEach(async () => {
	f = await fixture();
});
afterEach(async () => {
	await f.cleanup();
});
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function pattern(length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, index) => (index * 31 + 17) % 256);
}

describe("native projected-byte storage", () => {
	it("accepts a fractional monotonic clock and refuses its exact elapsed cutoff", async () => {
		f.clock.monotonic = 50_000.25;
		const bytes = Uint8Array.of(1, 2, 3);
		const blob = await project(f, bytes);
		expect(readAll(f, blob)).toEqual(bytes);
		const expiring = f.database.write((scope) => f.model.begin(scope, f.ref()));
		f.clock.monotonic += 60_000;
		await expect(expiring.write(bytes, new AbortController().signal)).rejects.toBeInstanceOf(
			RawContentError,
		);
	});
	it("accepts the committed native system clock", async () => {
		f.model = new NativeRawStore(f.database, f.accounts, f.devices, systemClock);
		const bytes = Uint8Array.of(7, 0, 255, 9);
		const blob = await project(f, bytes);
		expect(readAll(f, blob)).toEqual(bytes);
	});
	it("persists the complete native maximum through all 512 bounded chunks", async () => {
		const bytes = new Uint8Array(RAW_CONTENT_MAX_BYTES).fill(0x5a);
		const writer = f.database.write((scope) => f.model.begin(scope, f.ref()));
		const signal = new AbortController().signal;
		await writer.write(bytes, signal);
		const blob = await writer.commit(signal);
		const first = f.database.write((scope) => f.model.read(scope, f.ref(), blob));
		const last = f.database.write((scope) =>
			f.model.read(scope, f.ref(), blob, bytes.length - 65_536),
		);
		expect(first.bytes).toEqual(bytes.subarray(0, 65_536));
		expect(first.totalBytes).toBe(bytes.length);
		expect(first.sha256).toBe(sha256(bytes));
		expect(last.bytes).toEqual(bytes.subarray(bytes.length - 65_536));
		expect(last.nextOffset).toBeNull();
		expect(
			f.store.read(
				(sql) => sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM main.rawcontent_chunks")?.n,
			),
		).toBe(512);
	});
	it.each(["raw", "data"] as const)(
		"stores the actual decoded %s producer's binary output and reads it independently",
		async (member) => {
			const bytes = Uint8Array.from([0, 0xff, 0x80, 13, 10, 65, 0, 127, 0xfe, 10, 13, 42, 1]);
			const blob = await project(f, bytes, member, 1);
			expect(readAll(f, blob, 3)).toEqual(bytes);
			const first = f.database.write((scope) => f.model.read(scope, f.ref(), blob, 0, 3));
			expect(first).toEqual({
				bytes: bytes.slice(0, 3),
				nextOffset: 3,
				totalBytes: bytes.length,
				sha256: sha256(bytes),
			});
		},
	);

	it.each(["raw", "data"] as const)(
		"commits an empty %s value as an empty object",
		async (member) => {
			const blob = await project(f, new Uint8Array(), member, 2);
			expect(readAll(f, blob)).toEqual(new Uint8Array());
			expect(f.database.write((scope) => f.model.read(scope, f.ref(), blob))).toEqual({
				bytes: new Uint8Array(),
				nextOffset: null,
				totalBytes: 0,
				sha256: sha256(new Uint8Array()),
			});
		},
	);

	it("coalesces repeated tiny writes into one persisted bounded chunk", async () => {
		const bytes = pattern(128);
		const writer = f.database.write((scope) => f.model.begin(scope, f.ref()));
		const signal = new AbortController().signal;
		for (const byte of bytes) await writer.write(Uint8Array.of(byte), signal);
		const blob = await writer.commit(signal);
		expect(readAll(f, blob, 7)).toEqual(bytes);
		const chunks = f.database.write((scope) =>
			f.database
				.sql(scope)
				.all<{ seq: number; n: number }>(
					"SELECT seq,length(bytes) AS n FROM rawcontent_chunks WHERE object_id=? ORDER BY seq",
					[blob.ref],
				),
		);
		expect(chunks).toEqual([{ seq: 0, n: 128 }]);
	});

	it.each([65_535, 65_536, 65_537, 131_079])(
		"keeps exact bytes and full non-final chunks at size %i",
		async (length) => {
			const bytes = pattern(length);
			const blob = await project(f, bytes, "raw", 16_383);
			expect(readAll(f, blob)).toEqual(bytes);
			const chunks = f.database.write((scope) =>
				f.database
					.sql(scope)
					.all<{ seq: number; n: number }>(
						"SELECT seq,length(bytes) AS n FROM rawcontent_chunks WHERE object_id=? ORDER BY seq",
						[blob.ref],
					),
			);
			expect(chunks.map((row) => row.seq)).toEqual(chunks.map((_, index) => index));
			expect(chunks.reduce((sum, row) => sum + row.n, 0)).toBe(length);
			for (const row of chunks.slice(0, -1)) expect(row.n).toBe(65_536);
			expect(chunks.at(-1)?.n).toBe(((length - 1) % 65_536) + 1);
			const first = f.database.write((scope) => f.model.read(scope, f.ref(), blob));
			expect(first.totalBytes).toBe(length);
			expect(first.sha256).toBe(sha256(bytes));
		},
	);

	it("reads an unaligned bounded slice across two committed chunks", async () => {
		const bytes = pattern(131_079);
		const blob = await project(f, bytes, "data", 65_535);
		const slice = f.database.write((scope) => f.model.read(scope, f.ref(), blob, 65_534, 7));
		expect(slice).toEqual({
			bytes: bytes.slice(65_534, 65_541),
			nextOffset: 65_541,
			totalBytes: bytes.length,
			sha256: sha256(bytes),
		});
	});

	it("accepts the exact downward write limit with an earlier live TTL", async () => {
		const bytes = pattern(64);
		const blob = await project(f, bytes, "raw", 9, { maxBytes: 64, ttlMs: 1000 });
		expect(readAll(f, blob, 11)).toEqual(bytes);
	});

	it("returns independent byte slices rather than mutable persisted views", async () => {
		const bytes = pattern(40);
		const blob = await project(f, bytes);
		const first = f.database.write((scope) => f.model.read(scope, f.ref(), blob));
		first.bytes.fill(0);
		expect(readAll(f, blob)).toEqual(bytes);
	});

	it.each([true, false])(
		"reopens committed encrypted bytes with raw namespace registration %s",
		async (registerRaw) => {
			const bytes = new TextEncoder().encode(
				"DYTEST-native-raw-encryption-canary-7c09e264e1d4439b-".repeat(12),
			);
			const blob = await project(f, bytes, "raw", 31);
			for (const suffix of ["", "-wal", "-shm"]) {
				const filename = `${f.native.filename}${suffix}`;
				if (existsSync(filename)) expect(readFileSync(filename).includes(bytes)).toBe(false);
			}
			await f.reopen(registerRaw);
			expect(readAll(f, blob, 127)).toEqual(bytes);
			expect(f.database.write((scope) => f.model.read(scope, f.ref(), blob)).sha256).toBe(
				sha256(bytes),
			);
		},
	);
});
