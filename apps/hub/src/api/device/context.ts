import type { TLSSocket } from "node:tls";
import { types } from "node:util";
import {
	type BootstrapRequest,
	type DeviceStatus,
	SendReview,
} from "@draftyak/protocol/device-api";
import type { DeviceCapability } from "@draftyak/protocol/entities/device";
import type { HubMode } from "@draftyak/protocol/hub-runtime";
import { Authorizer, type RouteGrant } from "../../authz/authorizer.ts";
import { AuthzError } from "../../authz/errors.ts";
import { type NativeDevicePeer, NativeDeviceTls } from "../../authz/native-peer.ts";
import type { DeviceGrant } from "../../identity/devices.ts";
import { DevicePairingAuthority, DevicePairingRefusal } from "../../identity/devices-pairing.ts";
import { MasterKey } from "../../kernel/master-key.ts";
import {
	createNativeRuntimeState,
	type NativeRuntimeState,
} from "../../lifecycle/native-runtime-state.ts";
import {
	assertHubSessionAdmission,
	type HubSession,
	type HubSessionOptions,
	nativePairingWindows,
	openHubSession,
} from "../../lifecycle/session.ts";
import { createNativeEventWebSocket, type NativeEventWebSocket } from "./events-websocket.ts";
import {
	captureNativeOutboxFooterPolicy,
	createNativeOutboxReadContext,
	type NativeOutboxFooterPolicy,
	type NativeOutboxReadContext,
} from "./outbox-context.ts";
import {
	attachNativeDeviceHttp,
	type NativeDeviceRequest,
	type NativeDeviceRouteResult,
} from "./routes.ts";

/** Captured native startup DATA; requests cannot select the upstream mode. */
export interface NativeDeviceApiConfig {
	readonly testUpstreams: boolean;
	/** Explicit native startup choice; absent policy never supplies proposal facts. */
	readonly footerPolicy?: NativeOutboxFooterPolicy;
	/** Hosting choice captured by native construction, never selected by a request. */
	readonly runtimeMode?: HubMode;
}

export interface NativeDeviceEndpoint {
	readonly address: "127.0.0.1";
	readonly port: number;
	readonly hid: string;
}

/** Owns one original session and its real device listener. */
export interface NativeDeviceContext {
	readonly endpoint: NativeDeviceEndpoint;
	requirePeerRoute(
		peer: NativeDevicePeer,
		route: string,
		operation?: { readonly kind?: string; readonly preset?: string },
	): RouteGrant;
	requirePeerDevice(peer: NativeDevicePeer, capability: DeviceCapability): DeviceGrant;
	requirePeerKind(peer: NativeDevicePeer, kind: string): DeviceGrant;
	close(): Promise<void>;
}

export type NativeDeviceContextErrorCode =
	| "CONTEXT_OPTIONS"
	| "CONTEXT_UNAVAILABLE"
	| "OPEN_REFUSED"
	| "OPEN_INCOMPLETE"
	| "CLOSE_INCOMPLETE";

/** Fixed errors carry no service, socket, path or underlying diagnostic. */
export class NativeDeviceContextError extends Error {
	readonly code: NativeDeviceContextErrorCode;
	constructor(code: NativeDeviceContextErrorCode) {
		super(code);
		this.name = "NativeDeviceContextError";
		this.code = code;
	}
}

interface Owner {
	phase: "opening" | "open" | "closing" | "closed";
	session?: HubSession;
	authorizer?: Authorizer;
	listener?: NativeDeviceTls;
	endpoint?: NativeDeviceEndpoint;
	sidecar?: DevicePairingAuthority;
	outbox?: NativeOutboxReadContext;
	runtime?: NativeRuntimeState;
	events?: NativeEventWebSocket;
	eventsClosed: boolean;
	listenerClose?: Promise<void>;
	listenerClosed: boolean;
	sessionClosed: boolean;
	readonly pending: Set<Promise<unknown>>;
	closing?: Promise<void>;
}

interface NativeApiStartup {
	readonly masterKey: MasterKey | undefined;
	readonly secret: Uint8Array | undefined;
	readonly runtimeMode: HubMode | undefined;
}

const failedOpens = new WeakMap<object, Owner>();
const closeListener = NativeDeviceTls.prototype.close;
const closeSidecar = DevicePairingAuthority.prototype.close;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const secretByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const fillSecret = Uint8Array.prototype.fill;
const setSecret = Uint8Array.prototype.set;

function unavailable(): never {
	throw new NativeDeviceContextError("CONTEXT_UNAVAILABLE");
}

function admitted(owner: Owner): { session: HubSession; authorizer: Authorizer } {
	if (owner.phase !== "open" || !owner.session || !owner.authorizer) return unavailable();
	try {
		assertHubSessionAdmission(owner.session);
	} catch {
		return unavailable();
	}
	return { session: owner.session, authorizer: owner.authorizer };
}

