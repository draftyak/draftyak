import { createHash } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { parseMail } from "@draftyak/content";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkScope } from "../../src/jobs/database.ts";
import type { MetadataAccountRef } from "../../src/sync/apply.ts";
import { fixture } from "../content/ingest-fixture.ts";

const [
	{ NativeParsedStore },
	{ MAX_THREAD_PROJECTION_BYTES, NativeThreadError, NativeThreadReader },
	{ RAW_CONTENT_CHUNK_BYTES, RAW_CONTENT_MAX_BYTES },
] = await Promise.all([
	import("../../src/sync/parsed.ts"),
	import("../../src/sync/thread.ts"),
	import("../../src/sync/raw-store.ts"),
]);

type Fixture = Awaited<ReturnType<typeof fixture>>;
let owned: Fixture | undefined;
const asyncWork = new Set<{ controller: AbortController; completion: Promise<void> }>();
beforeEach(async () => {
	owned = undefined;
	owned = await fixture();
});
afterEach(async () => {
	const running = [...asyncWork];
	for (const work of running) work.controller.abort();
	await Promise.allSettled(running.map((work) => work.completion));
	for (const work of running) asyncWork.delete(work);
	const current = owned;
	owned = undefined;
	await current?.cleanup();
});
function current(): Fixture {
	if (!owned) throw new Error("Synthetic thread fixture unavailable");
	return owned;
}
function reader(f: Fixture) {
	return new NativeThreadReader(f.database, f.metadata, f.parsed);
}
async function withOwnedThreadWork(work: (signal: AbortSignal) => Promise<void>) {
	const controller = new AbortController();
	const completion = Promise.resolve().then(() => {
		controller.signal.throwIfAborted();
		return work(controller.signal);
	});
	const current = { controller, completion };
	asyncWork.add(current);
	try {
		await completion;
	} finally {
		controller.abort();
		asyncWork.delete(current);
	}
}

type BudgetSource = ReturnType<Fixture["parsed"]["capture"]>;
async function readBudgetSourcePass(
	f: Fixture,
	source: BudgetSource,
	expectedBytes: number,
	expectedHash: string,
	signal: AbortSignal,
): Promise<Uint8Array> {
	expect(
		Number.isSafeInteger(expectedBytes) &&
			expectedBytes > 0 &&
			expectedBytes <= RAW_CONTENT_MAX_BYTES,
	).toBe(true);
	const bytes = new Uint8Array(expectedBytes);
	let offset = 0;
	try {
		for (;;) {
			signal.throwIfAborted();
			const progress = f.database.write((scope) => {
				const slice = f.parsed.readSource(scope, source, offset, RAW_CONTENT_CHUNK_BYTES);
				try {
					expect(slice.totalBytes).toBe(expectedBytes);
					expect(slice.sha256).toBe(expectedHash);
					expect(
						slice.bytes.length > 0 &&
							slice.bytes.length <= RAW_CONTENT_CHUNK_BYTES &&
							offset + slice.bytes.length <= expectedBytes,
					).toBe(true);
					bytes.set(slice.bytes, offset);
					return { end: offset + slice.bytes.length, nextOffset: slice.nextOffset };
				} finally {
					slice.bytes.fill(0);
				}
			});
			offset = progress.end;
			if (progress.nextOffset === null) {
				expect(offset).toBe(expectedBytes);
				break;
			}
			expect(progress.nextOffset).toBe(offset);
			expect(offset < expectedBytes).toBe(true);
			await yieldTurn();
		}
		signal.throwIfAborted();
		expect(createHash("sha256").update(bytes).digest("hex")).toBe(expectedHash);
		return bytes;
	} catch (error) {
		bytes.fill(0);
		throw error;
	}
}

