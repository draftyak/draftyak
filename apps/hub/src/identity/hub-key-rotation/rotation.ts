import { createHash, createPublicKey, generateKeyPairSync, X509Certificate } from "node:crypto";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Ulid, UtcMs } from "@draftyak/protocol/scalars";
import { exportSpki, importSpki } from "@draftyak/protocol/sign";
import { openTypedStatement } from "@draftyak/protocol/statements";
import { HubKeyRotateStatement } from "@draftyak/protocol/statements/hub-key-rotate";
import { AuditChain } from "../../audit/chain.ts";
import { newId } from "../../kernel/ids.ts";
import { MasterKey } from "../../kernel/master-key.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../../store/store.ts";
import {
	HubIdentity,
	identityCertificate,
	signIdentitySuccessor,
	wrapIdentityKey,
} from "../hub-key.ts";

export const HUB_KEY_ROTATION_MIGRATIONS: string = fileURLToPath(
	new URL("./migrations/", import.meta.url),
);
export interface RotationClock {
	wallMs(): number;
}
export interface HubKeyRotationOptions {
	readonly clock?: RotationClock;
}
export type RotationActor =
	| { readonly kind: "cli"; readonly id: null }
	| { readonly kind: "device"; readonly id: string };
/** Internal persistence inputs, never evidence of authority: the caller proves epoch and actor. */
export interface RotationInput {
	readonly epoch: number;
	readonly actor: RotationActor;
}
export interface PreparedSuccessor {
	readonly __preparedSuccessor: never;
}
export interface RotationRecord {
	readonly seq: number;
	readonly id: string;
	readonly oldKey: string;
	readonly newKey: string;
	readonly epoch: number;
	readonly iat: number;
	readonly statement: Uint8Array;
	readonly signature: string;
}
interface Successor {
	readonly identity: HubIdentity;
	readonly certificate: string;
	readonly successorCertificate: string;
	readonly newKey: string;
	readonly wrapped: Buffer;
}
interface RotationRow {
	seq: number | null;
	id: string | null;
	old_key: string | null;
	new_key: string | null;
	epoch: number | null;
	iat: number | null;
	statement: Uint8Array | null;
	signature: string | null;
}

const TYP = "hub-key-rotate.v1";
const ACTION = "hub.identity_rotated";
const MAX_ROTATIONS = 4096;
const MAX_PREPARED = 4;
const PAGE = 128;
const UNAVAILABLE = "Hub identity rotation unavailable";
const CONFLICTED = "Hub identity rotation conflicted";
const CHAIN_UNAVAILABLE = "Hub identity chain unavailable";
const readStore = HubStore.prototype.read;
const assertStoreKey = HubStore.prototype.assertMasterKey;
const deriveKey = MasterKey.prototype.derive;
const appendAudit = AuditChain.prototype.append;
const verifyAudit = AuditChain.prototype.verify;
const lockIdentity = HubIdentity.prototype.lock;
const loadIdentity = HubIdentity.loadExisting;
const systemWallClock: RotationClock = Object.freeze({ wallMs: () => Date.now() });
// Only a complete, bounded record's certificate crosses into JavaScript; wrapped keys never do.
const SAVED_CERTIFICATE = `SELECT CASE WHEN
	typeof(identity_wrapped)='blob' AND length(identity_wrapped) BETWEEN 30 AND 4096 AND
	typeof(statement_wrapped)='blob' AND length(statement_wrapped) BETWEEN 30 AND 4096 AND
	typeof(identity_cert)='text' AND length(CAST(identity_cert AS BLOB)) BETWEEN 1 AND 16384 AND instr(identity_cert,char(0))=0
	THEN identity_cert ELSE NULL END AS identity_cert FROM main.hub_meta WHERE singleton=1`;
const ROW = `SELECT
	CASE WHEN typeof(seq)='integer' AND seq BETWEEN 1 AND ${MAX_ROTATIONS} THEN seq ELSE NULL END AS seq,
	CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB))=26 THEN id ELSE NULL END AS id,
	CASE WHEN typeof(old_key)='text' AND length(CAST(old_key AS BLOB))=122 THEN old_key ELSE NULL END AS old_key,
	CASE WHEN typeof(new_key)='text' AND length(CAST(new_key AS BLOB))=122 THEN new_key ELSE NULL END AS new_key,
	CASE WHEN typeof(epoch)='integer' AND epoch BETWEEN 0 AND 9007199254740991 THEN epoch ELSE NULL END AS epoch,
	CASE WHEN typeof(iat)='integer' AND iat BETWEEN 0 AND 9007199254740991 THEN iat ELSE NULL END AS iat,
	CASE WHEN typeof(statement)='blob' AND length(statement) BETWEEN 1 AND 1024 THEN statement ELSE NULL END AS statement,
	CASE WHEN typeof(signature)='text' AND length(CAST(signature AS BLOB))=86 THEN signature ELSE NULL END AS signature
	FROM main.hub_identity_rotations`;
