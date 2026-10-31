import { createHmac, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import {
	Draft,
	DraftAuthor,
	type DraftContent,
	DraftRevision,
} from "@draftyak/protocol/entities/draft";
import { type Flag, Flags, flagsHash } from "@draftyak/protocol/flags";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Sha256Hex, Ulid, UtcMs } from "@draftyak/protocol/scalars";
import { AuditChain } from "../audit/chain.ts";
import { type Clock, systemClock } from "../kernel/clock.ts";
import { newId } from "../kernel/ids.ts";
import { MasterKey } from "../kernel/master-key.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import { normalizeDraftBody, normalizeDraftContent } from "./normalize.ts";

export interface DraftBinding {
	readonly draftId: string;
	readonly accountId: string;
	readonly conversationId: string | null;
	readonly channel: "email" | "chat";
}
export interface NativeRevision {
	readonly draft: Draft;
	readonly revision: DraftRevision;
	readonly flagsHash: string;
	readonly authors: readonly DraftAuthor[];
	readonly channel: "email" | "chat";
	readonly lockId: string | null;
}
export interface DraftCreation extends DraftBinding {
	/** Attribution only. The native caller computes the envelope and authorizes its creation. */
	readonly author: DraftAuthor;
	readonly content: DraftContent;
	readonly flags: readonly Flag[];
}
export interface DraftAppend extends DraftCreation {
	readonly expectedRev: number;
}
export interface ModelBodyAppend extends DraftBinding {
	readonly expectedRev: number;
	readonly author: DraftAuthor;
	readonly body: string;
	readonly flags: readonly Flag[];
}
interface Header {
	readonly draft: Draft;
	readonly channel: "email" | "chat";
	readonly lockId: string | null;
}
interface HeaderRow {
	id: string;
	payload: string;
	audit_seq: number;
	mac: string;
}
interface RevisionRow {
	draft_id: string;
	rev: number;
	payload: string;
	previous: string;
	mac: string;
}
export class DraftRevisionError extends Error {
	readonly code = "DRAFT_REVISION_UNAVAILABLE";
	constructor() {
		super("Draft revision unavailable");
	}
}
export const revisionUnavailable = (): DraftRevisionError => new DraftRevisionError();
const readStore = HubStore.prototype.read,
	writeStore = HubStore.prototype.write,
	appendAudit = AuditChain.prototype.append,
	verifyAudit = AuditChain.prototype.verify,
	derive = MasterKey.prototype.derive;
const bindingKeys = ["draftId", "accountId", "conversationId", "channel"] as const;
const HEADER_SQL = `SELECT id,CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 8192 THEN payload ELSE NULL END AS payload,audit_seq,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac FROM main.native_drafts WHERE id=?`;
const REVISION_SQL = `SELECT draft_id,rev,CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152 THEN payload ELSE NULL END AS payload,CASE WHEN typeof(previous)='text' AND length(CAST(previous AS BLOB)) IN(0,64) THEN previous ELSE NULL END AS previous,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac FROM main.native_draft_revisions WHERE draft_id=? ORDER BY rev`;

