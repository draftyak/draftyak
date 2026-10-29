import { types } from "node:util";
import { DeviceStatus } from "@draftyak/protocol/device-api";
import {
	CONFIRMATION_PRESETS,
	type ConfirmationPreset,
	type DeviceCapability,
} from "@draftyak/protocol/entities/device";
import {
	type DeviceFacts,
	type DeviceGrant,
	DeviceRegistry,
	isDeviceRegistry,
} from "../identity/devices.ts";
import { type ReadStamp, readStamp, sameReadStamp } from "../store/read-stamp.ts";
import type { HubStore, SqlReader } from "../store/store.ts";
import {
	approverRefusal,
	candidateRefusal,
	decideCapability,
	decideKind,
	decidePrincipal,
	decideRoute,
	effectiveCapabilities,
	needCapability,
	type PeerFacts,
	type Principal,
	parsePreset,
	peerOf,
	presetRefusal,
	readPrincipal,
} from "./decide.ts";
import { AuthzError, type AuthzErrorCode } from "./errors.ts";
import { type NativeDevicePeer, nativePeerSpki } from "./native-peer.ts";

export interface RouteGrant {
	readonly deviceId: string;
	readonly epoch: number;
	readonly confirmed: boolean;
	readonly capabilities: readonly DeviceCapability[];
}
export interface ConfirmationTarget {
	readonly approver: string;
	readonly candidate: string;
	readonly preset: ConfirmationPreset;
	readonly capabilities: readonly DeviceCapability[];
	readonly role: "device";
	readonly name: string;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
	readonly epoch: number;
}

const registryState = DeviceRegistry.prototype.state;
const registryFacts = DeviceRegistry.prototype.facts;
const registryTransport = DeviceRegistry.prototype.factsByTransport;
const registryStore = DeviceRegistry.prototype.assertStore;
const grants = new WeakMap<
	DeviceGrant,
	{ registry: DeviceRegistry; reader: SqlReader; stamp: ReadStamp; peer?: NativeDevicePeer }
>();
const refuse = (code: AuthzErrorCode): never => {
	throw new AuthzError(code);
};
function guard<T>(work: () => T): T {
	try {
		return work();
	} catch (error) {
		throw error instanceof AuthzError ? error : new AuthzError("UNAVAILABLE");
	}
}