function closeOwner(owner: Owner): Promise<void> {
	if (owner.closing) return owner.closing;
	if (owner.phase === "closed") return Promise.resolve();
	owner.phase = "closing";
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	owner.closing = promise;
	const run = async (): Promise<void> => {
		if (owner.events && !owner.eventsClosed) {
			await owner.events.close();
			owner.eventsClosed = true;
		}
		if (owner.sidecar) closeSidecar.call(owner.sidecar);
		owner.outbox?.close();
		if (owner.runtime) await owner.runtime.close();
		if (owner.listener && !owner.listenerClosed) {
			// The listener caches its first close. Its rejection cannot be retried as progress.
			owner.listenerClose ??= closeListener.call(owner.listener);
			await owner.listenerClose;
			owner.listenerClosed = true;
		}
		await Promise.allSettled([...owner.pending]);
		if (owner.session && !owner.sessionClosed) {
			await owner.session.close();
			owner.sessionClosed = true;
		}
		owner.phase = "closed";
	};
	void run().then(resolve, () => reject(new NativeDeviceContextError("CLOSE_INCOMPLETE")));
	void promise.catch(() => {
		if (owner.closing === promise) owner.closing = undefined;
	});
	return promise;
}

/** Retries only the actual cleanup retained by an unsuccessful constructing call. */
export function closeFailedNativeDeviceContext(error: unknown): Promise<void> {
	const owner =
		error !== null && typeof error === "object" && !types.isProxy(error)
			? failedOpens.get(error)
			: undefined;
	if (!owner) return Promise.reject(new NativeDeviceContextError("CONTEXT_UNAVAILABLE"));
	return closeOwner(owner).then(() => {
		failedOpens.delete(error as object);
	});
}

function startupConfig(value: NativeDeviceApiConfig): NativeDeviceApiConfig {
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
		!Object.isFrozen(value)
	)
		throw new NativeDeviceContextError("CONTEXT_OPTIONS");
	const keys = Reflect.ownKeys(value);
	if (
		keys.length < 1 ||
		keys.length > 3 ||
		keys.some((key) => key !== "testUpstreams" && key !== "footerPolicy" && key !== "runtimeMode")
	)
		throw new NativeDeviceContextError("CONTEXT_OPTIONS");
	const slot = Object.getOwnPropertyDescriptor(value, "testUpstreams");
	if (!slot?.enumerable || !Object.hasOwn(slot, "value") || typeof slot.value !== "boolean")
		throw new NativeDeviceContextError("CONTEXT_OPTIONS");
	const captured: {
		testUpstreams: boolean;
		footerPolicy?: NativeOutboxFooterPolicy;
		runtimeMode?: HubMode;
	} = { testUpstreams: slot.value };
	const footer = Object.getOwnPropertyDescriptor(value, "footerPolicy");
	if (footer) {
		if (!footer.enumerable || !("value" in footer))
			throw new NativeDeviceContextError("CONTEXT_OPTIONS");
		try {
			captured.footerPolicy = captureNativeOutboxFooterPolicy(footer.value);
		} catch {
			throw new NativeDeviceContextError("CONTEXT_OPTIONS");
		}
	}
	const mode = Object.getOwnPropertyDescriptor(value, "runtimeMode");
	if (mode) {
		if (!mode.enumerable || !Object.hasOwn(mode, "value"))
			throw new NativeDeviceContextError("CONTEXT_OPTIONS");
		const nativeMode: unknown = mode.value;
		if (nativeMode !== "sidecar" && nativeMode !== "service")
			throw new NativeDeviceContextError("CONTEXT_OPTIONS");
		captured.runtimeMode = nativeMode;
	}
	return Object.freeze(captured);
}

/** Takes the valid original view before any configuration or asynchronous startup can fail. */
function takeBootstrapSecret(value: Uint8Array | undefined): Uint8Array | undefined {
	if (value === undefined) return undefined;
	if (types.isProxy(value) || !types.isUint8Array(value) || secretByteLength?.call(value) !== 16)
		throw new NativeDeviceContextError("CONTEXT_OPTIONS");
	let copy: Uint8Array | undefined;
	try {
		copy = new Uint8Array(16);
		setSecret.call(copy, value);
		return copy;
	} catch {
		if (copy) fillSecret.call(copy, 0);
		throw new NativeDeviceContextError("CONTEXT_OPTIONS");
	} finally {
		fillSecret.call(value, 0);
	}
}

