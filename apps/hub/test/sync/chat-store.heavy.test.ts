import { Buffer } from "node:buffer";
import type { ChatMessageChange, NormalizedChange } from "@draftyak/protocol/normalized-change";
import { Ulid } from "@draftyak/protocol/scalars";
import { describe, expect, it } from "vitest";
import type { WorkScope } from "../../src/jobs/database.ts";
import { JOB_LEASE_MS, type JobLease } from "../../src/jobs/queue.ts";
import { newId } from "../../src/kernel/ids.ts";
import type { MetadataAccountRef } from "../../src/sync/account-ref.ts";
import {
	CHAT_THREAD_MESSAGES,
	type ChatPageInput,
	NativeChatError,
	prepareChatPage,
} from "../../src/sync/chat-store.ts";
import { chatStoreFixture } from "./chat-store-fixture.ts";

type Fixture = Awaited<ReturnType<typeof chatStoreFixture>>;
type Resources = Fixture["initial"];
const CHANNEL = "C_DYTEST";
const ROOT = "1700000000.000001";
const SELECTION = { channelId: CHANNEL, threadTs: ROOT };
const COVERAGE = { state: "unknown", reason: "provider-history-unproven" };

async function withFixture(work: (fixture: Fixture) => void | Promise<void>): Promise<void> {
	const fixture = await chatStoreFixture();
	const outcome = await Promise.resolve()
		.then(() => work(fixture))
		.then(
			() => ({ ok: true as const }),
			(error: unknown) => ({ ok: false as const, error }),
		);
	try {
		await fixture.close();
	} catch (cleanupError) {
		if (!outcome.ok)
			throw new AggregateError([outcome.error, cleanupError], "Chat test cleanup failed");
		throw cleanupError;
	}
	if (!outcome.ok) throw outcome.error;
}

function message(index = 0, overrides: Partial<ChatMessageChange> = {}): ChatMessageChange {
	return {
		kind: "chat.message",
		channelId: CHANNEL,
		ts: index === 0 ? ROOT : `1700000000.${String(index + 1).padStart(6, "0")}`,
		...(index === 0 ? {} : { threadTs: ROOT }),
		sentAt: 1_700_000_000_000 + index,
		author: { kind: "user", id: "U_DYTEST" },
		text: `DYTEST message ${index}`,
		...overrides,
	};
}

function claim(
	fixture: Fixture,
	resources = fixture.initial,
	options: { accountId?: string; ownerId?: string; kind?: "sync" | "draft" } = {},
): JobLease {
	return resources.database.write((scope) => {
		const job = resources.queue.enqueue(scope, {
			id: newId(),
			accountId: options.accountId ?? fixture.ref.accountId,
			ownerId: options.ownerId ?? fixture.account.account.userId,
			kind: options.kind ?? "sync",
			refId: fixture.ref.pluginInstanceId,
		});
		const lease = resources.queue.claim(scope, job.accountId, job.id);
		if (!lease) throw new Error("DYTEST sync job was not claimable");
		return lease;
	});
}

function input(
	ref: MetadataAccountRef,
	changes: readonly NormalizedChange[],
	cursor = "page-1",
	expectedCursor: string | null = null,
	expectedRevision = 0,
): ChatPageInput {
	return { ...ref, expectedCursor, expectedRevision, cursor, changes };
}

function checkpoint(resources: Resources, ref: MetadataAccountRef) {
	return resources.database.write((scope) => resources.chat.checkpoint(scope, ref));
}

function read(resources: Resources, ref: MetadataAccountRef, selection = SELECTION) {
	return resources.database.write((scope) => resources.chat.readThread(scope, ref, selection));
}

function apply(
	fixture: Fixture,
	changes: readonly NormalizedChange[],
	cursor: string,
	resources = fixture.initial,
	ref = fixture.ref,
) {
	const previous = checkpoint(resources, ref);
	// DATA preparation is outside the native write; the lease remains the original Queue resource.
	const page = prepareChatPage(input(ref, changes, cursor, previous.cursor, previous.revision));
	const lease = claim(fixture, resources, { accountId: ref.accountId });
	const result = resources.database.write((scope) => resources.chat.applyPage(scope, lease, page));
	resources.database.write((scope) => resources.queue.complete(scope, result.lease));
	return result;
}

