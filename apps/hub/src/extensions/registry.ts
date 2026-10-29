import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";
import {
	type AdminOperation,
	type AuditSink,
	type BackupTarget,
	type CertProvider,
	defineExtensionModule,
	type ExtensionDeviceRoutes,
	type ExtensionRegistry,
	type HubModule,
	type IdentityProvider,
	type IdsOnlyEvent,
	type Logger,
	type PushProvider,
	type SendPolicyInput,
	type TransportProvider,
	type WorkspaceProvider,
} from "@draftyak/extensions";
import { DataClass } from "@draftyak/protocol/data-class";
import { AuditEvent } from "@draftyak/protocol/entities/audit";
import { Ulid } from "@draftyak/protocol/scalars";
import { systemClock, type TimerClock } from "../kernel/clock.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { moduleUrl, reverifyModule, type VerifiedModule, verifyModule } from "./artifacts.ts";
import { type ExtensionService, loadExtensionConfig, type ModuleConfig } from "./config.ts";
import {
	type ModuleDatabaseOwner,
	openModuleDatabase,
	retryRetainedConnections,
} from "./database.ts";
import { ExtensionError, refuse } from "./errors.ts";
import {
	canAccessAll,
	type DeadlineClock,
	evaluateSendPolicies,
	type RegisteredSendPolicy,
	type RegisteredWorkspaceAccess,
	type SendPolicyDecision,
	settleWithin,
} from "./policy.ts";
import {
	dataMember,
	denseArray,
	frozenCopy,
	inertRecord,
	isIdentifier,
	isPlainFunction,
	isThenable,
	ownData,
} from "./values.ts";

/** A module still evaluating, or still in register(), after ten seconds fails startup. */
export const MODULE_TIMEOUT_MS = 10_000;
export const MAX_LISTENERS = 16;
export const MAX_ADMIN_OPERATIONS = 32;
const MAX_REFUSED_CLASSES = 64;
const MAX_RENEW_BEFORE_MS = 366 * 24 * 60 * 60 * 1000;
const ACTION = /^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)*$/;
const REFERENCE = /^[a-z][A-Za-z0-9]{0,31}$/;

interface ProviderTypes {
	readonly transport: TransportProvider;
	readonly cert: CertProvider;
	readonly push: PushProvider;
	readonly backup: BackupTarget;
	readonly identity: IdentityProvider;
	readonly auditSink: AuditSink;
	readonly workspace: WorkspaceProvider;
}
export type ProviderService = keyof ProviderTypes;
export type RegisteredProvider<Service extends ProviderService> = Readonly<
	ProviderTypes[Service]
> & { readonly module: string };

export interface ExtensionModuleInfo {
	readonly id: string;
	readonly version: string;
}
export interface ExtensionLogEntry {
	readonly module: string;
	readonly level: "debug" | "info" | "warn" | "error";
	readonly action: string;
	readonly refs: Readonly<Record<string, string>>;
}
export interface ExtensionStartOptions {
	/** Canonical data folder holding config.json and each module's ext-<id>.db. */
	readonly dataDirectory: string;
	readonly nativeBinding: string;
	/** Derives each module's database key before any module code runs; never retained. */
	readonly masterKey: MasterKey;
	/** Timers and the monotonic clock behind every module deadline; captured once at start. */
	readonly clock?: TimerClock;
	readonly log?: (entry: ExtensionLogEntry) => void;
}

/** Native-only view of the loaded modules; nothing here is reachable from a module. */
export interface ExtensionHost {
	readonly modules: readonly ExtensionModuleInfo[];
	providers<Service extends ProviderService>(
		service: Service,
	): readonly RegisteredProvider<Service>[];
	/** AND-ed with core policy: deny wins, require only adds; a throw, timeout or invalid result denies. */
	evaluateSendPolicy(input: SendPolicyInput): Promise<SendPolicyDecision>;
	/** AND-ed with core ownership and routing; only an exact true from every provider allows. */
	canAccessWorkspace(userId: string, accountId: string): Promise<boolean>;
	/** Registration grants nothing: core verifies the admin statement and PIN before apply(). */
	adminOperation(module: string, kind: string): AdminOperation | undefined;
	/** The captured fetch; core mounts it only under L2 /ext/<id>/* after mTLS and current authorization. */
	deviceRoutes(module: string): Pick<ExtensionDeviceRoutes, "fetch"> | undefined;
	/** Delivers an ids-only projection to module listeners without awaiting them. */
	notify(event: AuditEvent): void;
	/** Retires every registration, so methods returned earlier refuse, and closes every module database. */
	close(): void;
}

