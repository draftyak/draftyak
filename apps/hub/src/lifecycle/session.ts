import {
	type BigIntStats,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	type Stats,
	statSync,
} from "node:fs";
import path from "node:path";
import { inspect, types } from "node:util";
import type { IdentityProvider } from "@draftyak/extensions";
import { AuditChain } from "../audit/chain.ts";
import { EventLog } from "../events/log.ts";
import { singleOwnerIdentity } from "../extensions/free/identity.ts";
import {
	type ExtensionHost,
	type ExtensionLogEntry,
	startExtensions,
} from "../extensions/registry.ts";
import { dataMember, inertRecord, isPlainFunction } from "../extensions/values.ts";
import { DeviceRegistry } from "../identity/devices.ts";
import { HubIdentity } from "../identity/hub-key.ts";
import {
	createNativeAccountApprovalsHandle,
	type NativeAccountApprovals,
	type NativeAccountApprovalsHandle,
} from "../identity/native-account-approvals.ts";
import { PinService } from "../identity/pin.ts";
import { WorkDatabase } from "../jobs/database.ts";
import { systemClock, type TimerClock } from "../kernel/clock.ts";
import { admitDataFolder, type DataFolder } from "../kernel/data-directory.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../kernel/namespaces.ts";
import type { BundledPluginPin } from "../plugins/installer/index.ts";
import { rootDirectory } from "../plugins/installer/tree.ts";
import { openNativePluginRegistry, type PluginRegistry } from "../plugins/registry/index.ts";
import { pins as snapshotPins } from "../plugins/registry/values.ts";
import {
	createNativeBackupRecoveryHandle,
	type NativeBackupRecovery,
	type NativeBackupRecoveryHandle,
} from "../recovery/backup-recovery.ts";
import { HubStore } from "../store/store.ts";
import { RAW_CONTENT_MIGRATIONS } from "../sync/raw-store.ts";
import { drainNativePlugins, type NativePluginSessionParts } from "./native-session-context.ts";
import { StartupRefusal } from "./preflight.ts";

export type HubSessionErrorCode =
	| "SESSION_OPTIONS"
	| "SESSION_ACTIVE"
	| "SESSION_UNAVAILABLE"
	| "HUB_STATE_INCOMPLETE"
	| "FIRST_RUN_INTERRUPTED"
	| "UNLOCK_REFUSED"
	| "STORE_UNAVAILABLE"
	| "IDENTITY_UNAVAILABLE"
	| "DEVICES_UNAVAILABLE"
	| "IDENTITY_PROVIDER_UNAVAILABLE"
	| "EXTENSIONS_UNAVAILABLE"
	| "PLUGINS_UNAVAILABLE"
	| "CLOSE_INCOMPLETE";

/** Fixed and content-free: no path, key material or cause is carried. */
export class HubSessionError extends Error {
	readonly code: HubSessionErrorCode;
	constructor(code: HubSessionErrorCode, message: string = code) {
		super(message);
		this.name = "HubSessionError";
		this.code = code;
	}
}

export interface HubSessionOptions {
	/** The canonical data folder: absolute, an existing directory and its own real path. */
	readonly folder: string;
	/** Absolute path of the pinned SQLite binding (`.node`). */
	readonly nativeBinding: string;
	/** Owned by the session from this call on: a failed open erases it, and so does close(). */
	readonly masterKey: MasterKey;
	readonly clock?: TimerClock;
	readonly log?: (entry: ExtensionLogEntry) => void;
	/** Immutable native startup pins; no request or archive supplies this catalog. */
	readonly bundles?: readonly BundledPluginPin[];
}