/** Detached bounded plain data; never execute caller accessors, iterators, or proxy traps. */
export function captureDraftData(input: unknown): unknown {
	let nodes = 0,
		units = 0;
	const visit = (value: unknown, depth: number): unknown => {
		if (++nodes > 10000 || depth > 16) throw revisionUnavailable();
		if (value === null || typeof value === "boolean") return value;
		if (typeof value === "string") {
			units += value.length;
			if (value.length > 400000 || units > 1000000) throw revisionUnavailable();
			return value;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) throw revisionUnavailable();
			return value;
		}
		if (!value || typeof value !== "object" || types.isProxy(value)) throw revisionUnavailable();
		if (Array.isArray(value)) {
			if (value.length > 1000 || Reflect.ownKeys(value).length !== value.length + 1)
				throw revisionUnavailable();
			const result: unknown[] = [];
			for (let index = 0; index < value.length; index++) {
				const d = Object.getOwnPropertyDescriptor(value, String(index));
				if (!d?.enumerable || !("value" in d)) throw revisionUnavailable();
				result.push(visit(d.value, depth + 1));
			}
			return result;
		}
		if (![Object.prototype, null].includes(Object.getPrototypeOf(value)))
			throw revisionUnavailable();
		const result: Record<string, unknown> = Object.create(null);
		for (const key of Reflect.ownKeys(value)) {
			const d = Object.getOwnPropertyDescriptor(value, key);
			if (typeof key !== "string" || !d?.enumerable || !("value" in d)) throw revisionUnavailable();
			result[key] = visit(d.value, depth + 1);
		}
		return result;
	};
	return visit(input, 0);
}
export function draftRecord(input: unknown, keys: readonly string[]): Record<string, unknown> {
	const value = captureDraftData(input);
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Reflect.ownKeys(value).length !== keys.length ||
		keys.some((key) => !Object.hasOwn(value, key))
	)
		throw revisionUnavailable();
	return value as Record<string, unknown>;
}
export function captureDraftBinding(input: DraftBinding): DraftBinding {
	const value = draftRecord(input, bindingKeys);
	if (
		!Ulid.safeParse(value.draftId).success ||
		!Ulid.safeParse(value.accountId).success ||
		!(value.conversationId === null || Ulid.safeParse(value.conversationId).success) ||
		!["email", "chat"].includes(value.channel as string) ||
		(value.channel === "chat" && value.conversationId === null)
	)
		throw revisionUnavailable();
	return value as unknown as DraftBinding;
}
export function immutableDraftData<T>(input: T): T {
	if (input && typeof input === "object") {
		for (const value of Object.values(input)) immutableDraftData(value);
		Object.freeze(input);
	}
	return input;
}
function flags(input: unknown): Flag[] {
	const value = captureDraftData(input);
	if (!Array.isArray(value) || value.length > 128) throw revisionUnavailable();
	return Flags.parse(value);
}
function bindHeader(header: Header, bound: DraftBinding): void {
	if (
		header.draft.id !== bound.draftId ||
		header.draft.accountId !== bound.accountId ||
		header.draft.conversationId !== bound.conversationId ||
		header.channel !== bound.channel
	)
		throw revisionUnavailable();
}
function asBinding(input: Record<string, unknown>): DraftBinding {
	return captureDraftBinding(
		Object.fromEntries(bindingKeys.map((key) => [key, input[key]])) as unknown as DraftBinding,
	);
}

/** Keep the snapshot's finite attribution list without exhausting the owner's first edit. */
function admitAuthor(authors: readonly DraftAuthor[], author: DraftAuthor): void {
	const keys = new Set(authors.map((item) => canonicalize(item)));
	if (keys.has(canonicalize(author))) return;
	const ownerRecorded = authors.some((item) => item.kind === "owner");
	const maximum = author.kind === "owner" || ownerRecorded ? 100 : 99;
	if (keys.size >= maximum) throw revisionUnavailable();
}

