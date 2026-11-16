import { types } from "node:util";
import type { SqliteDatabase } from "../store/open.ts";
import type { SqlReader, SqlValue } from "../store/store.ts";

const table = (name: string, columns: string, key = "id") =>
	({
		name,
		columns: columns.split(",") as readonly string[],
		key: key.split(",") as readonly string[],
	}) as const;
type Table = ReturnType<typeof table>;
const challengeColumns =
	"id,nonce,kind,target_id,device_id,user_id,data_class,epoch,target_version,statement,issued_at,expires_at,consumed_at,burned_at,signature";
// Fixed current native schemas. Module KV, files and optional namespaces are not part of this image.
const tables: readonly Table[] = [
	table("audit_meta", "singleton,audit_seq,audit_head,audit_tag", "singleton"),
	table("audit_events", "seq,id,at,action,actor_kind,actor_id,refs,previous,mac", "seq"),
	table("hub_meta", "singleton,identity_wrapped,statement_wrapped,identity_cert", "singleton"),
	table("users", "id,created_at"),
	table("approval_pins", "user_id,salt,hash,version,failures,locked_until", "user_id"),
	table("device_authority", "singleton,epoch,bootstrap_done,owner_user_id", "singleton"),
	table(
		"devices",
		"id,user_id,role,name,spki_sha256,approval_key,key_class,claim_window,paired_epoch,paired_at,capabilities,confirmed_epoch,confirmed_via,confirmed_preset,confirmed_by,confirmed_at,revoked_at",
	),
	table("jobs_meta", "singleton", "singleton"),
	table(
		"jobs",
		"seq,id,account_id,owner_id,kind,ref_id,state,attempts,max_attempts,created_at,next_at,lease_until,token",
		"seq",
	),
	table("events", "seq,user_id,account_id,data_class,kind,ids,at", "seq"),
	table("event_meta", "singleton,last_seq,floor_seq", "singleton"),
	table("native_drafts", "id,payload,audit_seq,mac"),
	table("native_draft_revisions", "draft_id,rev,payload,previous,mac", "draft_id,rev"),
	table("native_draft_locks", "id,draft_id,outbox_id,payload,audit_seq,mac"),
	// data_class is a stored generated column in the canonical credentials table.
	table("credentials", "id,owner_kind,owner_id,kind,generation,status,value"),
	table(
		"native_send_attempts",
		"id,outbox_id,ticket_id,payload,body,state,updated_at,audit_seq,mac",
	),
	table("accounts", "id,user_id,plugin_instance_id,generation,account_json"),
	table("plugin_versions", "id,plugin_id,version,descriptor,created_at"),
	table("plugin_generations", "id,plugin_id,version_id,owner_user_id,epoch,generation,state"),
	table("plugin_registry_identities", "id,plugin_id,owner_user_id,epoch"),
	table(
		"plugin_candidates",
		"id,registry_id,version_id,expected_generation,from_version_id,from_state,created_at",
	),
	table("outbox", "id,user_id,account_id,draft_id,state,schedule_kind,payload,audit_seq,mac"),
	table("approval_challenges", challengeColumns),
	table(
		"pair_confirm_operations",
		"id,approver_id,candidate_id,preset,digest,created_at,expires_at,used_at",
	),
	table(
		"approvals",
		"id,outbox_id,account_id,data_class,challenge_id,device_id,user_id,content_hash,flags_hash,epoch,target_version,iat,not_before,deliver_by,accepted_at,consumed_at,voided_at,void_reason,audit_seq,audit_mac,mac",
	),
	table(
		"native_admin_operations",
		"id,kind,owner_user_id,epoch,account_id,account_generation,state,payload,audit_seq,audit_mac,mac",
	),
	table("native_admin_challenges", challengeColumns),
	table("native_backup_recovery", "singleton,binding", "singleton"),
	table(
		"native_backup_operations",
		"id,kind,owner_user_id,epoch,state,payload,audit_seq,audit_mac,mac",
	),
	table("native_backup_challenges", challengeColumns),
	..."audit,core,devices,jobs,events,revisions,credentials,tickets,accounts,pluginregistry,outbox,challenges,verifier,admin,adminchallenges,backup,backupops,backupchallenges"
		.split(",")
		.flatMap((name) => [
			table(`_migrations_${name}`, "name,timestamp", "name"),
			table(`_migrations_${name}_lock`, "id,is_locked"),
		]),
];
const nameSet = (names: string): ReadonlySet<string> => new Set(names.split(","));
const indexes = nameSet(
	"accounts_owner,accounts_plugin,events_user_seq,events_at_seq,native_admin_challenges_open,native_admin_operations_owner,native_backup_challenges_open,native_backup_operations_owner,approval_challenges_open,jobs_one_running_account,jobs_pending,jobs_expiring,outbox_one_live_draft,outbox_draft,outbox_scheduled,approvals_one_live_user,approvals_live_item",
);
const triggers = nameSet(
	"native_draft_revisions_no_update,native_draft_revisions_no_replace,native_admin_challenges_fixed,native_admin_challenges_final,native_backup_challenges_fixed,native_backup_challenges_final,approval_challenges_fixed,approval_challenges_final,pair_confirm_operations_fixed,pair_confirm_operations_final,device_authority_no_delete,device_authority_forward,devices_no_delete,devices_fixed_identity,devices_final_revocation,devices_forward,devices_preset_fixed,approvals_fixed,approvals_final,plugin_versions_no_update,plugin_versions_no_delete,plugin_registry_identities_no_update,plugin_registry_identities_no_delete,plugin_candidates_no_update,plugin_candidates_no_delete,audit_no_update,audit_no_delete",
);
const tableNames = new Set([...tables.map((value) => value.name), "sqlite_sequence"]);
const catalogSql =
	"SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name LIMIT 257";