const PAGE_SQL = `${ROW} WHERE seq>? ORDER BY seq LIMIT ${PAGE}`;
const TAIL_SQL = `${ROW} ORDER BY seq DESC LIMIT 1`;
const AUDIT_SQL = `SELECT CASE WHEN typeof(seq)='integer' THEN seq ELSE NULL END AS seq,
	CASE WHEN typeof(refs)='text' AND length(CAST(refs AS BLOB)) BETWEEN 2 AND 4096 THEN refs ELSE NULL END AS refs
	FROM main.audit_events WHERE action=? AND seq>? ORDER BY seq LIMIT ${PAGE}`;

class RotationError extends Error {}
const unavailable = (): RotationError => new RotationError(UNAVAILABLE);
const keyHash = (spki: string): string =>
	createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex");
const certificateKey = (certificate: string): string =>
	exportSpki(new X509Certificate(certificate).publicKey);

function ownData(input: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		input === null ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input)) ||
		Reflect.ownKeys(input).length !== keys.length
	)
		throw unavailable();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor || !("value" in descriptor)) throw unavailable();
		result[key] = descriptor.value;
	}
	return result;
}
function rotationInput(input: unknown): { epoch: number; actor: RotationActor } {
	const { epoch, actor } = ownData(input, ["epoch", "actor"]);
	if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) throw unavailable();
	const { kind, id } = ownData(actor, ["kind", "id"]);
	if (kind === "cli" && id === null) return { epoch, actor: { kind, id } };
	if (kind === "device" && typeof id === "string" && Ulid.safeParse(id).success)
		return { epoch, actor: { kind, id } };
	throw unavailable();
}
function clockOption(options: unknown): RotationClock {
	const empty =
		options !== null &&
		typeof options === "object" &&
		!types.isProxy(options) &&
		Reflect.ownKeys(options).length === 0;
	const { clock } = empty ? { clock: undefined } : ownData(options, ["clock"]);
	if (clock === undefined) return systemWallClock;
	if (clock === null || typeof clock !== "object" || types.isProxy(clock)) throw unavailable();
	if (typeof (clock as Partial<RotationClock>).wallMs !== "function") throw unavailable();
	return clock as RotationClock;
}
function nextSeq(tail: RotationRow | undefined, oldKey: string): number {
	if (!tail) return 1;
	if (typeof tail.seq !== "number" || tail.seq >= MAX_ROTATIONS || tail.new_key !== oldKey)
		throw unavailable();
	return tail.seq + 1;
}
function savedCertificate(db: SqlReader): string | undefined {
	const certificate = db.get<{ identity_cert: unknown }>(SAVED_CERTIFICATE)?.identity_cert;
	return typeof certificate === "string" ? certificate : undefined;
}

function openRow(
	row: RotationRow,
	seq: number,
	previous: string | undefined,
	seen: Set<string>,
): RotationRecord {
	const { id, old_key: oldKey, new_key: newKey, epoch, iat, statement, signature } = row;
	if (
		row.seq !== seq ||
		typeof id !== "string" ||
		!Ulid.safeParse(id).success ||
		typeof oldKey !== "string" ||
		typeof newKey !== "string" ||
		typeof epoch !== "number" ||
		typeof iat !== "number" ||
		!types.isUint8Array(statement) ||
		typeof signature !== "string"
	)
		throw unavailable();
	if (previous !== undefined && oldKey !== previous) throw unavailable();
	if (oldKey === newKey || seen.has(newKey)) throw unavailable();
	importSpki(oldKey);
	importSpki(newKey);
	const opened = openTypedStatement(TYP, statement, signature, oldKey);
	if (!opened) throw unavailable();
	if (opened.hub !== keyHash(oldKey) || opened.keyUse !== "identity") throw unavailable();
	if (opened.newKey !== newKey || opened.epoch !== epoch || opened.iat !== iat) throw unavailable();
	seen.add(oldKey);
	seen.add(newKey);
	return Object.freeze({
		seq,
		id,
		oldKey,
		newKey,
		epoch,
		iat,
		statement: new Uint8Array(statement),
		signature,
	});
}
// Every row opens under its outgoing key and extends the one before it; the tail is the
// persisted identity, and the audit chain names each rotation once, in order.
function verifiedChain(db: SqlReader, identityKey: string): readonly RotationRecord[] {
	const records: RotationRecord[] = [];
	const seen = new Set<string>();
	for (;;) {
		const rows = db.all<RotationRow>(PAGE_SQL, [records.length]);
		if (!Array.isArray(rows) || rows.length > PAGE) throw unavailable();
		for (const row of rows)
			records.push(openRow(row, records.length + 1, records.at(-1)?.newKey, seen));
		if (rows.length < PAGE) break;
	}
	const tail = records.at(-1);
	if (tail && tail.newKey !== identityKey) throw unavailable();
	let linked = 0;
	let after = 0;
	for (;;) {
		const entries = db.all<{ seq: unknown; refs: unknown }>(AUDIT_SQL, [ACTION, after]);
		if (!Array.isArray(entries) || entries.length > PAGE) throw unavailable();
		for (const entry of entries) {
			if (linked >= records.length) throw unavailable();
			const id = records[linked]?.id;
			if (typeof entry.seq !== "number" || entry.refs !== canonicalize({ rotation: id }))
				throw unavailable();
			linked++;
			after = entry.seq;
		}
		if (entries.length < PAGE) break;
	}
	if (linked < records.length) throw unavailable();
	return Object.freeze(records);
}

