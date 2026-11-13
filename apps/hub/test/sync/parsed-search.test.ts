import { type ParsedMail, parseMail } from "@draftyak/content";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkError } from "../../src/jobs/values.ts";
import { newId } from "../../src/kernel/ids.ts";
import { createJsonMemberDecoder, writeJsonMember } from "../../src/plugins/broker/blob/index.ts";
import type { SqlValue } from "../../src/store/store.ts";
import { NativeSyncError } from "../../src/sync/apply.ts";
import {
	MAX_PARSED_JSON_BYTES,
	MAX_PARSED_SEARCH_BYTES,
	NativeParsedError,
	PARSED_SEARCH_SCAN_LIMIT,
} from "../../src/sync/parsed.ts";
import { emailMessage, fixture, type NativeParsedFixture } from "./parsed-fixture.ts";

// UNAPPLIED declarations: these require the proposed real FTS migration/writer.
// The existing fixture uses real native storage, jobs, Raw admission and scopes.
// Generated mail is unverified DATA, never a provider or reply authority.
let current: NativeParsedFixture | undefined;
beforeEach(async () => {
	current = undefined;
	current = await fixture();
});
afterEach(async () => {
	const owned = current;
	current = undefined;
	await owned?.cleanup();
});
function owned(): NativeParsedFixture {
	if (!current) throw new Error("Synthetic search fixture unavailable");
	return current;
}

const CACHE_COLUMNS = [
	"message_id",
	"account_id",
	"generation",
	"user_id",
	"plugin_instance_id",
	"mode",
	"provider_id",
	"thread_id",
	"account_digest",
	"metadata_digest",
	"source_cursor",
	"source_revision",
	"raw_ref",
	"raw_sha256",
	"raw_bytes",
	"parsed_json",
	"parsed_digest",
	"scope_token",
	"cleaned_body",
	"association",
] as const;
type NegativeCacheRow = Record<(typeof CACHE_COLUMNS)[number], SqlValue>;

async function stored(
	body: string,
	providerId = `DYTEST-search-${newId()}`,
	transform: (mail: ParsedMail) => ParsedMail = (mail) => mail,
) {
	const f = owned();
	f.apply([emailMessage(providerId)]);
	let messageId: string | undefined,
		after: string | null = null;
	for (;;) {
		const page = f.database.write((scope) => f.metadata.messages(scope, f.ref(), after));
		messageId = page.find((message) => message.providerId === providerId)?.id;
		if (messageId) break;
		const last = page.at(-1);
		if (page.length < 100 || !last) throw new Error("Synthetic search metadata missing");
		after = last.id;
	}
	const bytes = new TextEncoder().encode(
		`From: sender@example.invalid\r\nTo: ${f.account.address}\r\nSubject: DYTEST header-only-needle\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`,
	);
	try {
		const raw = await f.project(bytes);
		const mail = transform(
			await parseMail(bytes, { provider: "generic", ownerAddresses: [f.account.address] }),
		);
		const source = f.capture(messageId, raw);
		for (let pass = 0; pass < 2; pass++) f.scan(source).fill(0);
		return f.database.write((scope) => f.model.commit(scope, source, mail));
	} finally {
		bytes.fill(0);
	}
}

/** Large closed parser DATA, backed by the genuine Raw object and job above. */
function largeData(mail: ParsedMail, size = 2_200_000): ParsedMail {
	const address = mail.to[0]?.address;
	if (!address) throw new Error("Synthetic search recipient missing");
	const to = Array.from({ length: 64 }, () => ({ address, name: "" }));
	const result: ParsedMail = { ...mail, to };
	let remaining = size - Buffer.byteLength(JSON.stringify(result), "utf8");
	if (remaining < 0 || remaining > 64 * 65_536)
		throw new Error("Synthetic search byte shape unavailable");
	for (const item of to) {
		const count = Math.min(remaining, 65_536);
		item.name = "x".repeat(count);
		remaining -= count;
	}
	if (remaining !== 0) throw new Error("Synthetic search byte shape incomplete");
	return result;
}

