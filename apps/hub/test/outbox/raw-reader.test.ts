import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceEpochForRestore } from "../../src/identity/devices.ts";
import type { WorkScope } from "../../src/jobs/database.ts";
import { RAW_CONTENT_CHUNK_BYTES, RawContentError } from "../../src/sync/raw-store.ts";
import { fixture, type NativeRawFixture, project, readAll } from "./attachment-bytes-fixture.ts";

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

const live = (): AbortSignal => new AbortController().signal;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function counts(): readonly number[] {
	return f.store.read((sql) => [
		sql.get<{ n: number }>("SELECT count(*) AS n FROM main.rawcontent_objects")?.n ?? 0,
		sql.get<{ n: number }>("SELECT count(*) AS n FROM main.rawcontent_chunks")?.n ?? 0,
	]);
}
function denied(work: (scope: WorkScope) => unknown): void {
	const before = counts();
	let failure: unknown;
	expect(() =>
		f.database.write((scope) => {
			try {
				work(scope);
			} catch (error) {
				failure = error;
			}
		}),
	).toThrow();
	expect(failure).toBeInstanceOf(RawContentError);
	expect(failure).toMatchObject({
		code: "RAW_CONTENT_UNAVAILABLE",
		message: "Raw content unavailable",
	});
	expect(counts()).toEqual(before);
}