interface ServiceSpec {
	readonly methods: readonly string[];
	readonly optional?: readonly string[];
	readonly single?: boolean;
}
const SPECS: Readonly<Record<ProviderService | "sendPolicy", ServiceSpec>> = {
	transport: { methods: ["start", "addresses", "stop"] },
	cert: { methods: ["obtain"] },
	push: { methods: ["register", "notify"] },
	backup: { methods: ["put", "list", "get", "delete"] },
	identity: { methods: ["users", "maxOwners"], optional: ["authenticateBrowser"], single: true },
	sendPolicy: { methods: ["evaluate"] },
	auditSink: { methods: ["append"] },
	workspace: { methods: ["workspacesFor", "canAccess"], optional: ["assign"], single: true },
};
const PROVIDERS = Object.keys(SPECS).filter(
	(service): service is ProviderService => service !== "sendPolicy",
);

type Registration = Readonly<Record<string, unknown>> & {
	readonly module: string;
	readonly id: string;
};
interface Staging {
	readonly config: ModuleConfig;
	readonly services: Map<ProviderService | "sendPolicy", Registration>;
	readonly operations: Map<string, AdminOperation>;
	readonly listeners: ((event: IdsOnlyEvent) => void)[];
	routes?: Pick<ExtensionDeviceRoutes, "fetch">;
	migrations: boolean;
	active: boolean;
	poisoned: boolean;
}

/** Calls the captured method on its own object; once the host closes, every call refuses. */
const bound =
	(target: object, method: unknown, open: () => boolean) =>
	(...args: unknown[]): unknown => {
		if (!open()) refuse("unavailable");
		return Reflect.apply(method as (...args: unknown[]) => unknown, target, args);
	};

function staticFields(service: ProviderService | "sendPolicy", provider: object): object {
	if (service === "backup") {
		const refuses = denseArray(
			dataMember(provider, "refuses", "registration"),
			MAX_REFUSED_CLASSES,
			"registration",
		);
		if (
			!refuses.every((value) => DataClass.safeParse(value).success) ||
			new Set(refuses).size !== refuses.length
		)
			refuse("registration");
		return { refuses: Object.freeze(refuses) };
	}
	if (service === "cert") {
		const renewBeforeMs = dataMember(provider, "renewBeforeMs", "registration");
		if (
			typeof renewBeforeMs !== "number" ||
			!Number.isSafeInteger(renewBeforeMs) ||
			renewBeforeMs < 1 ||
			renewBeforeMs > MAX_RENEW_BEFORE_MS
		)
			refuse("registration");
		return { renewBeforeMs };
	}
	return {};
}

/** Snapshots the id, fixed fields and methods once; later changes to the object never apply. */
function capture(
	service: ProviderService | "sendPolicy",
	provider: unknown,
	module: string,
	open: () => boolean,
): Registration {
	if (provider === null || typeof provider !== "object" || types.isProxy(provider))
		refuse("registration");
	const id = dataMember(provider, "id", "registration");
	if (!isIdentifier(id)) refuse("registration");
	const spec = SPECS[service];
	const record: Record<string, unknown> = Object.assign(Object.create(null) as object, {
		module,
		id,
		...staticFields(service, provider),
	});
	for (const name of [...spec.methods, ...(spec.optional ?? [])]) {
		const method = dataMember(provider, name, "registration");
		if (method === undefined && spec.optional?.includes(name)) continue;
		if (!isPlainFunction(method)) refuse("registration");
		record[name] = bound(provider, method, open);
	}
	return Object.freeze(record) as Registration;
}

function adminOperation(handler: unknown, open: () => boolean): AdminOperation {
	if (handler === null || typeof handler !== "object" || types.isProxy(handler))
		refuse("registration");
	const summarize = dataMember(handler, "summarize", "registration"),
		apply = dataMember(handler, "apply", "registration");
	if (!isPlainFunction(summarize) || !isPlainFunction(apply)) refuse("registration");
	return Object.freeze(
		Object.assign(Object.create(null) as object, {
			summarize: bound(handler, summarize, open),
			apply: bound(handler, apply, open),
		}),
	) as AdminOperation;
}