describe("proposed native cleaned-body literal search DATA", () => {
	it("queries the real cleaned-body FTS index and returns only current unverified records", async () => {
		const record = await stored("alpha bravo"),
			f = owned();
		const page = f.database.write((scope) => f.model.search(scope, f.ref(), "alpha bravo"));
		expect(page.records).toEqual([record]);
		expect(page.coverage).toEqual({ state: "unknown", reason: "provider-history-unproven" });
		expect(page.records[0]?.association).toBe("unverified");
		expect(Object.isFrozen(page.records[0]?.mail.body)).toBe(true);
		expect(
			f.database.write((scope) => f.model.search(scope, f.ref(), "header-only-needle")).records,
		).toEqual([]);
		expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(
			MAX_PARSED_SEARCH_BYTES,
		);
	});

	it("quotes operators and column syntax as a literal phrase instead of search authority", async () => {
		await stored("alpha");
		const phrase = await stored("alpha OR beta"),
			f = owned();
		expect(
			f.database.write((scope) => f.model.search(scope, f.ref(), "alpha OR beta")).records,
		).toEqual([phrase]);
		expect(
			f.database.write((scope) =>
				f.model.search(scope, f.ref(), 'alpha" OR scope_token : * OR "beta'),
			).records,
		).toEqual([]);
	});

	it.each(["", "\ud800", "e\u0301", "x".repeat(257), "alpha\u0000", "!?"])(
		"refuses malformed, non-NFC or out-of-contract literal query %j",
		async (query) => {
			await stored("alpha");
			const f = owned();
			expect(() => f.database.write((scope) => f.model.search(scope, f.ref(), query))).toThrow(
				NativeParsedError,
			);
			expect(
				f.database.write((scope) => f.model.search(scope, f.ref(), "alpha")).records,
			).toHaveLength(1);
		},
	);

	it("accepts the scalar boundary and refuses invalid scan/cursor bounds in a real scope", async () => {
		const query = "x".repeat(256),
			record = await stored(query),
			f = owned();
		expect(f.database.write((scope) => f.model.search(scope, f.ref(), query)).records).toEqual([
			record,
		]);
		const fourByteQuery = "\u{10400}".repeat(256),
			fourByteRecord = await stored(fourByteQuery);
		expect(Buffer.byteLength(fourByteQuery, "utf8")).toBe(1024);
		expect(
			f.database.write((scope) => f.model.search(scope, f.ref(), fourByteQuery)).records,
		).toEqual([fourByteRecord]);
		for (const count of [0, 101, Number.NaN])
			expect(() =>
				f.database.write((scope) => f.model.search(scope, f.ref(), query, null, count)),
			).toThrow(NativeParsedError);
		expect(() =>
			f.database.write((scope) => f.model.search(scope, f.ref(), query, "not-an-id")),
		).toThrow(NativeParsedError);
	});

	it("rechecks the original account tuple and rejects a genuine foreign database scope", async () => {
		await stored("alpha");
		const f = owned();
		for (const wrong of [
			f.ref({ accountId: newId() }),
			f.ref({ generation: 2 }),
			f.ref({ pluginInstanceId: newId() }),
			f.ref({ ownerEpoch: f.ref().ownerEpoch + 1 }),
			f.ref({ mode: "read_only" }),
		]) {
			expect(() => f.database.write((scope) => f.model.search(scope, wrong, "alpha"))).toThrow(
				NativeParsedError,
			);
		}
		const other = await fixture();
		try {
			expect(() =>
				other.database.write((scope) => f.model.search(scope, f.ref(), "alpha")),
			).toThrow(NativeParsedError);
		} finally {
			await other.cleanup();
		}
	});

	it("advances at most 100 examined nonmatches and then reaches the remaining real row", async () => {
		for (let i = 0; i < 101; i++) await stored("noise");
		const f = owned(),
			first = f.database.write((scope) => f.model.search(scope, f.ref(), "absent"));
		expect(PARSED_SEARCH_SCAN_LIMIT).toBe(100);
		expect(first).toMatchObject({ records: [], scanned: 100 });
		expect(first.nextAfterId).not.toBeNull();
		const second = f.database.write((scope) =>
			f.model.search(scope, f.ref(), "absent", first.nextAfterId),
		);
		expect(second).toMatchObject({ records: [], scanned: 1, nextAfterId: null });
	});

	it("revalidates a genuinely old extraction and advances its stale matching candidate", async () => {
		const providerId = "DYTEST-search-stale",
			record = await stored("alpha", providerId),
			f = owned();
		const saved = f.store.read((sql) =>
			sql.get<NegativeCacheRow>(
				`SELECT ${CACHE_COLUMNS.join(",")} FROM main.content_parsed_messages WHERE message_id=?`,
				[record.messageId],
			),
		);
		if (!saved) throw new Error("Synthetic old extraction missing");
		f.apply([{ ...emailMessage(providerId), labelIds: ["INBOX", "DYTEST-CHANGED"] }]);
		// Negative stale-cache restoration only; no new positive parse or grant.
		f.store.write((sql) =>
			sql.run(
				`INSERT INTO main.content_parsed_messages(${CACHE_COLUMNS.join(",")}) VALUES(${CACHE_COLUMNS.map(() => "?").join(",")})`,
				CACHE_COLUMNS.map((column) => saved[column]),
			),
		);
		const page = f.database.write((scope) => f.model.search(scope, f.ref(), "alpha", null, 1));
		expect(page).toMatchObject({ records: [], scanned: 1, nextAfterId: record.messageId });
		expect(
			f.database.write((scope) => f.model.search(scope, f.ref(), "alpha", page.nextAfterId)),
		).toMatchObject({ records: [], scanned: 0, nextAfterId: null });
	});

	it("refuses a real FTS hit whose stored cleaned-body projection disagrees with revalidated mail", async () => {
		const record = await stored("alpha"),
			f = owned();
		f.store.write((sql) =>
			sql.run("UPDATE main.content_parsed_messages SET cleaned_body=? WHERE message_id=?", [
				"differentneedle",
				record.messageId,
			]),
		);
		expect(() =>
			f.database.write((scope) => f.model.search(scope, f.ref(), "differentneedle")),
		).toThrow(NativeParsedError);
	});

	it("preserves a deferred valid hit when the whole JSON envelope reaches its byte budget", async () => {
		const records = [
			await stored("budgetneedle", undefined, largeData),
			await stored("budgetneedle", undefined, largeData),
		].sort((a, b) => a.messageId.localeCompare(b.messageId));
		const f = owned(),
			first = f.database.write((scope) => f.model.search(scope, f.ref(), "budgetneedle"));
		expect(first.records.map((record) => record.messageId)).toEqual([records[0]?.messageId]);
		expect(first.nextAfterId).toBe(records[0]?.messageId);
		expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(
			MAX_PARSED_SEARCH_BYTES,
		);
		const second = f.database.write((scope) =>
			f.model.search(scope, f.ref(), "budgetneedle", first.nextAfterId),
		);
		expect(second.records.map((record) => record.messageId)).toEqual([records[1]?.messageId]);
		expect(Buffer.byteLength(JSON.stringify(second), "utf8")).toBeLessThanOrEqual(
			MAX_PARSED_SEARCH_BYTES,
		);
	});

	it("refuses a first hit that fits stored JSON but cannot fit its whole search envelope", async () => {
		const record = await stored("oversizedneedle", undefined, (mail) =>
				largeData(mail, MAX_PARSED_JSON_BYTES),
			),
			f = owned();
		expect(Buffer.byteLength(JSON.stringify(record.mail), "utf8")).toBe(MAX_PARSED_JSON_BYTES);
		expect(() =>
			f.database.write((scope) => f.model.search(scope, f.ref(), "oversizedneedle")),
		).toThrow(NativeParsedError);
	});
});