function startupMasterKey(options: HubSessionOptions): MasterKey | undefined {
	if (options === null || typeof options !== "object" || types.isProxy(options)) return undefined;
	const key: unknown = Object.getOwnPropertyDescriptor(options, "masterKey")?.value;
	return !types.isProxy(key) && key instanceof MasterKey ? key : undefined;
}

function status(owner: Owner, peer: NativeDevicePeer, config: NativeDeviceApiConfig): DeviceStatus {
	const { session, authorizer } = admitted(owner);
	const result = session.store.read((db) => {
		const route = authorizer.requirePeerRoute(db, peer, "status");
		return authorizer.status(db, route.deviceId, config.testUpstreams);
	});
	admitted(owner);
	return result;
}

async function bootstrap(
	owner: Owner,
	peer: NativeDevicePeer,
	config: NativeDeviceApiConfig,
	request: BootstrapRequest,
): Promise<DeviceStatus> {
	const { session, authorizer } = admitted(owner);
	const route = session.store.read((db) => authorizer.requirePeerRoute(db, peer, "bootstrap"));
	const prepared = await session.devices.prepareBootstrap(route.deviceId, request.pin);
	try {
		admitted(owner);
		const result = session.store.write((tx) => {
			admitted(owner);
			const current = authorizer.requirePeerRoute(tx, peer, "bootstrap");
			if (current.deviceId !== route.deviceId) throw new AuthzError("BOOTSTRAP_REFUSED");
			session.devices.completeBootstrap(tx, prepared, route.deviceId);
			admitted(owner);
			return authorizer.status(tx, route.deviceId, config.testUpstreams);
		});
		if (owner.sidecar) closeSidecar.call(owner.sidecar);
		admitted(owner);
		return result;
	} finally {
		session.devices.discard(prepared);
	}
}

function dispatch(
	owner: Owner,
	peer: NativeDevicePeer,
	config: NativeDeviceApiConfig,
	request: NativeDeviceRequest,
): Promise<NativeDeviceRouteResult> {
	admitted(owner);
	if (request.route === "status") return Promise.resolve(status(owner, peer, config));
	// Register the operation before the microtask starts any real asynchronous service work.
	const pending = Promise.resolve().then(async () => {
		const { session, authorizer } = admitted(owner);
		if (request.route === "bootstrap") return bootstrap(owner, peer, config, request.body);
		if (request.route === "scheduling-outbox") {
			const result = (owner.outbox ?? unavailable()).summary(peer);
			admitted(owner);
			return result;
		}
		if (request.route === "sync-pause") {
			session.store.read((db) => authorizer.requirePeerRoute(db, peer, "sync-pause"));
			const state = (owner.runtime ?? unavailable()).pauseSync(peer, request.body.paused);
			admitted(owner);
			return Object.freeze({ paused: state.syncPaused });
		}
		if (request.route === "send-review") {
			const record = (owner.outbox ?? unavailable()).get(peer, request.id);
			admitted(owner);
			if (record === undefined) return undefined;
			return SendReview.parse({
				id: record.id,
				snapshot: record.snapshot,
				contentHash: record.contentHash,
				flags: record.flags,
				flagsHash: record.flagsHash,
				state: record.state,
				stateReason: record.stateReason,
				requiredUsers: record.requiredUsers,
				expiresAt: record.expiresAt,
			});
		}
		if (
			(request.route === "pairing-claim" || request.route === "pairing-reveal") &&
			!session.devices.currentState().bootstrapDone
		) {
			const authority = owner.sidecar;
			if (!authority) throw new DevicePairingRefusal("PAIR_WINDOW_CLOSED");
			const result = session.store.write((tx) => {
				admitted(owner);
				if (request.route === "pairing-claim") return authority.claim(tx, peer, request.body);
				authority.reveal(tx, peer, request.body);
				return undefined;
			});
			admitted(owner);
			return result;
		}
		if (request.route === "pairing-window")
			session.store.read((db) => authorizer.requirePeerRoute(db, peer, "pairing-window"));
		const pairing = await nativePairingWindows(session);
		admitted(owner);
		let result: NativeDeviceRouteResult;
		if (request.route === "pairing-window") result = await pairing.open(peer, request.body);
		else if (request.route === "pairing-claim") result = pairing.claim(peer, request.body);
		else if (request.route === "pairing-reveal") {
			pairing.reveal(peer, request.body);
			result = undefined;
		} else return unavailable();
		admitted(owner);
		return result;
	});
	owner.pending.add(pending);
	void pending.then(
		() => owner.pending.delete(pending),
		() => owner.pending.delete(pending),
	);
	return pending;
}

