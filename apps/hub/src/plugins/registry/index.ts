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
	assertNativePluginOwner,
	type NativePluginSessionParts,
	nativePluginInputs,
} from "../../lifecycle/native-session-context.ts";
import {
	assertStoreTransaction,
	HubStore,
	type SqlReader,
	type SqlTransaction,
} from "../../store/store.ts";
import {
	type BundledPluginId,
	type BundledPluginPin,
	closeNativePluginInstaller,
	type InstalledPlugin,
	openNativePluginInstaller,
	openPluginInstaller,
	type PluginInstaller,
	type PluginInstallerOptions,
} from "../installer/index.ts";
import type { PluginCandidatePrior, PluginCandidateRecord } from "./candidates.ts";
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

export type { PluginCandidatePrior, PluginCandidateRecord } from "./candidates.ts";
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
	/** Reserves installed DATA without selecting it or issuing review/activation authority. */
	reserveBundledCandidate(
		id: BundledPluginId,
		version: string,
		archive: Uint8Array,
		expectedGeneration: number,
	): Promise<PluginCandidateRecord>;
	getCandidate(registryId: string, versionId: string): PluginCandidateRecord | undefined;
	getCandidateInTransaction(
		scope: WorkScope,
		registryId: string,
		versionId: string,
	): PluginCandidateRecord | undefined;
	get(id: BundledPluginId): PluginRecord | undefined;
	getInTransaction(scope: WorkScope, id: BundledPluginId): PluginRecord | undefined;
	disable(scope: WorkScope, id: BundledPluginId, expectedGeneration: number): PluginRecord;
	quarantine(scope: WorkScope, id: BundledPluginId, expectedGeneration: number): PluginRecord;
	/** Supported admin authority is unavailable until its owning verifier is merged. */
	install(): never;
	upgrade(): never;
	close(): Promise<void>;
}
interface NativeRegistryOwner {
	readonly session: unknown;
	readonly parts: NativePluginSessionParts;
}
interface NativeRegistry {
	readonly parts: NativePluginSessionParts;
	readonly opening: Promise<PluginRegistry>;
	value?: PluginRegistry;
	closing: boolean;
	closePromise?: Promise<void>;
}
const nativeRegistries = new WeakMap<object, NativeRegistry>();

/** Internal construction shares the original session's one installer and registry lifetime. */
export function openNativePluginRegistry(session: unknown): Promise<PluginRegistry> {
	try {
		const parts = nativePluginInputs(session),
			key = session as object;
		const previous = nativeRegistries.get(key);
		if (previous) {
			if (previous.closing || previous.parts !== parts) refuse("unavailable");
			return previous.opening;
		}
		let owner: NativeRegistry;
		const opening = Promise.resolve()
			.then(async () => {
				assertNativePluginOwner(session, parts);
				const value = await createPluginRegistry(
					{
						store: parts.store,
						database: parts.database,
						devices: parts.devices,
						audit: parts.audit,
						events: parts.events,
						clock: parts.clock,
						installer: {
							directory: parts.directory,
							bundles: parts.bundles,
							nativeBinding: parts.nativeBinding,
						},
					},
					{ session, parts },
				);
				owner.value = value;
				if (owner.closing) refuse("unavailable");
				return value;
			})
			.catch(() => {
				throw new PluginRegistryError("unavailable");
			});
		owner = { parts, opening, closing: false };
		nativeRegistries.set(key, owner);
		void opening.catch(() => undefined);
		return opening;
	} catch {
		return Promise.reject(new PluginRegistryError("unavailable"));
	}
}