type PurgeFixtureRef = ReturnType<NativeParsedFixture["ref"]>;
type PurgeRecord = Awaited<ReturnType<typeof stored>>;

async function storedForPurgeGeneration(
	ref: PurgeFixtureRef,
	count: number,
	metadataOnlyCount = 0,
): Promise<PurgeRecord[]> {
	const f = owned();
	if (
		!Number.isInteger(count) ||
		count < 1 ||
		count > 1001 ||
		!Number.isInteger(metadataOnlyCount) ||
		metadataOnlyCount < 0 ||
		metadataOnlyCount > 500
	)
		throw new Error("Generated purge row bound unavailable");
	const prefix = `DYTEST-purge-${newId()}`;
	const changes = Array.from({ length: count }, (_, index) =>
		emailMessage(`${prefix}-${String(index).padStart(4, "0")}`),
	);
	const metadataOnly = Array.from({ length: metadataOnlyCount }, (_, index) =>
		emailMessage(`000-DYTEST-before-${prefix}-${String(index).padStart(4, "0")}`),
	);
	const pageChanges = [...metadataOnly, ...changes];
	// Finish metadata pages before capturing their fixed checkpoint. Every capture
	// below has its own original job lease and NativeParsedSource.
	for (let offset = 0; offset < pageChanges.length; offset += 100) {
		const checkpoint = f.database.write((scope) => f.metadata.checkpoint(scope, ref));
		const handle = f.lease(newId());
		f.database.write((scope) =>
			f.metadata.applyPage(scope, handle, {
				...ref,
				expectedCursor: checkpoint.cursor,
				expectedRevision: checkpoint.revision,
				cursor: `DYTEST-purge-cursor-${checkpoint.revision + 1}`,
				changes: pageChanges.slice(offset, offset + 100),
			}),
		);
	}
	const wanted = new Set(changes.map((change) => change.providerId));
	const ids: string[] = [];
	let after: string | null = null;
	for (;;) {
		const page = f.database.write((scope) => f.metadata.messages(scope, ref, after));
		for (const message of page) if (wanted.has(message.providerId)) ids.push(message.id);
		const last = page.at(-1);
		if (page.length < 100 || !last) break;
		after = last.id;
	}
	expect(ids).toHaveLength(count);
	const bytes = new TextEncoder().encode(
		`From: sender@example.invalid\r\nTo: ${f.account.address}\r\nSubject: DYTEST purge\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\npurgeproof`,
	);
	try {
		const writer = f.database.write((scope) => f.raw.begin(scope, ref));
		const decoder = createJsonMemberDecoder("raw");
		const document = new TextEncoder().encode(
			JSON.stringify({ raw: Buffer.from(bytes).toString("base64url") }),
		);
		async function* entity(): AsyncGenerator<Uint8Array> {
			for (let offset = 0; offset < document.length; offset += 4096) {
				const chunk = document.subarray(offset, offset + 4096);
				decoder.countCompressed(chunk.byteLength);
				yield chunk;
			}
		}
		let blob: Awaited<ReturnType<typeof writeJsonMember>>;
		try {
			blob = await writeJsonMember(decoder, entity(), writer, new AbortController().signal);
		} finally {
			document.fill(0);
		}
		const mail = await parseMail(bytes, {
			provider: "generic",
			ownerAddresses: [f.account.address],
		});
		const records: PurgeRecord[] = [];
		// The genuine sealed Raw object can back several unverified records in this
		// same generation. Neither a Source nor its consumed lease is reused.
		for (const id of ids) {
			records.push(
				f.database.write((scope) => {
					const jobId = newId();
					f.jobs.enqueue(scope, {
						id: jobId,
						accountId: f.account.id,
						ownerId: f.account.userId,
						kind: "sync",
						refId: id,
					});
					const handle = f.jobs.claim(scope, f.account.id, jobId);
					if (!handle) throw new Error("Synthetic parse job was not claimed");
					const source = f.model.capture(scope, handle, ref, id, blob);
					for (let pass = 0; pass < 2; pass++) {
						let offset = 0;
						for (;;) {
							const slice = f.model.readSource(scope, source, offset);
							try {
								if (slice.nextOffset === null) break;
								offset = slice.nextOffset;
							} finally {
								slice.bytes.fill(0);
							}
						}
					}
					return f.model.commit(scope, source, mail);
				}),
			);
		}
		return records;
	} finally {
		bytes.fill(0);
	}
}

