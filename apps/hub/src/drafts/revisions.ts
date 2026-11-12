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
import { CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
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
	/** Complete flags recomputed by the native caller for the resulting revision. */
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
/** Native operation time only; the exact one-use object is checked again before a header binds. */
export interface PreparedDraftLock {
	readonly at: number;
}
interface LockPayload {
	readonly binding: DraftBinding;
	readonly snapshot: CurrentSendSnapshotV1;
	readonly revisionContentHash: string;
	readonly flagsHash: string;
	readonly status: "active" | "released" | "consumed";
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly auditEventMac: string;
}
interface PreparedLock {
	readonly service: NativeDraftRevisions;
	readonly store: HubStore;
	readonly tx: SqlTransaction;
	readonly binding: DraftBinding;
	readonly headerIdentity: string;
	readonly rev: number;
	readonly expectedLock: string | null;
	readonly lockId: string | null;
	readonly observedAt: number;
	readonly at: number;
	readonly previousLock: string | undefined;
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
const apply = Reflect.apply;
const assertMasterKey = HubStore.prototype.assertMasterKey,
	readStore = HubStore.prototype.read,
	appendAudit = AuditChain.prototype.append,
	verifyAudit = AuditChain.prototype.verify,
	verifySegment = AuditChain.prototype.verifySegment,
	derive = MasterKey.prototype.derive;
const bindingKeys = ["draftId", "accountId", "conversationId", "channel"] as const;
// Match the native array resource budget, including history reads that bypass input capture.
const MAX_NATIVE_FLAGS = 1000;
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
interface FreezeAuthority {
	assertLive(): void;
	sign(value: unknown): string;
	checkMac(value: unknown, mac: string): void;
	audit(
		tx: SqlTransaction,
		action: DraftLockAction | "draft.clock_skew",
		refs: Record<string, string>,
	): DraftAuditReceipt;
}
// Only the co-located freeze implementation can obtain these bound private operations.
const freezeAuthorities = new WeakMap<NativeDraftRevisions, FreezeAuthority>();
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
	if (!Array.isArray(value) || value.length > MAX_NATIVE_FLAGS) throw revisionUnavailable();
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

function lockContents(payload: LockPayload): string {
	return canonicalize({
		binding: payload.binding,
		snapshot: payload.snapshot,
		revisionContentHash: payload.revisionContentHash,
		flagsHash: payload.flagsHash,
		createdAt: payload.createdAt,
	});
}

/** Internal encrypted data storage. Author attribution and supplied flag facts confer no rights. */
export class NativeDraftRevisions {
	readonly #store: HubStore;
	readonly #audit: AuditChain;
	readonly #key: Buffer;
	readonly #clock: Clock;
	readonly #preparedLocks = new WeakMap<PreparedDraftLock, PreparedLock>();
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
			apply(assertMasterKey, store, [masterKey]);
			key = apply(derive, masterKey, ["drafts"]);
			apply(readStore, store, [
				(db: SqlReader) => {
					db.get("SELECT id FROM main.native_drafts LIMIT 1");
					apply(verifyAudit, audit, [db]);
				},
			]);
		} catch {
			key?.fill(0);
			throw revisionUnavailable();
		}
		this.#store = store;
		this.#audit = audit;
		this.#key = key;
		this.#clock = clock;
		freezeAuthorities.set(
			this,
			Object.freeze({
				assertLive: (): void => {
					if (this.#destroyed) throw revisionUnavailable();
				},
				sign: (value: unknown): string => this.#sign("freeze", value),
				checkMac: (value: unknown, mac: string): void => this.#checkMac("freeze", value, mac),
				audit: (
					tx: SqlTransaction,
					action: DraftLockAction | "draft.clock_skew",
					refs: Record<string, string>,
				): DraftAuditReceipt => this.#auditInTransaction(tx, action, refs),
			}),
		);
	}
	now(tx?: SqlTransaction): number {
		if (tx !== undefined) this.#assertTransaction(tx);
		return this.#now(tx);
	}
	#now(tx?: SqlTransaction): number {
		if (this.#destroyed) throw revisionUnavailable();
		if (tx !== undefined) this.#assertTransaction(tx);
		const at = this.#clock.wallMs();
		if (!UtcMs.safeParse(at).success) throw revisionUnavailable();
		return at;
	}
	#sign(domain: "header" | "revision" | "freeze", value: unknown): string {
		if (this.#destroyed) throw revisionUnavailable();
		return createHmac("sha256", this.#key)
			.update(`draftyak/draft-${domain}/v1\n`)
			.update(canonicalize(value))
			.digest("hex");
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
		if (auditFrom !== undefined) apply(verifySegment, this.#audit, [tx, auditFrom]);
	}
	#assertTransaction(tx: SqlTransaction): void {
		if (this.#destroyed) throw revisionUnavailable();
		assertStoreTransaction(this.#store, tx);
	}
	sameStore(other: NativeDraftRevisions): boolean {
		return this.#store === other.#store;
	}
	/** Validates native composition without exposing a SQL reader or transaction callback. */
	assertStore(store: HubStore): void {
		if (this.#store !== store) throw revisionUnavailable();
		this.#read(() => undefined);
	}
	#read<T>(work: (db: SqlReader) => T): T {
		if (this.#destroyed) throw revisionUnavailable();
		return apply(readStore, this.#store, [
			(db: SqlReader) => {
				apply(verifyAudit, this.#audit, [db]);
				return work(db);
			},
		]) as T;
	}
	// Draft reads authenticate only the audit segment their linkage depends on.
	#view<T>(work: (db: SqlReader) => T): T {
		if (this.#destroyed) throw revisionUnavailable();
		return apply(readStore, this.#store, [(db: SqlReader) => work(db)]) as T;
	}
	/** A fixed outbox transition cannot authenticate draft or freeze linkage. */
	auditOutboxInTransaction(
		tx: SqlTransaction,
		action: "outbox.proposed" | "outbox.superseded" | "outbox.approved" | "outbox.missed",
		outboxId: string,
	): DraftAuditReceipt {
		if (
			!["outbox.proposed", "outbox.superseded", "outbox.approved", "outbox.missed"].includes(
				action,
			) ||
			!Ulid.safeParse(outboxId).success
		)
			throw revisionUnavailable();
		return this.#auditInTransaction(tx, action, { outbox: outboxId });
	}
	#auditInTransaction(
		tx: SqlTransaction,
		action: string,
		refs: Record<string, string>,
		observedAt?: number,
	): DraftAuditReceipt {
		this.#assertTransaction(tx);
		const at = observedAt ?? this.#now(tx);
		if (!UtcMs.safeParse(at).success) throw revisionUnavailable();
		apply(appendAudit, this.#audit, [
			tx,
			{
				id: newId(at),
				at,
				action,
				actor: { kind: "hub", id: null },
				refs,
			},
		]);
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
		apply(verifySegment, this.#audit, [db, seq]);
	}
	#lock(
		tx: SqlTransaction,
		draftId: string,
		lockId: string,
	): { row: LockRow; payload: LockPayload } {
		const row = tx.get<LockRow>(LOCK_SQL, [lockId]);
		if (
			!row ||
			row.id !== lockId ||
			row.draft_id !== draftId ||
			!Ulid.safeParse(row.outbox_id).success ||
			typeof row.payload !== "string" ||
			!Number.isSafeInteger(row.audit_seq) ||
			row.audit_seq < 1
		)
			throw revisionUnavailable();
		const { mac, ...signed } = row;
		this.#checkMac("freeze", signed, mac);
		const data = draftRecord(JSON.parse(row.payload), [
			"binding",
			"snapshot",
			"revisionContentHash",
			"flagsHash",
			"status",
			"createdAt",
			"updatedAt",
			"auditEventMac",
		]);
		const binding = captureDraftBinding(data.binding as DraftBinding),
			snapshot = CurrentSendSnapshotV1.parse(data.snapshot);
		if (
			canonicalize(data) !== row.payload ||
			binding.draftId !== row.draft_id ||
			snapshot.outbox !== row.outbox_id ||
			!Sha256Hex.safeParse(data.revisionContentHash).success ||
			!Sha256Hex.safeParse(data.flagsHash).success ||
			!Sha256Hex.safeParse(data.auditEventMac).success ||
			!["active", "released", "consumed"].includes(data.status as string) ||
			!UtcMs.safeParse(data.createdAt).success ||
			!UtcMs.safeParse(data.updatedAt).success ||
			Number(data.updatedAt) < Number(data.createdAt)
		)
			throw revisionUnavailable();
		this.#linked(
			tx,
			LOCK_LINK_SQL,
			{ draft: row.draft_id, freeze: row.id, outbox: row.outbox_id },
			row.audit_seq,
			data.auditEventMac as string,
		);
		return {
			row,
			payload: {
				binding,
				snapshot,
				revisionContentHash: data.revisionContentHash as string,
				flagsHash: data.flagsHash as string,
				status: data.status as LockPayload["status"],
				createdAt: Number(data.createdAt),
				updatedAt: Number(data.updatedAt),
				auditEventMac: data.auditEventMac as string,
			},
		};
	}
	#header(db: SqlReader, bound: DraftBinding): Header {
		return this.#loadedHeader(db, bound).header;
	}
	#loadedHeader(db: SqlReader, bound: DraftBinding): { header: Header; identity: string } {
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
		return { header, identity: canonicalize(row) };
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
					revision.flags.length > MAX_NATIVE_FLAGS ||
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
			const observedAt = this.#now(),
				at = Math.max(observedAt, current.draft.updatedAt),
				content = normalizeDraftContent(data.content),
				author = DraftAuthor.parse(data.author);
			// Only the body-only entry point can attribute a later revision to a model run.
			if ((author.kind === "ai") !== modelBody) throw revisionUnavailable();
			admitAuthor(current.authors, author);
			if (content.channel !== bound.channel) throw revisionUnavailable();
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
			if (observedAt < at)
				this.#auditInTransaction(tx, "draft.clock_skew", { clockSkewDraft: bound.draftId });
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
			return this.#appendInTransaction(
				tx,
				{
					...bound,
					expectedRev: data.expectedRev as number,
					author,
					content: { ...current.revision.content, body: normalizeDraftBody(data.body as string) },
					flags: flags(data.flags),
				},
				true,
			);
		} catch {
			throw revisionUnavailable();
		}
	}
	/** Capture a native lock transition before its row is saved; this grants no caller rights. */
	prepareLockInTransaction(
		tx: SqlTransaction,
		binding: DraftBinding,
		expectedRev: number,
		expectedLock: string | null,
		lockId: string | null,
		timestampFloor = 0,
	): PreparedDraftLock {
		try {
			this.#assertTransaction(tx);
			const bound = captureDraftBinding(binding),
				loaded = this.#loadedHeader(tx, bound),
				current = this.#facts(tx, bound, loaded.header);
			if (
				current.draft.rev !== expectedRev ||
				current.lockId !== expectedLock ||
				current.draft.state !== "open" ||
				!UtcMs.safeParse(timestampFloor).success ||
				!(
					(expectedLock === null && Ulid.safeParse(lockId).success) ||
					(lockId === null && Ulid.safeParse(expectedLock).success)
				)
			)
				throw revisionUnavailable();
			let previous: LockPayload | undefined;
			if (expectedLock !== null) {
				previous = this.#lock(tx, bound.draftId, expectedLock).payload;
				if (
					previous.status !== "active" ||
					canonicalize(previous.binding) !== canonicalize(bound) ||
					previous.snapshot.source.rev !== expectedRev ||
					previous.revisionContentHash !== current.revision.contentSha256 ||
					previous.flagsHash !== current.flagsHash
				)
					throw revisionUnavailable();
			}
			const observedAt = this.#now(),
				at = Math.max(
					observedAt,
					timestampFloor,
					current.draft.updatedAt,
					current.revision.createdAt,
					previous?.updatedAt ?? 0,
				),
				receipt: PreparedDraftLock = Object.freeze({ at });
			this.#preparedLocks.set(receipt, {
				service: this,
				store: this.#store,
				tx,
				binding: bound,
				headerIdentity: loaded.identity,
				rev: expectedRev,
				expectedLock,
				lockId,
				observedAt,
				at,
				previousLock: previous === undefined ? undefined : lockContents(previous),
			});
			return receipt;
		} catch {
			throw revisionUnavailable();
		}
	}
	/** Bind only the authenticated row belonging to this exact native preparation, once. */
	setPreparedLockInTransaction(tx: SqlTransaction, receipt: PreparedDraftLock): NativeRevision {
		try {
			const saved = this.#preparedLocks.get(receipt);
			this.#preparedLocks.delete(receipt);
			this.#assertTransaction(tx);
			if (!saved || saved.service !== this || saved.store !== this.#store || saved.tx !== tx)
				throw revisionUnavailable();
			const loaded = this.#loadedHeader(tx, saved.binding),
				current = this.#facts(tx, saved.binding, loaded.header);
			if (
				loaded.identity !== saved.headerIdentity ||
				current.draft.rev !== saved.rev ||
				current.lockId !== saved.expectedLock ||
				current.draft.state !== "open"
			)
				throw revisionUnavailable();
			const id = saved.lockId ?? saved.expectedLock;
			if (id === null) throw revisionUnavailable();
			const { payload } = this.#lock(tx, saved.binding.draftId, id);
			if (
				payload.status !== (saved.lockId === null ? "released" : "active") ||
				canonicalize(payload.binding) !== canonicalize(saved.binding) ||
				payload.snapshot.account !== saved.binding.accountId ||
				payload.snapshot.conversation !== saved.binding.conversationId ||
				payload.snapshot.kind !== saved.binding.channel ||
				payload.snapshot.source.draft !== saved.binding.draftId ||
				payload.snapshot.source.rev !== saved.rev ||
				payload.revisionContentHash !== current.revision.contentSha256 ||
				payload.flagsHash !== current.flagsHash ||
				payload.updatedAt !== saved.at ||
				(saved.lockId !== null && payload.createdAt !== saved.at) ||
				(saved.previousLock !== undefined && lockContents(payload) !== saved.previousLock)
			)
				throw revisionUnavailable();
			if (saved.observedAt < saved.at)
				this.#auditInTransaction(
					tx,
					"draft.clock_skew",
					{ clockSkewDraft: saved.binding.draftId },
					saved.observedAt,
				);
			this.#saveHeader(
				tx,
				{
					draft: { ...current.draft, updatedAt: saved.at },
					channel: current.channel,
					lockId: saved.lockId,
					latestRevisionMac: loaded.header.latestRevisionMac,
				},
				saved.lockId === null ? "draft.unlocked" : "draft.locked",
				false,
			);
			return this.#facts(tx, saved.binding);
		} catch {
			throw revisionUnavailable();
		}
	}
	destroy(): void {
		this.#destroyed = true;
		freezeAuthorities.delete(this);
		this.#key.fill(0);
	}
}