export function closeNativePluginRegistry(session: unknown): Promise<void> {
	const owner =
		session !== null && typeof session === "object" ? nativeRegistries.get(session) : undefined;
	if (!owner) return Promise.resolve();
	owner.closing = true;
	if (owner.closePromise) return owner.closePromise;
	const immediate = owner.value?.close();
	if (immediate) void immediate.catch(() => undefined);
	const closing = Promise.allSettled([owner.opening])
		.then(async () => {
			if (immediate) await immediate;
			else if (owner.value) await owner.value.close();
		})
		.catch(() => {
			owner.closePromise = undefined;
			throw new PluginRegistryError("unavailable");
		});
	owner.closePromise = closing;
	void closing.catch(() => undefined);
	return closing;
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
interface IdentityRow {
	id: unknown;
	plugin_id: unknown;
	owner_user_id: unknown;
	epoch: unknown;
}
interface VersionRow {
	id: unknown;
	plugin_id: unknown;
	version: unknown;
	descriptor: unknown;
}
interface CandidateRow {
	id: unknown;
	expected_generation: unknown;
	from_version_id: unknown;
	from_state: unknown;
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
const IDENTITY_ROW = `SELECT ${text("id", 26)} AS id, ${text("plugin_id", 64)} AS plugin_id,
 ${text("owner_user_id", 26)} AS owner_user_id, ${number("epoch")} AS epoch
 FROM main.plugin_registry_identities`;
const VERSION_ROW = `SELECT ${text("id", 26)} AS id, ${text("plugin_id", 64)} AS plugin_id,
 ${text("version", 128)} AS version, ${text("descriptor", 524288)} AS descriptor
 FROM main.plugin_versions`;
const CANDIDATE_ROW = `SELECT ${text("id", 26)} AS id,
 ${number("expected_generation")} AS expected_generation,
 CASE WHEN from_version_id IS NULL THEN NULL ELSE ${text("from_version_id", 26)} END AS from_version_id,
 CASE WHEN from_state IS NULL THEN NULL ELSE ${text("from_state", 16)} END AS from_state
 FROM main.plugin_candidates`;

function sameSelection(left: PluginRecord | undefined, right: PluginRecord | undefined): boolean {
	if (!left || !right) return left === right;
	return (
		left.id === right.id &&
		left.versionId === right.versionId &&
		left.pluginId === right.pluginId &&
		left.version === right.version &&
		left.ownerUserId === right.ownerUserId &&
		left.epoch === right.epoch &&
		left.generation === right.generation &&
		left.state === right.state
	);
}

class Records {
	readonly #options: PluginRegistryOptions;
	readonly #installer: PluginInstaller;
	readonly #root: string;
	readonly #pins: ReadonlyMap<string, PackageLock>;
	readonly #versionSlots: readonly string[];
	readonly #versionFilter: string;
	readonly #active = new Set<string>();
	readonly #settling = new Set<Promise<void>>();
	readonly #native: NativeRegistryOwner | undefined;
	#closed = false;
	#closePromise: Promise<void> | undefined;
	constructor(
		options: PluginRegistryOptions,
		installer: PluginInstaller,
		root: string,
		catalog: readonly BundledPluginPin[],
		native?: NativeRegistryOwner,
	) {
		this.#options = options;
		this.#installer = installer;
		this.#root = root;
		this.#pins = new Map(catalog.map((pin) => [pinKey(pin.id, pin.package.version), pin.package]));
		this.#versionSlots = Object.freeze(catalog.flatMap((pin) => [pin.id, pin.package.version]));
		this.#versionFilter = catalog.map(() => "(plugin_id=? AND version=?)").join(" OR ");
		this.#native = native;
	}
	#owner(sql: SqlReader): Owner {
		if (this.#closed) refuse("unavailable");
		if (this.#native) assertNativePluginOwner(this.#native.session, this.#native.parts);
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
	#identity(
		sql: SqlTransaction,
		id: BundledPluginId,
		owner: Owner,
		selected: PluginRecord | undefined,
		at: number,
	): string {
		const previous = sql.get<IdentityRow>(`${IDENTITY_ROW} WHERE plugin_id=?`, [id]);
		if (previous) {
			const registryId = ulid(previous.id);
			if (
				previous.plugin_id !== id ||
				previous.owner_user_id !== owner.id ||
				previous.epoch !== owner.epoch ||
				(selected && selected.id !== registryId)
			)
				refuse("data");
			return registryId;
		}
		const registryId = selected?.id ?? newId(at);
		sql.run(
			"INSERT INTO main.plugin_registry_identities(id,plugin_id,owner_user_id,epoch) VALUES(?,?,?,?)",
			[registryId, id, owner.id, owner.epoch],
		);
		return registryId;
	}
	#newVersion(
		sql: SqlTransaction,
		id: BundledPluginId,
		version: string,
		descriptor: string,
		at: number,
	): string {
		// The bounded current catalog does not include every immutable historical version.
		const count = sql.get<{ n: number }>(
			`SELECT count(*) AS n FROM main.plugin_versions WHERE ${this.#versionFilter}`,
			this.#versionSlots,
		)?.n;
		if (!Number.isSafeInteger(count) || (count as number) >= this.#pins.size) refuse("data");
		const versionId = newId(at);
		sql.run(
			"INSERT INTO main.plugin_versions(id,plugin_id,version,descriptor,created_at) VALUES(?,?,?,?,?)",
			[versionId, id, version, descriptor, at],
		);
		return versionId;
	}
	#candidate(
		sql: SqlReader,
		rawRegistry: string,
		rawVersion: string,
		owner: Owner,
	): PluginCandidateRecord | undefined {
		const registryId = ulid(rawRegistry),
			versionId = ulid(rawVersion);
		if (registryId === versionId) refuse("input");
		const identity = sql.get<IdentityRow>(`${IDENTITY_ROW} WHERE id=?`, [registryId]);
		if (!identity) return undefined;
		const id = pluginId(identity.plugin_id);
		if (identity.owner_user_id !== owner.id || identity.epoch !== owner.epoch) refuse("data");
		const selected = this.#record(sql, id, owner);
		if (selected && selected.id !== registryId) refuse("data");
		const expectedGeneration = selected?.generation ?? 0;
		const row = sql.get<CandidateRow>(
			`${CANDIDATE_ROW} WHERE registry_id=? AND version_id=? AND expected_generation=?`,
			[registryId, versionId, expectedGeneration],
		);
		if (!row) return undefined;
		if (
			row.expected_generation !== expectedGeneration ||
			row.from_version_id !== (selected?.versionId ?? null) ||
			row.from_state !== (selected?.state ?? null)
		)
			refuse("data");
		const target = sql.get<VersionRow>(`${VERSION_ROW} WHERE id=?`, [versionId]);
		if (!target || target.plugin_id !== id || typeof target.version !== "string") refuse("data");
		const pin = this.#pins.get(pinKey(id, target.version));
		if (!pin || pin.version !== target.version) refuse("data");
		const from: PluginCandidatePrior | null = selected
			? Object.freeze({
					versionId: selected.versionId,
					version: selected.version,
					registryGeneration: selected.generation,
					state: selected.state,
				})
			: null;
		return Object.freeze({
			id: ulid(row.id),
			registryId,
			versionId,
			pluginId: id,
			version: pin.version,
			ownerUserId: owner.id,
			epoch: owner.epoch,
			expectedGeneration,
			from,
			installed: decode(target.descriptor, id, pin, this.#root),
		});
	}
	#scope<T>(scope: WorkScope, operation: (sql: SqlTransaction, owner: Owner) => T): T {
		try {
			const sql = workSql.call(this.#options.database, scope);
			assertStoreTransaction(this.#options.store, sql);
			const result = operation(sql, this.#owner(sql));
			if (this.#native) assertNativePluginOwner(this.#native.session, this.#native.parts);
			return result;
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
	getCandidate(registryId: string, versionId: string): PluginCandidateRecord | undefined {
		try {
			return storeRead.call(this.#options.store, (sql: SqlReader) =>
				this.#candidate(sql, registryId, versionId, this.#owner(sql)),
			) as PluginCandidateRecord | undefined;
		} catch (error) {
			throw error instanceof PluginRegistryError ? error : new PluginRegistryError("data");
		}
	}
	getCandidateInTransaction(
		scope: WorkScope,
		registryId: string,
		versionId: string,
	): PluginCandidateRecord | undefined {
		return this.#scope(scope, (sql, owner) => this.#candidate(sql, registryId, versionId, owner));
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
	stageBundled(
		rawId: BundledPluginId,
		version: string,
		archive: Uint8Array,
		rawExpected: number,
	): Promise<PluginRecord> {
		const result = this.#stageBundled(rawId, version, archive, rawExpected);
		return this.#track(result);
	}
	#track<T>(result: Promise<T>): Promise<T> {
		const settled = result.then(
			() => undefined,
			() => undefined,
		);
		this.#settling.add(settled);
		void settled.then(() => this.#settling.delete(settled));
		return result;
	}
	reserveBundledCandidate(
		id: BundledPluginId,
		version: string,
		archive: Uint8Array,
		expectedGeneration: number,
	): Promise<PluginCandidateRecord> {
		// Publish the whole pending operation before its fallible body can allocate resources.
		return this.#track(
			Promise.resolve().then(() =>
				this.#reserveBundledCandidate(id, version, archive, expectedGeneration),
			),
		);
	}
	async #reserveBundledCandidate(
		rawId: BundledPluginId,
		version: string,
		archive: Uint8Array,
		rawExpected: number,
	): Promise<PluginCandidateRecord> {
		let id: BundledPluginId | undefined;
		let reserved = false;
		try {
			if (this.#closed) refuse("unavailable");
			id = pluginId(rawId);
			const selectedId = id;
			const expected = integer(rawExpected, 0, Number.MAX_SAFE_INTEGER - 1);
			if (typeof version !== "string") refuse("input");
			const lock = this.#pins.get(pinKey(id, version));
			if (!lock) refuse("input");
			if (this.#active.has(id)) refuse("conflict");
			const preflight = (): { owner: Owner; selected: PluginRecord | undefined } =>
				workWrite.call(this.#options.database, (scope: WorkScope) =>
					this.#scope(scope, (sql, owner) => {
						const selected = this.#record(sql, selectedId, owner);
						if ((selected?.generation ?? 0) !== expected) refuse("conflict");
						return { owner, selected };
					}),
				) as { owner: Owner; selected: PluginRecord | undefined };
			const before = preflight();
			this.#active.add(id);
			reserved = true;
			let installed: InstalledPlugin;
			try {
				installed = await this.#installer.inspect(id, version, archive);
			} catch {
				const current = preflight();
				if (
					current.owner.id !== before.owner.id ||
					current.owner.epoch !== before.owner.epoch ||
					!sameSelection(current.selected, before.selected)
				)
					refuse("conflict");
				installed = await this.#installer.install(id, version, archive);
			}
			const retained = snapshot(installed, id, lock, this.#root),
				descriptor = encode(retained);
			if (this.#closed) refuse("unavailable");
			return workWrite.call(this.#options.database, (scope: WorkScope) =>
				this.#scope(scope, (sql, owner) => {
					const selected = this.#record(sql, selectedId, owner);
					if (
						owner.id !== before.owner.id ||
						owner.epoch !== before.owner.epoch ||
						!sameSelection(selected, before.selected)
					)
						refuse("conflict");
					const at = integer((this.#options.clock ?? systemClock).wallMs(), 0, 0xffffffffffff);
					const existing = sql.get<VersionRow>(`${VERSION_ROW} WHERE plugin_id=? AND version=?`, [
						selectedId,
						version,
					]);
					let versionId: string;
					if (existing) {
						if (
							existing.plugin_id !== selectedId ||
							existing.version !== version ||
							encode(decode(existing.descriptor, selectedId, lock, this.#root)) !== descriptor
						)
							refuse("data");
						versionId = ulid(existing.id);
					} else versionId = this.#newVersion(sql, selectedId, version, descriptor, at);
					const registryId = this.#identity(sql, selectedId, owner, selected, at);
					if (registryId === versionId) refuse("data");
					if (
						sql.get(
							"SELECT 1 AS found FROM main.plugin_candidates WHERE registry_id=? AND version_id=? AND expected_generation=?",
							[registryId, versionId, expected],
						)
					)
						refuse("conflict");
					const candidateId = newId(at);
					sql.run(
						"INSERT INTO main.plugin_candidates(id,registry_id,version_id,expected_generation,from_version_id,from_state,created_at) VALUES(?,?,?,?,?,?,?)",
						[
							candidateId,
							registryId,
							versionId,
							expected,
							selected?.versionId ?? null,
							selected?.state ?? null,
							at,
						],
					);
					const candidate = this.#candidate(sql, registryId, versionId, owner);
					if (!candidate || candidate.id !== candidateId) refuse("data");
					return candidate;
				}),
			) as PluginCandidateRecord;
		} catch (error) {
			throw error instanceof PluginRegistryError ? error : new PluginRegistryError("install");
		} finally {
			if (reserved && id !== undefined) this.#active.delete(id);
		}
	}
	async #stageBundled(
		rawId: BundledPluginId,
		version: string,
		archive: Uint8Array,
		rawExpected: number,
	): Promise<PluginRecord> {
		let id: BundledPluginId | undefined;
		let reserved = false;
		try {
			if (this.#closed) refuse("unavailable");
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
					const at = integer((this.#options.clock ?? systemClock).wallMs(), 0, 0xffffffffffff);
					const versionId = this.#newVersion(sql, selected, version, descriptor, at),
						recordId = this.#identity(sql, selected, current, previous, at);
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
	close(): Promise<void> {
		this.#closed = true;
		if (!this.#closePromise) {
			this.#closePromise = Promise.allSettled([...this.#settling, this.#installer.close()])
				.then((results) => {
					if (results.some((result) => result.status === "rejected"))
						throw new PluginRegistryError("unavailable");
				})
				.catch(() => {
					this.#closePromise = undefined;
					throw new PluginRegistryError("unavailable");
				});
			void this.#closePromise.catch(() => undefined);
		}
		return this.#closePromise;
	}
}

/** Native composition only: this stages verified records and never activates or reviews a plugin. */
export async function openPluginRegistry(raw: PluginRegistryOptions): Promise<PluginRegistry> {
	return createPluginRegistry(raw);
}

async function createPluginRegistry(
	raw: PluginRegistryOptions,
	native?: NativeRegistryOwner,
): Promise<PluginRegistry> {
	let installer: PluginInstaller | undefined;
	try {
		if (native) assertNativePluginOwner(native.session, native.parts);
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
		const config = fields(input.installer, ["directory", "bundles", "nativeBinding"]),
			catalog = pins(config.bundles);
		const root = await canonicalDirectory(config.directory);
		if (native) assertNativePluginOwner(native.session, native.parts);
		installer = native
			? await openNativePluginInstaller(native.session)
			: await openPluginInstaller({
					directory: root,
					bundles: catalog,
					nativeBinding: config.nativeBinding as string,
				});
		if (native) assertNativePluginOwner(native.session, native.parts);
		const records = new Records(options, installer, root, catalog, native);
		return Object.freeze({
			stageBundled: records.stageBundled.bind(records),
			reserveBundledCandidate: records.reserveBundledCandidate.bind(records),
			getCandidate: records.getCandidate.bind(records),
			getCandidateInTransaction: records.getCandidateInTransaction.bind(records),
			get: records.get.bind(records),
			getInTransaction: records.getInTransaction.bind(records),
			disable: records.disable.bind(records),
			quarantine: records.quarantine.bind(records),
			install: records.install.bind(records),
			upgrade: records.upgrade.bind(records),
			close: records.close.bind(records),
		});
	} catch {
		if (native) await closeNativePluginInstaller(native.session);
		else await installer?.close();
		throw new PluginRegistryError("unavailable");
	}
}