function replacePurgeAccount(status: "active" | "disconnecting"): PurgeFixtureRef {
	const f = owned();
	return f.database.write((scope) => {
		const current = f.accounts.get(scope, f.account.userId, f.account.id);
		if (!current) throw new Error("Generated purge account unavailable");
		const next = f.accounts.replace(
			scope,
			{ ...current.account, status, deletionDeadline: null },
			current.generation,
		);
		return f.ref({ generation: next.generation });
	});
}

const RAW_OBJECT_COLUMNS = [
	"id",
	"user_id",
	"account_id",
	"generation",
	"plugin_instance_id",
	"mode",
	"owner_epoch",
	"state",
	"created_at",
	"expires_at",
	"max_bytes",
	"byte_count",
	"chunk_count",
	"sha256",
] as const;
type RawObjectSnapshot = Record<(typeof RAW_OBJECT_COLUMNS)[number], SqlValue> & { id: string };
type RawChunkSnapshot = { object_id: string; seq: number; bytes_hex: string; sha256: string };

function purgeRawSnapshot(originalIds?: readonly string[]) {
	const f = owned();
	return f.database.write((scope) => {
		const sql = f.database.sql(scope);
		const objects = sql.all<RawObjectSnapshot>(
			`SELECT ${RAW_OBJECT_COLUMNS.join(",")} FROM main.rawcontent_objects WHERE account_id=? ORDER BY id`,
			[f.account.id],
		);
		const ids = originalIds ?? objects.map((object) => object.id);
		const chunks =
			ids.length === 0
				? []
				: sql.all<RawChunkSnapshot>(
						`SELECT object_id,seq,hex(bytes) AS bytes_hex,sha256 FROM main.rawcontent_chunks WHERE object_id IN (${ids.map(() => "?").join(",")}) ORDER BY object_id,seq`,
						ids,
					);
		return { objects, chunks };
	});
}