function storedCounts(resources: Resources) {
	return resources.database.write((scope) => {
		const sql = resources.database.sql(scope);
		const count = (query: string) => {
			const value = sql.get<{ count: number }>(query)?.count;
			if (!Number.isSafeInteger(value) || value === undefined || value < 0)
				throw new Error("DYTEST count was not a nonnegative integer");
			return value;
		};
		return {
			checkpoints: count("SELECT count(*) AS count FROM main.chatcontent_checkpoints"),
			messages: count("SELECT count(*) AS count FROM main.chatcontent_messages"),
			threads: count("SELECT count(*) AS count FROM main.chatcontent_threads"),
			events: count("SELECT count(*) AS count FROM main.events"),
		};
	});
}

describe("native chat storage", () => {
	it("snapshots hygienic content and preserves native thread and message IDs through replay and edit", async () => {
		await withFixture((fixture) => {
			const resources = fixture.initial;
			const raw = message(0, {
				text: "DYTEST https://docs.example.test/private?canary=hidden",
				subtype: "file_share",
				files: [{ id: "F_DYTEST", name: "DYTEST.txt", contentType: "text/plain", size: 7 }],
			});
			const changes = [raw, message(1)];
			const page = prepareChatPage(input(fixture.ref, changes));
			Object.assign(raw, {
				text: "DYTEST changed after preparation",
				author: { kind: "bot", id: "B_CHANGED" },
			});
			Object.assign(raw.files?.[0] ?? {}, { name: "CHANGED.txt" });
			changes.pop();
			const lease = claim(fixture);
			const first = resources.database.write((scope) =>
				resources.chat.applyPage(scope, lease, page),
			);
			expect(first.changedMessageIds).toHaveLength(2);
			expect(first.changedConversationIds).toHaveLength(1);
			expect(() =>
				resources.database.write((scope) => resources.queue.complete(scope, lease)),
			).toThrow();
			resources.database.write((scope) => resources.queue.complete(scope, first.lease));
			const original = read(resources, fixture.ref);
			expect(original.availability).toBe("available");
			expect(original.coverage).toEqual(COVERAGE);
			expect(Ulid.safeParse(original.conversationId).success).toBe(true);
			expect(original.messages).toHaveLength(2);
			expect(original.messages.every((row) => Ulid.safeParse(row.id).success)).toBe(true);
			expect(original.messages[0]).toMatchObject({
				ts: ROOT,
				author: { kind: "user", id: "U_DYTEST" },
				subtype: "file_share",
				files: [{ id: "F_DYTEST", name: "DYTEST.txt", contentType: "text/plain", size: 7 }],
				body: {
					text: "DYTEST [link 1: docs.example.test]",
					links: [{ index: 1, host: "docs.example.test" }],
				},
			});
			expect(JSON.stringify(original)).not.toContain("canary=hidden");
			const replay = apply(
				fixture,
				[
					message(0, {
						text: "DYTEST https://docs.example.test/private?canary=hidden",
						subtype: "file_share",
						files: [{ id: "F_DYTEST", name: "DYTEST.txt", contentType: "text/plain", size: 7 }],
					}),
					message(1),
				],
				"page-2",
			);
			expect(replay.changedMessageIds).toEqual([]);
			expect(replay.changedConversationIds).toEqual([]);
			const edited = apply(
				fixture,
				[message(1, { text: "DYTEST edited reply", editedAt: 1_700_000_000_010 })],
				"page-3",
			);
			const current = read(resources, fixture.ref);
			expect(current.conversationId).toBe(original.conversationId);
			expect(current.messages.map((row) => row.id)).toEqual(original.messages.map((row) => row.id));
			expect(current.messages[1]?.body.text).toBe("DYTEST edited reply");
			expect(current.threadRevision).toBe(3);
			expect(edited.changedMessageIds).toEqual([original.messages[1]?.id]);
			expect(current.checkpoint).toEqual({ cursor: "page-3", revision: 3 });
		});
	});

	it("reopens the same encrypted database without changing owner, epoch, thread ID or checkpoint", async () => {
		await withFixture(async (fixture) => {
			apply(fixture, [message(), message(1)], "before-reopen");
			const before = read(fixture.initial, fixture.ref);
			const state = fixture.initial.registry.currentState();
			const reopened = await fixture.reopen();
			expect(reopened.store).not.toBe(fixture.initial.store);
			expect(reopened.registry.currentState()).toEqual(state);
			expect(read(reopened, fixture.ref)).toEqual(before);
			apply(fixture, [message(2)], "after-reopen", reopened);
			const after = read(reopened, fixture.ref);
			expect(after.conversationId).toBe(before.conversationId);
			expect(after.messages.slice(0, 2)).toEqual(before.messages);
			expect(after.checkpoint).toEqual({ cursor: "after-reopen", revision: 2 });
		});
	});

	it("fences account, plugin, epoch and mode DATA against the real current account and registry", async () => {
		await withFixture((fixture) => {
			for (const replacement of [
				{ accountId: newId() },
				{ pluginInstanceId: newId() },
				{ ownerEpoch: fixture.ref.ownerEpoch + 1 },
				{ mode: "read_only" as const },
			]) {
				const page = prepareChatPage(input({ ...fixture.ref, ...replacement }, [message()]));
				const lease = claim(fixture);
				const before = storedCounts(fixture.initial);
				expect(() =>
					fixture.initial.database.write((scope) =>
						fixture.initial.chat.applyPage(scope, lease, page),
					),
				).toThrow(NativeChatError);
				expect(storedCounts(fixture.initial)).toEqual(before);
				expect(checkpoint(fixture.initial, fixture.ref)).toEqual({ cursor: null, revision: 0 });
				fixture.initial.database.write((scope) =>
					fixture.initial.queue.cancel(scope, lease.job.id),
				);
			}
		});
	});

	it("isolates generations using actual account replacement and a new native conversation mapping", async () => {
		await withFixture((fixture) => {
			apply(fixture, [message()], "generation-1");
			const oldThread = read(fixture.initial, fixture.ref);
			const replacement = fixture.initial.database.write((scope) =>
				fixture.initial.accounts.replace(
					scope,
					{
						...fixture.account.account,
						alias: "dytest-generation-2",
					},
					fixture.account.generation,
				),
			);
			expect(replacement.generation).toBe(fixture.ref.generation + 1);
			expect(() => checkpoint(fixture.initial, fixture.ref)).toThrow(NativeChatError);
			const currentRef = { ...fixture.ref, generation: replacement.generation };
			expect(checkpoint(fixture.initial, currentRef)).toEqual({ cursor: null, revision: 0 });
			expect(read(fixture.initial, currentRef).availability).toBe("missing");
			apply(fixture, [message()], "generation-2", fixture.initial, currentRef);
			const current = read(fixture.initial, currentRef);
			expect(current.conversationId).not.toBe(oldThread.conversationId);
			expect(current.messages[0]?.id).not.toBe(oldThread.messages[0]?.id);
			expect(current.coverage).toEqual(COVERAGE);
		});
	});

	it("rejects genuinely issued jobs with the wrong account, kind or owner and expired original leases", async () => {
		await withFixture((fixture) => {
			const page = prepareChatPage(input(fixture.ref, [message()]));
			const other = fixture.initial.database.write((scope) =>
				fixture.initial.accounts.create(scope, {
					...fixture.account.account,
					id: newId(),
					pluginInstanceId: newId(),
					alias: "dytest-other-account",
				}),
			);
			for (const options of [
				{ accountId: other.account.id },
				{ kind: "draft" as const },
				{ ownerId: newId() },
			]) {
				const lease = claim(fixture, fixture.initial, options);
				expect(() =>
					fixture.initial.database.write((scope) =>
						fixture.initial.chat.applyPage(scope, lease, page),
					),
				).toThrow(NativeChatError);
				fixture.initial.database.write((scope) =>
					fixture.initial.queue.cancel(scope, lease.job.id),
				);
			}
			const expired = claim(fixture);
			fixture.clock.wall += JOB_LEASE_MS + 1;
			fixture.clock.monotonic += JOB_LEASE_MS + 1;
			expect(() =>
				fixture.initial.database.write((scope) =>
					fixture.initial.chat.applyPage(scope, expired, page),
				),
			).toThrow(NativeChatError);
			expect(checkpoint(fixture.initial, fixture.ref)).toEqual({ cursor: null, revision: 0 });
			expect(read(fixture.initial, fixture.ref).availability).toBe("missing");
			fixture.initial.database.write((scope) =>
				fixture.initial.queue.cancel(scope, expired.job.id),
			);
		});
	});

	it("poisons the original scope even when a cursor CAS failure is caught inside its write", async () => {
		await withFixture((fixture) => {
			apply(fixture, [message()], "page-1");
			const page = prepareChatPage(input(fixture.ref, [message(1)], "page-2", "wrong-cursor", 1));
			const lease = claim(fixture);
			const before = storedCounts(fixture.initial);
			let caught: unknown;
			expect(() =>
				fixture.initial.database.write((scope) => {
					try {
						fixture.initial.chat.applyPage(scope, lease, page);
					} catch (error) {
						caught = error;
					}
				}),
			).toThrow();
			expect(caught).toBeInstanceOf(NativeChatError);
			expect(storedCounts(fixture.initial)).toEqual(before);
			expect(checkpoint(fixture.initial, fixture.ref)).toEqual({ cursor: "page-1", revision: 1 });
			expect(read(fixture.initial, fixture.ref).messages).toHaveLength(1);
			expect(() =>
				fixture.initial.database.write((scope) => fixture.initial.queue.complete(scope, lease)),
			).toThrow();
			fixture.initial.database.write((scope) => fixture.initial.queue.cancel(scope, lease.job.id));
		});
	});

	it("rolls content and events back while neither consumed lease handle revives", async () => {
		await withFixture((fixture) => {
			const page = prepareChatPage(input(fixture.ref, [message()]));
			const lease = claim(fixture);
			const before = storedCounts(fixture.initial);
			let replacement: JobLease | undefined;
			const rollback = new Error("DYTEST forced outer rollback");
			expect(() =>
				fixture.initial.database.write((scope) => {
					replacement = fixture.initial.chat.applyPage(scope, lease, page).lease;
					throw rollback;
				}),
			).toThrow(rollback);
			expect(replacement).toBeDefined();
			expect(storedCounts(fixture.initial)).toEqual(before);
			expect(read(fixture.initial, fixture.ref).availability).toBe("missing");
			expect(() =>
				fixture.initial.database.write((scope) => fixture.initial.queue.complete(scope, lease)),
			).toThrow();
			if (!replacement) throw new Error("DYTEST renewed lease missing");
			const renewed = replacement;
			expect(() =>
				fixture.initial.database.write((scope) => fixture.initial.queue.complete(scope, renewed)),
			).toThrow();
			fixture.initial.database.write((scope) => fixture.initial.queue.cancel(scope, lease.job.id));
		});
	});

	it("withholds reply-only history and never resurrects a deleted root from a valid later replay page", async () => {
		await withFixture((fixture) => {
			const missing = read(fixture.initial, fixture.ref);
			expect(missing).toMatchObject({
				availability: "missing",
				conversationId: null,
				messages: [],
				coverage: COVERAGE,
			});
			apply(fixture, [message(1)], "replies-only");
			const withheld = read(fixture.initial, fixture.ref);
			expect(withheld).toMatchObject({
				availability: "withheld",
				messages: [],
				coverage: COVERAGE,
			});
			expect(Ulid.safeParse(withheld.conversationId).success).toBe(true);
			apply(fixture, [message()], "root-arrives");
			const available = read(fixture.initial, fixture.ref);
			expect(available.availability).toBe("available");
			expect(available.messages).toHaveLength(2);
			apply(fixture, [{ kind: "chat.deleted", channelId: CHANNEL, ts: ROOT }], "root-deleted");
			expect(read(fixture.initial, fixture.ref)).toMatchObject({
				availability: "withheld",
				messages: [],
				coverage: COVERAGE,
			});
			const replay = apply(fixture, [message()], "old-root-replayed");
			expect(replay.checkpoint).toEqual({ cursor: "old-root-replayed", revision: 4 });
			expect(replay.changedMessageIds).toEqual([]);
			expect(replay.changedConversationIds).toEqual([]);
			expect(read(fixture.initial, fixture.ref)).toMatchObject({
				conversationId: available.conversationId,
				availability: "withheld",
				messages: [],
				coverage: COVERAGE,
			});
		});
	});

	it("keeps the latest edit when older edited and unedited payloads arrive at valid new checkpoints", async () => {
		await withFixture((fixture) => {
			apply(fixture, [message(), message(1)], "initial");
			apply(
				fixture,
				[message(1, { text: "DYTEST latest edit", editedAt: 1_700_000_000_020 })],
				"newer",
			);
			const latest = read(fixture.initial, fixture.ref);
			const oldEdit = apply(
				fixture,
				[message(1, { text: "DYTEST old edit", editedAt: 1_700_000_000_010 })],
				"older",
			);
			const unedited = apply(fixture, [message(1)], "unedited-replay");
			expect(oldEdit.checkpoint).toEqual({ cursor: "older", revision: 3 });
			expect(unedited.checkpoint).toEqual({ cursor: "unedited-replay", revision: 4 });
			expect(oldEdit.changedMessageIds).toEqual([]);
			expect(unedited.changedMessageIds).toEqual([]);
			const current = read(fixture.initial, fixture.ref);
			expect(current.conversationId).toBe(latest.conversationId);
			expect(current.messages).toEqual(latest.messages);
			expect(current.threadRevision).toBe(latest.threadRevision);
			expect(current.messages[1]).toMatchObject({
				body: { text: "DYTEST latest edit" },
				editedAt: 1_700_000_000_020,
			});
		});
	});

	it("canonicalizes equivalent root replay but rejects equal-version conflict and creation-time mutation atomically", async () => {
		await withFixture((fixture) => {
			apply(
				fixture,
				[message(), message(1, { text: "DYTEST reviewed edit", editedAt: 1_700_000_000_020 })],
				"initial",
			);
			const beforeReplay = read(fixture.initial, fixture.ref);
			const equivalent = apply(fixture, [message(0, { threadTs: ROOT })], "equivalent-root");
			expect(equivalent.changedMessageIds).toEqual([]);
			expect(equivalent.changedConversationIds).toEqual([]);
			expect(read(fixture.initial, fixture.ref).messages).toEqual(beforeReplay.messages);
			for (const conflicting of [
				message(1, { text: "DYTEST conflicting same-version body", editedAt: 1_700_000_000_020 }),
				message(1, {
					text: "DYTEST newer edit with changed creation time",
					editedAt: 1_700_000_000_030,
					sentAt: 1_700_000_000_002,
				}),
			]) {
				const page = prepareChatPage(
					input(fixture.ref, [conflicting], "conflict", "equivalent-root", 2),
				);
				const lease = claim(fixture);
				const before = storedCounts(fixture.initial);
				let caught: unknown;
				expect(() =>
					fixture.initial.database.write((scope) => {
						try {
							fixture.initial.chat.applyPage(scope, lease, page);
						} catch (error) {
							caught = error;
						}
					}),
				).toThrow();
				expect(caught).toBeInstanceOf(NativeChatError);
				expect(storedCounts(fixture.initial)).toEqual(before);
				const after = read(fixture.initial, fixture.ref);
				expect(after.messages).toEqual(beforeReplay.messages);
				expect(after.checkpoint).toEqual({ cursor: "equivalent-root", revision: 2 });
				expect(after.threadRevision).toBe(beforeReplay.threadRevision);
				fixture.initial.database.write((scope) =>
					fixture.initial.queue.cancel(scope, lease.job.id),
				);
			}
		});
	});

	it("returns explicit empty truncation beyond the message limit without claiming complete history", async () => {
		await withFixture((fixture) => {
			apply(
				fixture,
				Array.from({ length: CHAT_THREAD_MESSAGES + 1 }, (_, index) => message(index)),
				"too-many",
			);
			expect(read(fixture.initial, fixture.ref)).toMatchObject({
				availability: "truncated",
				messages: [],
				coverage: COVERAGE,
				checkpoint: { cursor: "too-many", revision: 1 },
			});
		});
	});

	it("returns empty byte truncation for a sub-100-message thread accumulated over bounded pages", async () => {
		await withFixture((fixture) => {
			const text = "\u{1F600}".repeat(40_000);
			expect(Buffer.byteLength(text)).toBe(160_000);
			for (let page = 0; page < 3; page++) {
				apply(
					fixture,
					Array.from({ length: 18 }, (_, offset) => message(page * 18 + offset, { text })),
					`large-${page}`,
				);
			}
			expect(read(fixture.initial, fixture.ref)).toMatchObject({
				availability: "truncated",
				messages: [],
				coverage: COVERAGE,
				checkpoint: { cursor: "large-2", revision: 3 },
			});
		});
	});

	it("rejects retired scopes, foreign database scopes and a retired projection without issuing authority", async () => {
		await withFixture(async (fixture) => {
			let expiredScope: WorkScope | undefined;
			fixture.initial.database.write((scope) => {
				expiredScope = scope;
			});
			if (!expiredScope) throw new Error("DYTEST original scope missing");
			const originalScope = expiredScope;
			expect(() => fixture.initial.chat.checkpoint(originalScope, fixture.ref)).toThrow(
				NativeChatError,
			);
			await withFixture((other) => {
				expect(() =>
					other.initial.database.write((scope) =>
						fixture.initial.chat.checkpoint(scope, fixture.ref),
					),
				).toThrow(NativeChatError);
				// The foreign database still owns its own scopes; rejection is not a fabricated poison claim.
				expect(checkpoint(other.initial, other.ref)).toEqual({ cursor: null, revision: 0 });
			});
			fixture.initial.chat.retire();
			expect(() => checkpoint(fixture.initial, fixture.ref)).toThrow(NativeChatError);
		});
	});

	it("refuses changed persisted body DATA rather than returning a message with a stale digest", async () => {
		await withFixture((fixture) => {
			apply(fixture, [message()], "original");
			const original = read(fixture.initial, fixture.ref);
			const row = original.messages[0];
			if (!row) throw new Error("DYTEST stored root missing");
			fixture.initial.database.write((scope) => {
				const sql = fixture.initial.database.sql(scope);
				const stored = sql.get<{ json: string }>(
					"SELECT payload_json AS json FROM main.chatcontent_messages WHERE id=?",
					[row.id],
				);
				if (!stored) throw new Error("DYTEST stored payload missing");
				const altered = stored.json.replace("DYTEST message 0", "DYTEST altered body");
				expect(altered).not.toBe(stored.json);
				expect(
					sql.run("UPDATE main.chatcontent_messages SET payload_json=? WHERE id=?", [
						altered,
						row.id,
					]).changes,
				).toBe(1);
			});
			expect(() => read(fixture.initial, fixture.ref)).toThrow(NativeChatError);
			expect(checkpoint(fixture.initial, fixture.ref)).toEqual({ cursor: "original", revision: 1 });
		});
	});

	it("refuses forged prepared handles, accessors and non-chat pages before content can be stored", async () => {
		await withFixture((fixture) => {
			let reads = 0;
			const accessor = Object.defineProperty(input(fixture.ref, [message()]), "changes", {
				enumerable: true,
				get() {
					reads++;
					return [message()];
				},
			});
			expect(() => prepareChatPage(accessor)).toThrow(NativeChatError);
			expect(reads).toBe(0);
			expect(() =>
				prepareChatPage(input(fixture.ref, [{ kind: "email.deleted", providerId: "DYTEST" }])),
			).toThrow(NativeChatError);
			expect(() =>
				prepareChatPage(
					input(
						fixture.ref,
						Array.from({ length: 501 }, () => message()),
					),
				),
			).toThrow(NativeChatError);
			expect(() =>
				prepareChatPage(input(fixture.ref, [message(1, { editedAt: 1_700_000_000_000 })])),
			).toThrow(NativeChatError);
			const lease = claim(fixture);
			const forged = {} as ReturnType<typeof prepareChatPage>;
			expect(() =>
				fixture.initial.database.write((scope) =>
					fixture.initial.chat.applyPage(scope, lease, forged),
				),
			).toThrow(NativeChatError);
			// Refusing inert DATA before Queue.renew does not consume the independently issued lease.
			fixture.initial.database.write((scope) => fixture.initial.queue.complete(scope, lease));
			expect(checkpoint(fixture.initial, fixture.ref)).toEqual({ cursor: null, revision: 0 });
		});
	});
});