/** Only the fetch entry is kept; the module's own routes object never reaches core. */
function deviceRoutes(routes: unknown, open: () => boolean): Pick<ExtensionDeviceRoutes, "fetch"> {
	if (routes === null || typeof routes !== "object" || types.isProxy(routes))
		refuse("registration");
	const fetch = dataMember(routes, "fetch", "registration");
	if (!isPlainFunction(fetch)) refuse("registration");
	return Object.freeze(
		Object.assign(Object.create(null) as object, { fetch: bound(routes, fetch, open) }),
	) as Pick<ExtensionDeviceRoutes, "fetch">;
}

/** Entries carry the module id, a validated action code and ULID references; never free text. */
function logger(module: string, sink: ExtensionStartOptions["log"], usable: () => boolean): Logger {
	const write =
		(level: ExtensionLogEntry["level"]) =>
		(action: unknown, refs?: unknown): void => {
			if (!usable()) refuse("unavailable");
			if (typeof action !== "string" || action.length > 64 || ACTION.exec(action)?.[0] !== action)
				refuse("module");
			const copied: [string, string][] = [];
			for (const [kind, value] of refs === undefined ? [] : ownData(refs, 32, "module")) {
				if (REFERENCE.exec(kind)?.[0] !== kind || !Ulid.safeParse(value).success) refuse("module");
				copied.push([kind, value as string]);
			}
			const entry = Object.freeze({
				module,
				level,
				action,
				refs: Object.freeze(Object.fromEntries(copied)),
			});
			try {
				sink?.(entry);
			} catch {
				/* A failing hub sink never reaches the module. */
			}
		};
	return Object.freeze(
		Object.assign(Object.create(null) as object, {
			debug: write("debug"),
			info: write("info"),
			warn: write("warn"),
			error: write("error"),
		}),
	) as Logger;
}

/** One frozen registry per module; registrations count only while its register() runs. */
function moduleRegistry(
	staging: Staging,
	owner: ModuleDatabaseOwner,
	others: readonly Staging[],
	log: Logger,
	open: () => boolean,
): ExtensionRegistry {
	const { config } = staging;
	const registration =
		<Args extends unknown[]>(apply: (...args: Args) => void) =>
		(...args: Args): void => {
			if (!staging.active) refuse("registration");
			try {
				apply(...args);
			} catch (error) {
				// A refused registration fails startup even when the module catches the error.
				staging.poisoned = true;
				throw error instanceof ExtensionError ? error : new ExtensionError("registration");
			}
		};
	const provider = (service: ProviderService | "sendPolicy") =>
		registration((value: unknown) => {
			if (!config.provides.has(service) || staging.services.has(service)) refuse("registration");
			const record = capture(service, value, config.id, open);
			for (const other of others) {
				const existing = other.services.get(service);
				if (existing && (SPECS[service].single || existing.id === record.id))
					refuse("registration");
			}
			staging.services.set(service, record);
		});
	return Object.freeze(
		Object.assign(Object.create(null) as object, {
			transport: provider("transport"),
			cert: provider("cert"),
			push: provider("push"),
			backup: provider("backup"),
			identity: provider("identity"),
			sendPolicy: provider("sendPolicy"),
			auditSink: provider("auditSink"),
			workspace: provider("workspace"),
			// The configured, pinned migrations already ran; a declaration must name that folder.
			migrations: registration((directory: unknown) => {
				if (
					staging.migrations ||
					typeof directory !== "string" ||
					directory !== config.migrations?.directory
				)
					refuse("registration");
				staging.migrations = true;
			}),
			db: () => owner.database,
			adminOp: registration((kind: unknown, handler: unknown) => {
				if (
					!config.provides.has("adminOp") ||
					!isIdentifier(kind) ||
					staging.operations.has(kind) ||
					staging.operations.size >= MAX_ADMIN_OPERATIONS
				)
					refuse("registration");
				staging.operations.set(kind, adminOperation(handler, open));
			}),
			deviceRoutes: registration((routes: unknown) => {
				if (!config.provides.has("deviceRoutes") || staging.routes !== undefined)
					refuse("registration");
				// Module-owned handlers; they only ever answer under the module's own /ext/<id>/ prefix.
				staging.routes = deviceRoutes(routes, open);
			}),
			onEvent: registration((listener: unknown) => {
				if (!isPlainFunction(listener) || staging.listeners.length >= MAX_LISTENERS)
					refuse("registration");
				staging.listeners.push(listener);
			}),
			log,
		}),
	) as ExtensionRegistry;
}