function purgeParsedSnapshot() {
	const f = owned();
	return f.database.write((scope) =>
		f.database
			.sql(scope)
			.all<NegativeCacheRow & { seq: number }>(
				`SELECT seq,${CACHE_COLUMNS.join(",")} FROM main.content_parsed_messages WHERE account_id=? ORDER BY generation,user_id,message_id`,
				[f.account.id],
			),
	);
}

function purgeFtsMatches(): readonly { rowid: number }[] {
	const f = owned();
	return f.database.write((scope) =>
		f.database
			.sql(scope)
			.all<{ rowid: number }>(
				"SELECT rowid FROM main.content_parsed_fts WHERE content_parsed_fts MATCH ? ORDER BY rowid",
				['cleaned_body : "purgeproof"'],
			),
	);
}

function expectPurgeScopeRefusal(ref: PurgeFixtureRef): void {
	const f = owned(),
		beforeRaw = purgeRawSnapshot(),
		beforeParsed = purgeParsedSnapshot();
	expect(beforeRaw.objects.length).toBeGreaterThan(0);
	expect(beforeRaw.chunks.length).toBeGreaterThan(0);
	const rawIds = beforeRaw.objects.map((object) => object.id),
		sentinelId = newId();
	const handle = f.lease(newId(), "retention");
	let inner: unknown, outer: unknown;
	try {
		f.database.write((scope) => {
			f.jobs.enqueue(scope, {
				id: sentinelId,
				accountId: f.account.id,
				ownerId: f.account.userId,
				kind: "retention",
				refId: newId(),
			});
			try {
				f.metadata.purge(scope, handle, ref);
			} catch (error) {
				inner = error;
			}
		});
	} catch (error) {
		outer = error;
	}
	expect(inner).toBeInstanceOf(NativeSyncError);
	expect(inner).toMatchObject({ code: "SYNC_UNAVAILABLE" });
	expect(outer).toBeInstanceOf(WorkError);
	expect(outer).toMatchObject({ code: "scope" });
	expect(f.database.write((scope) => f.jobs.get(scope, sentinelId))).toBeUndefined();
	expect(purgeRawSnapshot(rawIds)).toEqual(beforeRaw);
	expect(purgeParsedSnapshot()).toEqual(beforeParsed);
}

