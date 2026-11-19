import { Buffer } from "node:buffer";
import { lstat, mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseMail } from "@draftyak/content";
import type { Account } from "@draftyak/protocol/entities/account";
import { jcsSha256 } from "@draftyak/protocol/hash";
import type { BlobRef, NormalizedChange } from "@draftyak/protocol/normalized-change";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftBinding, DraftCreation } from "../../src/drafts/revisions.ts";
import type { WorkScope } from "../../src/jobs/database.ts";
import type { MetadataAccountRef } from "../../src/sync/apply.ts";
import type { NativeParsedRecord } from "../../src/sync/parsed.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ NativeAccounts },
	{ NativeDraftRevisions },
	{ NativeReplySourceStore, ReplySourceError, REPLY_SOURCE_NAMESPACE, REPLY_SOURCE_MIGRATIONS },
	{ EventLog },
	{ WorkDatabase },
	{ JobQueue },
	{ newId },
	{ HUB_NAMESPACES },
	{ CONTENT_MIGRATIONS, NativeMetadataStore },
	{ RAW_CONTENT_MIGRATIONS, NativeRawStore },
	{ NativeParsedStore },
	{ createJsonMemberDecoder, writeJsonMember },
	{ bootstrap, closeFixture, fixture: nativeFixture, owner },
] = await Promise.all([
	import("../../src/accounts/records.ts"),
	import("../../src/drafts/revisions.ts"),
	import("../../src/drafts/reply-source.ts"),
	import("../../src/events/log.ts"),
	import("../../src/jobs/database.ts"),
	import("../../src/jobs/queue.ts"),
	import("../../src/kernel/ids.ts"),
	import("../../src/kernel/namespaces.ts"),
	import("../../src/sync/apply.ts"),
	import("../../src/sync/raw-store.ts"),
	import("../../src/sync/parsed.ts"),
	import("../../src/plugins/broker/blob/index.ts"),
	import("../authz/native-fixture.ts"),
]);

type NativeFixture = Awaited<ReturnType<typeof nativeFixture>>;
type EmailAccount = Extract<Account, { channel: "email" }>;
interface OwnedFixture {
	native: NativeFixture;
	revisions?: InstanceType<typeof NativeDraftRevisions>;
	replies?: InstanceType<typeof NativeReplySourceStore>;
	closed?: boolean;
}
interface Fixture {
	native: NativeFixture;
	store: NativeFixture["store"];
	database: InstanceType<typeof WorkDatabase>;
	accounts: InstanceType<typeof NativeAccounts>;
	jobs: InstanceType<typeof JobQueue>;
	metadata: InstanceType<typeof NativeMetadataStore>;
	raw: InstanceType<typeof NativeRawStore>;
	parsed: InstanceType<typeof NativeParsedStore>;
	revisions: InstanceType<typeof NativeDraftRevisions>;
	replies: InstanceType<typeof NativeReplySourceStore>;
	account: EmailAccount;
	ref(overrides?: Partial<MetadataAccountRef>): MetadataAccountRef;
	apply(changes: readonly NormalizedChange[]): void;
	seed(body?: string, messageId?: string): Promise<NativeParsedRecord>;
}
const owned: OwnedFixture[] = [];
interface OwnedMigration {
	directory: string;
	parent: string;
	dev?: bigint;
	ino?: bigint;
	removed?: boolean;
	pendingSetup?: boolean;
}
const ownedMigrations: OwnedMigration[] = [];

async function failureMigration(): Promise<OwnedMigration> {
	const parent = await realpath(tmpdir());
	const directory = await mkdtemp(path.join(parent, "dytest-reply-migration-"));
	const custody: OwnedMigration = {
		directory: path.resolve(directory),
		parent: path.resolve(parent),
	};
	ownedMigrations.push(custody);
	const stat = await lstat(directory, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink())
		throw new Error("DYTEST reply migration directory unavailable");
	custody.dev = stat.dev;
	custody.ino = stat.ino;
	await writeFile(
		path.join(directory, "0001_insert_failure.sql"),
		"CREATE TRIGGER dytest_reply_insert_fail BEFORE INSERT ON native_reply_sources BEGIN SELECT RAISE(ABORT, 'DYTEST reply insert failure'); END;\n",
		{ flag: "wx" },
	);
	return custody;
}