const invalidSequenceSql =
	"SELECT 1 FROM main.sqlite_sequence GROUP BY name HAVING name IS NOT 'jobs' OR count(*) <> 1 LIMIT 1";
interface SchemaObject {
	readonly type: string;
	readonly name: string;
	readonly tbl_name: string;
	readonly sql: string | null;
}
export class BackupImageCopyError extends Error {
	readonly code = "BACKUP_IMAGE_COPY_UNAVAILABLE";
	constructor() {
		super("Backup image copy unavailable");
		this.name = "BackupImageCopyError";
	}
}
function refuse(): never {
	throw new BackupImageCopyError();
}
const quote = (name: string): string => `"${name}"`;
function catalog(values: SchemaObject[]): SchemaObject[] {
	if (values.length > 256) refuse();
	const found = new Set<string>();
	for (const value of values) {
		if (!tableNames.has(value.tbl_name) || found.has(value.name)) refuse();
		found.add(value.name);
		if (value.type === "table") {
			if (value.name !== value.tbl_name || !tableNames.has(value.name)) refuse();
		} else if (value.type === "index") {
			if (value.sql === null) {
				if (!value.name.startsWith(`sqlite_autoindex_${value.tbl_name}_`)) refuse();
			} else if (!indexes.has(value.name)) refuse();
		} else if (value.type !== "trigger" || !triggers.has(value.name)) refuse();
		if (value.sql !== null && (typeof value.sql !== "string" || value.sql.length > 32768)) refuse();
	}
	for (const name of [...tableNames, ...indexes, ...triggers]) if (!found.has(name)) refuse();
	return values;
}
const catalogColumns: readonly (keyof SchemaObject)[] = ["type", "name", "tbl_name", "sql"];
function sameCatalog(left: readonly SchemaObject[], right: readonly SchemaObject[]): boolean {
	return (
		left.length === right.length &&
		left.every((row, index) => {
			const other = right[index];
			return other !== undefined && catalogColumns.every((column) => row[column] === other[column]);
		})
	);
}
function value(row: Record<string, unknown>, column: string, index: number): SqlValue {
	const cell = row[column];
	const kind = row[`__copy_type_${index}`];
	if (kind === "null" && cell === null) return null;
	if (kind === "text" && typeof cell === "string") return cell;
	if (kind === "integer" && typeof cell === "string" && /^-?(0|[1-9][0-9]*)$/.test(cell))
		return BigInt(cell);
	if (kind === "blob" && types.isUint8Array(cell)) return Buffer.from(cell);
	return refuse();
}
function copyTable(source: SqlReader, destination: SqliteDatabase, spec: Table): void {
	const select = spec.columns
		.flatMap((column, index) => [
			`CASE typeof(${quote(column)}) WHEN 'integer' THEN CAST(${quote(column)} AS TEXT) ELSE ${quote(column)} END AS ${quote(column)}`,
			`typeof(${quote(column)}) AS "__copy_type_${index}"`,
		])
		.join(",");
	// Qualify source keys: the selected integer cells are text only for lossless decoding.
	const order = spec.key.map((column) => `"__source".${quote(column)}`).join(",");
	const columns = spec.columns.map(quote).join(",");
	const insert = destination.prepare(
		`INSERT INTO ${quote(spec.name)}(${columns}) VALUES(${spec.columns.map(() => "?").join(",")})`,
	);
	let after: SqlValue[] = [];
	for (;;) {
		const where =
			after.length === 0 ? "" : ` WHERE (${order}) > (${spec.key.map(() => "?").join(",")})`;
		const rows = source.all<Record<string, unknown>>(
			`SELECT ${select} FROM main.${quote(spec.name)} AS "__source"${where} ORDER BY ${order} LIMIT 8`,
			after,
		);
		if (rows.length > 8) refuse();
		for (const row of rows) {
			const cells: SqlValue[] = [];
			try {
				for (const [index, column] of spec.columns.entries()) cells.push(value(row, column, index));
				if (insert.run(...cells).changes !== 1) refuse();
				after = spec.key.map((key) => cells[spec.columns.indexOf(key)] ?? refuse());
			} finally {
				for (const cell of cells) if (types.isUint8Array(cell)) cell.fill(0);
			}
		}
		if (rows.length < 8) return;
	}
}
/** SQL DATA only. The native caller owns authorization, original Store transaction and image lifetime. */
export function copyBackupImageRows(
	source: SqlReader,
	destination: SqliteDatabase,
	template: SqlReader,
): void {
	try {
		const canonical = catalog(template.all<SchemaObject>(catalogSql));
		if (!sameCatalog(canonical, catalog(source.all<SchemaObject>(catalogSql)))) refuse();
		if (
			!destination.open ||
			destination.inTransaction ||
			destination.pragma("foreign_keys", { simple: true }) !== 1 ||
			destination.pragma("recursive_triggers", { simple: true }) !== 1
		)
			refuse();
		destination
			.transaction(() => {
				if (destination.prepare(catalogSql).all().length !== 0) refuse();
				destination.pragma("defer_foreign_keys = ON");
				for (const object of canonical) {
					if (object.type === "table" && object.name !== "sqlite_sequence")
						destination.exec(object.sql ?? refuse());
				}
				for (const spec of tables) copyTable(source, destination, spec);
				// AUTOINCREMENT creates this internal table. Preserve a sequence above surviving job rows.
				if (source.get(invalidSequenceSql)) refuse();
				destination.prepare("DELETE FROM main.sqlite_sequence WHERE name='jobs'").run();
				copyTable(source, destination, table("sqlite_sequence", "name,seq", "name"));
				for (const object of canonical) {
					if (object.type !== "table" && object.sql !== null) destination.exec(object.sql);
				}
				if (destination.prepare("SELECT 1 FROM pragma_foreign_key_check LIMIT 1").get()) refuse();
				if (
					!sameCatalog(canonical, catalog(destination.prepare(catalogSql).all() as SchemaObject[]))
				)
					refuse();
			})
			.immediate();
	} catch {
		throw new BackupImageCopyError();
	}
}
