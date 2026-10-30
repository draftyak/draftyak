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
	readonly latestRevisionMac: string;
	readonly auditEventMac: string;
}
export interface DraftAuditReceipt {
	readonly seq: number;
	readonly mac: string;
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
interface LockRow {
	id: string;
	draft_id: string;
	outbox_id: string;
	payload: string;
	audit_seq: number;
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
	verifySegment = AuditChain.prototype.verifySegment,
	derive = MasterKey.prototype.derive;
const bindingKeys = ["draftId", "accountId", "conversationId", "channel"] as const;
// The only audit actions that link a header or a lock row; other modules' events never count.
const DRAFT_HEADER_ACTIONS = [
	"draft.created",
	"draft.appended",
	"draft.locked",
	"draft.unlocked",
] as const;
const DRAFT_LOCK_ACTIONS = [
	"draft.freeze_active",
	"draft.freeze_released",
	"draft.freeze_consumed",
] as const;
type DraftHeaderAction = (typeof DRAFT_HEADER_ACTIONS)[number];
export type DraftLockAction = (typeof DRAFT_LOCK_ACTIONS)[number];
const actionIn = (actions: readonly string[]): string =>
	`action IN (${actions.map((action) => `'${action}'`).join(",")})`;
// The audit MACs cover rows, not indexes, so these lookups never read an index.
const AUDIT_LINK_COLUMNS =
	"seq,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac";
export const HEADER_LINK_SQL: string = `SELECT ${AUDIT_LINK_COLUMNS} FROM main.audit_events NOT INDEXED WHERE refs=? AND ${actionIn(DRAFT_HEADER_ACTIONS)} ORDER BY seq DESC LIMIT 1`;
export const LOCK_LINK_SQL: string = `SELECT ${AUDIT_LINK_COLUMNS} FROM main.audit_events NOT INDEXED WHERE refs=? AND ${actionIn(DRAFT_LOCK_ACTIONS)} ORDER BY seq DESC LIMIT 1`;
export const DRAFT_USED_SQL: string = `SELECT 1 FROM main.audit_events NOT INDEXED WHERE ${actionIn([...DRAFT_HEADER_ACTIONS, ...DRAFT_LOCK_ACTIONS])} AND json_extract(refs,'$.draft')=? LIMIT 1`;
export const OUTBOX_USED_SQL: string = `SELECT 1 FROM main.audit_events NOT INDEXED WHERE ${actionIn(DRAFT_LOCK_ACTIONS)} AND json_extract(refs,'$.outbox')=? LIMIT 1`;
const LOCK_SQL = `SELECT id,draft_id,outbox_id,CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152 THEN payload ELSE NULL END AS payload,audit_seq,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac FROM main.native_draft_locks WHERE id=?`;
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

/** Internal encrypted data storage. Author attribution and supplied flag facts confer no rights. */
export class NativeDraftRevisions {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #key: Buffer;
	readonly #clock: Clock;
	// One wall-clock reading per live transaction, shared by every write in it.
	readonly #times = new WeakMap<SqlTransaction, number>();
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
			key = derive.call(masterKey, "drafts");
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
	now(tx?: SqlTransaction): number {
		if (tx !== undefined) this.#assertTransaction(tx);
		return this.#now(tx);
	}
	#now(tx?: SqlTransaction): number {
		if (this.#destroyed) throw revisionUnavailable();
		const known = tx === undefined ? undefined : this.#times.get(tx);
		if (known !== undefined) return known;
		const at = this.#clock.wallMs();
		if (!UtcMs.safeParse(at).success) throw revisionUnavailable();
		if (tx !== undefined) this.#times.set(tx, at);
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
	/** With auditFrom, also authenticates the audit rows from that sequence through the head. */
	assertTransaction(tx: SqlTransaction, auditFrom?: number): void {
		this.#assertTransaction(tx);
		if (auditFrom !== undefined) verifySegment.call(this.#audit, tx, auditFrom);
	}
	#assertTransaction(tx: SqlTransaction): void {
		if (this.#destroyed) throw revisionUnavailable();
		assertStoreTransaction(this.#store, tx);
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
	// Draft reads authenticate only the audit segment their linkage depends on.
	#view<T>(work: (db: SqlReader) => T): T {
		if (this.#destroyed) throw revisionUnavailable();
		return readStore.call(this.#store, (db: SqlReader) => work(db)) as T;
	}
	write<T>(work: (tx: SqlTransaction) => T): T {
		if (this.#destroyed) throw revisionUnavailable();
		return writeStore.call(this.#store, (tx: SqlTransaction) => {
			verifyAudit.call(this.#audit, tx);
			return work(tx);
		}) as T;
	}
	auditInTransaction(
		tx: SqlTransaction,
		action: string,
		refs: Record<string, string>,
	): DraftAuditReceipt {
		return this.#auditInTransaction(tx, action, refs);
	}
	#auditInTransaction(
		tx: SqlTransaction,
		action: string,
		refs: Record<string, string>,
	): DraftAuditReceipt {
		this.#assertTransaction(tx);
		const at = this.#now(tx);
		appendAudit.call(this.#audit, tx, {
			id: newId(at),
			at,
			action,
			actor: { kind: "hub", id: null },
			refs,
		});
		const head = tx.get<{ audit_seq: number; audit_head: string }>(
			"SELECT audit_seq,CASE WHEN typeof(audit_head)='text' AND length(CAST(audit_head AS BLOB))=64 THEN audit_head ELSE NULL END AS audit_head FROM main.audit_meta WHERE singleton=1",
		);
		if (
			!head ||
			!Number.isSafeInteger(head.audit_seq) ||
			head.audit_seq < 1 ||
			!Sha256Hex.safeParse(head.audit_head).success
		)
			throw revisionUnavailable();
		return Object.freeze({ seq: head.audit_seq, mac: head.audit_head });
	}
	/** The row's audit event is the latest of its kind and no row from it to the head is altered. */
	#linked(
		db: SqlReader,
		sql: string,
		refs: Record<string, string>,
		seq: number,
		mac: string,
	): void {
		const latest = db.get<{ seq: number; mac: string }>(sql, [canonicalize(refs)]);
		if (latest?.seq !== seq || latest.mac !== mac) throw revisionUnavailable();
		verifySegment.call(this.#audit, db, seq);
	}
	#activeLock(tx: SqlTransaction, draftId: string, lockId: string): void {
		const row = tx.get<LockRow>(LOCK_SQL, [lockId]);
		if (
			!row ||
			row.id !== lockId ||
			row.draft_id !== draftId ||
			typeof row.payload !== "string" ||
			!Number.isSafeInteger(row.audit_seq)
		)
			throw revisionUnavailable();
		const { mac, ...signed } = row;
		this.#checkMac("freeze", signed, mac);
		const payload = draftRecord(JSON.parse(row.payload), [
			"binding",
			"snapshot",
			"revisionContentHash",
			"flagsHash",
			"status",
			"createdAt",
			"updatedAt",
			"auditEventMac",
		]);
		if (
			canonicalize(payload) !== row.payload ||
			payload.status !== "active" ||
			!Sha256Hex.safeParse(payload.auditEventMac).success
		)
			throw revisionUnavailable();
		this.#linked(
			tx,
			LOCK_LINK_SQL,
			{ draft: row.draft_id, freeze: row.id, outbox: row.outbox_id },
			row.audit_seq,
			payload.auditEventMac as string,
		);
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
		const parsed = draftRecord(JSON.parse(row.payload), [
				"draft",
				"channel",
				"lockId",
				"latestRevisionMac",
				"auditEventMac",
			]),
			draft = Draft.parse(parsed.draft);
		if (
			canonicalize(parsed) !== row.payload ||
			draft.rev > 10000 ||
			!["email", "chat"].includes(parsed.channel as string) ||
			!(parsed.lockId === null || Ulid.safeParse(parsed.lockId).success) ||
			!Sha256Hex.safeParse(parsed.latestRevisionMac).success ||
			!Sha256Hex.safeParse(parsed.auditEventMac).success
		)
			throw revisionUnavailable();
		this.#linked(
			db,
			HEADER_LINK_SQL,
			{ draft: row.id },
			row.audit_seq,
			parsed.auditEventMac as string,
		);
		const header = {
			draft,
			channel: parsed.channel,
			lockId: parsed.lockId,
			latestRevisionMac: parsed.latestRevisionMac,
			auditEventMac: parsed.auditEventMac,
		} as Header;
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
		if (!latest || index !== header.draft.rev || previous !== header.latestRevisionMac)
			throw revisionUnavailable();
		return { latest, authors: [...authors.values()], page };
	}
	#facts(
		db: SqlReader,
		bound: DraftBinding,
		header: Header = this.#header(db, bound),
	): NativeRevision {
		const history = this.#history(db, header),
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
			return this.#view((db) => this.#facts(db, captured));
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
			return this.#view((db) => {
				const header = this.#header(db, captured);
				return immutableDraftData(this.#history(db, header, afterRev, limit).page);
			});
		} catch {
			throw revisionUnavailable();
		}
	}
	#saveHeader(
		tx: SqlTransaction,
		header: Omit<Header, "auditEventMac">,
		action: DraftHeaderAction,
		insert: boolean,
	): void {
		if (Buffer.byteLength(canonicalize({ ...header, auditEventMac: "0".repeat(64) })) > 8192)
			throw revisionUnavailable();
		const receipt = this.#auditInTransaction(tx, action, { draft: header.draft.id }),
			audit_seq = receipt.seq,
			row = {
				id: header.draft.id,
				payload: canonicalize({ ...header, auditEventMac: receipt.mac }),
				audit_seq,
			},
			mac = this.#sign("header", row);
		if (Buffer.byteLength(row.payload) > 8192) throw revisionUnavailable();
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
	#prepareRevision(
		tx: SqlTransaction,
		bound: DraftBinding,
		revision: DraftRevision,
	): Readonly<RevisionRow> {
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
		return Object.freeze({ ...row, mac: this.#sign("revision", { binding: bound, ...row }) });
	}
	#saveRevision(tx: SqlTransaction, row: Readonly<RevisionRow>): void {
		tx.run(
			"INSERT INTO main.native_draft_revisions(draft_id,rev,payload,previous,mac) VALUES(?,?,?,?,?)",
			[row.draft_id, row.rev, row.payload, row.previous, row.mac],
		);
	}
	createInTransaction(tx: SqlTransaction, input: DraftCreation): NativeRevision {
		try {
			this.#assertTransaction(tx);
			const data = draftRecord(input, [...bindingKeys, "author", "content", "flags"]),
				bound = asBinding(data),
				content = normalizeDraftContent(data.content),
				author = DraftAuthor.parse(data.author),
				at = this.#now(tx);
			if (content.channel !== bound.channel) throw revisionUnavailable();
			if (tx.get(DRAFT_USED_SQL, [bound.draftId])) throw revisionUnavailable();
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
			if (Buffer.byteLength(canonicalize(revision)) > 2097152) throw revisionUnavailable();
			const prepared = this.#prepareRevision(tx, bound, revision);
			this.#saveHeader(
				tx,
				{ draft, channel: bound.channel, lockId: null, latestRevisionMac: prepared.mac },
				"draft.created",
				true,
			);
			this.#saveRevision(tx, prepared);
			return this.#facts(tx, bound);
		} catch {
			throw revisionUnavailable();
		}
	}
	appendInTransaction(tx: SqlTransaction, input: DraftAppend): NativeRevision {
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
			const at = Math.max(this.#now(tx), current.draft.updatedAt),
				content = normalizeDraftContent(data.content),
				author = DraftAuthor.parse(data.author);
			if (
				content.channel !== bound.channel ||
				new Set([...current.authors.map((item) => canonicalize(item)), canonicalize(author)]).size >
					100
			)
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
			const prepared = this.#prepareRevision(tx, bound, revision);
			this.#saveRevision(tx, prepared);
			this.#saveHeader(
				tx,
				{ draft, channel: bound.channel, lockId: null, latestRevisionMac: prepared.mac },
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
			// A new revision gets its own flags (spec/flags-v1.md); earlier ones never carry over.
			return NativeDraftRevisions.prototype.appendInTransaction.call(this, tx, {
				...bound,
				expectedRev: data.expectedRev as number,
				author,
				content: { ...current.revision.content, body: normalizeDraftBody(data.body as string) },
				flags: flags(data.flags),
			});
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
			const captured = captureDraftBinding(bound),
				header = this.#header(tx, captured),
				current = this.#facts(tx, captured, header);
			if (
				current.draft.rev !== expectedRev ||
				current.lockId !== expectedLock ||
				current.draft.state !== "open" ||
				!(lockId === null || Ulid.safeParse(lockId).success)
			)
				throw revisionUnavailable();
			if (lockId !== null) this.#activeLock(tx, current.draft.id, lockId);
			const at = Math.max(this.#now(tx), current.draft.updatedAt);
			this.#saveHeader(
				tx,
				{
					draft: { ...current.draft, updatedAt: at },
					channel: current.channel,
					lockId,
					latestRevisionMac: header.latestRevisionMac,
				},
				lockId === null ? "draft.unlocked" : "draft.locked",
				false,
			);
			return this.#facts(tx, captured);
		} catch {
			throw revisionUnavailable();
		}
	}
	destroy(): void {
		this.#destroyed = true;
		this.#key.fill(0);
	}
}