async function removeMigration(custody: OwnedMigration): Promise<void> {
	const directory = path.resolve(custody.directory);
	if (
		path.dirname(directory).toLowerCase() !== custody.parent.toLowerCase() ||
		!path.basename(directory).startsWith("dytest-reply-migration-")
	)
		throw new Error("DYTEST reply migration cleanup path refused");
	const stat = await lstat(directory, { bigint: true });
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.dev !== custody.dev ||
		stat.ino !== custody.ino ||
		(await realpath(directory)).toLowerCase() !== directory.toLowerCase()
	)
		throw new Error("DYTEST reply migration cleanup identity refused");
	const sql = path.join(directory, "0001_insert_failure.sql");
	try {
		const file = await lstat(sql);
		if (!file.isFile() || file.isSymbolicLink())
			throw new Error("DYTEST reply migration cleanup file refused");
		await unlink(sql);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	await rmdir(directory);
	custody.removed = true;
}

beforeEach(() => {
	if (owned.length || ownedMigrations.length)
		throw new Error("DYTEST unresolved reply fixture cleanup");
});
afterEach(async () => {
	const errors: unknown[] = [];
	for (const fixture of [...owned].reverse()) {
		if (fixture.closed) continue;
		try {
			fixture.replies?.destroy();
		} catch (error) {
			errors.push(error);
		}
		try {
			fixture.revisions?.destroy();
		} catch (error) {
			errors.push(error);
		}
		try {
			await closeFixture(fixture.native);
			fixture.closed = true;
		} catch (error) {
			errors.push(error);
		}
	}
	if (owned.every((fixture) => fixture.closed)) {
		for (const migration of [...ownedMigrations].reverse()) {
			if (migration.removed) continue;
			if (migration.pendingSetup) {
				errors.push(new Error("DYTEST unresolved native reply migration setup"));
				continue;
			}
			try {
				await removeMigration(migration);
			} catch (error) {
				errors.push(error);
			}
		}
	}
	if (errors.length) throw new AggregateError(errors, "DYTEST reply fixture cleanup failed");
	owned.length = 0;
	ownedMigrations.length = 0;
});