// This envelope-budget fixture uses genuine parser DATA and native persistence,
// not 36 default-worker ingests. Other ingestion integration cases stay unchanged.
async function prepareBudgetRecord(
	f: Fixture,
	messageId: string,
	blob: Awaited<ReturnType<Fixture["project"]>>,
	input: Uint8Array,
	signal: AbortSignal,
): Promise<ReturnType<Fixture["parsed"]["commit"]>> {
	let source: BudgetSource | undefined;
	let bytes: Uint8Array | undefined;
	try {
		signal.throwIfAborted();
		const lease = f.lease(messageId);
		const currentSource = f.database.write((scope) => {
			const captured = f.parsed.capture(scope, lease, f.ref, messageId, blob);
			source = captured;
			return captured;
		});
		const address = f.database.write((scope) => f.parsed.ownerAddress(scope, currentSource));
		expect(address).toBe(f.account.address);
		const expectedHash = createHash("sha256").update(input).digest("hex");
		bytes = await readBudgetSourcePass(f, currentSource, input.length, expectedHash, signal);
		const mail = await parseMail(bytes, { provider: "generic", ownerAddresses: [address] });
		signal.throwIfAborted();
		expect(mail.rawSha256).toBe(expectedHash);
		expect(mail.direction).toBe("inbound");
		expect(mail.auth.dmarc).toBe("none");
		expect(mail.auth.verifiedSender).toBeUndefined();
		bytes.fill(0);
		bytes = await readBudgetSourcePass(f, currentSource, input.length, expectedHash, signal);
		bytes.fill(0);
		signal.throwIfAborted();
		return f.database.write((scope) => f.parsed.commit(scope, currentSource, mail));
	} catch (error) {
		if (source !== undefined) {
			const failedSource = source;
			try {
				f.database.write((scope) => f.parsed.abandon(scope, failedSource));
			} catch {
				// A stale source remains refused; no replacement lease/source is made.
			}
		}
		throw error;
	} finally {
		bytes?.fill(0);
	}
}

function expectThreadRefused(work: () => unknown) {
	let failure: unknown;
	try {
		work();
	} catch (error) {
		failure = error;
	}
	expect(failure instanceof NativeThreadError).toBe(true);
	if (failure instanceof NativeThreadError) {
		expect(failure.code).toBe("THREAD_UNAVAILABLE");
		expect(Object.hasOwn(failure, "cause")).toBe(false);
	}
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
	"association",
	"seq",
	"scope_token",
	"cleaned_body",
] as const;
type SavedCache = Record<(typeof CACHE_COLUMNS)[number], string | number>;

function saveOldCache(f: Fixture, messageIds: readonly string[]): readonly SavedCache[] {
	return f.native.store.read((sql) =>
		messageIds.map((messageId) => {
			const row = sql.get<SavedCache>(
				`SELECT ${CACHE_COLUMNS.join(",")} FROM main.content_parsed_messages WHERE message_id=?`,
				[messageId],
			);
			if (!row) throw new Error("Synthetic original parsed cache unavailable");
			return row;
		}),
	);
}

function restoreOldCache(f: Fixture, rows: readonly SavedCache[]): void {
	// Negative cache-corruption setup: preserve the exact earlier worker-derived
	// values after normal metadata invalidation. These rows must not become current.
	f.native.store.write((sql) => {
		for (const row of rows) {
			sql.run("DELETE FROM main.content_parsed_messages WHERE message_id=?", [row.message_id]);
			sql.run(
				`INSERT INTO main.content_parsed_messages(${CACHE_COLUMNS.join(",")}) VALUES(${CACHE_COLUMNS.map(() => "?").join(",")})`,
				CACHE_COLUMNS.map((column) => row[column]),
			);
		}
	});
}

async function ingestRows(f: Fixture) {
	const lease = f.lease();
	f.database.write((scope) =>
		f.metadata.applyPage(scope, lease, {
			...f.ref,
			expectedCursor: "DYTEST-ingest-page-1",
			expectedRevision: 1,
			cursor: "DYTEST-thread-page-2",
			changes: ["second", "third"].map((suffix) => ({
				kind: "email.message" as const,
				providerId: `DYTEST-provider-message-${suffix}`,
				threadId: f.message.threadId,
				internalDate: 990_000,
				labelIds: ["INBOX"],
			})),
		}),
	);
	const messages = f.database.write((scope) => f.metadata.messages(scope, f.ref));
	expect(messages).toHaveLength(3);
	for (const message of messages) {
		const bytes = new TextEncoder().encode(
			[
				"From: dytest-sender@example.invalid",
				"To: dytest-owner@example.invalid",
				`Subject: DYTEST ${message.providerId}`,
				`Message-ID: <${message.id}@example.invalid>`,
				"Content-Type: text/plain; charset=utf-8",
				"",
				"DYTEST thread body",
			].join("\r\n"),
		);
		const blob = await f.project(bytes);
		await f.ingestor.ingest(f.lease(message.id), f.ref, message.id, blob);
	}
	return messages;
}