/** Internal encrypted data storage. Author attribution and supplied flag facts confer no rights. */
export class NativeDraftRevisions {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #key: Buffer;
	readonly #clock: Clock;
	#destroyed = false;
	constructor(
		store: HubStore,
		audit: AuditChain,
		masterKey: MasterKey,
		clock: Clock = systemClock,
	) {
		let key: Buffer | undefined;
		try {
			if ([store, audit, masterKey, clock].some(types.isProxy)) throw revisionUnavailable();
			HubStore.prototype.assertMasterKey.call(store, masterKey);
			key = derive.call(masterKey, "handles");
			readStore.call(store, (db: SqlReader) => {
				db.get("SELECT id FROM main.native_drafts LIMIT 1");
				verifyAudit.call(audit, db);
			});
		} catch {
			key?.fill(0);
			throw revisionUnavailable();
		}
		this.#store = store;
		this.#audit = audit;
		this.#key = key;
		this.#clock = clock;
	}
	now(): number {
		return this.#now();
	}
	#now(): number {
		const at = this.#clock.wallMs();
		if (this.#destroyed || !UtcMs.safeParse(at).success) throw revisionUnavailable();
		return at;
	}
	/** Shared internal authentication for revision and freeze rows, under distinct domains. */
	sign(domain: "header" | "revision" | "freeze", value: unknown): string {
		return this.#sign(domain, value);
	}
	#sign(domain: "header" | "revision" | "freeze", value: unknown): string {
		if (this.#destroyed) throw revisionUnavailable();
		return createHmac("sha256", this.#key)
			.update(`draftyak/draft-${domain}/v1\n`)
			.update(canonicalize(value))
			.digest("hex");
	}
	checkMac(domain: "header" | "revision" | "freeze", value: unknown, mac: string): void {
		this.#checkMac(domain, value, mac);
	}
	#checkMac(domain: "header" | "revision" | "freeze", value: unknown, mac: string): void {
		if (
			!Sha256Hex.safeParse(mac).success ||
			!timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(this.#sign(domain, value), "hex"))
		)
			throw revisionUnavailable();
	}
	assertTransaction(tx: SqlTransaction): void {
		this.#assertTransaction(tx);
	}
	#assertTransaction(tx: SqlTransaction): void {
		if (this.#destroyed) throw revisionUnavailable();
		assertStoreTransaction(this.#store, tx);
		verifyAudit.call(this.#audit, tx);
	}
	sameStore(other: NativeDraftRevisions): boolean {
		return this.#store === other.#store;
	}
	read<T>(work: (db: SqlReader) => T): T {
		return this.#read(work);
	}
	#read<T>(work: (db: SqlReader) => T): T {
		if (this.#destroyed) throw revisionUnavailable();
		return readStore.call(this.#store, (db: SqlReader) => {
			verifyAudit.call(this.#audit, db);
			return work(db);
		}) as T;
	}
	write<T>(work: (tx: SqlTransaction) => T): T {
		if (this.#destroyed) throw revisionUnavailable();
		return writeStore.call(this.#store, (tx: SqlTransaction) => {
			verifyAudit.call(this.#audit, tx);
			return work(tx);
		}) as T;
	}
	auditInTransaction(tx: SqlTransaction, action: string, refs: Record<string, string>): number {
		return this.#auditInTransaction(tx, action, refs);
	}
	#auditInTransaction(tx: SqlTransaction, action: string, refs: Record<string, string>): number {
		this.#assertTransaction(tx);
		const at = this.#now();
		appendAudit.call(this.#audit, tx, {
			id: newId(at),
			at,
			action,
			actor: { kind: "hub", id: null },
			refs,
		});
		const seq = tx.get<{ audit_seq: number }>(
			"SELECT audit_seq FROM main.audit_meta WHERE singleton=1",
		)?.audit_seq;
		if (!seq || !Number.isSafeInteger(seq)) throw revisionUnavailable();
		return seq;
	}
	#header(db: SqlReader, bound: DraftBinding): Header {
		const row = db.get<HeaderRow>(HEADER_SQL, [bound.draftId]);
		if (
			!row ||
			row.id !== bound.draftId ||
			typeof row.payload !== "string" ||
			!Number.isSafeInteger(row.audit_seq) ||
			row.audit_seq < 1
		)
			throw revisionUnavailable();
		const { mac, ...signed } = row;
		this.#checkMac("header", signed, mac);
		const latest = db.get<{ seq: number }>(
			"SELECT seq FROM main.audit_events WHERE refs=? ORDER BY seq DESC LIMIT 1",
			[canonicalize({ draft: row.id })],
		);
		if (latest?.seq !== row.audit_seq) throw revisionUnavailable();
		const parsed = draftRecord(JSON.parse(row.payload), ["draft", "channel", "lockId"]),
			draft = Draft.parse(parsed.draft);
		if (
			canonicalize(parsed) !== row.payload ||
			draft.rev > 10000 ||
			!["email", "chat"].includes(parsed.channel as string) ||
			!(parsed.lockId === null || Ulid.safeParse(parsed.lockId).success)
		)
			throw revisionUnavailable();
		const header = { draft, channel: parsed.channel, lockId: parsed.lockId } as Header;
		bindHeader(header, bound);
		return header;
	}
	#history(
		db: SqlReader,
		header: Header,
		afterRev = 0,
		limit = 0,
	): { latest: DraftRevision; authors: DraftAuthor[]; page: DraftRevision[] } {
		const bound: DraftBinding = {
			draftId: header.draft.id,
			accountId: header.draft.accountId,
			conversationId: header.draft.conversationId,
			channel: header.channel,
		};
		const count = db.get<{ n: number }>(
			"SELECT count(*) AS n FROM main.native_draft_revisions WHERE draft_id=?",
			[bound.draftId],
		);
		if (count?.n !== header.draft.rev) throw revisionUnavailable();
		let previous = "",
			previousAt = header.draft.createdAt,
			index = 0,
			latest: DraftRevision | undefined;
		const page: DraftRevision[] = [],
			authors = new Map<string, DraftAuthor>();
		while (index < header.draft.rev) {
			const rows = db.all<RevisionRow>(`${REVISION_SQL} LIMIT 8 OFFSET ?`, [bound.draftId, index]);
			if (!rows.length) throw revisionUnavailable();
			for (const row of rows) {
				if (
					!row ||
					row.draft_id !== bound.draftId ||
					row.rev !== index + 1 ||
					typeof row.payload !== "string" ||
					row.previous !== previous
				)
					throw revisionUnavailable();
				const { mac, ...signed } = row;
				this.#checkMac("revision", { binding: bound, ...signed }, mac);
				const revision = DraftRevision.parse(JSON.parse(row.payload));
				if (
					canonicalize(revision) !== row.payload ||
					revision.draftId !== bound.draftId ||
					revision.rev !== row.rev ||
					revision.content.channel !== bound.channel ||
					jcsSha256(revision.content) !== revision.contentSha256 ||
					canonicalize(normalizeDraftContent(revision.content)) !==
						canonicalize(revision.content) ||
					revision.flags.length > 128 ||
					revision.createdAt < header.draft.createdAt ||
					revision.createdAt > header.draft.updatedAt ||
					revision.createdAt < previousAt
				)
					throw revisionUnavailable();
				previous = mac;
				previousAt = revision.createdAt;
				latest = revision;
				index++;
				authors.set(canonicalize(revision.author), revision.author);
				if (authors.size > 100) throw revisionUnavailable();
				if (index > afterRev && page.length < limit) page.push(revision);
			}
		}
		if (!latest || index !== header.draft.rev) throw revisionUnavailable();
		return { latest, authors: [...authors.values()], page };
	}
	#facts(db: SqlReader, bound: DraftBinding): NativeRevision {
		const header = this.#header(db, bound),
			history = this.#history(db, header),
			revision = history.latest,
			authors = history.authors;
		return immutableDraftData({
			draft: header.draft,
			revision,
			flagsHash: flagsHash(revision.flags),
			authors,
			channel: header.channel,
			lockId: header.lockId,
		});
	}
	current(bound: DraftBinding): NativeRevision {
		try {
			const captured = captureDraftBinding(bound);
			return this.#read((db) => this.#facts(db, captured));
		} catch {
			throw revisionUnavailable();
		}
	}
	currentInTransaction(tx: SqlTransaction, bound: DraftBinding): NativeRevision {
		try {
			this.#assertTransaction(tx);
			return this.#facts(tx, captureDraftBinding(bound));
		} catch {
			throw revisionUnavailable();
		}
	}
	history(bound: DraftBinding, afterRev = 0, limit = 32): readonly DraftRevision[] {
		try {
			if (
				!Number.isSafeInteger(afterRev) ||
				afterRev < 0 ||
				!Number.isSafeInteger(limit) ||
				limit < 1 ||
				limit > 32
			)
				throw revisionUnavailable();
			const captured = captureDraftBinding(bound);
			return this.#read((db) => {
				const header = this.#header(db, captured);
				return immutableDraftData(this.#history(db, header, afterRev, limit).page);
			});
		} catch {
			throw revisionUnavailable();
		}
	}
	#saveHeader(tx: SqlTransaction, header: Header, action: string, insert: boolean): void {
		const audit_seq = this.#auditInTransaction(tx, action, { draft: header.draft.id }),
			row = { id: header.draft.id, payload: canonicalize(header), audit_seq },
			mac = this.#sign("header", row);
		if (insert)
			tx.run("INSERT INTO main.native_drafts(id,payload,audit_seq,mac) VALUES(?,?,?,?)", [
				row.id,
				row.payload,
				audit_seq,
				mac,
			]);
		else if (
			tx.run("UPDATE main.native_drafts SET payload=?,audit_seq=?,mac=? WHERE id=?", [
				row.payload,
				audit_seq,
				mac,
				row.id,
			]).changes !== 1
		)
			throw revisionUnavailable();
	}
	#saveRevision(tx: SqlTransaction, bound: DraftBinding, revision: DraftRevision): void {
		const previous =
			revision.rev === 1
				? ""
				: tx.get<{ mac: string }>(
						"SELECT mac FROM main.native_draft_revisions WHERE draft_id=? AND rev=?",
						[bound.draftId, revision.rev - 1],
					)?.mac;
		if (previous === undefined) throw revisionUnavailable();
		const row = {
			draft_id: bound.draftId,
			rev: revision.rev,
			payload: canonicalize(revision),
			previous,
		};
		if (Buffer.byteLength(row.payload) > 2097152) throw revisionUnavailable();
		tx.run(
			"INSERT INTO main.native_draft_revisions(draft_id,rev,payload,previous,mac) VALUES(?,?,?,?,?)",
			[
				row.draft_id,
				row.rev,
				row.payload,
				previous,
				this.#sign("revision", { binding: bound, ...row }),
			],
		);
	}
	createInTransaction(tx: SqlTransaction, input: DraftCreation): NativeRevision {
		try {
			this.#assertTransaction(tx);
			const data = draftRecord(input, [...bindingKeys, "author", "content", "flags"]),
				bound = asBinding(data),
				content = normalizeDraftContent(data.content),
				author = DraftAuthor.parse(data.author),
				at = this.#now();
			if (content.channel !== bound.channel) throw revisionUnavailable();
			if (
				tx.get("SELECT 1 FROM main.audit_events WHERE json_extract(refs,'$.draft')=? LIMIT 1", [
					bound.draftId,
				])
			)
				throw revisionUnavailable();
			const draft = Draft.parse({
					id: bound.draftId,
					accountId: bound.accountId,
					conversationId: bound.conversationId,
					rev: 1,
					state: "open",
					createdAt: at,
					updatedAt: at,
				}),
				revision = DraftRevision.parse({
					draftId: bound.draftId,
					rev: 1,
					author,
					content,
					contentSha256: jcsSha256(content),
					flags: flags(data.flags),
					createdAt: at,
				});
			this.#saveHeader(tx, { draft, channel: bound.channel, lockId: null }, "draft.created", true);
			this.#saveRevision(tx, bound, revision);
			return this.#facts(tx, bound);
		} catch {
			throw revisionUnavailable();
		}
	}
	appendInTransaction(tx: SqlTransaction, input: DraftAppend): NativeRevision {
		return this.#appendInTransaction(tx, input, false);
	}
	#appendInTransaction(tx: SqlTransaction, input: DraftAppend, modelBody: boolean): NativeRevision {
		try {
			this.#assertTransaction(tx);
			const data = draftRecord(input, [
					...bindingKeys,
					"expectedRev",
					"author",
					"content",
					"flags",
				]),
				bound = asBinding(data),
				current = this.#facts(tx, bound);
			if (
				current.draft.rev !== data.expectedRev ||
				current.draft.state !== "open" ||
				current.lockId !== null ||
				current.draft.rev >= 10000
			)
				throw revisionUnavailable();
			const at = this.#now(),
				content = normalizeDraftContent(data.content),
				author = DraftAuthor.parse(data.author);
			// Only the body-only entry point can attribute a later revision to a model run.
			if ((author.kind === "ai") !== modelBody) throw revisionUnavailable();
			admitAuthor(current.authors, author);
			if (at < current.draft.updatedAt || content.channel !== bound.channel)
				throw revisionUnavailable();
			const revision = DraftRevision.parse({
					draftId: bound.draftId,
					rev: current.draft.rev + 1,
					author,
					content,
					contentSha256: jcsSha256(content),
					flags: flags(data.flags),
					createdAt: at,
				}),
				draft = Draft.parse({ ...current.draft, rev: revision.rev, updatedAt: at });
			this.#saveRevision(tx, bound, revision);
			this.#saveHeader(
				tx,
				{ draft, channel: bound.channel, lockId: null },
				"draft.appended",
				false,
			);
			return this.#facts(tx, bound);
		} catch {
			throw revisionUnavailable();
		}
	}
	appendModelBodyInTransaction(tx: SqlTransaction, input: ModelBodyAppend): NativeRevision {
		try {
			this.#assertTransaction(tx);
			const data = draftRecord(input, [...bindingKeys, "expectedRev", "author", "body", "flags"]),
				bound = asBinding(data),
				current = this.#facts(tx, bound),
				author = DraftAuthor.parse(data.author);
			if (author.kind !== "ai") throw revisionUnavailable();
			const merged = [
				...new Map(
					[...current.revision.flags, ...flags(data.flags)].map((flag) => [
						canonicalize(flag),
						flag,
					]),
				).values(),
			];
			return this.#appendInTransaction(
				tx,
				{
					...bound,
					expectedRev: data.expectedRev as number,
					author,
					content: { ...current.revision.content, body: normalizeDraftBody(data.body as string) },
					flags: merged,
				},
				true,
			);
		} catch {
			throw revisionUnavailable();
		}
	}
	/** Internal freeze composition only; authorization must already be checked by its native caller. */
	setLockInTransaction(
		tx: SqlTransaction,
		bound: DraftBinding,
		expectedRev: number,
		expectedLock: string | null,
		lockId: string | null,
	): NativeRevision {
		try {
			this.#assertTransaction(tx);
			const current = this.#facts(tx, captureDraftBinding(bound));
			if (
				current.draft.rev !== expectedRev ||
				current.lockId !== expectedLock ||
				current.draft.state !== "open" ||
				!(lockId === null || Ulid.safeParse(lockId).success)
			)
				throw revisionUnavailable();
			const at = this.#now();
			if (at < current.draft.updatedAt) throw revisionUnavailable();
			this.#saveHeader(
				tx,
				{ draft: { ...current.draft, updatedAt: at }, channel: current.channel, lockId },
				lockId === null ? "draft.unlocked" : "draft.locked",
				false,
			);
			return this.#facts(tx, bound);
		} catch {
			throw revisionUnavailable();
		}
	}
	destroy(): void {
		this.#destroyed = true;
		this.#key.fill(0);
	}
}