declare const frozenRevisionBrand: unique symbol;
/** A one-use proof of stored data and lock currentness. It carries no approval or caller rights. */
export interface FrozenRevisionProof {
	readonly [frozenRevisionBrand]: true;
}
export interface FrozenRevisionFacts extends DraftBinding {
	readonly rev: number;
	readonly outboxId: string;
	readonly revisionContentHash: string;
	readonly snapshotHash: string;
	readonly flagsHash: string;
	readonly snapshot: CurrentSendSnapshotV1;
}
interface FreezePayload {
	readonly binding: DraftBinding;
	readonly snapshot: CurrentSendSnapshotV1;
	readonly revisionContentHash: string;
	readonly flagsHash: string;
	readonly status: "active" | "released" | "consumed";
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly auditEventMac: string;
}
interface FreezeRow {
	id: string;
	draft_id: string;
	outbox_id: string;
	payload: string;
	audit_seq: number;
	mac: string;
}
const proofs = new WeakMap<
	FrozenRevisionProof,
	{ revisions: NativeDraftRevisions; lockId: string }
>();
const methods = Object.freeze({
	assertTransaction: NativeDraftRevisions.prototype.assertTransaction,
	currentInTransaction: NativeDraftRevisions.prototype.currentInTransaction,
	now: NativeDraftRevisions.prototype.now,
	prepareLockInTransaction: NativeDraftRevisions.prototype.prepareLockInTransaction,
	setPreparedLockInTransaction: NativeDraftRevisions.prototype.setPreparedLockInTransaction,
	sameStore: NativeDraftRevisions.prototype.sameStore,
});
const SELECT = `SELECT id,draft_id,outbox_id,CASE WHEN typeof(payload)='text' AND length(CAST(payload AS BLOB)) BETWEEN 1 AND 2097152 THEN payload ELSE NULL END AS payload,audit_seq,CASE WHEN typeof(mac)='text' AND length(CAST(mac AS BLOB))=64 THEN mac ELSE NULL END AS mac FROM main.native_draft_locks WHERE id=?`;

