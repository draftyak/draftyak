import { ConfirmationPreset, PublicKeySpki } from "@draftyak/protocol/entities/device";
import { DisplayName } from "@draftyak/protocol/pairing";
import { Sha256Hex, Ulid } from "@draftyak/protocol/scalars";
import { CAPABILITY_BITS, capabilitiesOf } from "../authz/decide.ts";
import { AuthzError } from "../authz/errors.ts";
import {
	assertStoreTransaction,
	type HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../store/store.ts";
import type { AuthorityState, DeviceFacts } from "./devices.ts";

export type ConfirmedVia = "bootstrap" | "approver" | "cli" | "recovery";

const MAX = "9007199254740991";
const text = (column: string, bounds: string, nullable = false): string =>
	`CASE WHEN ${nullable ? `${column} IS NULL OR ` : ""}(typeof(${column})='text' AND length(CAST(${column} AS BLOB)) ${bounds}) THEN ${column} ELSE '!' END`;
const integer = (column: string, low: number, high: string, nullable = false): string =>
	`CASE WHEN ${nullable ? `${column} IS NULL OR ` : ""}(typeof(${column})='integer' AND ${column} BETWEEN ${low} AND ${high}) THEN ${column} ELSE -1 END`;
// Every stored value is typed and bounded in SQL before it crosses into JavaScript.
const AUTHORITY_COLUMNS = [
	`${integer("a.epoch", 0, MAX)} AS epoch`,
	`${integer("a.bootstrap_done", 0, "1")} AS bootstrap_done`,
	`${text("a.owner_user_id", "=26", true)} AS owner_user_id`,
].join(",");
const DEVICE_COLUMNS = [
	"d.id IS NOT NULL AS present",
	`${text("d.id", "=26")} AS id`,
	`${text("d.user_id", "=26", true)} AS user_id`,
	`${text("d.role", "BETWEEN 1 AND 16")} AS role`,
	`${text("d.name", "BETWEEN 1 AND 256")} AS name`,
	`${text("d.spki_sha256", "=64")} AS spki_sha256`,
	`${text("d.approval_key", "=122")} AS approval_key`,
	`${text("d.key_class", "BETWEEN 1 AND 16", true)} AS key_class`,
	`${text("d.claim_window", "BETWEEN 1 AND 16")} AS claim_window`,
	`${integer("d.paired_epoch", 0, MAX)} AS paired_epoch`,
	`${integer("d.paired_at", 0, MAX)} AS paired_at`,
	`${integer("d.capabilities", 0, "31")} AS capabilities`,
	`${integer("d.confirmed_epoch", 0, MAX, true)} AS confirmed_epoch`,
	`${text("d.confirmed_via", "BETWEEN 1 AND 16", true)} AS confirmed_via`,
	`${text("d.confirmed_preset", "BETWEEN 1 AND 16", true)} AS confirmed_preset`,
	`${text("d.confirmed_by", "=26", true)} AS confirmed_by`,
	`${integer("d.confirmed_at", 0, MAX, true)} AS confirmed_at`,
	`${integer("d.revoked_at", 0, MAX, true)} AS revoked_at`,
].join(",");
const AUTHORITY_SQL = `SELECT ${AUTHORITY_COLUMNS} FROM main.device_authority AS a WHERE a.singleton=1`;
// One statement, so the device and the authority come from one snapshot.
const BY_ID_SQL = `SELECT ${AUTHORITY_COLUMNS},${DEVICE_COLUMNS} FROM main.device_authority AS a LEFT JOIN main.devices AS d ON d.id=? WHERE a.singleton=1`;
const BY_TRANSPORT_SQL = `SELECT ${AUTHORITY_COLUMNS},${DEVICE_COLUMNS} FROM main.device_authority AS a LEFT JOIN main.devices AS d ON d.spki_sha256=? WHERE a.singleton=1`;

interface AuthorityColumns {
	epoch: unknown;
	bootstrap_done: unknown;
	owner_user_id: unknown;
}
interface DeviceColumns extends AuthorityColumns {
	present: unknown;
	id: unknown;
	user_id: unknown;
	role: unknown;
	name: unknown;
	spki_sha256: unknown;
	approval_key: unknown;
	key_class: unknown;
	claim_window: unknown;
	paired_epoch: unknown;
	paired_at: unknown;
	capabilities: unknown;
	confirmed_epoch: unknown;
	confirmed_via: unknown;
	confirmed_preset: unknown;
	confirmed_by: unknown;
	confirmed_at: unknown;
	revoked_at: unknown;
}
const unavailable = (): never => {
	throw new AuthzError("UNAVAILABLE");
};
const counter = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const ulid = (value: unknown): value is string =>
	typeof value === "string" && Ulid.safeParse(value).success;

function authority(row: AuthorityColumns | undefined): AuthorityState {
	if (
		!row ||
		!counter(row.epoch) ||
		(row.bootstrap_done !== 0 && row.bootstrap_done !== 1) ||
		(row.owner_user_id !== null && !ulid(row.owner_user_id)) ||
		(row.bootstrap_done === 1 && row.owner_user_id === null)
	)
		return unavailable();
	return Object.freeze({
		epoch: row.epoch,
		bootstrapDone: row.bootstrap_done === 1,
		ownerUserId: row.owner_user_id,
	});
}

function device(row: DeviceColumns, state: AuthorityState): DeviceFacts | undefined {
	if (row.present === 0) return undefined;
	const {
		id,
		user_id: userId,
		name,
		spki_sha256: spki,
		approval_key: key,
		claim_window: window,
		paired_epoch: pairedEpoch,
		capabilities: mask,
		confirmed_epoch: confirmedEpoch,
		confirmed_via: via,
		confirmed_preset: preset,
		confirmed_by: by,
		confirmed_at: at,
		revoked_at: revokedAt,
	} = row;
	const confirmed = confirmedEpoch !== null;
	if (
		row.present !== 1 ||
		!ulid(id) ||
		(userId !== null && !ulid(userId)) ||
		row.role !== "device" ||
		typeof name !== "string" ||
		!DisplayName.safeParse(name).success ||
		typeof spki !== "string" ||
		!Sha256Hex.safeParse(spki).success ||
		typeof key !== "string" ||
		!PublicKeySpki.safeParse(key).success ||
		(row.key_class !== null && row.key_class !== "keyring" && row.key_class !== "dev") ||
		(window !== "sidecar" && window !== "pairing") ||
		!counter(pairedEpoch) ||
		!counter(row.paired_at) ||
		!counter(mask) ||
		mask > 31 ||
		(confirmed && !counter(confirmedEpoch)) ||
		confirmed !== (mask !== 0) ||
		confirmed !== (via !== null) ||
		confirmed !== (at !== null) ||
		(via !== null &&
			via !== "bootstrap" &&
			via !== "approver" &&
			via !== "cli" &&
			via !== "recovery") ||
		(confirmed ? !ConfirmationPreset.safeParse(preset).success : preset !== null) ||
		(via === "cli" && preset !== "cli") ||
		((via === "bootstrap" || via === "recovery") && preset !== "desktop") ||
		(typeof mask === "number" &&
			(mask & ~(preset === "desktop" ? 31 : preset === "mobile" ? 7 : preset === "cli" ? 3 : 0)) !==
				0) ||
		(via === "approver") !== (by !== null) ||
		(by !== null && !ulid(by)) ||
		(at !== null && !counter(at)) ||
		(confirmed && userId === null) ||
		(revokedAt !== null && !counter(revokedAt))
	)
		return unavailable();
	return Object.freeze({
		deviceId: id,
		userId,
		role: "device",
		revoked: revokedAt !== null,
		epoch: state.epoch,
		bootstrapDone: state.bootstrapDone,
		window,
		pairedEpoch,
		confirmedEpoch: confirmed ? (confirmedEpoch as number) : null,
		confirmedPreset: preset as ConfirmationPreset | null,
		keyClass: row.key_class as "keyring" | "dev" | null,
		storedCapabilities: capabilitiesOf(mask),
		spkiSha256: spki,
		approvalKey: key,
		name,
	});
}

export function readAuthority(db: SqlReader): AuthorityState {
	return authority(db.get<AuthorityColumns>(AUTHORITY_SQL));
}

/** Both tables exist, and the store's persisted hub identity certificate, if any. */
export function readSetup(db: SqlReader): string | undefined {
	readAuthority(db);
	db.get("SELECT 1 AS found FROM main.devices AS d LIMIT 1");
	const certificate = db.get<{ identity_cert: unknown }>(
		"SELECT CASE WHEN typeof(identity_cert)='text' AND length(CAST(identity_cert AS BLOB)) BETWEEN 1 AND 16384 AND instr(identity_cert,char(0))=0 THEN identity_cert ELSE NULL END AS identity_cert FROM main.hub_meta WHERE singleton=1",
	)?.identity_cert;
	return typeof certificate === "string" ? certificate : undefined;
}

/** A device by id or transport hash, with the authority from the same statement. */
export function readFacts(
	db: SqlReader,
	by: "id" | "transport",
	value: string,
): { readonly authority: AuthorityState; readonly facts: DeviceFacts | undefined } {
	const row = db.get<DeviceColumns>(by === "id" ? BY_ID_SQL : BY_TRANSPORT_SQL, [value]);
	const state = authority(row);
	const found = row ? device(row, state) : undefined;
	if (found && (by === "id" ? found.deviceId : found.spkiSha256) !== value) return unavailable();
	return Object.freeze({ authority: state, facts: found });
}

export function deviceConflict(
	db: SqlReader,
	id: string,
	spkiSha256: string,
	approvalKey: string,
): boolean {
	return (
		db.get(
			"SELECT 1 AS found FROM main.devices AS d WHERE d.id=? OR d.spki_sha256=? OR d.approval_key=? LIMIT 1",
			[id, spkiSha256, approvalKey],
		) !== undefined
	);
}

export function currentApprovers(db: SqlReader, epoch: number): number {
	const count = db.get<{ count: unknown }>(
		"SELECT count(*) AS count FROM main.devices AS d WHERE d.revoked_at IS NULL AND d.confirmed_epoch=? AND (d.capabilities & ?)<>0",
		[epoch, CAPABILITY_BITS.approve],
	)?.count;
	return counter(count) ? count : unavailable();
}

const once = (result: { changes: number }): void => {
	if (result.changes !== 1) unavailable();
};

export function insertCandidate(
	store: HubStore,
	tx: SqlTransaction,
	values: {
		readonly id: string;
		readonly userId: string | null;
		readonly name: string;
		readonly spkiSha256: string;
		readonly approvalKey: string;
		readonly window: "sidecar" | "pairing";
		readonly epoch: number;
		readonly at: number;
	},
): void {
	assertStoreTransaction(store, tx);
	once(
		tx.run(
			"INSERT INTO main.devices(id,user_id,role,name,spki_sha256,approval_key,key_class,claim_window,paired_epoch,paired_at) VALUES(?,?,'device',?,?,?,NULL,?,?,?)",
			[
				values.id,
				values.userId,
				values.name,
				values.spkiSha256,
				values.approvalKey,
				values.window,
				values.epoch,
				values.at,
			],
		),
	);
}

export function confirmDevice(
	store: HubStore,
	tx: SqlTransaction,
	values: {
		readonly id: string;
		readonly userId: string;
		readonly mask: number;
		readonly epoch: number;
		readonly via: ConfirmedVia;
		readonly preset: ConfirmationPreset;
		readonly by: string | null;
		readonly at: number;
	},
): void {
	assertStoreTransaction(store, tx);
	once(
		tx.run(
			"UPDATE main.devices SET user_id=?,capabilities=?,confirmed_epoch=?,confirmed_via=?,confirmed_preset=?,confirmed_by=?,confirmed_at=? WHERE id=? AND revoked_at IS NULL AND (confirmed_epoch IS NULL OR confirmed_epoch<?)",
			[
				values.userId,
				values.mask,
				values.epoch,
				values.via,
				values.preset,
				values.by,
				values.at,
				values.id,
				values.epoch,
			],
		),
	);
}

export function revokeDevice(store: HubStore, tx: SqlTransaction, id: string, at: number): void {
	assertStoreTransaction(store, tx);
	once(tx.run("UPDATE main.devices SET revoked_at=? WHERE id=? AND revoked_at IS NULL", [at, id]));
}

export function createOwner(store: HubStore, tx: SqlTransaction, owner: string, at: number): void {
	assertStoreTransaction(store, tx);
	once(tx.run("INSERT INTO main.users(id,created_at) VALUES(?,?)", [owner, at]));
	once(
		tx.run(
			"UPDATE main.device_authority SET owner_user_id=? WHERE singleton=1 AND owner_user_id IS NULL",
			[owner],
		),
	);
}

export function finishBootstrap(store: HubStore, tx: SqlTransaction, epoch: number): void {
	assertStoreTransaction(store, tx);
	once(
		tx.run(
			"UPDATE main.device_authority SET bootstrap_done=1 WHERE singleton=1 AND bootstrap_done=0 AND epoch=?",
			[epoch],
		),
	);
}

export function advanceEpoch(store: HubStore, tx: SqlTransaction): void {
	assertStoreTransaction(store, tx);
	once(
		tx.run(
			`UPDATE main.device_authority SET epoch=epoch+1,bootstrap_done=0 WHERE singleton=1 AND epoch<${MAX}`,
		),
	);
}