describe("native current parsed-thread projection", () => {
	it("keeps an empty parsed result unknown with original account/checkpoint data", () => {
		const f = current();
		const model = reader(f);
		const page = f.database.write((scope) => model.read(scope, f.ref, f.message.threadId));
		expect(page).toEqual({
			account: f.ref,
			threadId: f.message.threadId,
			checkpoint: { cursor: "DYTEST-ingest-page-1", revision: 1 },
			messages: [],
			nextAfterId: null,
			coverage: { state: "unknown", reason: "provider-history-unproven" },
		});
		expect(Object.isFrozen(page)).toBe(true);
		expect(Object.isFrozen(page.account)).toBe(true);
		expect(Object.isFrozen(page.messages)).toBe(true);
		expect(Object.isFrozen(page.coverage)).toBe(true);
	});

	it("paginates actual ingested rows without promoting a populated thread to complete", async () => {
		const f = current();
		const rows = await ingestRows(f);
		const model = reader(f);
		const first = f.database.write((scope) =>
			model.read(scope, f.ref, f.message.threadId, null, 2),
		);
		expect(first.messages.map((message) => message.messageId)).toEqual(
			rows.slice(0, 2).map((message) => message.id),
		);
		expect(first.nextAfterId).toBe(rows[1]?.id);
		expect(first.coverage).toEqual({ state: "unknown", reason: "provider-history-unproven" });
		const tail = f.database.write((scope) =>
			model.read(scope, f.ref, f.message.threadId, first.nextAfterId, 2),
		);
		expect(tail.messages.map((message) => message.messageId)).toEqual([rows[2]?.id]);
		expect(tail.nextAfterId).toBeNull();
		expect(tail.coverage).toEqual(first.coverage);
		for (const record of [...first.messages, ...tail.messages]) {
			expect(record.association).toBe("unverified");
			expect(record.mail.direction).toBe("inbound");
			expect(record.mail.auth.dmarc).toBe("none");
			expect(Object.isFrozen(record)).toBe(true);
			expect(Object.isFrozen(record.mail)).toBe(true);
			expect(Reflect.set(record.mail, "subject", "DYTEST changed")).toBe(false);
		}
	});

	it("paginates genuine parsed mail within the complete response byte budget", async () => {
		await withOwnedThreadWork(async (signal) => {
			const f = current();
			const messageCount = 36;
			const pageLease = f.lease();
			f.database.write((scope) =>
				f.metadata.applyPage(scope, pageLease, {
					...f.ref,
					expectedCursor: "DYTEST-ingest-page-1",
					expectedRevision: 1,
					cursor: "DYTEST-byte-page-2",
					changes: Array.from({ length: messageCount - 1 }, (_, index) => ({
						kind: "email.message" as const,
						providerId: `DYTEST-byte-message-${index}`,
						threadId: f.message.threadId,
						internalDate: 990_000,
						labelIds: ["INBOX"],
					})),
				}),
			);
			const messages = f.database.write((scope) => f.metadata.messages(scope, f.ref));
			expect(messages).toHaveLength(messageCount);
			// A real maximum-length plain body needs 120,000 UTF-8 bytes, without
			// changing the parser's 40,000-character or one MiB text limits.
			const body = "\u754c".repeat(40_000);
			let storedBytes = 0;
			let rawBytes = 0;
			for (const message of messages) {
				signal.throwIfAborted();
				const bytes = new TextEncoder().encode(
					[
						"From: dytest-sender@example.invalid",
						"To: dytest-owner@example.invalid",
						`Subject: DYTEST ${message.providerId}`,
						`Message-ID: <${message.id}@example.invalid>`,
						"Content-Type: text/plain; charset=utf-8",
						"Content-Transfer-Encoding: 8bit",
						"",
						body,
					].join("\r\n"),
				);
				try {
					expect(bytes.length <= RAW_CONTENT_MAX_BYTES).toBe(true);
					rawBytes += bytes.length;
					const blob = await f.project(bytes);
					signal.throwIfAborted();
					const record = await prepareBudgetRecord(f, message.id, blob, bytes, signal);
					expect(record.mail.body.text === body).toBe(true);
					storedBytes += Buffer.byteLength(JSON.stringify(record), "utf8");
				} finally {
					bytes.fill(0);
				}
			}
			expect(rawBytes < 5 * 1_048_576).toBe(true);
			expect(storedBytes > MAX_THREAD_PROJECTION_BYTES).toBe(true);
			const model = reader(f);
			let cursor: string | null = null;
			let terminated = false;
			let pageCount = 0;
			const observed: string[] = [];
			for (let index = 0; index <= messageCount; index++) {
				signal.throwIfAborted();
				const page = f.database.write((scope) =>
					model.read(scope, f.ref, f.message.threadId, cursor, 100),
				);
				pageCount++;
				expect(Buffer.byteLength(JSON.stringify(page), "utf8") <= MAX_THREAD_PROJECTION_BYTES).toBe(
					true,
				);
				expect(page.messages.length <= 100).toBe(true);
				observed.push(...page.messages.map((record) => record.messageId));
				if (page.nextAfterId === null) {
					terminated = true;
					break;
				}
				expect(cursor === null || page.nextAfterId > cursor).toBe(true);
				cursor = page.nextAfterId;
			}
			expect(pageCount > 1).toBe(true);
			expect(terminated).toBe(true);
			expect(observed).toEqual(messages.map((message) => message.id));
		});
	});

	it("continues past stale cached rows to a later genuinely re-ingested message", async () => {
		const f = current();
		const rows = await ingestRows(f);
		const lastMessage = rows.at(-1);
		if (!lastMessage) throw new Error("Synthetic thread rows unavailable");
		const retained = f.database.write((scope) => f.parsed.read(scope, f.ref, lastMessage.id));
		if (!retained) throw new Error("Synthetic parsed row unavailable");
		const oldCache = saveOldCache(
			f,
			rows.slice(0, -1).map((message) => message.id),
		);
		const pageLease = f.lease();
		f.database.write((scope) =>
			f.metadata.applyPage(scope, pageLease, {
				...f.ref,
				expectedCursor: "DYTEST-thread-page-2",
				expectedRevision: 2,
				cursor: "DYTEST-thread-page-3",
				changes: rows.slice(0, -1).map((message) => ({
					kind: "email.message" as const,
					providerId: message.providerId,
					threadId: message.threadId,
					internalDate: message.internalDate + 1,
					labelIds: [...message.labelIds],
				})),
			}),
		);
		restoreOldCache(f, oldCache);
		await f.ingestor.ingest(f.lease(lastMessage.id), f.ref, lastMessage.id, retained.raw);
		expect(
			f.native.store.read(
				(sql) =>
					sql.get<{ count: number }>("SELECT count(*) AS count FROM main.content_parsed_messages")
						?.count,
			),
		).toBe(3);
		const firstMessage = rows[0];
		if (!firstMessage) throw new Error("Synthetic first thread row unavailable");
		expect(
			f.database.write((scope) => f.parsed.read(scope, f.ref, firstMessage.id)),
		).toBeUndefined();
		const model = reader(f);
		let cursor: string | null = null;
		let terminated = false;
		const observed: string[] = [];
		for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
			const page = f.database.write((scope) =>
				model.read(scope, f.ref, f.message.threadId, cursor, 1),
			);
			observed.push(...page.messages.map((record) => record.messageId));
			expect(page.coverage).toEqual({ state: "unknown", reason: "provider-history-unproven" });
			if (page.nextAfterId === null) {
				terminated = true;
				break;
			}
			expect(cursor === null || page.nextAfterId > cursor).toBe(true);
			cursor = page.nextAfterId;
		}
		expect(terminated).toBe(true);
		expect(observed).toEqual([lastMessage.id]);
	});

	it("refuses an oversized provider key before serializing a thread envelope", () => {
		const f = current();
		const model = reader(f);
		const badThreadId = "X".repeat(257);
		const originalStringify = JSON.stringify;
		let serializedBadEnvelope = false;
		const passthrough = ((...args: unknown[]) => {
			const value = args[0];
			if (
				value !== null &&
				typeof value === "object" &&
				Object.getOwnPropertyDescriptor(value, "threadId")?.value === badThreadId
			)
				serializedBadEnvelope = true;
			return Reflect.apply(originalStringify, JSON, args);
		}) as typeof JSON.stringify;
		const spy = vi.spyOn(JSON, "stringify").mockImplementation(passthrough);
		try {
			expectThreadRefused(() => f.database.write((scope) => model.read(scope, f.ref, badThreadId)));
			expect(serializedBadEnvelope).toBe(false);
		} finally {
			spy.mockRestore();
		}
		expect(JSON.stringify).toBe(originalStringify);
	});

	it.each(["account", "generation", "epoch", "mode", "deadline"] as const)(
		"refuses a stale or mismatched %s against genuine native account state",
		(field) => {
			const f = current();
			const model = reader(f);
			let ref: MetadataAccountRef = f.ref;
			if (field === "account") ref = { ...ref, accountId: f.account.pluginInstanceId };
			else if (field === "generation") ref = { ...ref, generation: ref.generation + 1 };
			else if (field === "epoch") ref = { ...ref, ownerEpoch: ref.ownerEpoch + 1 };
			else if (field === "mode") ref = { ...ref, mode: "read_only" };
			else {
				expect(
					f.database.write((scope) => model.read(scope, ref, f.message.threadId)).coverage,
				).toEqual({ state: "unknown", reason: "provider-history-unproven" });
				const deadline = f.time.wall + 5_000;
				const changed = f.database.write((scope) =>
					f.accounts.replace(
						scope,
						{ ...f.account, status: "credential_lost", deletionDeadline: deadline },
						ref.generation,
					),
				);
				expect(changed.generation).toBe(ref.generation + 1);
				expect(changed.account.status).toBe("credential_lost");
				expect(changed.account.deletionDeadline).toBe(deadline);
				ref = { ...ref, generation: changed.generation };
				// A deadline belongs only to credential_lost accounts. The current
				// projection refuses that state before expiry as well as at expiry.
				expectThreadRefused(() =>
					f.database.write((scope) => model.read(scope, ref, f.message.threadId)),
				);
				f.time.wall += 5_000;
				f.time.monotonic += 5_000;
			}
			expectThreadRefused(() =>
				f.database.write((scope) => model.read(scope, ref, f.message.threadId)),
			);
		},
	);

	it("refuses original scopes from another store and original retired scopes", async () => {
		const f = current();
		const model = reader(f);
		const sibling = await fixture();
		try {
			expectThreadRefused(() =>
				sibling.database.write((scope) => model.read(scope, f.ref, f.message.threadId)),
			);
		} finally {
			await sibling.cleanup();
		}
		let retired: WorkScope | undefined;
		f.database.write((scope) => {
			retired = scope;
		});
		if (!retired) throw new Error("Synthetic original scope was not captured");
		const retiredScope = retired;
		expectThreadRefused(() => model.read(retiredScope, f.ref, f.message.threadId));
	});

	it.each(["plain", "copied-prototype"] as const)(
		"refuses a %s parsed-store substitute without invoking its shadow method",
		(shape) => {
			const f = current();
			let calls = 0;
			const fake = Object.create(shape === "plain" ? null : NativeParsedStore.prototype);
			Object.defineProperty(fake, "forThread", {
				value: () => {
					calls++;
					return [];
				},
			});
			const model = new NativeThreadReader(f.database, f.metadata, fake);
			expectThreadRefused(() =>
				f.database.write((scope) => model.read(scope, f.ref, f.message.threadId)),
			);
			expect(calls).toBe(0);
		},
	);

	it.each([0, 101, 1.5])("refuses an invalid row bound %s", (limit) => {
		const f = current();
		const model = reader(f);
		expectThreadRefused(() =>
			f.database.write((scope) => model.read(scope, f.ref, f.message.threadId, null, limit)),
		);
	});
});