function matches(
	current: NativeRevision,
	bound: DraftBinding,
	snapshot: CurrentSendSnapshotV1,
): void {
	const revision = current.revision,
		content = revision.content;
	if (snapshot.render !== undefined) throw revisionUnavailable();
	if (
		snapshot.account !== bound.accountId ||
		snapshot.conversation !== bound.conversationId ||
		snapshot.kind !== bound.channel ||
		snapshot.source.draft !== bound.draftId ||
		snapshot.source.rev !== revision.rev ||
		snapshot.body.text !== content.body ||
		canonicalize(snapshot.source.authors) !== canonicalize(current.authors)
	)
		throw revisionUnavailable();
	if (content.channel === "email") {
		if (
			snapshot.kind !== "email" ||
			(bound.conversationId === null &&
				(snapshot.email.threadId !== undefined ||
					snapshot.email.inReplyTo !== undefined ||
					snapshot.email.references.length !== 0)) ||
			canonicalize(snapshot.email.to) !== canonicalize(content.to) ||
			canonicalize(snapshot.email.cc) !== canonicalize(content.cc) ||
			canonicalize(snapshot.email.bcc) !== canonicalize(content.bcc) ||
			snapshot.email.subject !== content.subject ||
			canonicalize(snapshot.attachments) !==
				canonicalize(content.attachments.map(({ blobId: _, ...attachment }) => attachment))
		)
			throw revisionUnavailable();
	} else if (
		snapshot.kind !== "chat" ||
		(snapshot.chat.threadTs ?? null) !== content.threadTs ||
		snapshot.chat.broadcast !== content.broadcast ||
		snapshot.attachments.length !== 0
	)
		throw revisionUnavailable();
}

