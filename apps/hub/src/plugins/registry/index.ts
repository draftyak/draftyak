import { fileURLToPath } from "node:url";
import { canonicalDirectory, type PackageLock } from "../../artifacts/index.ts";
import { AuditChain } from "../../audit/chain.ts";
import { EventLog } from "../../events/log.ts";
import { DeviceRegistry } from "../../identity/devices.ts";
import { WorkDatabase, type WorkScope } from "../../jobs/database.ts";
import { fields, integer, id as ulid } from "../../jobs/values.ts";
import { type Clock, systemClock } from "../../kernel/clock.ts";
import { newId } from "../../kernel/ids.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../../store/store.ts";
import {
	type BundledPluginId,
	type InstalledPlugin,
	openPluginInstaller,
	type PluginInstaller,
	type PluginInstallerOptions,
} from "../installer/index.ts";
import {
	decode,
	encode,
	PluginRegistryError,
	pinKey,
	pins,
	pluginId,
	refuse,
	snapshot,
} from "./values.ts";

export { PluginRegistryError, type PluginRegistryErrorCode } from "./values.ts";
export const PLUGIN_REGISTRY_MIGRATIONS: string = fileURLToPath(
	new URL(
		import.meta.url.endsWith(".ts") ? "./migrations/" : "./plugins/registry/migrations/",
		import.meta.url,
	),
);
export type PluginRecordState = "staged" | "disabled" | "quarantined";
/** Inert installed data only. No record is a reviewed or runnable generation. */
export interface PluginRecord {
	readonly id: string;
	readonly versionId: string;
	readonly pluginId: BundledPluginId;
	readonly version: string;
	readonly ownerUserId: string;
	readonly epoch: number;
	readonly generation: number;
	readonly state: PluginRecordState;
	readonly installed: InstalledPlugin;
}
export interface PluginRegistryOptions {
	readonly store: HubStore;
	readonly database: WorkDatabase;
	readonly devices: DeviceRegistry;
	readonly audit: AuditChain;
	readonly events: EventLog;
	/** Native startup catalog and root; never request-provided install or review authority. */
	readonly installer: PluginInstallerOptions;
	readonly clock?: Clock;
}
export interface PluginRegistry {
	stageBundled(
		id: BundledPluginId,
		version: string,
		archive: Uint8Array,
		expectedGeneration: number,
	): Promise<PluginRecord>;
	get(id: BundledPluginId): PluginRecord | undefined;
	getInTransaction(scope: WorkScope, id: BundledPluginId): PluginRecord | undefined;
	disable(scope: WorkScope, id: BundledPluginId, expectedGeneration: number): PluginRecord;
	quarantine(scope: WorkScope, id: BundledPluginId, expectedGeneration: number): PluginRecord;
	/** Supported admin authority is unavailable until its owning verifier is merged. */
	install(): never;
	upgrade(): never;
	close(): Promise<void>;
}
interface Owner {
	readonly id: string;
	readonly epoch: number;
}
interface Row {
	id: unknown;
	version_id: unknown;
	plugin_id: unknown;
	version: unknown;
	owner_user_id: unknown;
	epoch: unknown;
	generation: unknown;
	state: unknown;
	descriptor: unknown;
	version_plugin_id: unknown;
}
const storeRead = HubStore.prototype.read,
	workWrite = WorkDatabase.prototype.write,
	workSql = WorkDatabase.prototype.sql,
	abort = WorkDatabase.prototype.abort,
	assertDevices = DeviceRegistry.prototype.assertStore,
	deviceState = DeviceRegistry.prototype.state,
	appendAudit = AuditChain.prototype.append,
	appendEvent = EventLog.prototype.append;
const text = (column: string, maximum: number): string =>
	`CASE WHEN typeof(${column})='text' AND length(CAST(${column} AS BLOB)) BETWEEN 1 AND ${maximum} THEN ${column} ELSE NULL END`;
const number = (column: string): string =>
	`CASE WHEN typeof(${column})='integer' AND ${column} BETWEEN 0 AND 9007199254740991 THEN ${column} ELSE NULL END`;
const ROW = `SELECT ${text("g.id", 26)} AS id, ${text("g.version_id", 26)} AS version_id,
 ${text("g.plugin_id", 64)} AS plugin_id, ${text("v.plugin_id", 64)} AS version_plugin_id,
 ${text("v.version", 128)} AS version, ${text("g.owner_user_id", 26)} AS owner_user_id,
 ${number("g.epoch")} AS epoch, ${number("g.generation")} AS generation,
 ${text("g.state", 16)} AS state, ${text("v.descriptor", 524288)} AS descriptor
 FROM main.plugin_generations AS g LEFT JOIN main.plugin_versions AS v ON v.id=g.version_id`;