async function openContext(
	options: HubSessionOptions,
	onPeer: (
		peer: NativeDevicePeer,
		socket: TLSSocket,
		context: NativeDeviceContext,
		owner: Owner,
	) => void,
	startup?: NativeApiStartup,
): Promise<NativeDeviceContext> {
	const owner: Owner = {
		phase: "opening",
		eventsClosed: false,
		listenerClosed: false,
		sessionClosed: false,
		pending: new Set(),
	};
	try {
		const session = await openHubSession(options);
		owner.session = session;
		assertHubSessionAdmission(session);
		owner.authorizer = new Authorizer(session.devices);
		if (startup) {
			try {
				if (!startup.masterKey) throw new NativeDeviceContextError("CONTEXT_OPTIONS");
				owner.events = createNativeEventWebSocket(session);
				if (startup.runtimeMode !== undefined)
					owner.runtime = createNativeRuntimeState(session, startup.runtimeMode);
				owner.outbox = createNativeOutboxReadContext(session, startup.masterKey, owner.runtime);
				if (startup.secret && !session.devices.currentState().bootstrapDone) {
					owner.sidecar = new DevicePairingAuthority(
						session.devices,
						session.store,
						startup.masterKey,
						startup.secret,
					);
				}
			} finally {
				if (startup.secret) fillSecret.call(startup.secret, 0);
			}
		}
		const context: NativeDeviceContext = Object.freeze({
			get endpoint(): NativeDeviceEndpoint {
				admitted(owner);
				return owner.endpoint ?? unavailable();
			},
			requirePeerRoute(
				peer: NativeDevicePeer,
				route: string,
				operation?: { readonly kind?: string; readonly preset?: string },
			): RouteGrant {
				const { session, authorizer } = admitted(owner);
				const result = session.store.read((db) =>
					authorizer.requirePeerRoute(db, peer, route, operation),
				);
				admitted(owner);
				return result;
			},
			requirePeerDevice(peer: NativeDevicePeer, capability: DeviceCapability): DeviceGrant {
				const { session, authorizer } = admitted(owner);
				const result = session.store.read((db) =>
					authorizer.requirePeerDevice(db, peer, capability),
				);
				admitted(owner);
				return result;
			},
			requirePeerKind(peer: NativeDevicePeer, kind: string): DeviceGrant {
				const { session, authorizer } = admitted(owner);
				const result = session.store.read((db) => authorizer.requirePeerKind(db, peer, kind));
				admitted(owner);
				return result;
			},
			close: () => closeOwner(owner),
		});
		owner.listener = new NativeDeviceTls(session.devices, session.identity, (peer, socket) => {
			try {
				admitted(owner);
				const returned = onPeer(peer, socket, context, owner);
				void Promise.resolve(returned).catch(() => socket.destroy());
			} catch {
				socket.destroy();
			}
		});
		const port = await owner.listener.listen();
		assertHubSessionAdmission(session);
		owner.endpoint = Object.freeze({ address: "127.0.0.1", port, hid: session.identity.hid });
		owner.phase = "open";
		return context;
	} catch (error) {
		if (!owner.session) throw error;
		try {
			await closeOwner(owner);
		} catch {
			const retained = new NativeDeviceContextError("OPEN_INCOMPLETE");
			failedOpens.set(retained, owner);
			throw retained;
		}
		throw new NativeDeviceContextError("OPEN_REFUSED");
	}
}

/** Opens a new original session; no caller-provided session or listener is adopted. */
export function openNativeDeviceContext(
	options: HubSessionOptions,
	onPeer: (peer: NativeDevicePeer, socket: TLSSocket, context: NativeDeviceContext) => void,
): Promise<NativeDeviceContext> {
	if (typeof onPeer !== "function" || types.isProxy(onPeer))
		return Promise.reject(new NativeDeviceContextError("CONTEXT_OPTIONS"));
	return openContext(options, (peer, socket, context) => onPeer(peer, socket, context));
}

/** Mounts the bounded native HTTP routes on the original listener's real TLS connections. */
export async function openNativeDeviceApi(
	options: HubSessionOptions,
	config: NativeDeviceApiConfig,
	bootstrapSecret?: Uint8Array,
): Promise<NativeDeviceContext> {
	const secret = takeBootstrapSecret(bootstrapSecret);
	try {
		const captured = startupConfig(config);
		const startup = {
			masterKey: startupMasterKey(options),
			secret,
			runtimeMode: captured.runtimeMode,
		};
		return await openContext(
			options,
			(peer, socket, _context, owner) => {
				attachNativeDeviceHttp(
					socket,
					(request) => dispatch(owner, peer, captured, request),
					(request, upgradeSocket, head) => {
						admitted(owner);
						if (upgradeSocket !== socket || request.socket !== socket) return unavailable();
						const events = owner.events ?? unavailable();
						events.upgrade(peer, request, upgradeSocket, head);
					},
				);
			},
			startup,
		);
	} finally {
		if (secret) fillSecret.call(secret, 0);
	}
}