/**
 * Internal native composition only. The caller owns the write transaction and proves the epoch
 * and actor; this core proves no authority and never makes an identity other than a successor.
 */
export class HubKeyRotation {
	readonly #store: HubStore;
	readonly #masterKey: MasterKey;
	readonly #audit: AuditChain;
	readonly #clock: RotationClock;
	readonly #prepared = new Map<PreparedSuccessor, Successor>();
	#inFlight = 0;
	#locked = false;
	constructor(
		store: HubStore,
		masterKey: MasterKey,
		audit: AuditChain,
		options: HubKeyRotationOptions = {},
	) {
		let clock: RotationClock;
		try {
			if ([store, masterKey, audit].some((value) => types.isProxy(value))) throw unavailable();
			clock = clockOption(options);
			assertStoreKey.call(store, masterKey);
			readStore.call(store, (db: SqlReader) => {
				db.get("SELECT seq FROM main.hub_identity_rotations LIMIT 1");
				verifyAudit.call(audit, db);
			});
		} catch {
			throw new Error(UNAVAILABLE);
		}
		this.#store = store;
		this.#masterKey = masterKey;
		this.#audit = audit;
		this.#clock = clock;
	}
	async prepareSuccessor(identity: HubIdentity): Promise<PreparedSuccessor> {
		let counted = false;
		let key: Buffer | undefined;
		let wrapped: Buffer | undefined;
		try {
			if (
				this.#locked ||
				types.isProxy(identity) ||
				Object.getPrototypeOf(identity) !== HubIdentity.prototype
			)
				throw unavailable();
			const certificate = identity.certificate;
			const statementKey = identity.statementKey;
			if (typeof certificate !== "string" || typeof statementKey !== "string") throw unavailable();
			const oldKey = certificateKey(certificate);
			if (this.#inFlight + this.#prepared.size >= MAX_PREPARED)
				throw new RotationError("Hub identity rotation busy");
			this.#inFlight++;
			counted = true;
			assertStoreKey.call(this.#store, this.#masterKey);
			const successor = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
			const successorCertificate = await identityCertificate(successor);
			if (this.#locked) throw unavailable();
			assertStoreKey.call(this.#store, this.#masterKey);
			key = deriveKey.call(this.#masterKey, "secrets");
			wrapped = wrapIdentityKey(successor, key);
			const newKey = exportSpki(createPublicKey(successor));
			if (
				newKey === oldKey ||
				newKey === statementKey ||
				certificateKey(successorCertificate) !== newKey
			)
				throw unavailable();
			const prepared = Object.freeze(Object.create(null)) as PreparedSuccessor;
			this.#prepared.set(prepared, {
				identity,
				certificate,
				successorCertificate,
				newKey,
				wrapped,
			});
			wrapped = undefined;
			return prepared;
		} catch (error) {
			throw new Error(error instanceof RotationError ? error.message : UNAVAILABLE);
		} finally {
			if (counted) this.#inFlight--;
			key?.fill(0);
			wrapped?.fill(0);
		}
	}
	commit(tx: SqlTransaction, prepared: PreparedSuccessor, input: RotationInput): RotationRecord {
		assertStoreTransaction(this.#store, tx);
		const successor = this.#prepared.get(prepared);
		this.#prepared.delete(prepared);
		if (!successor) throw new Error(UNAVAILABLE);
		try {
			if (this.#locked) throw unavailable();
			assertStoreKey.call(this.#store, this.#masterKey);
			const { epoch, actor } = rotationInput(input);
			const { identity, newKey } = successor;
			const certificate = savedCertificate(tx);
			if (identity.certificate !== successor.certificate) throw unavailable();
			if (certificate === undefined || certificate !== identity.certificate) throw unavailable();
			const oldKey = certificateKey(certificate);
			const seq = nextSeq(tx.get<RotationRow>(TAIL_SQL), oldKey);
			const iat = this.#clock.wallMs();
			if (!UtcMs.safeParse(iat).success) throw unavailable();
			const statement: HubKeyRotateStatement = {
				v: 1,
				hub: identity.hid,
				epoch,
				keyUse: "identity",
				newKey,
				iat,
			};
			if (!HubKeyRotateStatement.safeParse(statement).success) throw unavailable();
			const bytes = Buffer.from(canonicalize(statement), "utf8");
			const signature = signIdentitySuccessor(identity, statement);
			const opened = openTypedStatement(TYP, bytes, signature, oldKey);
			if (!opened || canonicalize(opened) !== canonicalize(statement)) throw unavailable();
			const id = newId(iat);
			const event = newId(iat);
			// Audit, chain row, then identity: a partial write left by a swallowed error never loads.
			appendAudit.call(this.#audit, tx, {
				id: event,
				at: iat,
				action: ACTION,
				actor,
				refs: { rotation: id },
			});
			tx.run(
				"INSERT INTO main.hub_identity_rotations(seq,id,old_key,new_key,epoch,iat,statement,signature) VALUES(?,?,?,?,?,?,?,?)",
				[seq, id, oldKey, newKey, epoch, iat, bytes, signature],
			);
			if (
				tx.run(
					"UPDATE main.hub_meta SET identity_wrapped=?,identity_cert=? WHERE singleton=1 AND identity_cert=?",
					[successor.wrapped, successor.successorCertificate, certificate],
				).changes !== 1
			)
				throw new RotationError(CONFLICTED);
			lockIdentity.call(identity);
			return Object.freeze({
				seq,
				id,
				oldKey,
				newKey,
				epoch,
				iat,
				statement: new Uint8Array(bytes),
				signature,
			});
		} catch (error) {
			throw new Error(error instanceof RotationError ? error.message : UNAVAILABLE);
		} finally {
			successor.wrapped.fill(0);
		}
	}
	discard(prepared: PreparedSuccessor): void {
		const successor = this.#prepared.get(prepared);
		this.#prepared.delete(prepared);
		successor?.wrapped.fill(0);
	}
	/** A bounded, verified read of the whole chain against the persisted identity. */
	chain(db: SqlReader): readonly RotationRecord[] {
		try {
			if (this.#locked) throw unavailable();
			verifyAudit.call(this.#audit, db);
			const certificate = savedCertificate(db);
			if (certificate === undefined) throw unavailable();
			return verifiedChain(db, certificateKey(certificate));
		} catch {
			throw new Error(CHAIN_UNAVAILABLE);
		}
	}
	lock(): void {
		this.#locked = true;
		for (const successor of this.#prepared.values()) successor.wrapped.fill(0);
		this.#prepared.clear();
	}
}

/** Restart loader: never makes an identity, and refuses one the signed chain does not end in. */
export async function openRotatedIdentity(
	store: HubStore,
	masterKey: MasterKey,
	audit: AuditChain,
): Promise<HubIdentity> {
	let identity: HubIdentity | undefined;
	try {
		if ([store, masterKey, audit].some((value) => types.isProxy(value))) throw unavailable();
		assertStoreKey.call(store, masterKey);
		const persisted = readStore.call(store, (db: SqlReader) => {
			db.get("SELECT seq FROM main.hub_identity_rotations LIMIT 1");
			return savedCertificate(db);
		}) as string | undefined;
		if (persisted === undefined) throw unavailable();
		const loaded = await loadIdentity(store, masterKey);
		identity = loaded;
		readStore.call(store, (db: SqlReader) => {
			verifyAudit.call(audit, db);
			if (loaded.certificate !== persisted || savedCertificate(db) !== persisted)
				throw unavailable();
			verifiedChain(db, certificateKey(persisted));
		});
		return loaded;
	} catch {
		if (identity) lockIdentity.call(identity);
		throw new Error(CHAIN_UNAVAILABLE);
	}
}