describe("native parsed purge barrier DATA", () => {
	it("keeps Raw bytes while a bounded parsed batch remains and purges real generations and FTS before Raw removal", async () => {
		const f = owned(),
			firstRef = f.ref();
		await storedForPurgeGeneration(firstRef, 1001, 500);
		const secondRef = replacePurgeAccount("active");
		expect(secondRef.generation).toBe(firstRef.generation + 1);
		await storedForPurgeGeneration(secondRef, 1);
		const beforeParsed = purgeParsedSnapshot(),
			beforeRaw = purgeRawSnapshot();
		expect(beforeParsed).toHaveLength(1002);
		expect([...new Set(beforeParsed.map((row) => row.generation))].sort()).toEqual([
			firstRef.generation,
			secondRef.generation,
		]);
		expect(purgeFtsMatches()).toHaveLength(1002);
		expect(beforeRaw.objects).toHaveLength(2);
		expect([...new Set(beforeRaw.objects.map((row) => row.generation))].sort()).toEqual([
			firstRef.generation,
			secondRef.generation,
		]);
		expect(beforeRaw.chunks.length).toBeGreaterThan(0);
		const parsedIds = new Set(beforeParsed.map((row) => row.message_id));
		// This is the same account/order/LIMIT rowset as the real parent DELETE.
		// All first500 parents are genuine metadata-only rows, so their deletion
		// cannot conceal an omitted or incorrectly bounded direct Parsed DELETE.
		const parentCandidates = f.database.write((scope) =>
			f.database
				.sql(scope)
				.all<{ id: string; generation: number; provider_id: string }>(
					"SELECT id,generation,provider_id FROM main.content_messages WHERE account_id=? ORDER BY generation,provider_id LIMIT 500",
					[f.account.id],
				),
		);
		expect(parentCandidates).toHaveLength(500);
		expect(
			parentCandidates.every(
				(row) =>
					row.generation === firstRef.generation &&
					row.provider_id.startsWith("000-DYTEST-before-") &&
					!parsedIds.has(row.id),
			),
		).toBe(true);
		const ref = replacePurgeAccount("disconnecting"),
			rawIds = beforeRaw.objects.map((object) => object.id);
		let handle = f.lease(newId(), "retention"),
			previousCount = beforeParsed.length;
		let sawBatchWithRowsRemaining = false,
			sawRawRemoval = false,
			complete = false;
		// Earlier journal phases and metadata cascades are real. The 500 bound is
		// direct derived deletes, not the total number deleted by public purge.
		for (let call = 0; call < 64; call++) {
			const progress = f.database.write((scope) => f.metadata.purge(scope, handle, ref));
			const remaining = purgeParsedSnapshot(),
				matches = purgeFtsMatches(),
				raw = purgeRawSnapshot(rawIds);
			expect(remaining.length).toBeLessThanOrEqual(previousCount);
			expect(matches).toHaveLength(remaining.length);
			if (call === 0) {
				expect(beforeParsed.length - remaining.length).toBe(500);
				expect(1002 - matches.length).toBe(500);
				expect(raw).toEqual(beforeRaw);
			}
			if (remaining.length > 0) {
				expect(raw).toEqual(beforeRaw);
				if (remaining.length < previousCount) sawBatchWithRowsRemaining = true;
			}
			if (
				raw.objects.length < beforeRaw.objects.length ||
				raw.chunks.length < beforeRaw.chunks.length
			) {
				sawRawRemoval = true;
				expect(remaining).toEqual([]);
				expect(matches).toEqual([]);
			}
			previousCount = remaining.length;
			if (!progress.more) {
				complete = true;
				break;
			}
			if (!progress.lease) throw new Error("Native purge continuation lease unavailable");
			handle = progress.lease;
		}
		expect(sawBatchWithRowsRemaining).toBe(true);
		expect(sawRawRemoval).toBe(true);
		expect(complete).toBe(true);
		expect(purgeParsedSnapshot()).toEqual([]);
		expect(purgeFtsMatches()).toEqual([]);
		expect(purgeRawSnapshot(rawIds)).toEqual({ objects: [], chunks: [] });
	});

	it.each([
		["below", "00000000000000000000000000"],
		["above", "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"],
	] as const)(
		"poisons the transaction for a parsed owner %s the real owner without touching Raw",
		async (side, foreignUserId) => {
			const record = await stored("purgeproof"),
				f = owned();
			expect(
				side === "below" ? foreignUserId < f.account.userId : foreignUserId > f.account.userId,
			).toBe(true);
			// Corrupt cache DATA only: maintain the SQL scope-token CHECK and leave
			// the genuine metadata owner, account and original job issuer untouched.
			f.database.write((scope) =>
				f.database
					.sql(scope)
					.run(
						"UPDATE main.content_parsed_messages SET user_id=?,scope_token='dyparsedv1z'||lower(hex(?))||'z'||lower(hex(account_id))||'z'||CAST(generation AS TEXT)||'z'||lower(hex(plugin_instance_id))||'z'||lower(hex(mode))||'z'||account_digest WHERE message_id=?",
						[foreignUserId, foreignUserId, record.messageId],
					),
			);
			expect(purgeParsedSnapshot()[0]?.user_id).toBe(foreignUserId);
			expectPurgeScopeRefusal(replacePurgeAccount("disconnecting"));
		},
	);

	it.each(["parsed page index", "cleaned-body FTS table"] as const)(
		"poisons a missing required %s before any Raw removal",
		async (name) => {
			await stored("purgeproof");
			const f = owned(),
				ref = replacePurgeAccount("disconnecting");
			// Only the fixture's original native connection may corrupt these two
			// literal dependencies; the public store continues refusing schema SQL.
			f.breakParsedSchema(name);
			const object = name === "parsed page index" ? "content_parsed_page" : "content_parsed_fts";
			expect(
				f.database.write((scope) =>
					f.database
						.sql(scope)
						.get("SELECT count(*) AS n FROM main.sqlite_schema WHERE name=?", [object]),
				),
			).toEqual({ n: 0 });
			expectPurgeScopeRefusal(ref);
		},
	);
});