function provided(staging: Staging, service: ExtensionService): boolean {
	if (service === "adminOp") return staging.operations.size > 0;
	if (service === "deviceRoutes") return staging.routes !== undefined;
	return staging.services.has(service);
}

/** Imports the verified bytes, never the file, and checks the default export against its config. */
async function loadModule(verified: VerifiedModule, clock: DeadlineClock): Promise<HubModule> {
	const { config } = verified;
	reverifyModule(verified);
	const settled = await settleWithin(() => import(moduleUrl(verified)), MODULE_TIMEOUT_MS, clock);
	let descriptor: HubModule;
	try {
		if (settled === undefined) refuse("module");
		// Engine namespace objects hold only data bindings; the export itself must pass the contract.
		const exported = Reflect.getOwnPropertyDescriptor(settled.value as object, "default");
		if (!exported || !("value" in exported)) refuse("module");
		descriptor = defineExtensionModule(exported.value as HubModule);
	} catch {
		refuse("module");
	}
	if (
		descriptor.id !== config.id ||
		descriptor.version !== config.version ||
		(descriptor.migrations !== undefined && descriptor.migrations !== config.migrations?.directory)
	)
		refuse("module");
	return descriptor;
}

/** Captures the host's timer and monotonic clock once; later changes to the object never apply. */
function deadlineClock(clock: unknown): DeadlineClock {
	if (clock === null || typeof clock !== "object" || types.isProxy(clock)) refuse("config");
	const after = dataMember(clock, "after", "config"),
		monotonicMs = dataMember(clock, "monotonicMs", "config");
	if (!isPlainFunction(after) || !isPlainFunction(monotonicMs)) refuse("config");
	return Object.freeze({
		after: (ms: number, signal?: AbortSignal) =>
			Reflect.apply(after, clock, [ms, signal]) as Promise<void>,
		monotonicMs: () => Reflect.apply(monotonicMs, clock, []) as number,
	});
}

function startOptions(options: ExtensionStartOptions): Pick<
	ExtensionStartOptions,
	"dataDirectory" | "nativeBinding" | "masterKey" | "log"
> & {
	readonly clock: DeadlineClock;
} {
	const record = inertRecord(
		options,
		["dataDirectory", "nativeBinding", "masterKey"],
		["clock", "log"],
		"config",
	);
	const { dataDirectory, nativeBinding, masterKey, clock, log } = record;
	if (
		typeof dataDirectory !== "string" ||
		typeof nativeBinding !== "string" ||
		types.isProxy(masterKey) ||
		!(masterKey instanceof MasterKey) ||
		(log !== undefined && !isPlainFunction(log))
	)
		refuse("config");
	const deadlines = deadlineClock(clock === undefined ? systemClock : clock);
	try {
		if (
			!path.isAbsolute(dataDirectory) ||
			!lstatSync(dataDirectory).isDirectory() ||
			realpathSync.native(dataDirectory) !== dataDirectory
		)
			refuse("config");
	} catch {
		refuse("config");
	}
	return {
		dataDirectory,
		nativeBinding,
		masterKey,
		clock: deadlines,
		log: log as ExtensionStartOptions["log"],
	};
}

// One live host per data folder: two would hold separate connections to the same module files.
const live = new Set<string>();

interface StartState {
	open: boolean;
	readonly stagings: Staging[];
	readonly owners: ModuleDatabaseOwner[];
}

function release(state: StartState): boolean {
	state.open = false;
	for (const staging of state.stagings) staging.active = false;
	let clean = true;
	for (const owner of state.owners) clean = owner.close() && clean;
	return clean;
}

