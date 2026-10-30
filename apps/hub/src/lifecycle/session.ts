import { lstatSync, readdirSync, realpathSync, type Stats, statSync } from "node:fs";
import path from "node:path";
import { inspect, types } from "node:util";
import { AuditChain } from "../audit/chain.ts";
import {
	type ExtensionHost,
	type ExtensionLogEntry,
	startExtensions,
} from "../extensions/registry.ts";
import { dataMember, inertRecord, isPlainFunction } from "../extensions/values.ts";
import { HubIdentity } from "../identity/hub-key.ts";
import { PinService } from "../identity/pin.ts";
import { systemClock, type TimerClock } from "../kernel/clock.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { HUB_NAMESPACES } from "../kernel/namespaces.ts";
import { HubStore } from "../store/store.ts";

export type HubSessionErrorCode =
	| "SESSION_OPTIONS"
	| "SESSION_ACTIVE"
	| "HUB_STATE_INCOMPLETE"
	| "FIRST_RUN_INTERRUPTED"
	| "UNLOCK_REFUSED"
	| "STORE_UNAVAILABLE"
	| "IDENTITY_UNAVAILABLE"
	| "EXTENSIONS_UNAVAILABLE"
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
	readonly extensions: ExtensionHost;
	/**
	 * Closes the extensions, locks the PIN service and the identity, destroys the audit key, closes
	 * the store and erases the master key. Idempotent; a store close that fails is retried next call.
	 */
	close(): void;
}

interface Settings {
	readonly folder: string;
	readonly nativeBinding: string;
	readonly masterKey: MasterKey;
	readonly clock: TimerClock;
	readonly log: HubSessionOptions["log"];
}
interface Parts {
	readonly store: HubStore;
	readonly audit: AuditChain;
	readonly identity: HubIdentity;
	readonly pins: PinService;
	readonly extensions: ExtensionHost;
}

const DATABASE = "draftyak.db";
const NEVER_INITIALIZED =
	"Database was never initialized; remove this unused empty database before creating it again";
const AUDIT_INCOMPLETE =
	"Audit storage is missing or incomplete. Restore a valid backup; remove and recreate the database only if it was never used.";
// Without the database, any of these means a lost database rather than a first run.
const HUB_STATE =
	/^(?:draftyak\.db-(?:wal|shm|journal)|mk\.recovery|ext-.+\.db(?:-wal|-shm|-journal)?)$/;
const AUDIT_TABLE =
	"SELECT 1 AS found FROM main.sqlite_schema WHERE type='table' AND name='audit_meta'";
const deriveKey = MasterKey.prototype.derive;
const destroyKey = MasterKey.prototype.destroy;
const closeStore = HubStore.prototype.close;
const destroyAudit = AuditChain.prototype.destroy;
const lockIdentity = HubIdentity.prototype.lock;
const lockPins = PinService.prototype.lock;
const redacted = (): string => "[REDACTED]";
// One session per data folder in this process, from the start of its open until its store closes.
const live = new Set<string>();
// Stores that a failed open could not close; every later open retries them first.
const unclosed = new Set<HubStore>();

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
	} = inertRecord(options, ["folder", "nativeBinding", "masterKey"], ["clock", "log"], "config");
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

/** The handoff order before the store closes: extensions, PIN service, identity, audit key. */
function stop(parts: Partial<Parts>): boolean {
	let clean = true;
	try {
		parts.extensions?.close();
	} catch {
		clean = false;
	}
	if (parts.pins) lockPins.call(parts.pins);
	if (parts.identity) lockIdentity.call(parts.identity);
	if (parts.audit) destroyAudit.call(parts.audit);
	return clean;
}

function session(folder: string, masterKey: MasterKey, parts: Parts): HubSession {
	let stopped = false,
		done = false;
	const close = (): void => {
		if (done) return;
		let clean = true;
		if (!stopped) {
			stopped = true;
			clean = stop(parts);
		}
		// A store whose close fails stays with this session until a later call proves it closed.
		if (tryClose(parts.store)) {
			done = true;
			live.delete(folder);
		} else clean = false;
		erase(masterKey);
		if (!clean) throw new HubSessionError("CLOSE_INCOMPLETE");
	};
	const { identity } = parts;
	const result = { hubId: identity.hubId, hid: identity.hid, ...parts, close };
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
	for (const store of unclosed) if (tryClose(store)) unclosed.delete(store);
	if (live.has(folder) || unclosed.size > 0) {
		erase(masterKey);
		throw new HubSessionError(live.has(folder) ? "SESSION_ACTIVE" : "STORE_UNAVAILABLE");
	}
	live.add(folder);
	let code: HubSessionErrorCode = "STORE_UNAVAILABLE";
	let store: HubStore | undefined,
		audit: AuditChain | undefined,
		identity: HubIdentity | undefined,
		pins: PinService | undefined;
	try {
		const filename = path.join(folder, DATABASE);
		const existing = existingDatabase(folder, filename);
		try {
			store = new HubStore({
				filename,
				nativeBinding,
				masterKey,
				create: !existing,
				migrations: HUB_NAMESPACES,
			});
		} catch (error) {
			throw new HubSessionError(notADatabase(error) ? "UNLOCK_REFUSED" : "STORE_UNAVAILABLE");
		}
		// Checked before migrating: the refused migration would still write its bookkeeping tables.
		if (existing && !store.read((db) => db.get(AUDIT_TABLE)))
			throw new HubSessionError("FIRST_RUN_INTERRUPTED", AUDIT_INCOMPLETE);
		await store.migrate("audit");
		await store.migrate("core");
		const auditKey = deriveKey.call(masterKey, "audit");
		try {
			audit = new AuditChain(auditKey);
		} finally {
			auditKey.fill(0);
		}
		code = "IDENTITY_UNAVAILABLE";
		identity = await HubIdentity.loadOrCreate(store, masterKey);
		pins = new PinService(store, audit, clock);
		code = "EXTENSIONS_UNAVAILABLE";
		const extensions = await startExtensions({
			dataDirectory: folder,
			nativeBinding,
			masterKey,
			clock,
			log,
		});
		return session(folder, masterKey, { store, audit, identity, pins, extensions });
	} catch (error) {
		stop({ pins, identity, audit });
		if (store && !tryClose(store)) unclosed.add(store);
		erase(masterKey);
		live.delete(folder);
		throw error instanceof HubSessionError ? error : new HubSessionError(code);
	}
}