/** The unlocked hub's services. JSON and inspection show none of them. */
export interface HubSession {
	readonly hubId: string;
	readonly hid: string;
	readonly store: HubStore;
	readonly audit: AuditChain;
	readonly identity: HubIdentity;
	/** The one PIN service for this store. */
	readonly pins: PinService;
	/** Native-only authority over this session's store, audit chain, identity and PIN service. */
	readonly devices: DeviceRegistry;
	/** The captured configured provider, or the native single-owner default; never grants rights. */
	readonly identityProvider: IdentityProvider;
	readonly extensions: ExtensionHost;
	/** The configured native registry, after genuine bootstrap. Accepts no configuration arguments. */
	plugins(): Promise<PluginRegistry>;
	/** Account approvals bound to this original session. Accepts no configuration arguments. */
	accountApprovals(): NativeAccountApprovals;
	/**
	 * Closes the extensions, locks device authority, the PIN service and identity, destroys the audit key, closes
	 * the store and erases the master key. Idempotent; a store close that fails is retried next call.
	 */
	close(): Promise<void>;
}

interface Settings {
	readonly folder: string;
	readonly nativeBinding: string;
	readonly masterKey: MasterKey;
	readonly clock: TimerClock;
	readonly log: HubSessionOptions["log"];
	readonly bundles: readonly BundledPluginPin[] | undefined;
}
interface Parts {
	readonly store: HubStore;
	readonly audit: AuditChain;
	readonly identity: HubIdentity;
	readonly pins: PinService;
	readonly devices: DeviceRegistry;
	readonly identityProvider: IdentityProvider;
	readonly extensions: ExtensionHost;
}

const DATABASE = "draftyak.db";
const NEVER_INITIALIZED =
	"Database was never initialized; remove this unused empty database before creating it again";
const AUDIT_INCOMPLETE =
	"Audit storage is missing or incomplete. Restore a valid backup; remove and recreate the database only if it was never used.";
// Without the database, any of these means a lost database rather than a first run.
const HUB_STATE =
	/^(?:draftyak\.db-(?:wal|shm|journal)|mk\.recovery|plugins|ext-.+\.db(?:-wal|-shm|-journal)?)$/;
const AUDIT_TABLE =
	"SELECT 1 AS found FROM main.sqlite_schema WHERE type='table' AND name='audit_meta'";
const deriveKey = MasterKey.prototype.derive;
const destroyKey = MasterKey.prototype.destroy;
const closeStore = HubStore.prototype.close;
const assertStoreKey = HubStore.prototype.assertMasterKey;
const currentDevices = DeviceRegistry.prototype.currentState;
const destroyAudit = AuditChain.prototype.destroy;
const lockIdentity = HubIdentity.prototype.lock;
const lockPins = PinService.prototype.lock;
const lockDevices = DeviceRegistry.prototype.lock;
const redacted = (): string => "[REDACTED]";
// One session per data folder in this process, from the start of its open until its store closes.
const live = new Set<string>();
// Stores that a failed open could not close; every later open retries them first.
const unclosed = new Set<{
	readonly store: HubStore | undefined;
	readonly admission: DataFolder;
}>();

interface NativeOwner {
	readonly config: Settings;
	readonly admission: DataFolder;
	readonly folderStat: BigIntStats;
	readonly parts: Parts;
	phase: "open" | "closing" | "closed";
	native?: NativePluginSessionParts;
	rootStat?: BigIntStats;
	pluginsPromise?: Promise<PluginRegistry>;
	accountApprovals?: NativeAccountApprovalsHandle;
	accountApprovalsClosed: boolean;
	recovery?: NativeBackupRecoveryHandle;
	recoveryClosed: boolean;
	closePromise?: Promise<void>;
	stopped: boolean;
	drained: boolean;
	storeClosed: boolean;
}
// Only the original constructing factory registers a session. There is no exported proof mint.
const nativeOwners = new WeakMap<object, NativeOwner>();

function assertFolder(admission: DataFolder, folder: string, original: BigIntStats): void {
	admission.assertHeld();
	const stat = lstatSync(folder, { bigint: true });
	if (
		!stat.isDirectory() ||
		stat.ino === 0n ||
		stat.ino !== original.ino ||
		stat.dev !== original.dev ||
		realpathSync.native(folder) !== folder
	)
		throw new HubSessionError("PLUGINS_UNAVAILABLE");
}