function host(state: StartState, clock: DeadlineClock, folder: string): ExtensionHost {
	const { stagings } = state;
	const lists = new Map(
		PROVIDERS.map((service) => [
			service,
			Object.freeze(stagings.flatMap((staging) => staging.services.get(service) ?? [])),
		]),
	);
	const policies = stagings.flatMap(
		(staging) => (staging.services.get("sendPolicy") as RegisteredSendPolicy | undefined) ?? [],
	);
	const workspaces = (lists.get("workspace") ??
		[]) as unknown as readonly RegisteredWorkspaceAccess[];
	const listeners = stagings.flatMap((staging) => staging.listeners);
	const byId = new Map(stagings.map((staging) => [staging.config.id, staging]));
	const denied: SendPolicyDecision = Object.freeze({ kind: "deny", policies: Object.freeze([]) });
	return Object.freeze({
		modules: Object.freeze(
			stagings.map(({ config }) => Object.freeze({ id: config.id, version: config.version })),
		),
		providers: <Service extends ProviderService>(service: Service) => {
			const list = lists.get(service);
			if (list === undefined) throw new TypeError("Unknown extension service");
			return (state.open ? list : Object.freeze([])) as readonly RegisteredProvider<Service>[];
		},
		evaluateSendPolicy: async (input: SendPolicyInput): Promise<SendPolicyDecision> => {
			if (!state.open) return denied;
			const decision = await evaluateSendPolicies(policies, input, clock);
			return state.open ? decision : denied;
		},
		canAccessWorkspace: async (userId: string, accountId: string): Promise<boolean> =>
			state.open && (await canAccessAll(workspaces, userId, accountId, clock)) && state.open,
		adminOperation: (module: string, kind: string) =>
			state.open ? byId.get(module)?.operations.get(kind) : undefined,
		deviceRoutes: (module: string) => (state.open ? byId.get(module)?.routes : undefined),
		notify: (event: AuditEvent): void => {
			const parsed = AuditEvent.safeParse(event);
			if (!state.open || !parsed.success) return;
			const { id, at, action, refs } = parsed.data;
			const projection: IdsOnlyEvent = frozenCopy({ id, at, action, refs });
			for (const listener of listeners)
				queueMicrotask(() => {
					if (!state.open) return;
					try {
						isThenable(listener(projection));
					} catch {
						/* A listener failure stays with its module. */
					}
				});
		},
		close: (): void => {
			if (!state.open) return;
			const clean = release(state);
			live.delete(folder);
			if (!clean) refuse("cleanup");
		},
	});
}

/**
 * Loads the configured modules in three steps. Every pin is checked before any module code runs.
 * Each module's own database is then opened and migrated from the verified bytes, still before any
 * module code runs. Finally each module is checked again at its load boundary, imported from the
 * verified bytes and registered, in config order. Any failure retires every registration, closes
 * every module database and returns no host.
 */
export async function startExtensions(options: ExtensionStartOptions): Promise<ExtensionHost> {
	const { dataDirectory, nativeBinding, masterKey, clock, log } = startOptions(options);
	if (live.has(dataDirectory)) refuse("unavailable");
	if (!retryRetainedConnections()) refuse("cleanup");
	live.add(dataDirectory);
	const state: StartState = { open: true, stagings: [], owners: [] };
	const open = (): boolean => state.open;
	try {
		const verified = loadExtensionConfig(dataDirectory).modules.map(verifyModule);
		for (const { config, migrations } of verified)
			state.owners.push(
				await openModuleDatabase({
					dataDirectory,
					nativeBinding,
					masterKey,
					id: config.id,
					migrations,
				}),
			);
		for (const [index, artifact] of verified.entries()) {
			const descriptor = await loadModule(artifact, clock);
			const staging: Staging = {
				config: artifact.config,
				services: new Map(),
				operations: new Map(),
				listeners: [],
				migrations: false,
				active: true,
				poisoned: false,
			};
			const registry = moduleRegistry(
				staging,
				state.owners[index] ?? refuse("database"),
				[...state.stagings],
				logger(artifact.config.id, log, open),
				open,
			);
			state.stagings.push(staging);
			const settled = await settleWithin(
				() => descriptor.register(registry),
				MODULE_TIMEOUT_MS,
				clock,
			);
			staging.active = false;
			if (staging.poisoned) refuse("registration");
			if (settled === undefined) refuse("module");
			for (const service of artifact.config.provides)
				if (!provided(staging, service)) refuse("registration");
		}
		return host(state, clock, dataDirectory);
	} catch (error) {
		release(state);
		live.delete(dataDirectory);
		throw error instanceof ExtensionError ? error : new ExtensionError("module");
	}
}
