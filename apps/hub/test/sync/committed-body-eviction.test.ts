import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EVENT_MIGRATIONS, EventLog } from "../../src/events/log.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { JOB_MIGRATIONS, JobQueue } from "../../src/jobs/queue.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../../src/store/store.ts";
import {
	acknowledgeCommittedBodyRefetch,
	COMMITTED_BODY_EVICTION_JOURNAL_SQL,
	CommittedBodyEvictionError,
	pendingCommittedBodyRefetch,
	readCommittedBodyEviction,
	stepCommittedBodyEviction,
} from "../../src/sync/committed-body-eviction.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

type Selection = Parameters<typeof stepCommittedBodyEviction>[1];
interface SqlFixture {
	store: HubStore;
	database: WorkDatabase;
	queue: JobQueue;
	reopen(): void;
	close(): void;
}
const PREFIX = "draftyak-body-eviction-test-";
const uncertain = new Set<object>();
const AT = 1_700_000_000_000;
const id = (value: number): string => value.toString(16).toUpperCase().padStart(26, "0");
const sha = (value: string | Uint8Array): string =>
	createHash("sha256").update(value).digest("hex");

async function sqlFixture(): Promise<SqlFixture> {
	const parent = realpathSync(os.tmpdir());
	const dir = realpathSync(mkdtempSync(path.join(parent, PREFIX)));
	const originalRoot = lstatSync(dir, { bigint: true });
	const journal = path.join(dir, "journal");
	mkdirSync(journal);
	const originalJournal = lstatSync(journal, { bigint: true });
	writeFileSync(path.join(journal, "0001_evictions.sql"), COMMITTED_BODY_EVICTION_JOURNAL_SQL, {
		flag: "wx",
	});
	const registered = Object.freeze({
		audit: path.join(migrations, "audit"),
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
		content: path.resolve(import.meta.dirname, "../../src/sync/migrations"),
		rawcontent: path.resolve(import.meta.dirname, "../../src/sync/raw-migrations"),
		bodyevictions: journal,
	});
	const filename = path.join(dir, "fixture.db");
	const keyBytes = randomBytes(32);
	let key: MasterKey;
	try {
		key = new MasterKey(keyBytes);
	} finally {
		keyBytes.fill(0);
	}
	const stores = new Set<HubStore>();
	const closed = new Set<HubStore>();
	let constructionUncertain = false;
	let finished = false;
	const open = (create: boolean): HubStore => {
		try {
			const store = new HubStore({
				filename,
				masterKey: key,
				nativeBinding,
				migrations: registered,
				...(create ? { create: true } : {}),
			});
			stores.add(store);
			return store;
		} catch (error) {
			constructionUncertain = true;
			throw error;
		}
	};
	const closeStore = (store: HubStore): void => {
		if (closed.has(store)) return;
		store.close();
		closed.add(store);
	};
	const remove = (): void => {
		const current = lstatSync(dir, { bigint: true });
		const child = lstatSync(journal, { bigint: true });
		if (
			path.resolve(dir) !== dir ||
			path.dirname(dir) !== parent ||
			!path.basename(dir).startsWith(PREFIX) ||
			path.relative(parent, dir) !== path.basename(dir) ||
			realpathSync(dir) !== dir ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== originalRoot.dev ||
			current.ino !== originalRoot.ino ||
			current.birthtimeNs !== originalRoot.birthtimeNs ||
			current.mode !== originalRoot.mode ||
			!child.isDirectory() ||
			child.isSymbolicLink() ||
			realpathSync(journal) !== journal ||
			child.dev !== originalJournal.dev ||
			child.ino !== originalJournal.ino ||
			child.birthtimeNs !== originalJournal.birthtimeNs ||
			child.mode !== originalJournal.mode
		)
			throw new Error("Eviction fixture cleanup target refused");
		for (const name of readdirSync(dir)) {
			if (name === "journal") continue;
			if (!/^fixture\.db(?:-wal|-shm|-journal)?$/.test(name))
				throw new Error("Eviction fixture unexpected file");
			const entry = path.join(dir, name),
				stat = lstatSync(entry);
			if (
				!stat.isFile() ||
				stat.isSymbolicLink() ||
				stat.nlink !== 1 ||
				realpathSync(entry) !== entry
			)
				throw new Error("Eviction fixture file identity refused");
		}
		if (readdirSync(journal).join("|") !== "0001_evictions.sql")
			throw new Error("Eviction migration cleanup refused");
		const migration = path.join(journal, "0001_evictions.sql"),
			stat = lstatSync(migration);
		if (
			!stat.isFile() ||
			stat.isSymbolicLink() ||
			stat.nlink !== 1 ||
			realpathSync(migration) !== migration
		)
			throw new Error("Eviction migration identity refused");
		rmSync(dir, { recursive: true, force: false });
		try {
			lstatSync(dir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		throw new Error("Eviction fixture remains after cleanup");
	};
	const close = (): void => {
		if (finished) return;
		let failed = false;
		for (const store of stores) {
			try {
				closeStore(store);
			} catch {
				failed = true;
			}
		}
		if (failed || constructionUncertain) {
			uncertain.add({ key, dir, stores, closed });
			throw new Error("Eviction fixture close unconfirmed");
		}
		try {
			remove();
			key.destroy();
			finished = true;
		} catch (error) {
			uncertain.add({ key, dir, stores, closed });
			throw error;
		}
	};
	try {
		const store = open(true);
		for (const namespace of Object.keys(registered)) await store.migrate(namespace);
		const database = new WorkDatabase(store);
		const events = new EventLog(database, () => AT);
		const queue = new JobQueue(database, events, { wallMs: () => AT, monotonicMs: () => 0 });
		const fixture: SqlFixture = {
			store,
			database,
			queue,
			close,
			reopen: () => {
				closeStore(fixture.store);
				fixture.store = open(false);
				fixture.database = new WorkDatabase(fixture.store);
				fixture.queue = new JobQueue(fixture.database, new EventLog(fixture.database, () => AT), {
					wallMs: () => AT,
					monotonicMs: () => 0,
				});
			},
		};
		return fixture;
	} catch (error) {
		try {
			close();
		} catch (cleanup) {
			throw new AggregateError([error, cleanup], "Eviction setup and cleanup failed");
		}
		throw error;
	}
}

async function withFixture(work: (fixture: SqlFixture) => void | Promise<void>): Promise<void> {
	const fixture = await sqlFixture();
	const outcome = await Promise.resolve()
		.then(() => work(fixture))
		.then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	try {
		fixture.close();
	} catch (cleanup) {
		if (!outcome.ok)
			throw new AggregateError([outcome.error, cleanup], "Eviction test and cleanup failed");
		throw cleanup;
	}
	if (!outcome.ok) throw outcome.error;
}

interface DataSet {
	readonly selection: Selection;
	readonly conversationId: string;
	readonly needle: string;
}
function seed(sql: SqlTransaction, index = 0, chunkCount = 65): DataSet {
	const bytes = Array.from({ length: chunkCount }, (_, seq) =>
		Buffer.alloc(seq === chunkCount - 1 ? 17 : 65_536, 65 + index),
	);
	const rawBytes = bytes.reduce((total, chunk) => total + chunk.length, 0);
	const hash = createHash("sha256");
	for (const chunk of bytes) hash.update(chunk);
	const rawSha256 = hash.digest("hex");
	const selected: Selection = {
		evictionId: id(600 + index),
		messageId: id(200 + index),
		raw: { ref: id(100 + index) },
		accountId: id(1),
		generation: 1,
		userId: id(2),
		pluginInstanceId: id(3),
		mode: "full",
		ownerEpoch: 4,
		rawSha256,
		rawBytes,
		chunkCount,
	};
	const conversationId = id(300 + index),
		providerId = `DYTEST-M${index}`,
		threadId = `DYTEST-T${index}`;
	const needle = `dytestevictionneedle${index}`;
	sql.run(
		"INSERT INTO content_checkpoints(account_id,generation,user_id,plugin_instance_id,mode,cursor,revision) VALUES(?,?,?,?,?,'dytest-cursor',1) ON CONFLICT(account_id,generation) DO NOTHING",
		[
			selected.accountId,
			selected.generation,
			selected.userId,
			selected.pluginInstanceId,
			selected.mode,
		],
	);
	sql.run(
		"INSERT INTO content_conversations(id,user_id,account_id,generation,provider_id) VALUES(?,?,?,?,?)",
		[conversationId, selected.userId, selected.accountId, selected.generation, threadId],
	);
	sql.run(
		"INSERT INTO content_messages(id,user_id,account_id,generation,provider_id,conversation_id,internal_date,label_json,size_bytes) VALUES(?,?,?,?,?,?,?,'[]',?)",
		[
			selected.messageId,
			selected.userId,
			selected.accountId,
			selected.generation,
			providerId,
			conversationId,
			AT,
			rawBytes,
		],
	);
	sql.run(
		"INSERT INTO rawcontent_objects(id,user_id,account_id,generation,plugin_instance_id,mode,owner_epoch,state,created_at,expires_at,max_bytes,byte_count,chunk_count,sha256) VALUES(?,?,?,?,?,?,?,'committed',?,?,?,?,?,?)",
		[
			selected.raw.ref,
			selected.userId,
			selected.accountId,
			selected.generation,
			selected.pluginInstanceId,
			selected.mode,
			selected.ownerEpoch,
			AT,
			AT + 60_000,
			rawBytes,
			rawBytes,
			chunkCount,
			rawSha256,
		],
	);
	for (const [seq, chunk] of bytes.entries())
		sql.run("INSERT INTO rawcontent_chunks(object_id,seq,bytes,sha256) VALUES(?,?,?,?)", [
			selected.raw.ref,
			seq,
			chunk,
			sha(chunk),
		]);
	if (rawBytes > 0) projection(sql, selected, 1000 + index, needle);
	return { selection: selected, conversationId, needle };
}

function projection(sql: SqlTransaction, selected: Selection, seq: number, needle: string): void {
	const current = sql.get<{ providerId: string; threadId: string }>(
		"SELECT m.provider_id AS providerId,c.provider_id AS threadId FROM content_messages m JOIN content_conversations c ON c.id=m.conversation_id WHERE m.id=?",
		[selected.messageId],
	);
	if (!current) throw new Error("DYTEST projection metadata missing");
	const accountDigest = sha("DYTEST account"),
		metadataDigest = sha(`DYTEST metadata ${seq}`);
	// Synthetic projection DATA satisfying the real DDL; no parser/association authority is claimed.
	const parsed = JSON.stringify({
		body: {
			text: needle,
			removals: { hidden: 0, invisible: 0, quoted: 0, truncated: 0, uris: 0 },
			links: [],
			suspectedInstructions: false,
		},
	});
	const hex = (text: string) => Buffer.from(text).toString("hex");
	const scope = `dyparsedv1z${hex(selected.userId)}z${hex(selected.accountId)}z${selected.generation}z${hex(selected.pluginInstanceId)}z${hex(selected.mode)}z${accountDigest}`;
	sql.run(
		"INSERT INTO content_parsed_messages(seq,message_id,account_id,generation,user_id,plugin_instance_id,mode,provider_id,thread_id,account_digest,metadata_digest,source_cursor,source_revision,raw_ref,raw_sha256,raw_bytes,parsed_json,parsed_digest,association,scope_token,cleaned_body) VALUES(?,?,?,?,?,?,?,?,?,?,?,'dytest-cursor',1,?,?,?,?,?,'unverified',?,?)",
		[
			seq,
			selected.messageId,
			selected.accountId,
			selected.generation,
			selected.userId,
			selected.pluginInstanceId,
			selected.mode,
			current.providerId,
			current.threadId,
			accountDigest,
			metadataDigest,
			selected.raw.ref,
			selected.rawSha256,
			selected.rawBytes,
			parsed,
			sha(parsed),
			scope,
			needle,
		],
	);
}

function replacementRaw(
	sql: SqlTransaction,
	selected: Selection,
	ref = selected.raw.ref,
): Selection {
	const bytes = Buffer.from("DYTEST newer committed cache body");
	const replacement: Selection = {
		...selected,
		raw: { ref },
		rawSha256: sha(bytes),
		rawBytes: bytes.length,
		chunkCount: 1,
	};
	sql.run(
		"INSERT INTO rawcontent_objects(id,user_id,account_id,generation,plugin_instance_id,mode,owner_epoch,state,created_at,expires_at,max_bytes,byte_count,chunk_count,sha256) VALUES(?,?,?,?,?,?,?,'committed',?,?,?,?,1,?)",
		[
			ref,
			selected.userId,
			selected.accountId,
			selected.generation,
			selected.pluginInstanceId,
			selected.mode,
			selected.ownerEpoch,
			AT + 1,
			AT + 60_000,
			bytes.length,
			bytes.length,
			replacement.rawSha256,
		],
	);
	sql.run("INSERT INTO rawcontent_chunks(object_id,seq,bytes,sha256) VALUES(?,0,?,?)", [
		ref,
		bytes,
		sha(bytes),
	]);
	return replacement;
}

function chunkCount(sql: SqlReader, rawId: string): number {
	const value = sql.get<{ count: number }>(
		"SELECT count(*) AS count FROM rawcontent_chunks WHERE object_id=?",
		[rawId],
	)?.count;
	if (value === undefined || !Number.isSafeInteger(value) || value < 0)
		throw new Error("DYTEST chunk count missing");
	return value;
}
function matches(sql: SqlReader, needle: string): number[] {
	return sql
		.all<{ rowid: number }>(
			"SELECT rowid FROM content_parsed_fts WHERE content_parsed_fts MATCH ? ORDER BY rowid",
			[needle],
		)
		.map((row) => row.rowid);
}
function metadata(sql: SqlReader) {
	return {
		messages: sql.all("SELECT * FROM content_messages ORDER BY id"),
		conversations: sql.all("SELECT * FROM content_conversations ORDER BY id"),
		checkpoints: sql.all("SELECT * FROM content_checkpoints ORDER BY account_id,generation"),
	};
}
function progress(fixture: SqlFixture, selected: Selection) {
	return fixture.store.write((sql) => readCommittedBodyEviction(sql, selected));
}
function refetch(fixture: SqlFixture, selected: Selection) {
	return fixture.store.write((sql) => pendingCommittedBodyRefetch(sql, selected));
}

describe("committed body eviction in the original SQL transaction", () => {
	it("invalidates only the selected body and FTS parent while deleting at most 64 chunks", async () => {
		await withFixture((fixture) => {
			const [target, neighbor] = fixture.store.write((sql) => [seed(sql), seed(sql, 1, 3)]);
			if (!target || !neighbor) throw new Error("DYTEST rows missing");
			const originalMetadata = fixture.store.read(metadata);
			expect(fixture.store.read((sql) => matches(sql, target.needle))).toEqual([1000]);
			expect(fixture.store.read((sql) => matches(sql, neighbor.needle))).toEqual([1001]);
			const first = fixture.store.write((sql) => stepCommittedBodyEviction(sql, target.selection));
			expect(first).toMatchObject({
				phase: "discarding",
				refetchState: "pending",
				deletedChunks: 64,
				deletedObjects: 0,
				deletedParsed: 1,
				more: true,
			});
			fixture.store.read((sql) => {
				expect(chunkCount(sql, target.selection.raw.ref)).toBe(1);
				expect(chunkCount(sql, neighbor.selection.raw.ref)).toBe(3);
				expect(
					sql.get("SELECT state,sha256 FROM rawcontent_objects WHERE id=?", [
						target.selection.raw.ref,
					]),
				).toEqual({ state: "discarding", sha256: "" });
				expect(
					sql.get("SELECT message_id FROM content_parsed_messages WHERE message_id=?", [
						target.selection.messageId,
					]),
				).toBeUndefined();
				expect(matches(sql, target.needle)).toEqual([]);
				expect(matches(sql, neighbor.needle)).toEqual([1001]);
				expect(metadata(sql)).toEqual(originalMetadata);
			});
			expect(refetch(fixture, target.selection)).toBeNull();
		});
	});

	it("rolls invalidation, FTS deletion, chunks and durable intent back with the caller's outer write", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql));
			const originalMetadata = fixture.store.read(metadata);
			const rollback = new Error("DYTEST outer rollback");
			expect(() =>
				fixture.store.write((sql) => {
					const provisional = stepCommittedBodyEviction(sql, data.selection);
					expect(provisional.deletedChunks).toBe(64);
					throw rollback;
				}),
			).toThrow(rollback);
			fixture.store.read((sql) => {
				expect(chunkCount(sql, data.selection.raw.ref)).toBe(65);
				expect(
					sql.get("SELECT state,sha256 FROM rawcontent_objects WHERE id=?", [
						data.selection.raw.ref,
					]),
				).toEqual({ state: "committed", sha256: data.selection.rawSha256 });
				expect(matches(sql, data.needle)).toEqual([1000]);
				expect(metadata(sql)).toEqual(originalMetadata);
			});
			expect(progress(fixture, data.selection)).toBeNull();
		});
	});

	it("resumes durable progress after same-key encrypted reopen and preserves pending refetch", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql));
			fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			fixture.reopen();
			expect(progress(fixture, data.selection)).toMatchObject({
				phase: "discarding",
				refetchState: "pending",
				more: true,
			});
			const final = fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			expect(final).toMatchObject({
				phase: "complete",
				deletedChunks: 1,
				deletedObjects: 1,
				more: false,
				refetchRequired: true,
			});
			fixture.reopen();
			fixture.store.read((sql) => {
				expect(
					sql.get("SELECT id FROM rawcontent_objects WHERE id=?", [data.selection.raw.ref]),
				).toBeUndefined();
				expect(chunkCount(sql, data.selection.raw.ref)).toBe(0);
			});
			expect(progress(fixture, data.selection)).toMatchObject({
				phase: "complete",
				refetchState: "pending",
				refetchRequired: true,
			});
			expect(refetch(fixture, data.selection)).toEqual(data.selection);
		});
	});

	it("does not lose refetch intent when independent discarding SQL cleanup removes the object", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql));
			fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			// A separate original SQL caller performs ordinary discard cleanup, not a staged abort.
			fixture.store.write((sql) => {
				expect(
					sql.run("DELETE FROM rawcontent_chunks WHERE object_id=?", [data.selection.raw.ref])
						.changes,
				).toBe(1);
				expect(
					sql.run(
						"DELETE FROM rawcontent_objects WHERE id=? AND state='discarding' AND sha256=''",
						[data.selection.raw.ref],
					).changes,
				).toBe(1);
			});
			fixture.reopen();
			const final = fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			expect(final).toMatchObject({
				phase: "complete",
				deletedChunks: 0,
				deletedObjects: 0,
				more: false,
				refetchRequired: true,
			});
			expect(refetch(fixture, data.selection)).toEqual(data.selection);
			const repeated = fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			expect(repeated).toMatchObject({
				phase: "complete",
				deletedChunks: 0,
				deletedObjects: 0,
				refetchRequired: true,
			});
		});
	});

	it("commits a real Queue enqueue and refetch acknowledgement together, or neither on rollback", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql, 0, 1));
			fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			const jobId = id(900),
				rollback = new Error("DYTEST enqueue rollback");
			expect(() =>
				fixture.database.write((scope) => {
					fixture.queue.enqueue(scope, {
						id: jobId,
						accountId: data.selection.accountId,
						ownerId: data.selection.userId,
						kind: "sync",
						refId: data.selection.pluginInstanceId,
					});
					acknowledgeCommittedBodyRefetch(fixture.database.sql(scope), data.selection);
					throw rollback;
				}),
			).toThrow(rollback);
			expect(refetch(fixture, data.selection)).toEqual(data.selection);
			expect(fixture.database.write((scope) => fixture.queue.get(scope, jobId))).toBeUndefined();
			fixture.database.write((scope) => {
				fixture.queue.enqueue(scope, {
					id: jobId,
					accountId: data.selection.accountId,
					ownerId: data.selection.userId,
					kind: "sync",
					refId: data.selection.pluginInstanceId,
				});
				acknowledgeCommittedBodyRefetch(fixture.database.sql(scope), data.selection);
			});
			fixture.reopen();
			expect(refetch(fixture, data.selection)).toBeNull();
			expect(progress(fixture, data.selection)).toMatchObject({
				phase: "complete",
				refetchState: "acknowledged",
				refetchRequired: false,
			});
			expect(fixture.database.write((scope) => fixture.queue.get(scope, jobId))).toMatchObject({
				id: jobId,
				kind: "sync",
				accountId: data.selection.accountId,
				refId: data.selection.pluginInstanceId,
			});
		});
	});

	it("refuses stale full selected identities without changing raw, parsed, FTS or metadata DATA", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql));
			const selected = data.selection;
			const originalMetadata = fixture.store.read(metadata);
			const stale: Selection[] = [
				{ ...selected, messageId: id(999) },
				{ ...selected, raw: { ref: id(998) } },
				{ ...selected, userId: id(997) },
				{ ...selected, accountId: id(996) },
				{ ...selected, generation: selected.generation + 1 },
				{ ...selected, pluginInstanceId: id(995) },
				{ ...selected, mode: "read_only" },
				{ ...selected, ownerEpoch: selected.ownerEpoch + 1 },
				{ ...selected, rawSha256: sha("DYTEST different raw") },
				{ ...selected, rawBytes: selected.rawBytes + 1 },
				{ ...selected, rawBytes: selected.rawBytes + 65_536, chunkCount: selected.chunkCount + 1 },
			];
			for (const changed of stale) {
				expect(() => fixture.store.write((sql) => stepCommittedBodyEviction(sql, changed))).toThrow(
					CommittedBodyEvictionError,
				);
				expect(progress(fixture, selected)).toBeNull();
				fixture.store.read((sql) => {
					expect(chunkCount(sql, selected.raw.ref)).toBe(65);
					expect(
						sql.get("SELECT state,sha256 FROM rawcontent_objects WHERE id=?", [selected.raw.ref]),
					).toEqual({ state: "committed", sha256: selected.rawSha256 });
					expect(matches(sql, data.needle)).toEqual([1000]);
					expect(metadata(sql)).toEqual(originalMetadata);
				});
			}
		});
	});

	it("binds continuation to its full tuple and never deletes a reappeared committed raw object", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql));
			fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			expect(() =>
				fixture.store.write((sql) =>
					stepCommittedBodyEviction(sql, {
						...data.selection,
						ownerEpoch: data.selection.ownerEpoch + 1,
					}),
				),
			).toThrow(CommittedBodyEvictionError);
			expect(fixture.store.read((sql) => chunkCount(sql, data.selection.raw.ref))).toBe(1);
			const newer = fixture.store.write((sql) => {
				sql.run("DELETE FROM rawcontent_chunks WHERE object_id=?", [data.selection.raw.ref]);
				sql.run("DELETE FROM rawcontent_objects WHERE id=?", [data.selection.raw.ref]);
				return replacementRaw(sql, data.selection);
			});
			const superseded = fixture.store.write((sql) =>
				stepCommittedBodyEviction(sql, data.selection),
			);
			expect(superseded).toMatchObject({
				phase: "complete",
				refetchState: "superseded",
				deletedChunks: 0,
				deletedObjects: 0,
				more: false,
				refetchRequired: false,
			});
			fixture.reopen();
			const repeated = fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			expect(repeated).toMatchObject({
				refetchState: "superseded",
				deletedChunks: 0,
				deletedObjects: 0,
				refetchRequired: false,
			});
			expect(refetch(fixture, data.selection)).toBeNull();
			fixture.store.read((sql) => {
				expect(chunkCount(sql, newer.raw.ref)).toBe(1);
				expect(
					sql.get("SELECT state,sha256,byte_count FROM rawcontent_objects WHERE id=?", [
						newer.raw.ref,
					]),
				).toEqual({ state: "committed", sha256: newer.rawSha256, byte_count: newer.rawBytes });
			});
		});
	});

	it("retains a newer parsed projection and its FTS tokens while superseding the old refetch intent", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql));
			fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			const needle = "dytestnewprojection";
			const newer = fixture.store.write((sql) => {
				const replacement = replacementRaw(sql, data.selection, id(1100));
				projection(sql, replacement, 2000, needle);
				return replacement;
			});
			expect(fixture.store.read((sql) => matches(sql, needle))).toEqual([2000]);
			const result = fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			expect(result).toMatchObject({
				refetchState: "superseded",
				refetchRequired: false,
				deletedParsed: 0,
			});
			expect(result.deletedChunks).toBeLessThanOrEqual(64);
			expect(refetch(fixture, data.selection)).toBeNull();
			fixture.store.read((sql) => {
				expect(matches(sql, needle)).toEqual([2000]);
				expect(
					sql.get("SELECT raw_ref,raw_sha256 FROM content_parsed_messages WHERE message_id=?", [
						data.selection.messageId,
					]),
				).toEqual({ raw_ref: newer.raw.ref, raw_sha256: newer.rawSha256 });
				expect(chunkCount(sql, newer.raw.ref)).toBe(1);
				expect(
					sql.get("SELECT state,sha256 FROM rawcontent_objects WHERE id=?", [newer.raw.ref]),
				).toEqual({ state: "committed", sha256: newer.rawSha256 });
			});
		});
	});

	it("rejects premature acknowledgement and rolls a final cleanup step back without losing continuation", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql));
			fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection));
			expect(() =>
				fixture.store.write((sql) => acknowledgeCommittedBodyRefetch(sql, data.selection)),
			).toThrow(CommittedBodyEvictionError);
			const rollback = new Error("DYTEST continuation rollback");
			expect(() =>
				fixture.store.write((sql) => {
					expect(stepCommittedBodyEviction(sql, data.selection)).toMatchObject({
						phase: "complete",
						deletedChunks: 1,
						deletedObjects: 1,
					});
					throw rollback;
				}),
			).toThrow(rollback);
			fixture.reopen();
			expect(fixture.store.read((sql) => chunkCount(sql, data.selection.raw.ref))).toBe(1);
			expect(progress(fixture, data.selection)).toMatchObject({
				phase: "discarding",
				refetchState: "pending",
				more: true,
			});
			expect(
				fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection)),
			).toMatchObject({
				phase: "complete",
				deletedChunks: 1,
				deletedObjects: 1,
				refetchRequired: true,
			});
		});
	});

	it("completes a coherent zero-byte committed object without inventing a parsed body", async () => {
		await withFixture((fixture) => {
			const data = fixture.store.write((sql) => seed(sql, 0, 0));
			expect(data.selection.rawSha256).toBe(sha(Buffer.alloc(0)));
			expect(
				fixture.store.write((sql) => stepCommittedBodyEviction(sql, data.selection)),
			).toMatchObject({
				phase: "complete",
				deletedChunks: 0,
				deletedObjects: 1,
				deletedParsed: 0,
				refetchRequired: true,
				more: false,
			});
			expect(refetch(fixture, data.selection)).toEqual(data.selection);
		});
	});
});