function sessionOwner(session: unknown, phase: "open" | "held"): NativeOwner {
	const owner =
		session !== null && typeof session === "object" && !types.isProxy(session)
			? nativeOwners.get(session)
			: undefined;
	if (
		!owner ||
		(phase !== "open" && phase !== "held") ||
		owner.phase === "closed" ||
		owner.storeClosed ||
		(phase === "open" && owner.phase !== "open")
	)
		throw new HubSessionError("SESSION_UNAVAILABLE");
	assertFolder(owner.admission, owner.config.folder, owner.folderStat);
	if (phase === "open") assertStoreKey.call(owner.parts.store, owner.config.masterKey);
	return owner;
}

/** Checks the original unlocked session's admission without creating plugin state. */
export function assertHubSessionAdmission(session: unknown): void {
	try {
		sessionOwner(session, "open");
	} catch {
		throw new HubSessionError("SESSION_UNAVAILABLE");
	}
}

/** Internal assertion only: no service parts or proof object leave the original owner. */
export function assertNativeBackupRecoveryOwner(
	session: unknown,
	expectedHandle: NativeBackupRecoveryHandle,
): void {
	const owner = sessionOwner(session, "open");
	if (owner.recovery !== expectedHandle || owner.recoveryClosed)
		throw new HubSessionError("SESSION_UNAVAILABLE");
}

/** Deep consuming seam; the public Session shape and package runtime exports stay fixed. */
export function nativeBackupRecovery(session: unknown): NativeBackupRecovery {
	const owner = sessionOwner(session, "open");
	owner.recovery ??= createNativeBackupRecoveryHandle(
		session,
		owner.parts.store,
		owner.config.masterKey,
		owner.config.folder,
	);
	const facade = owner.recovery.get();
	assertNativeBackupRecoveryOwner(session, owner.recovery);
	return facade;
}