async function fixture(failLinkInsert = false): Promise<Fixture> {
	const failing = failLinkInsert ? await failureMigration() : undefined;
	if (failing) failing.pendingSetup = true;
	const native = await nativeFixture({
		...Object.fromEntries(
			Object.entries(HUB_NAMESPACES).filter(
				([name]) => !["audit", "core", "devices"].includes(name),
			),
		),
		content: CONTENT_MIGRATIONS,
		rawcontent: RAW_CONTENT_MIGRATIONS,
		[REPLY_SOURCE_NAMESPACE]: REPLY_SOURCE_MIGRATIONS,
		...(failing ? { replyfailure: failing.directory } : {}),
	});
	const custody: OwnedFixture = { native };
	owned.push(custody);
	if (failing) failing.pendingSetup = false;
	await bootstrap(native);
	const clock = { wallMs: () => 1_000_000, monotonicMs: () => 50_000 };
	const database = new WorkDatabase(native.store);
	const events = new EventLog(database, clock.wallMs);
	const accounts = new NativeAccounts(database, events, native.audit, clock.wallMs);
	const jobs = new JobQueue(database, events, clock);
	const metadata = new NativeMetadataStore(
		database,
		accounts,
		native.registry,
		jobs,
		events,
		clock,
	);
	const raw = new NativeRawStore(database, accounts, native.registry, clock);
	const parsed = new NativeParsedStore(database, accounts, native.registry, jobs, metadata, raw);
	const revisions = new NativeDraftRevisions(native.store, native.audit, native.key, clock);
	custody.revisions = revisions;
	const replies = new NativeReplySourceStore(database, native.store, revisions, parsed, native.key);
	custody.replies = replies;
	const account: EmailAccount = {
		channel: "email",
		id: newId(),
		userId: owner(native),
		alias: "dytest-reply-mailbox",
		mode: "full",
		status: "active",
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: 1000,
		pluginInstanceId: newId(),
		address: "dytest-reply@example.invalid",
	};
	database.write((scope) => accounts.create(scope, account));
	const ownerEpoch = native.store.read((sql) => native.registry.state(sql).epoch);
	const ref = (overrides: Partial<MetadataAccountRef> = {}): MetadataAccountRef => ({
		accountId: account.id,
		generation: 1,
		pluginInstanceId: account.pluginInstanceId,
		ownerEpoch,
		mode: account.mode,
		...overrides,
	});
	const lease = (messageId: string) =>
		database.write((scope) => {
			const jobId = newId();
			jobs.enqueue(scope, {
				id: jobId,
				accountId: account.id,
				ownerId: account.userId,
				kind: "sync",
				refId: messageId,
			});
			const claimed = jobs.claim(scope, account.id, jobId);
			if (!claimed) throw new Error("DYTEST reply source job not claimed");
			return claimed;
		});
	const apply = (changes: readonly NormalizedChange[]): void => {
		const checkpoint = database.write((scope) => metadata.checkpoint(scope, ref()));
		const handle = lease(newId());
		database.write((scope) =>
			metadata.applyPage(scope, handle, {
				...ref(),
				expectedCursor: checkpoint.cursor,
				expectedRevision: checkpoint.revision,
				cursor: `DYTEST-reply-cursor-${checkpoint.revision + 1}`,
				changes,
			}),
		);
	};
	const project = async (bytes: Uint8Array): Promise<BlobRef> => {
		const writer = database.write((scope) => raw.begin(scope, ref()));
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
		try {
			return await writeJsonMember(decoder, entity(), writer, new AbortController().signal);
		} finally {
			document.fill(0);
		}
	};
	const seed = async (
		body = "Synthetic original incoming mail",
		existingId?: string,
	): Promise<NativeParsedRecord> => {
		let messageId = existingId;
		if (messageId === undefined) {
			const providerId = `DYTEST-reply-${newId()}`;
			apply([emailMessage(providerId)]);
			messageId = database.write(
				(scope) =>
					metadata.messages(scope, ref()).find((message) => message.providerId === providerId)?.id,
			);
		}
		if (!messageId) throw new Error("DYTEST original reply metadata missing");
		const bytes = new TextEncoder().encode(
			`From: Sender <sender@example.invalid>\r\nTo: ${account.address}\r\nSubject: Synthetic original\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${body}`,
		);
		try {
			const blob = await project(bytes);
			const handle = lease(messageId);
			const source = database.write((scope) =>
				parsed.capture(scope, handle, ref(), messageId, blob),
			);
			for (let pass = 0; pass < 2; pass++) {
				let offset = 0;
				for (;;) {
					const slice = database.write((scope) => parsed.readSource(scope, source, offset, 4096));
					try {
						if (slice.nextOffset === null) break;
						offset = slice.nextOffset;
					} finally {
						slice.bytes.fill(0);
					}
				}
			}
			const mail = await parseMail(bytes, {
				provider: "generic",
				ownerAddresses: [account.address],
			});
			return database.write((scope) => parsed.commit(scope, source, mail));
		} finally {
			bytes.fill(0);
		}
	};
	return {
		native,
		store: native.store,
		database,
		accounts,
		jobs,
		metadata,
		raw,
		parsed,
		revisions,
		replies,
		account,
		ref,
		apply,
		seed,
	};
}

function emailMessage(providerId: string) {
	return {
		kind: "email.message" as const,
		providerId,
		threadId: "DYTEST-reply-thread",
		internalDate: 990_000,
		labelIds: ["INBOX"],
		sizeBytes: 123,
	};
}
function creation(f: Fixture, source: NativeParsedRecord): DraftCreation {
	return {
		draftId: newId(),
		accountId: f.account.id,
		conversationId: source.conversationId,
		channel: "email",
		author: { kind: "owner", id: f.account.userId },
		content: {
			channel: "email",
			to: ["sender@example.invalid"],
			cc: [],
			bcc: [],
			subject: "Re: Synthetic original",
			body: "Synthetic reply",
			attachments: [],
		},
		flags: [{ code: "EXTERNAL_LINK", severity: "ack" }],
	};
}
function binding(input: DraftCreation): DraftBinding {
	return {
		draftId: input.draftId,
		accountId: input.accountId,
		conversationId: input.conversationId,
		channel: input.channel,
	};
}
function snapshot(f: Fixture) {
	return f.store.read((sql) => {
		f.native.audit.verify(sql);
		return {
			drafts: sql.get<{ n: number }>("SELECT count(*) AS n FROM main.native_drafts")?.n,
			revisions: sql.get<{ n: number }>("SELECT count(*) AS n FROM main.native_draft_revisions")?.n,
			links: sql.get<{ n: number }>("SELECT count(*) AS n FROM main.native_reply_sources")?.n,
			auditEvents: sql.get<{ n: number }>("SELECT count(*) AS n FROM main.audit_events")?.n,
		};
	});
}
function savedLink(f: Fixture, draftId: string): { payload: string; mac: string } {
	const row = f.store.read((sql) =>
		sql.get<{ payload: string; mac: string }>(
			"SELECT payload,mac FROM main.native_reply_sources WHERE draft_id=?",
			[draftId],
		),
	);
	if (!row) throw new Error("DYTEST genuine reply association missing");
	return row;
}
function replaceLink(f: Fixture, draftId: string, row: { payload: string; mac: string }): void {
	// Negative corruption only: the positive row always comes from the genuine module.
	f.store.write((sql) => {
		sql.run("DELETE FROM main.native_reply_sources WHERE draft_id=?", [draftId]);
		sql.run(
			"INSERT INTO main.native_reply_sources(draft_id,initial_rev,payload,mac) VALUES(?,1,?,?)",
			[draftId, row.payload, row.mac],
		);
	});
}