/** Authorization decisions over the registry's live state; it never writes. */
export class Authorizer {
	readonly #registry: DeviceRegistry;
	constructor(registry: DeviceRegistry) {
		if (!isDeviceRegistry(registry)) throw new AuthzError("UNAVAILABLE");
		this.#registry = registry;
	}
	#peer(db: SqlReader, deviceId: string): { facts: DeviceFacts | undefined; peer: PeerFacts } {
		const facts = registryFacts.call(this.#registry, db, deviceId);
		return { facts, peer: peerOf(facts, facts ?? registryState.call(this.#registry, db)) };
	}
	#grant(
		db: SqlReader,
		facts: DeviceFacts | undefined,
		refusal: AuthzErrorCode | undefined,
	): DeviceGrant {
		if (refusal || !facts) return refuse(refusal ?? "UNAVAILABLE");
		const stamp = readStamp(db) ?? refuse("UNAVAILABLE");
		const owner = registryState.call(this.#registry, db).ownerUserId;
		if (owner === null || owner !== facts.userId) return refuse("UNAVAILABLE");
		const grant = Object.freeze({
			deviceId: facts.deviceId,
			userId: facts.userId ?? refuse("UNAVAILABLE"),
			epoch: facts.epoch,
			capabilities: effectiveCapabilities(facts),
			approvalKey: facts.approvalKey,
			ownerUserId: owner,
			revision: stamp.revision,
		});
		grants.set(grant, { registry: this.#registry, reader: db, stamp });
		return grant;
	}
	/** The non-revoked device holding this transport key, for the L2 TLS gate. */
	knownTransport(db: SqlReader, spkiSha256: string): string | undefined {
		return guard(() => {
			const facts = registryTransport.call(this.#registry, db, spkiSha256);
			return facts && !facts.revoked ? facts.deviceId : undefined;
		});
	}
	requireDevice(db: SqlReader, deviceId: string, capability: DeviceCapability): DeviceGrant {
		return guard(() => {
			const { facts, peer } = this.#peer(db, deviceId);
			return this.#grant(db, facts, decideCapability(peer, capability));
		});
	}
	requireKind(db: SqlReader, deviceId: string, kind: string): DeviceGrant {
		return guard(() => {
			const { facts, peer } = this.#peer(db, deviceId);
			return this.#grant(db, facts, decideKind(peer, kind));
		});
	}
	/** The incoming transport is unforgeable; every call re-reads current durable rights. */
	requirePeerDevice(
		db: SqlReader,
		peer: NativeDevicePeer,
		capability: DeviceCapability,
	): DeviceGrant {
		return this.#bindPeer(this.requireDevice(db, this.#peerDevice(db, peer), capability), peer);
	}
	requirePeerKind(db: SqlReader, peer: NativeDevicePeer, kind: string): DeviceGrant {
		return this.#bindPeer(this.requireKind(db, this.#peerDevice(db, peer), kind), peer);
	}
	requirePeerRoute(
		db: SqlReader,
		peer: NativeDevicePeer,
		route: string,
		operation?: { readonly kind?: string; readonly preset?: string },
	): RouteGrant {
		return this.requireRoute(db, this.#peerDevice(db, peer), route, operation);
	}
	#peerDevice(db: SqlReader, peer: NativeDevicePeer): string {
		const spki = nativePeerSpki(this.#registry, peer);
		const facts = registryTransport.call(this.#registry, db, spki);
		if (!facts) return refuse("DEVICE_UNKNOWN");
		if (facts.revoked) return refuse("DEVICE_REVOKED");
		return facts.deviceId;
	}
	#bindPeer(grant: DeviceGrant, peer: NativeDevicePeer): DeviceGrant {
		const bound = grants.get(grant) ?? refuse("UNAVAILABLE");
		bound.peer = peer;
		return grant;
	}
	assertCurrentGrant(db: SqlReader, grant: DeviceGrant): void {
		const bound = grants.get(grant);
		if (
			!bound ||
			bound.registry !== this.#registry ||
			bound.reader !== db ||
			!sameReadStamp(bound.stamp, readStamp(db))
		)
			throw new AuthzError("UNAVAILABLE");
		registryState.call(this.#registry, db);
		if (bound.peer) nativePeerSpki(this.#registry, bound.peer);
	}
	assertStore(store: HubStore): void {
		registryStore.call(this.#registry, store);
	}
	requireRoute(
		db: SqlReader,
		deviceId: string,
		routeId: string,
		operation?: { readonly kind?: string; readonly preset?: string },
	): RouteGrant {
		return guard(() => {
			const { facts, peer } = this.#peer(db, deviceId);
			const refusal = decideRoute(peer, routeId, operation);
			if (refusal || !facts) return refuse(refusal ?? "UNAVAILABLE");
			const capabilities = effectiveCapabilities(facts);
			return Object.freeze({
				deviceId: facts.deviceId,
				epoch: facts.epoch,
				confirmed: capabilities.length > 0,
				capabilities,
			});
		});
	}
	/** The checks confirmByApprover makes without the statement, in the same order. */
	requireConfirmable(
		db: SqlReader,
		approver: string,
		candidate: string,
		preset: ConfirmationPreset,
	): ConfirmationTarget {
		return guard(() => {
			const parsed = parsePreset(preset);
			const { facts: signer, peer } = this.#peer(db, approver);
			if (!peer.bootstrapDone) refuse("NOT_BOOTSTRAPPED");
			const refusal = approverRefusal(peer, parsed);
			if (refusal || !signer || parsed === undefined) return refuse(refusal ?? "UNAVAILABLE");
			if (candidate === signer.deviceId) refuse("CANDIDATE_INVALID");
			const target = registryFacts.call(this.#registry, db, candidate);
			if (target && target.epoch !== signer.epoch) refuse("UNAVAILABLE");
			const pending = candidateRefusal(target, signer.epoch);
			if (pending || !target) return refuse(pending ?? "UNAVAILABLE");
			const unfit = presetRefusal(parsed, target.role);
			if (unfit) refuse(unfit);
			return Object.freeze({
				approver: signer.deviceId,
				candidate: target.deviceId,
				preset: parsed,
				capabilities: CONFIRMATION_PRESETS[parsed],
				role: target.role,
				name: target.name,
				transportSpkiSha256: target.spkiSha256,
				signingKey: target.approvalKey,
				epoch: signer.epoch,
			});
		});
	}
	requirePrincipal(
		db: SqlReader,
		principal: Principal,
		need: DeviceCapability | string,
	): {
		readonly kind: Principal["kind"];
		readonly pin: "required" | "none";
		readonly grant?: DeviceGrant;
	} {
		return guard(() => {
			const actor = readPrincipal(principal);
			if (!actor) return refuse("PRINCIPAL_REFUSED");
			if (actor.kind === "device") {
				const wanted = needCapability(need);
				const grant =
					wanted?.kind === undefined && wanted !== undefined
						? this.requireDevice(db, actor.id, wanted.capability)
						: this.requireKind(db, actor.id, need);
				const authority = wanted?.capability === "approve" || wanted?.capability === "admin";
				return Object.freeze({ kind: actor.kind, pin: authority ? "required" : "none", grant });
			}
			registryState.call(this.#registry, db);
			const decision = decidePrincipal(actor, need);
			if (typeof decision === "string") return refuse(decision);
			return Object.freeze({ kind: actor.kind, pin: decision.pin });
		});
	}
	status(db: SqlReader, deviceId: string, testUpstreams: boolean): DeviceStatus {
		return guard(() => {
			const facts = registryFacts.call(this.#registry, db, deviceId);
			if (!facts) return refuse("DEVICE_UNKNOWN");
			if (facts.revoked) return refuse("DEVICE_REVOKED");
			const capabilities = effectiveCapabilities(facts);
			const status = DeviceStatus.safeParse({
				deviceId: facts.deviceId,
				epoch: facts.epoch,
				confirmed: capabilities.length > 0,
				capabilities: [...capabilities],
				testUpstreams,
			});
			if (!status.success) return refuse("UNAVAILABLE");
			return Object.freeze({
				...status.data,
				capabilities: Object.freeze([...status.data.capabilities]),
			});
		});
	}
}

const authorizerStore = Authorizer.prototype.assertStore;
/** Genuine authorizer private state and the exact native store are required for composition. */
export function assertAuthorizerStore(authorizer: Authorizer, store: HubStore): void {
	guard(() => {
		if (types.isProxy(authorizer)) refuse("UNAVAILABLE");
		authorizerStore.call(authorizer, store);
	});
}