/** Internal consuming seam only; not exported from the package root. */
export function nativePluginSession(
	session: unknown,
	phase: "open" | "held",
): NativePluginSessionParts {
	try {
		const owner = sessionOwner(session, phase);
		if (!owner.native) {
			if (phase !== "open" || !owner.config.bundles)
				throw new HubSessionError("PLUGINS_UNAVAILABLE");
			const state = currentDevices.call(owner.parts.devices);
			if (!state.bootstrapDone || state.ownerUserId === null)
				throw new HubSessionError("PLUGINS_UNAVAILABLE");
			const directory = path.join(owner.config.folder, "plugins");
			try {
				mkdirSync(directory, { mode: 0o700 });
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			owner.rootStat = rootDirectory(directory);
			const database = new WorkDatabase(owner.parts.store);
			owner.native = Object.freeze({
				store: owner.parts.store,
				database,
				devices: owner.parts.devices,
				audit: owner.parts.audit,
				events: new EventLog(database, () => owner.config.clock.wallMs()),
				directory,
				nativeBinding: owner.config.nativeBinding,
				bundles: owner.config.bundles,
				clock: owner.config.clock,
			});
		}
		rootDirectory(owner.native.directory, owner.rootStat);
		return owner.native;
	} catch {
		throw new HubSessionError("PLUGINS_UNAVAILABLE");
	}
}

function erase(key: unknown): void {
	try {
		if (!types.isProxy(key) && key instanceof MasterKey) destroyKey.call(key);
	} catch {
		/* Only a real MasterKey holds bytes to erase. */
	}
}

function tryClose(store: HubStore): boolean {
	try {
		closeStore.call(store);
		return true;
	} catch {
		return false;
	}
}

/** The PIN service calls wallMs; the extension deadlines call monotonicMs and after. */
const usableClock = (clock: object): boolean =>
	["wallMs", "monotonicMs", "after"].every((name) =>
		isPlainFunction(dataMember(clock, name, "config")),
	);

/** The key handed over with the options, found without running any accessor. */
function offeredKey(options: unknown): unknown {
	if (options === null || typeof options !== "object" || types.isProxy(options)) return undefined;
	return Object.getOwnPropertyDescriptor(options, "masterKey")?.value;
}

function settings(options: unknown): Settings {
	const {
		folder,
		nativeBinding,
		masterKey,
		clock = systemClock,
		log,
		bundles,
	} = inertRecord(
		options,
		["folder", "nativeBinding", "masterKey"],
		["clock", "log", "bundles"],
		"config",
	);
	if (
		types.isProxy(masterKey) ||
		!(masterKey instanceof MasterKey) ||
		typeof folder !== "string" ||
		!path.isAbsolute(folder) ||
		!lstatSync(folder).isDirectory() ||
		realpathSync.native(folder) !== folder ||
		typeof nativeBinding !== "string" ||
		!path.isAbsolute(nativeBinding) ||
		path.extname(nativeBinding) !== ".node" ||
		!statSync(nativeBinding).isFile() ||
		typeof clock !== "object" ||
		clock === null ||
		types.isProxy(clock) ||
		!usableClock(clock) ||
		(log !== undefined && (typeof log !== "function" || types.isProxy(log)))
	)
		throw new HubSessionError("SESSION_OPTIONS");
	return {
		folder,
		nativeBinding,
		masterKey,
		clock: clock as TimerClock,
		log: log as Settings["log"],
		bundles: bundles === undefined ? undefined : snapshotPins(bundles),
	};
}

/** True for an existing database; a missing one is a first run only without other hub state. */
function existingDatabase(folder: string, filename: string): boolean {
	let stat: Stats;
	try {
		stat = lstatSync(filename);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		if (readdirSync(folder).some((name) => HUB_STATE.test(name.toLowerCase())))
			throw new HubSessionError("HUB_STATE_INCOMPLETE");
		return false;
	}
	if (stat.isFile() && stat.size === 0)
		throw new HubSessionError("FIRST_RUN_INTERRUPTED", NEVER_INITIALIZED);
	return true;
}

const notADatabase = (error: unknown): boolean =>
	error instanceof Error && (error as NodeJS.ErrnoException).code === "SQLITE_NOTADB";

/** The handoff order before the store closes: extensions, devices, PIN service, identity, audit key. */
function stop(parts: Partial<Parts>): boolean {
	let clean = true;
	try {
		parts.extensions?.close();
	} catch {
		clean = false;
	}
	if (parts.devices) lockDevices.call(parts.devices);
	if (parts.pins) lockPins.call(parts.pins);
	if (parts.identity) lockIdentity.call(parts.identity);
	if (parts.audit) destroyAudit.call(parts.audit);
	return clean;
}

function session(
	config: Settings,
	admission: DataFolder,
	folderStat: BigIntStats,
	parts: Parts,
): HubSession {
	const { folder, masterKey } = config;
	const owner: NativeOwner = {
		config,
		admission,
		folderStat,
		parts,
		phase: "open",
		stopped: false,
		drained: false,
		accountApprovalsClosed: false,
		recoveryClosed: false,
		storeClosed: false,
	};
	const close = (): Promise<void> => {
		if (owner.closePromise) return owner.closePromise;
		if (owner.phase === "closed") {
			owner.closePromise = Promise.resolve();
			return owner.closePromise;
		}
		owner.phase = "closing";
		const { promise: closing, resolve, reject } = Promise.withResolvers<void>();
		owner.closePromise = closing;
		const draining: Promise<void>[] = [];
		const approvals = owner.accountApprovals;
		const recovery = owner.recovery;
		if (recovery && !owner.recoveryClosed) {
			try {
				recovery.beginClose();
			} catch {
				draining.push(Promise.reject(new HubSessionError("CLOSE_INCOMPLETE")));
			}
		}
		if (approvals && !owner.accountApprovalsClosed) {
			try {
				approvals.beginClose();
			} catch {
				draining.push(Promise.reject(new HubSessionError("CLOSE_INCOMPLETE")));
			}
		}
		if (owner.native && !owner.drained) {
			try {
				draining.push(
					drainNativePlugins(result).then(() => {
						owner.drained = true;
					}),
				);
			} catch {
				draining.push(Promise.reject(new HubSessionError("CLOSE_INCOMPLETE")));
			}
		}
		if (approvals && !owner.accountApprovalsClosed) {
			try {
				draining.push(
					approvals.close().then(() => {
						owner.accountApprovalsClosed = true;
					}),
				);
			} catch {
				draining.push(Promise.reject(new HubSessionError("CLOSE_INCOMPLETE")));
			}
		}
		if (recovery && !owner.recoveryClosed) {
			try {
				draining.push(
					recovery.close().then(() => {
						owner.recoveryClosed = true;
					}),
				);
			} catch {
				draining.push(Promise.reject(new HubSessionError("CLOSE_INCOMPLETE")));
			}
		}
		let clean = true;
		if (!owner.stopped) {
			owner.stopped = true;
			try {
				clean = stop(parts);
			} catch {
				clean = false;
			}
		}
		const finish = (): void => {
			if (!owner.storeClosed) {
				if (!tryClose(parts.store)) throw new HubSessionError("CLOSE_INCOMPLETE");
				owner.storeClosed = true;
			}
			admission.release();
			owner.phase = "closed";
			live.delete(folder);
			if (!clean) throw new HubSessionError("CLOSE_INCOMPLETE");
		};
		const settle = (drained: boolean): void => {
			try {
				if (!drained) throw new HubSessionError("CLOSE_INCOMPLETE");
				finish();
				resolve();
			} catch {
				reject(new HubSessionError("CLOSE_INCOMPLETE"));
			} finally {
				erase(masterKey);
			}
		};
		if (draining.length > 0) {
			void Promise.allSettled(draining).then((outcomes) => {
				settle(outcomes.every((outcome) => outcome.status === "fulfilled"));
			});
		} else {
			// Keep the genuine busy-store refusal synchronous, even though completion is awaitable.
			settle(true);
		}
		void closing.catch(() => {
			if (owner.closePromise === closing) owner.closePromise = undefined;
		});
		return closing;
	};
	const plugins = (...arguments_: unknown[]): Promise<PluginRegistry> => {
		if (arguments_.length !== 0 || owner.phase !== "open")
			return Promise.reject(new HubSessionError("PLUGINS_UNAVAILABLE"));
		try {
			const state = currentDevices.call(parts.devices);
			if (!state.bootstrapDone || state.ownerUserId === null)
				throw new HubSessionError("PLUGINS_UNAVAILABLE");
			nativePluginSession(result, "open");
		} catch {
			return Promise.reject(new HubSessionError("PLUGINS_UNAVAILABLE"));
		}
		if (!owner.pluginsPromise) {
			let opening: Promise<PluginRegistry>;
			try {
				opening = openNativePluginRegistry(result);
			} catch {
				return Promise.reject(new HubSessionError("PLUGINS_UNAVAILABLE"));
			}
			const pending = opening.catch(() => {
				throw new HubSessionError("PLUGINS_UNAVAILABLE");
			});
			owner.pluginsPromise = pending;
			void pending.catch(() => {
				if (owner.pluginsPromise === pending) owner.pluginsPromise = undefined;
			});
		}
		return owner.pluginsPromise;
	};
	const accountApprovals = (...arguments_: unknown[]): NativeAccountApprovals => {
		try {
			if (arguments_.length !== 0) throw new HubSessionError("SESSION_UNAVAILABLE");
			sessionOwner(result, "open");
			owner.accountApprovals ??= createNativeAccountApprovalsHandle(
				result,
				masterKey,
				config.clock,
			);
			const approvals = owner.accountApprovals.get();
			sessionOwner(result, "open");
			return approvals;
		} catch {
			throw new HubSessionError("SESSION_UNAVAILABLE");
		}
	};
	const { identity } = parts;
	const result = {
		hubId: identity.hubId,
		hid: identity.hid,
		...parts,
		plugins,
		accountApprovals,
		close,
	};
	nativeOwners.set(result, owner);
	Object.defineProperty(result, "toJSON", { value: redacted });
	Object.defineProperty(result, inspect.custom, { value: redacted });
	return Object.freeze(result);
}

/**
 * Opens the hub in its data folder and owns the master key from the call on. A missing database is
 * created only in a folder without other hub state, and an existing one is never created again. An
 * interrupted first run or a wrong key refuses before any migration, deletes nothing and creates
 * no identity.
 */
export async function openHubSession(options: HubSessionOptions): Promise<HubSession> {
	const offered = offeredKey(options);
	let config: Settings;
	try {
		config = settings(options);
	} catch {
		erase(offered);
		throw new HubSessionError("SESSION_OPTIONS");
	}
	const { folder, nativeBinding, masterKey, clock, log } = config;
	for (const pending of unclosed)
		if (!pending.store || tryClose(pending.store)) {
			try {
				pending.admission.release();
				unclosed.delete(pending);
			} catch {
				/* Retain the original admission for retry. */
			}
		}
	if (live.has(folder) || unclosed.size > 0) {
		erase(masterKey);
		throw new HubSessionError(live.has(folder) ? "SESSION_ACTIVE" : "STORE_UNAVAILABLE");
	}
	live.add(folder);
	let code: HubSessionErrorCode = "STORE_UNAVAILABLE";
	let store: HubStore | undefined,
		audit: AuditChain | undefined,
		identity: HubIdentity | undefined,
		pins: PinService | undefined,
		devices: DeviceRegistry | undefined,
		extensions: ExtensionHost | undefined,
		admission: DataFolder | undefined;
	try {
		// Authenticate the offered native key before admission creates any filesystem state.
		const checkedKey = deriveKey.call(masterKey, "db");
		checkedKey.fill(0);
		try {
			admission = admitDataFolder(folder, { nativeBinding });
		} catch (error) {
			throw new HubSessionError(
				error instanceof StartupRefusal && error.code === "DATA_DIR_LOCKED"
					? "SESSION_ACTIVE"
					: "STORE_UNAVAILABLE",
			);
		}
		const folderStat = lstatSync(folder, { bigint: true });
		assertFolder(admission, folder, folderStat);
		const filename = path.join(folder, DATABASE);
		const existing = existingDatabase(folder, filename);
		try {
			store = new HubStore({
				filename,
				nativeBinding,
				masterKey,
				create: !existing,
				migrations: { ...HUB_NAMESPACES, rawcontent: RAW_CONTENT_MIGRATIONS },
			});
		} catch (error) {
			throw new HubSessionError(notADatabase(error) ? "UNLOCK_REFUSED" : "STORE_UNAVAILABLE");
		}
		// Checked before migrating: the refused migration would still write its bookkeeping tables.
		if (existing && !store.read((db) => db.get(AUDIT_TABLE)))
			throw new HubSessionError("FIRST_RUN_INTERRUPTED", AUDIT_INCOMPLETE);
		await migrateHubSchemas(store);
		assertFolder(admission, folder, folderStat);
		const auditKey = deriveKey.call(masterKey, "audit");
		try {
			audit = new AuditChain(auditKey);
		} finally {
			auditKey.fill(0);
		}
		code = "IDENTITY_UNAVAILABLE";
		identity = await HubIdentity.loadOrCreate(store, masterKey);
		pins = new PinService(store, audit, clock);
		code = "DEVICES_UNAVAILABLE";
		devices = new DeviceRegistry(store, audit, pins, { identity, clock });
		code = "EXTENSIONS_UNAVAILABLE";
		extensions = await startExtensions({
			dataDirectory: folder,
			nativeBinding,
			masterKey,
			clock,
			log,
		});
		code = "IDENTITY_PROVIDER_UNAVAILABLE";
		const identityProvider = extensions.providers("identity")[0] ?? singleOwnerIdentity(devices);
		assertFolder(admission, folder, folderStat);
		return session(config, admission, folderStat, {
			store,
			audit,
			identity,
			pins,
			devices,
			identityProvider,
			extensions,
		});
	} catch (error) {
		stop({ extensions, devices, pins, identity, audit });
		if (store && !tryClose(store) && admission) unclosed.add({ store, admission });
		else if (admission) {
			try {
				admission.release();
			} catch {
				unclosed.add({ store, admission });
			}
		}
		erase(masterKey);
		live.delete(folder);
		throw error instanceof HubSessionError ? error : new HubSessionError(code);
	}
}