describe("native immutable reply source association", () => {
	it("creates the draft and unverified original-source link on the same genuine live transaction", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		const associated = f.database.write((scope) => {
			const original = f.database.sql(scope);
			const result = f.replies.create(scope, input, {
				account: f.ref(),
				messageId: source.messageId,
			});
			expect(f.database.sql(scope)).toBe(original);
			const current = f.revisions.currentInTransaction(original, binding(input));
			expect(current.revision.rev).toBe(1);
			expect(result.initialRevisionSha256).toBe(jcsSha256(current.revision));
			return result;
		});
		expect(associated.binding).toEqual(binding(input));
		expect(associated.initialRev).toBe(1);
		expect(associated.currentRev).toBe(1);
		expect(associated.association).toBe("unverified");
		expect(associated.source).toMatchObject({
			account: f.ref(),
			messageId: source.messageId,
			providerId: source.providerId,
			threadId: source.threadId,
			conversationId: source.conversationId,
			raw: source.raw,
			rawSha256: source.rawSha256,
			rawBytes: source.rawBytes,
			sourceCheckpoint: source.sourceCheckpoint,
		});
		expect(associated.source.mailSha256).toBe(jcsSha256(source.mail));
		expect(associated).not.toHaveProperty("mail");
		expect(associated.source).not.toHaveProperty("mail");
		expect(Object.isFrozen(associated)).toBe(true);
		expect(Object.isFrozen(associated.source.account)).toBe(true);
		expect(f.database.write((scope) => f.replies.read(scope, binding(input)))).toEqual(associated);
	});

	it("keeps the authenticated initial source and revision through an ordinary append", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		const first = f.database.write((scope) =>
			f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
		);
		const row = savedLink(f, input.draftId);
		f.database.write((scope) =>
			f.revisions.appendInTransaction(f.database.sql(scope), {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "Owner edited reply" },
			}),
		);
		const later = f.database.write((scope) => f.replies.read(scope, binding(input)));
		expect(later.currentRev).toBe(2);
		expect(later.initialRev).toBe(1);
		expect(later.initialRevisionSha256).toBe(first.initialRevisionSha256);
		expect(later.source).toEqual(first.source);
		expect(savedLink(f, input.draftId)).toEqual(row);
	});

	it("rolls creation, source link and audit back when the enclosing original write fails", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source),
			before = snapshot(f);
		expect(() =>
			f.database.write((scope) => {
				f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId });
				throw new Error("DYTEST late enclosing failure");
			}),
		).toThrow("DYTEST late enclosing failure");
		expect(snapshot(f)).toEqual(before);
	});

	it("poisons the genuine scope after a late link INSERT failure even when the caller catches it", async () => {
		const f = await fixture(true),
			source = await f.seed(),
			input = creation(f, source);
		const before = snapshot(f);
		let caught = false;
		expect(() =>
			f.database.write((scope) => {
				try {
					f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId });
				} catch (error) {
					expect(error).toBeInstanceOf(ReplySourceError);
					caught = true;
				}
			}),
		).toThrow();
		expect(caught).toBe(true);
		expect(snapshot(f)).toEqual(before);
	});

	it("refuses wrong account, generation, owner epoch, plugin, mode, conversation and chat inputs", async () => {
		const f = await fixture(),
			source = await f.seed(),
			before = snapshot(f);
		const selections = [
			f.ref({ accountId: newId() }),
			f.ref({ generation: 2 }),
			f.ref({ ownerEpoch: f.ref().ownerEpoch + 1 }),
			f.ref({ pluginInstanceId: newId() }),
			f.ref({ mode: "read_only" }),
		];
		for (const account of selections)
			expect(() =>
				f.database.write((scope) =>
					f.replies.create(scope, creation(f, source), { account, messageId: source.messageId }),
				),
			).toThrow(ReplySourceError);
		for (const change of [{ accountId: newId() }, { conversationId: newId() }])
			expect(() =>
				f.database.write((scope) =>
					f.replies.create(
						scope,
						{ ...creation(f, source), ...change },
						{ account: f.ref(), messageId: source.messageId },
					),
				),
			).toThrow(ReplySourceError);
		const chat = {
			...creation(f, source),
			channel: "chat" as const,
			content: {
				channel: "chat" as const,
				body: "Synthetic chat reply",
				threadTs: null,
				broadcast: false,
			},
		};
		expect(() =>
			f.database.write((scope) =>
				f.replies.create(scope, chat, { account: f.ref(), messageId: source.messageId }),
			),
		).toThrow(ReplySourceError);
		expect(snapshot(f)).toEqual(before);
	});

	it("refuses a missing exact internal source instead of selecting another message from its thread", async () => {
		const f = await fixture(),
			source = await f.seed(),
			before = snapshot(f);
		expect(() =>
			f.database.write((scope) =>
				f.replies.create(scope, creation(f, source), { account: f.ref(), messageId: newId() }),
			),
		).toThrow(ReplySourceError);
		expect(snapshot(f)).toEqual(before);
	});

	it("requires the original live scope and receiver, including with an original SQL facade in a copied scope", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		f.database.write((scope) =>
			f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
		);
		let retired: WorkScope | undefined;
		f.database.write((scope) => {
			retired = scope;
		});
		if (!retired) throw new Error("DYTEST genuine retired scope missing");
		const originalRetired = retired;
		expect(() => f.replies.read(originalRetired, binding(input))).toThrow(ReplySourceError);
		expect(() =>
			f.database.write((scope) =>
				f.replies.read(Object.freeze({ sql: f.database.sql(scope) }), binding(input)),
			),
		).toThrow();
		expect(() =>
			f.database.write((scope) =>
				NativeReplySourceStore.prototype.read.call(Object.create(f.replies), scope, binding(input)),
			),
		).toThrow();
		expect(
			f.database.write((scope) => f.replies.read(scope, binding(input))).source.messageId,
		).toBe(source.messageId);
	});

	it("refuses another genuine store's scope and another genuine parsed store", async () => {
		const f = await fixture(),
			other = await fixture(),
			source = await f.seed(),
			input = creation(f, source),
			before = snapshot(f);
		expect(() =>
			other.database.write((scope) =>
				f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
			),
		).toThrow();
		expect(() => {
			const wrong = new NativeReplySourceStore(
				f.database,
				f.store,
				f.revisions,
				other.parsed,
				f.native.key,
			);
			try {
				f.database.write((scope) =>
					wrong.create(scope, input, { account: f.ref(), messageId: source.messageId }),
				);
			} finally {
				wrong.destroy();
			}
		}).toThrow(ReplySourceError);
		expect(snapshot(f)).toEqual(before);
	});

	it("refuses a draft without an association and a mismatched draft binding", async () => {
		const f = await fixture(),
			source = await f.seed(),
			plain = creation(f, source);
		f.database.write((scope) => f.revisions.createInTransaction(f.database.sql(scope), plain));
		expect(() => f.database.write((scope) => f.replies.read(scope, binding(plain)))).toThrow(
			ReplySourceError,
		);
		const linked = creation(f, source);
		f.database.write((scope) =>
			f.replies.create(scope, linked, { account: f.ref(), messageId: source.messageId }),
		);
		expect(() =>
			f.database.write((scope) =>
				f.replies.read(scope, { ...binding(linked), accountId: newId() }),
			),
		).toThrow(ReplySourceError);
	});

	it("keeps the exact original source when a later message advances the same thread's checkpoint", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		const first = f.database.write((scope) =>
			f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
		);
		const laterMessage = await f.seed("A later message in the same thread");
		expect(laterMessage.messageId).not.toBe(source.messageId);
		expect(laterMessage.threadId).toBe(source.threadId);
		expect(laterMessage.sourceCheckpoint.revision).toBeGreaterThan(
			source.sourceCheckpoint.revision,
		);
		const read = f.database.write((scope) => f.replies.read(scope, binding(input)));
		expect(read.source).toEqual(first.source);
		expect(read.source.messageId).toBe(source.messageId);
	});

	it("refuses a source deleted by the genuine metadata producer without changing the saved anchor", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		f.database.write((scope) =>
			f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
		);
		const row = savedLink(f, input.draftId);
		f.apply([{ kind: "email.deleted", providerId: source.providerId }]);
		expect(() => f.database.write((scope) => f.replies.read(scope, binding(input)))).toThrow(
			ReplySourceError,
		);
		expect(savedLink(f, input.draftId)).toEqual(row);
	});

	it("refuses changed source metadata instead of reusing the old extraction", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		f.database.write((scope) =>
			f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
		);
		const row = savedLink(f, input.draftId);
		f.apply([{ ...emailMessage(source.providerId), threadId: "DYTEST-changed-thread" }]);
		expect(() => f.database.write((scope) => f.replies.read(scope, binding(input)))).toThrow(
			ReplySourceError,
		);
		expect(savedLink(f, input.draftId)).toEqual(row);
	});

	it("refuses a genuine replacement extraction for the same internal message ID", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		f.database.write((scope) =>
			f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
		);
		const row = savedLink(f, input.draftId),
			replacement = await f.seed("Changed original bytes", source.messageId);
		expect(replacement.messageId).toBe(source.messageId);
		expect(replacement.rawSha256).not.toBe(source.rawSha256);
		expect(() => f.database.write((scope) => f.replies.read(scope, binding(input)))).toThrow(
			ReplySourceError,
		);
		expect(savedLink(f, input.draftId)).toEqual(row);
	});

	it("refuses a missing parsed extraction without returning a weaker ready result", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		f.database.write((scope) =>
			f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
		);
		f.store.write((sql) =>
			sql.run("DELETE FROM main.content_parsed_messages WHERE message_id=?", [source.messageId]),
		);
		expect(() => f.database.write((scope) => f.replies.read(scope, binding(input)))).toThrow(
			ReplySourceError,
		);
	});

	it.each(["mac", "payload"] as const)(
		"refuses %s corruption of a genuine persisted association",
		async (field) => {
			const f = await fixture(),
				source = await f.seed(),
				input = creation(f, source);
			f.database.write((scope) =>
				f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
			);
			const row = savedLink(f, input.draftId);
			const changed =
				field === "mac"
					? { ...row, mac: row.mac === "0".repeat(64) ? "1".repeat(64) : "0".repeat(64) }
					: { ...row, payload: row.payload.replace(source.rawSha256, "0".repeat(64)) };
			expect(changed[field]).not.toBe(row[field]);
			replaceLink(f, input.draftId, changed);
			expect(() => f.database.write((scope) => f.replies.read(scope, binding(input)))).toThrow(
				ReplySourceError,
			);
		},
	);

	it("binds a genuine association to its exact draft rather than accepting a transplanted authenticated row", async () => {
		const f = await fixture(),
			source = await f.seed(),
			first = creation(f, source),
			second = creation(f, source);
		f.database.write((scope) => {
			f.replies.create(scope, first, { account: f.ref(), messageId: source.messageId });
			f.replies.create(scope, second, { account: f.ref(), messageId: source.messageId });
		});
		replaceLink(f, second.draftId, savedLink(f, first.draftId));
		expect(() => f.database.write((scope) => f.replies.read(scope, binding(second)))).toThrow(
			ReplySourceError,
		);
	});

	it("enforces immutable SQL rows and terminal service destruction", async () => {
		const f = await fixture(),
			source = await f.seed(),
			input = creation(f, source);
		f.database.write((scope) =>
			f.replies.create(scope, input, { account: f.ref(), messageId: source.messageId }),
		);
		const row = savedLink(f, input.draftId);
		expect(() =>
			f.store.write((sql) =>
				sql.run("UPDATE main.native_reply_sources SET payload=payload WHERE draft_id=?", [
					input.draftId,
				]),
			),
		).toThrow();
		expect(() =>
			f.store.write((sql) =>
				sql.run(
					"INSERT OR REPLACE INTO main.native_reply_sources(draft_id,initial_rev,payload,mac) VALUES(?,1,?,?)",
					[input.draftId, row.payload, row.mac],
				),
			),
		).toThrow();
		expect(savedLink(f, input.draftId)).toEqual(row);
		f.replies.destroy();
		f.replies.destroy();
		expect(() => f.database.write((scope) => f.replies.read(scope, binding(input)))).toThrow(
			ReplySourceError,
		);
	});
});