/** Internal revision freeze/lock storage, joined to real authority only by its native caller. */
export class NativeDraftFreeze {
	readonly #revisions: NativeDraftRevisions;
	readonly #authority: FreezeAuthority;
	constructor(revisions: NativeDraftRevisions) {
		try {
			if (types.isProxy(revisions)) throw revisionUnavailable();
			const authority = freezeAuthorities.get(revisions);
			if (!authority) throw revisionUnavailable();
			authority.assertLive();
			this.#authority = authority;
		} catch {
			throw revisionUnavailable();
		}
		this.#revisions = revisions;
	}
	#facts(payload: FreezePayload): FrozenRevisionFacts {
		return immutableDraftData({
			...payload.binding,
			rev: payload.snapshot.source.rev,
			outboxId: payload.snapshot.outbox,
			revisionContentHash: payload.revisionContentHash,
			snapshotHash: contentHash(payload.snapshot),
			flagsHash: payload.flagsHash,
			snapshot: payload.snapshot,
		});
	}
	#load(db: SqlTransaction, id: string): { row: FreezeRow; payload: FreezePayload } {
		if (!Ulid.safeParse(id).success) throw revisionUnavailable();
		const row = db.get<FreezeRow>(SELECT, [id]);
		if (
			!row ||
			row.id !== id ||
			!Ulid.safeParse(row.draft_id).success ||
			!Ulid.safeParse(row.outbox_id).success ||
			typeof row.payload !== "string" ||
			!Number.isSafeInteger(row.audit_seq) ||
			row.audit_seq < 1
		)
			throw revisionUnavailable();
		const { mac, ...signed } = row;
		this.#authority.checkMac(signed, mac);
		const data = draftRecord(JSON.parse(row.payload), [
				"binding",
				"snapshot",
				"revisionContentHash",
				"flagsHash",
				"status",
				"createdAt",
				"updatedAt",
				"auditEventMac",
			]),
			binding = captureDraftBinding(data.binding as DraftBinding),
			snapshot = CurrentSendSnapshotV1.parse(data.snapshot);
		if (
			canonicalize(data) !== row.payload ||
			!Sha256Hex.safeParse(data.revisionContentHash).success ||
			!Sha256Hex.safeParse(data.flagsHash).success ||
			!Sha256Hex.safeParse(data.auditEventMac).success ||
			!["active", "released", "consumed"].includes(data.status as string) ||
			!UtcMs.safeParse(data.createdAt).success ||
			!UtcMs.safeParse(data.updatedAt).success ||
			Number(data.updatedAt) < Number(data.createdAt) ||
			row.draft_id !== binding.draftId ||
			row.outbox_id !== snapshot.outbox
		)
			throw revisionUnavailable();
		const latest = db.get<{ seq: number; mac: string }>(LOCK_LINK_SQL, [
			canonicalize({ draft: row.draft_id, freeze: row.id, outbox: row.outbox_id }),
		]);
		if (latest?.seq !== row.audit_seq || latest.mac !== data.auditEventMac)
			throw revisionUnavailable();
		apply(methods.assertTransaction, this.#revisions, [db, row.audit_seq]);
		return {
			row,
			payload: {
				binding,
				snapshot,
				revisionContentHash: data.revisionContentHash as string,
				flagsHash: data.flagsHash as string,
				status: data.status as FreezePayload["status"],
				createdAt: Number(data.createdAt),
				updatedAt: Number(data.updatedAt),
				auditEventMac: data.auditEventMac as string,
			},
		};
	}
	#save(
		tx: SqlTransaction,
		id: string,
		payload: Omit<FreezePayload, "auditEventMac">,
		previous: FreezeRow | null,
	): FreezePayload {
		apply(methods.assertTransaction, this.#revisions, [tx]);
		if (
			previous !== null &&
			(previous.id !== id ||
				previous.draft_id !== payload.binding.draftId ||
				previous.outbox_id !== payload.snapshot.outbox)
		)
			throw revisionUnavailable();
		const action: DraftLockAction = `draft.freeze_${payload.status}`;
		if (Buffer.byteLength(canonicalize({ ...payload, auditEventMac: "0".repeat(64) })) > 2097152)
			throw revisionUnavailable();
		const receipt = this.#authority.audit(tx, action, {
				draft: payload.binding.draftId,
				freeze: id,
				outbox: payload.snapshot.outbox,
			}),
			audit_seq = receipt.seq,
			text = canonicalize({ ...payload, auditEventMac: receipt.mac }),
			row = {
				id,
				draft_id: payload.binding.draftId,
				outbox_id: payload.snapshot.outbox,
				payload: text,
				audit_seq,
			};
		if (Buffer.byteLength(text) > 2097152) throw revisionUnavailable();
		const mac = this.#authority.sign(row);
		if (previous === null) {
			if (
				tx.run(
					"INSERT INTO main.native_draft_locks(id,draft_id,outbox_id,payload,audit_seq,mac) VALUES(?,?,?,?,?,?)",
					[row.id, row.draft_id, row.outbox_id, row.payload, audit_seq, mac],
				).changes !== 1
			)
				throw revisionUnavailable();
		} else if (
			tx.run(
				"UPDATE main.native_draft_locks SET payload=?,audit_seq=?,mac=? WHERE id=? AND draft_id=? AND outbox_id=? AND payload=? AND audit_seq=? AND mac=?",
				[
					row.payload,
					audit_seq,
					mac,
					previous.id,
					previous.draft_id,
					previous.outbox_id,
					previous.payload,
					previous.audit_seq,
					previous.mac,
				],
			).changes !== 1
		)
			throw revisionUnavailable();
		// A row count does not establish the value left by triggers or its current audit link.
		const stored = this.#load(tx, id);
		if (
			stored.row.id !== row.id ||
			stored.row.draft_id !== row.draft_id ||
			stored.row.outbox_id !== row.outbox_id ||
			stored.row.payload !== row.payload ||
			stored.row.audit_seq !== row.audit_seq ||
			stored.row.mac !== mac
		)
			throw revisionUnavailable();
		return stored.payload;
	}
	#proof(lockId: string): FrozenRevisionProof {
		const handle = Object.freeze(Object.create(null)) as FrozenRevisionProof;
		proofs.set(handle, { revisions: this.#revisions, lockId });
		return handle;
	}
	#current(
		tx: SqlTransaction,
		bound: DraftBinding,
		outboxId: string,
	): { row: FreezeRow; payload: FreezePayload; current: NativeRevision } {
		const current: NativeRevision = apply(methods.currentInTransaction, this.#revisions, [
			tx,
			bound,
		]);
		if (current.lockId === null) throw revisionUnavailable();
		const stored = this.#load(tx, current.lockId);
		if (
			stored.payload.status !== "active" ||
			stored.row.outbox_id !== outboxId ||
			stored.payload.revisionContentHash !== current.revision.contentSha256 ||
			stored.payload.flagsHash !== current.flagsHash ||
			canonicalize(stored.payload.binding) !== canonicalize(bound)
		)
			throw revisionUnavailable();
		matches(current, bound, stored.payload.snapshot);
		return { ...stored, current };
	}
	freezeInTransaction(
		tx: SqlTransaction,
		binding: DraftBinding,
		expectedRev: number,
		input: CurrentSendSnapshotV1,
	): FrozenRevisionProof {
		try {
			apply(methods.assertTransaction, this.#revisions, [tx]);
			const bound = captureDraftBinding(binding),
				snapshot = CurrentSendSnapshotV1.parse(captureDraftData(input)),
				current: NativeRevision = apply(methods.currentInTransaction, this.#revisions, [tx, bound]);
			if (
				current.draft.rev !== expectedRev ||
				current.draft.state !== "open" ||
				current.lockId !== null
			)
				throw revisionUnavailable();
			matches(current, bound, snapshot);
			if (tx.get(OUTBOX_USED_SQL, [snapshot.outbox])) throw revisionUnavailable();
			const observedAt: number = apply(methods.now, this.#revisions, []),
				at = Math.max(observedAt, current.draft.updatedAt, current.revision.createdAt),
				id = newId(at);
			if (observedAt < at)
				this.#authority.audit(tx, "draft.clock_skew", {
					clockSkewDraft: bound.draftId,
				});
			const prepared: PreparedDraftLock = apply(methods.prepareLockInTransaction, this.#revisions, [
				tx,
				bound,
				expectedRev,
				null,
				id,
				at,
			]);
			this.#save(
				tx,
				id,
				{
					binding: bound,
					snapshot,
					revisionContentHash: current.revision.contentSha256,
					flagsHash: current.flagsHash,
					status: "active",
					createdAt: prepared.at,
					updatedAt: prepared.at,
				},
				null,
			);
			apply(methods.setPreparedLockInTransaction, this.#revisions, [tx, prepared]);
			return this.#proof(id);
		} catch {
			throw revisionUnavailable();
		}
	}
	/** Reopen the existing active lock as data-currentness proof, never as approval. */
	proofInTransaction(
		tx: SqlTransaction,
		binding: DraftBinding,
		outboxId: string,
	): FrozenRevisionProof {
		try {
			apply(methods.assertTransaction, this.#revisions, [tx]);
			const stored = this.#current(tx, captureDraftBinding(binding), outboxId);
			return this.#proof(stored.row.id);
		} catch {
			throw revisionUnavailable();
		}
	}
	consumeInTransaction(tx: SqlTransaction, proof: FrozenRevisionProof): FrozenRevisionFacts {
		const saved = proofs.get(proof);
		proofs.delete(proof);
		try {
			apply(methods.assertTransaction, this.#revisions, [tx]);
			if (!saved || !apply(methods.sameStore, this.#revisions, [saved.revisions]))
				throw revisionUnavailable();
			const loaded = this.#load(tx, saved.lockId),
				{ row, payload, current } = this.#current(tx, loaded.payload.binding, loaded.row.outbox_id);
			if (row.id !== saved.lockId) throw revisionUnavailable();
			const rawAt: number = apply(methods.now, this.#revisions, []),
				at = Math.max(
					rawAt,
					payload.updatedAt,
					current.draft.updatedAt,
					current.revision.createdAt,
				);
			if (rawAt < at)
				this.#authority.audit(tx, "draft.clock_skew", {
					clockSkewDraft: payload.binding.draftId,
				});
			const consumed = this.#save(
				tx,
				row.id,
				{ ...payload, status: "consumed", updatedAt: at },
				row,
			);
			if (consumed.status !== "consumed") throw revisionUnavailable();
			const verified: NativeRevision = apply(methods.currentInTransaction, this.#revisions, [
				tx,
				consumed.binding,
			]);
			if (verified.lockId !== row.id || canonicalize(verified) !== canonicalize(current))
				throw revisionUnavailable();
			return this.#facts(consumed);
		} catch {
			throw revisionUnavailable();
		}
	}
	/** Native cancellation/supersede composition may release only an unconsumed data lock. */
	releaseInTransaction(tx: SqlTransaction, binding: DraftBinding, outboxId: string): void {
		try {
			apply(methods.assertTransaction, this.#revisions, [tx]);
			const bound = captureDraftBinding(binding),
				{ row, payload, current } = this.#current(tx, bound, outboxId);
			if (current.draft.state !== "open") throw revisionUnavailable();
			const rawAt: number = apply(methods.now, this.#revisions, []),
				at = Math.max(
					rawAt,
					payload.updatedAt,
					current.draft.updatedAt,
					current.revision.createdAt,
				);
			if (rawAt < at)
				this.#authority.audit(tx, "draft.clock_skew", {
					clockSkewDraft: bound.draftId,
				});
			const prepared: PreparedDraftLock = apply(methods.prepareLockInTransaction, this.#revisions, [
				tx,
				bound,
				current.draft.rev,
				row.id,
				null,
				at,
			]);
			this.#save(tx, row.id, { ...payload, status: "released", updatedAt: prepared.at }, row);
			apply(methods.setPreparedLockInTransaction, this.#revisions, [tx, prepared]);
		} catch {
			throw revisionUnavailable();
		}
	}
}
