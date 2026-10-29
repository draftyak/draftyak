import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DraftAuthor, DraftContent } from "@draftyak/protocol/entities/draft";
import { sha256Hex } from "@draftyak/protocol/hash";
import type { CurrentSendSnapshotV1 } from "@draftyak/protocol/snapshot";
import { AuditChain } from "../../src/audit/chain.ts";
import { NativeDraftFreeze } from "../../src/drafts/freeze.ts";
import {
	type DraftBinding,
	type DraftCreation,
	NativeDraftRevisions,
	type NativeRevision,
} from "../../src/drafts/revisions.ts";
import type { Clock } from "../../src/kernel/clock.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HubStore, type StoreOptions } from "../../src/store/store.ts";
import { migrations, nativeBinding } from "../store/helpers.ts";

interface ReopenedRevisionFixture {
	store: HubStore;
	revisions: NativeDraftRevisions;
	freeze: NativeDraftFreeze;
}
export interface RevisionFixture {
	options: StoreOptions;
	dir: string;
	filename: string;
	key: MasterKey;
	audit: AuditChain;
	store: HubStore;
	clock: Clock;
	time: { now: number };
	revisions: NativeDraftRevisions;
	freeze: NativeDraftFreeze;
	stores: HubStore[];
	services: NativeDraftRevisions[];
	author: DraftAuthor;
	canary: string;
	make(channel?: "email" | "chat"): DraftCreation;
	bind(input: DraftCreation): DraftBinding;
	create(input?: DraftCreation): NativeRevision;
	snapshot(current: NativeRevision): CurrentSendSnapshotV1;
	reopen(): ReopenedRevisionFixture;
}
export async function revisionFixture(): Promise<RevisionFixture> {
	const dir = mkdtempSync(path.join(os.tmpdir(), "draftyak-native-revisions-")),
		filename = path.join(dir, "hub.db"),
		fault = path.join(dir, "fault");
	mkdirSync(fault);
	writeFileSync(
		path.join(fault, "0001_fault.sql"),
		"CREATE TABLE revision_parent(id INTEGER PRIMARY KEY); CREATE TABLE revision_child(id INTEGER REFERENCES revision_parent(id) DEFERRABLE INITIALLY DEFERRED);",
	);
	const key = new MasterKey(randomBytes(32)),
		auditKey = key.derive("audit"),
		audit = new AuditChain(auditKey);
	auditKey.fill(0);
	const options = {
		filename,
		nativeBinding,
		masterKey: key,
		migrations: {
			audit: path.join(migrations, "audit"),
			core: path.join(migrations, "core"),
			revisions: path.resolve(import.meta.dirname, "../../src/drafts/migrations"),
			fault,
		},
	};
	const store = new HubStore({ ...options, create: true });
	await store.migrate("audit");
	await store.migrate("core");
	await store.migrate("revisions");
	await store.migrate("fault");
	const time = { now: 1_800_000_000_000 },
		clock = { wallMs: () => time.now, monotonicMs: () => 10_000 },
		revisions = new NativeDraftRevisions(store, audit, key, clock),
		freeze = new NativeDraftFreeze(revisions),
		stores = [store],
		services = [revisions];
	const author = { kind: "owner" as const, id: newId(time.now) },
		canary = `DYTEST-${randomBytes(24).toString("hex")}`;
	const make = (channel: "email" | "chat" = "email"): DraftCreation => {
		const content: DraftContent =
			channel === "email"
				? {
						channel,
						to: ["recipient@example.test"],
						cc: [],
						bcc: [],
						subject: "Synthetic draft",
						body: `${canary}\r\nCafe\u0301`,
						attachments: [
							{
								blobId: newId(time.now),
								filename: "example.txt",
								contentType: "Text/Plain; charset=utf-8",
								size: 3,
								sha256: sha256Hex("abc"),
							},
						],
					}
				: { channel, body: canary, threadTs: "100.200", broadcast: false };
		return {
			draftId: newId(time.now),
			accountId: newId(time.now),
			conversationId: channel === "chat" ? newId(time.now) : null,
			channel,
			author,
			content,
			flags: [{ code: "EXTERNAL_LINK", severity: "ack" }],
		};
	};
	const bind = (input: DraftCreation): DraftBinding => ({
		draftId: input.draftId,
		accountId: input.accountId,
		conversationId: input.conversationId,
		channel: input.channel,
	});
	// These callers are storage fixtures. They do not represent admitted users or approval grants.
	const create = (input = make()): NativeRevision =>
		store.write((tx) => revisions.createInTransaction(tx, input));
	const snapshot = (current: NativeRevision): CurrentSendSnapshotV1 => {
		const base = {
			v: 1 as const,
			hub: sha256Hex("synthetic hub"),
			epoch: 3,
			outbox: newId(time.now),
			account: current.draft.accountId,
			conversation: current.draft.conversationId,
			body: { text: current.revision.content.body, footer: "" },
			attachments: [],
			schedule: { kind: "now" as const },
			source: { draft: current.draft.id, rev: current.revision.rev, authors: current.authors },
		};
		const content = current.revision.content;
		return content.channel === "email"
			? {
					...base,
					kind: "email",
					attachments: content.attachments.map(({ blobId: _, ...value }) => value),
					email: {
						from: "sender@example.test",
						to: content.to,
						cc: content.cc,
						bcc: content.bcc,
						subject: content.subject,
						references: [],
					},
				}
			: {
					...base,
					kind: "chat",
					conversation: current.draft.conversationId as string,
					chat: {
						channelId: "C1",
						channelName: "fixture",
						channelType: "public",
						external: false,
						shared: false,
						memberCount: 2,
						...(content.threadTs === null ? {} : { threadTs: content.threadTs }),
						broadcast: content.broadcast,
					},
				};
	};
	const reopen = () => {
		store.close();
		const next = new HubStore(options),
			nextRevisions = new NativeDraftRevisions(next, audit, key, clock);
		stores.push(next);
		services.push(nextRevisions);
		return { store: next, revisions: nextRevisions, freeze: new NativeDraftFreeze(nextRevisions) };
	};
	return {
		options,
		dir,
		filename,
		key,
		audit,
		store,
		clock,
		time,
		revisions,
		freeze,
		stores,
		services,
		author,
		canary,
		make,
		bind,
		create,
		snapshot,
		reopen,
	};
}