describe("native parsed cleanup creation-stamp DATA", () => {
	it("retains current parsed and FTS data when committed Raw has a different creation stamp", async () => {
		const record = await stored("creationstampneedle"),
			f = owned(),
			ref = f.ref();
		const creationStamp = ref.ownerEpoch === 0 ? 1 : ref.ownerEpoch - 1;
		expect(Number.isSafeInteger(creationStamp)).toBe(true);
		expect(creationStamp).toBeGreaterThanOrEqual(0);
		expect(creationStamp).not.toBe(ref.ownerEpoch);
		// Change only retained-byte creation DATA, never registry/current authority or a lease.
		// This is not an epoch transition, an earlier-stamp claim or Restore acceptance.
		const changed = f.database.write(
			(scope) =>
				f.database
					.sql(scope)
					.run(
						"UPDATE main.rawcontent_objects SET owner_epoch=? WHERE id=? AND state='committed' AND owner_epoch=? AND account_id=? AND generation=? AND user_id=? AND plugin_instance_id=? AND mode=?",
						[
							creationStamp,
							record.raw.ref,
							ref.ownerEpoch,
							ref.accountId,
							ref.generation,
							f.account.userId,
							ref.pluginInstanceId,
							ref.mode,
						],
					).changes,
		);
		expect(changed).toBe(1);
		const readRaw = (): string => {
			const slice = f.database.write((scope) => f.raw.read(scope, ref, record.raw));
			try {
				expect(slice.totalBytes).toBe(record.rawBytes);
				expect(slice.sha256).toBe(record.rawSha256);
				expect(slice.nextOffset).toBeNull();
				expect(Buffer.from(slice.bytes).toString("utf8")).toContain("creationstampneedle");
				return Buffer.from(slice.bytes).toString("hex");
			} finally {
				slice.bytes.fill(0);
			}
		};
		const matches = () =>
			f.database.write(
				(scope) =>
					f.database
						.sql(scope)
						.get<{ count: number }>(
							"SELECT count(*) AS count FROM main.content_parsed_fts JOIN main.content_parsed_messages p ON p.seq=content_parsed_fts.rowid WHERE p.message_id=? AND content_parsed_fts MATCH ?",
							[record.messageId, 'cleaned_body : "creationstampneedle"'],
						)?.count,
			);
		const rawBytes = readRaw();
		expect(f.database.write((scope) => f.model.read(scope, ref, record.messageId))).toEqual(record);
		expect(matches()).toBe(1);
		expect(
			f.database.write((scope) => f.model.search(scope, ref, "creationstampneedle")).records,
		).toEqual([record]);
		const noncurrent = f.ref({ ownerEpoch: creationStamp });
		expect(() =>
			f.database.write((scope) => f.model.read(scope, noncurrent, record.messageId)),
		).toThrow(NativeParsedError);
		// Use a separate genuine scope after the refusal; no poisoned scope is revived.
		expect(f.database.write((scope) => f.model.cleanup(scope, ref))).toMatchObject({
			deleted: 0,
			more: false,
		});
		expect(readRaw()).toBe(rawBytes);
		expect(f.database.write((scope) => f.model.read(scope, ref, record.messageId))).toEqual(record);
		expect(matches()).toBe(1);
		expect(
			f.database.write((scope) => f.model.search(scope, ref, "creationstampneedle")).records,
		).toEqual([record]);
	});
});