describe("native raw attachment reader", () => {
	it("keeps a genuine staged object unreadable until its writer commits", async () => {
		const bytes = new Uint8Array([3, 5, 8, 13]);
		const writer = f.database.write((scope) => f.model.begin(scope, f.ref()));
		try {
			await writer.write(bytes, live());
			const staged = f.store.read((sql) =>
				sql.get<{ id: string }>("SELECT id FROM main.rawcontent_objects WHERE state='staged'"),
			);
			if (!staged) throw new Error("Synthetic staged raw object unavailable");
			denied((scope) => f.model.read(scope, f.ref(), { ref: staged.id }));
			const blob = await writer.commit(live());
			expect(blob.ref).toBe(staged.id);
			const slice = f.database.write((scope) => f.model.read(scope, f.ref(), blob));
			expect(slice).toEqual({
				bytes,
				nextOffset: null,
				totalBytes: bytes.length,
				sha256: hash(bytes),
			});
		} finally {
			await writer.abort();
		}
	});

	it("returns detached bounded slices with exact cross-chunk progress", async () => {
		const bytes = Uint8Array.from(
			{ length: RAW_CONTENT_CHUNK_BYTES + 7 },
			(_, index) => index % 251,
		);
		const blob = await project(f, bytes);
		const read = (offset: number, maxBytes: number) =>
			f.database.write((scope) => f.model.read(scope, f.ref(), blob, offset, maxBytes));
		const cross = read(RAW_CONTENT_CHUNK_BYTES - 2, 7);
		expect(cross).toEqual({
			bytes: bytes.slice(RAW_CONTENT_CHUNK_BYTES - 2, RAW_CONTENT_CHUNK_BYTES + 5),
			nextOffset: RAW_CONTENT_CHUNK_BYTES + 5,
			totalBytes: bytes.length,
			sha256: hash(bytes),
		});
		cross.bytes.fill(0);
		expect(read(RAW_CONTENT_CHUNK_BYTES - 2, 7).bytes).toEqual(
			bytes.slice(RAW_CONTENT_CHUNK_BYTES - 2, RAW_CONTENT_CHUNK_BYTES + 5),
		);
		const first = read(0, RAW_CONTENT_CHUNK_BYTES);
		const last = read(RAW_CONTENT_CHUNK_BYTES, RAW_CONTENT_CHUNK_BYTES);
		expect(first).toEqual({
			bytes: bytes.slice(0, RAW_CONTENT_CHUNK_BYTES),
			nextOffset: RAW_CONTENT_CHUNK_BYTES,
			totalBytes: bytes.length,
			sha256: hash(bytes),
		});
		expect(last).toEqual({
			bytes: bytes.slice(RAW_CONTENT_CHUNK_BYTES),
			nextOffset: null,
			totalBytes: bytes.length,
			sha256: hash(bytes),
		});
		expect(read(bytes.length, 1)).toEqual({
			bytes: new Uint8Array(),
			nextOffset: null,
			totalBytes: bytes.length,
			sha256: hash(bytes),
		});
		for (const [offset, maxBytes] of [
			[-1, 1],
			[0.5, 1],
			[bytes.length + 1, 1],
			[0, 0],
			[0, RAW_CONTENT_CHUNK_BYTES + 1],
		] as const)
			denied((scope) => f.model.read(scope, f.ref(), blob, offset, maxBytes));
		await f.reopen(false);
		expect(readAll(f, blob)).toEqual(bytes);
		expect(read(0, RAW_CONTENT_CHUNK_BYTES)).toEqual(first);
	});

	it("refuses a stored chunk whose digest no longer matches its bytes", async () => {
		const bytes = new Uint8Array([21, 34, 55]);
		const blob = await project(f, bytes);
		const original = hash(bytes);
		const corrupted = `${original[0] === "0" ? "1" : "0"}${original.slice(1)}`;
		try {
			f.store.write((sql) => {
				expect(
					sql.run("UPDATE main.rawcontent_chunks SET sha256=? WHERE object_id=? AND seq=0", [
						corrupted,
						blob.ref,
					]).changes,
				).toBe(1);
			});
			denied((scope) => f.model.read(scope, f.ref(), blob));
		} finally {
			f.store.write((sql) =>
				sql.run("UPDATE main.rawcontent_chunks SET sha256=? WHERE object_id=? AND seq=0", [
					original,
					blob.ref,
				]),
			);
		}
		expect(readAll(f, blob)).toEqual(bytes);
	});

	it("fences account generations and the combined native restore/bootstrap gate", async () => {
		const bytes = new Uint8Array([89, 144]);
		const blob = await project(f, bytes);
		const originalRef = f.ref();
		expect(readAll(f, blob)).toEqual(bytes);
		const other = f.email();
		f.database.write((scope) => f.accounts.create(scope, other));
		denied((scope) =>
			f.model.read(
				scope,
				f.ref({ accountId: other.id, pluginInstanceId: other.pluginInstanceId }),
				blob,
			),
		);
		f.generation = f.database.write(
			(scope) =>
				f.accounts.replace(scope, { ...f.account, alias: "dytest-raw-replaced" }, f.generation)
					.generation,
		);
		expect(f.generation).toBe(originalRef.generation + 1);
		denied((scope) => f.model.read(scope, originalRef, blob));
		denied((scope) => f.model.read(scope, f.ref(), blob));
		const currentBlob = await project(f, bytes);
		expect(readAll(f, currentBlob)).toEqual(bytes);
		const currentRef = f.ref();
		const epoch = f.database.write((scope) => advanceEpochForRestore(f.devices, scope.sql));
		expect(epoch).toBe(currentRef.ownerEpoch + 1);
		expect(f.store.read((sql) => f.devices.state(sql).bootstrapDone)).toBe(false);
		denied((scope) => f.model.read(scope, currentRef, currentBlob));
		denied((scope) => f.model.read(scope, f.ref({ ownerEpoch: epoch }), currentBlob));
	});

	it("expires only abandoned staging and preserves committed and unexpired objects", async () => {
		const committedBytes = new Uint8Array([1, 4, 9]);
		const committed = await project(f, committedBytes, "raw", 4096, { ttlMs: 1 });
		const expired = f.database.write((scope) => f.model.begin(scope, f.ref(), { ttlMs: 1 }));
		const unexpired = f.database.write((scope) => f.model.begin(scope, f.ref(), { ttlMs: 1000 }));
		try {
			await expired.write(new Uint8Array(RAW_CONTENT_CHUNK_BYTES).fill(6), live());
			const liveBytes = new Uint8Array([2, 7, 18]);
			await unexpired.write(liveBytes, live());
			f.clock.wall += 1;
			f.clock.monotonic += 1;
			expect(f.database.write((scope) => f.model.expireStaging(scope))).toEqual({
				deletedChunks: 1,
				deletedObjects: 1,
				more: false,
			});
			expect(counts()).toEqual([2, 1]);
			expect(readAll(f, committed)).toEqual(committedBytes);
			const liveBlob = await unexpired.commit(live());
			expect(liveBlob.ref).not.toBe(committed.ref);
			expect(readAll(f, liveBlob)).toEqual(liveBytes);
			await expect(expired.commit(live())).rejects.toMatchObject({
				code: "RAW_CONTENT_UNAVAILABLE",
				message: "Raw content unavailable",
			});
			expect(f.database.write((scope) => f.model.expireStaging(scope))).toEqual({
				deletedChunks: 0,
				deletedObjects: 0,
				more: false,
			});
			expect(readAll(f, committed)).toEqual(committedBytes);
			expect(readAll(f, liveBlob)).toEqual(liveBytes);
		} finally {
			await Promise.all([expired.abort(), unexpired.abort()]);
		}
	});
});