class Records {
	readonly #options: PluginRegistryOptions;
	readonly #installer: PluginInstaller;
	readonly #root: string;
	readonly #pins: ReadonlyMap<string, PackageLock>;
	readonly #active = new Set<string>();
	#closed = false;
	constructor(
		options: PluginRegistryOptions,
		installer: PluginInstaller,
		root: string,
		catalog: ReadonlyMap<string, PackageLock>,
	) {
		this.#options = options;
		this.#installer = installer;
		this.#root = root;
		this.#pins = catalog;
	}
	#owner(sql: SqlReader): Owner {
		if (this.#closed) refuse("unavailable");
		assertDevices.call(this.#options.devices, this.#options.store);
		const current = deviceState.call(this.#options.devices, sql);
		if (!current.bootstrapDone || current.ownerUserId === null) refuse("unavailable");
		return { id: ulid(current.ownerUserId), epoch: integer(current.epoch) };
	}
	#record(sql: SqlReader, id: BundledPluginId, owner: Owner): PluginRecord | undefined {
		const row = sql.get<Row>(`${ROW} WHERE g.plugin_id=?`, [id]);
		if (!row) return undefined;
		const pin =
			typeof row.version === "string" ? this.#pins.get(pinKey(id, row.version)) : undefined;
		if (
			!pin ||
			row.plugin_id !== id ||
			row.version_plugin_id !== id ||
			row.owner_user_id !== owner.id ||
			row.epoch !== owner.epoch ||
			!["staged", "disabled", "quarantined"].includes(String(row.state))
		)
			refuse("data");
		return Object.freeze({
			id: ulid(row.id),
			versionId: ulid(row.version_id),
			pluginId: id,
			version: pin.version,
			ownerUserId: owner.id,
			epoch: owner.epoch,
			generation: integer(row.generation, 1),
			state: row.state as PluginRecordState,
			installed: decode(row.descriptor, id, pin, this.#root),
		});
	}
	#scope<T>(scope: WorkScope, operation: (sql: SqlTransaction, owner: Owner) => T): T {
		try {
			const sql = workSql.call(this.#options.database, scope);
			assertStoreTransaction(this.#options.store, sql);
			return operation(sql, this.#owner(sql));
		} catch (error) {
			try {
				abort.call(this.#options.database, scope);
			} catch {
				/* A foreign or expired scope grants no write. */
			}
			throw error instanceof PluginRegistryError ? error : new PluginRegistryError("unavailable");
		}
	}
	get(raw: BundledPluginId): PluginRecord | undefined {
		try {
			const id = pluginId(raw);
			return storeRead.call(this.#options.store, (sql: SqlReader) =>
				this.#record(sql, id, this.#owner(sql)),
			) as PluginRecord | undefined;
		} catch (error) {
			throw error instanceof PluginRegistryError ? error : new PluginRegistryError("data");
		}
	}
	getInTransaction(scope: WorkScope, raw: BundledPluginId): PluginRecord | undefined {
		return this.#scope(scope, (sql, owner) => this.#record(sql, pluginId(raw), owner));
	}
	#notice(
		scope: WorkScope,
		sql: SqlTransaction,
		owner: Owner,
		record: PluginRecord,
		action: string,
	): void {
		const at = integer((this.#options.clock ?? systemClock).wallMs(), 0, 0xffffffffffff);
		appendAudit.call(this.#options.audit, sql, {
			id: newId(at),
			at,
			action,
			actor: { kind: "hub", id: null },
			refs: { plugin: record.id, version: record.versionId },
		});
		appendEvent.call(this.#options.events, scope, {
			userId: owner.id,
			accountId: null,
			dataClass: "hub.state",
			kind: "plugins.changed",
			ids: [record.id],
		});
	}
	async stageBundled(
		rawId: BundledPluginId,
		version: string,
		archive: Uint8Array,
		rawExpected: number,
	): Promise<PluginRecord> {
		let id: BundledPluginId | undefined;
		let reserved = false;
		try {
			id = pluginId(rawId);
			const expected = integer(rawExpected, 0, Number.MAX_SAFE_INTEGER - 1);
			if (typeof version !== "string") refuse("input");
			const key = pinKey(id, version),
				lock = this.#pins.get(key);
			if (!lock) refuse("input");
			if (this.#active.has(id)) refuse("conflict");
			const preflight = (): Owner =>
				workWrite.call(this.#options.database, (scope: WorkScope) =>
					this.#scope(scope, (sql, current) => {
						const previous = this.#record(sql, id as BundledPluginId, current);
						if (
							(previous?.generation ?? 0) !== expected ||
							sql.get(
								"SELECT 1 AS found FROM main.plugin_versions WHERE plugin_id=? AND version=?",
								[id as string, version],
							)
						)
							refuse("conflict");
						return current;
					}),
				) as Owner;
			const owner = preflight();
			this.#active.add(id);
			reserved = true;
			let installed: InstalledPlugin;
			try {
				installed = await this.#installer.inspect(id, version, archive);
			} catch {
				const current = preflight();
				if (current.id !== owner.id || current.epoch !== owner.epoch) refuse("conflict");
				// Strict install writes only when its deterministic target is absent.
				installed = await this.#installer.install(id, version, archive);
			}
			const retained = snapshot(installed, id, lock, this.#root),
				descriptor = encode(retained);
			if (this.#closed) refuse("unavailable");
			const selected = id;
			const record = workWrite.call(this.#options.database, (scope: WorkScope) =>
				this.#scope(scope, (sql, current) => {
					if (current.id !== owner.id || current.epoch !== owner.epoch) refuse("conflict");
					const previous = this.#record(sql, selected, current);
					if ((previous?.generation ?? 0) !== expected) refuse("conflict");
					const count = sql.get<{ n: number }>("SELECT count(*) AS n FROM main.plugin_versions")?.n;
					if (!Number.isSafeInteger(count) || (count as number) >= this.#pins.size) refuse("data");
					const at = integer((this.#options.clock ?? systemClock).wallMs(), 0, 0xffffffffffff);
					const versionId = newId(at),
						recordId = previous?.id ?? newId(at);
					sql.run(
						"INSERT INTO main.plugin_versions(id,plugin_id,version,descriptor,created_at) VALUES(?,?,?,?,?)",
						[versionId, selected, version, descriptor, at],
					);
					if (previous) {
						if (
							sql.run(
								"UPDATE main.plugin_generations SET version_id=?,generation=?,state='staged' WHERE plugin_id=? AND generation=?",
								[versionId, expected + 1, selected, expected],
							).changes !== 1
						)
							refuse("conflict");
					} else
						sql.run(
							"INSERT INTO main.plugin_generations(id,plugin_id,version_id,owner_user_id,epoch,generation,state) VALUES(?,?,?,?,?,1,'staged')",
							[recordId, selected, versionId, current.id, current.epoch],
						);
					const recorded = this.#record(sql, selected, current);
					if (!recorded) refuse("data");
					this.#notice(scope, sql, current, recorded, "plugin.staged");
					return recorded;
				}),
			) as PluginRecord;
			return record;
		} catch (error) {
			throw error instanceof PluginRegistryError ? error : new PluginRegistryError("install");
		} finally {
			if (reserved && id !== undefined) this.#active.delete(id);
		}
	}
	#tighten(
		scope: WorkScope,
		raw: BundledPluginId,
		expected: number,
		state: "disabled" | "quarantined",
	): PluginRecord {
		return this.#scope(scope, (sql, owner) => {
			const id = pluginId(raw),
				previous = this.#record(sql, id, owner);
			if (!previous || previous.generation !== integer(expected, 1, Number.MAX_SAFE_INTEGER - 1))
				refuse("conflict");
			if (previous.state === state) return previous;
			if (previous.state === "quarantined") refuse("conflict");
			if (
				sql.run(
					"UPDATE main.plugin_generations SET state=?,generation=generation+1 WHERE plugin_id=? AND generation=?",
					[state, id, expected],
				).changes !== 1
			)
				refuse("conflict");
			const updated = this.#record(sql, id, owner);
			if (!updated) refuse("data");
			this.#notice(scope, sql, owner, updated, `plugin.${state}`);
			return updated;
		});
	}
	disable(scope: WorkScope, id: BundledPluginId, expected: number): PluginRecord {
		return this.#tighten(scope, id, expected, "disabled");
	}
	quarantine(scope: WorkScope, id: BundledPluginId, expected: number): PluginRecord {
		return this.#tighten(scope, id, expected, "quarantined");
	}
	install(): never {
		return refuse("admin");
	}
	upgrade(): never {
		return refuse("admin");
	}
	async close(): Promise<void> {
		this.#closed = true;
		await this.#installer.close();
	}
}

/** Native composition only: this stages verified records and never activates or reviews a plugin. */
export async function openPluginRegistry(raw: PluginRegistryOptions): Promise<PluginRegistry> {
	let installer: PluginInstaller | undefined;
	try {
		const input = fields(
			raw,
			["store", "database", "devices", "audit", "events", "installer"],
			["clock"],
		);
		const options = input as unknown as PluginRegistryOptions;
		assertDevices.call(options.devices, options.store);
		storeRead.call(options.store, (sql: SqlReader) => {
			const state = deviceState.call(options.devices, sql);
			if (!state.bootstrapDone || state.ownerUserId === null) refuse("unavailable");
		});
		const config = fields(input.installer, ["directory", "bundles"]),
			catalog = pins(config.bundles);
		const root = await canonicalDirectory(config.directory);
		installer = await openPluginInstaller({ directory: root, bundles: catalog });
		const records = new Records(
			options,
			installer,
			root,
			new Map(catalog.map((pin) => [pinKey(pin.id, pin.package.version), pin.package])),
		);
		return Object.freeze({
			stageBundled: records.stageBundled.bind(records),
			get: records.get.bind(records),
			getInTransaction: records.getInTransaction.bind(records),
			disable: records.disable.bind(records),
			quarantine: records.quarantine.bind(records),
			install: records.install.bind(records),
			upgrade: records.upgrade.bind(records),
			close: records.close.bind(records),
		});
	} catch {
		await installer?.close();
		throw new PluginRegistryError("unavailable");
	}
}
