import { types } from "node:util";
import { Authorizer } from "../authz/authorizer.ts";
import { AuthzError } from "../authz/errors.ts";
import { type NativeDevicePeer, nativePeerSpki } from "../authz/native-peer.ts";
import { type DeviceGrant, DeviceRegistry } from "../identity/devices.ts";
import type { HubStore, SqlReader } from "../store/store.ts";

const registryStore = DeviceRegistry.prototype.assertStore;
const registryFacts = DeviceRegistry.prototype.facts;
const authorizerStore = Authorizer.prototype.assertStore;
const requirePeerDevice = Authorizer.prototype.requirePeerDevice;
const assertCurrentGrant = Authorizer.prototype.assertCurrentGrant;

function refusal(error: unknown): AuthzError {
	try {
		if (!types.isProxy(error) && error instanceof AuthzError) return error;
	} catch {
		// Unrecognized failures must not expose their contents.
	}
	return new AuthzError("UNAVAILABLE");
}

/** Require a live desktop or CLI device for native outbox cancellation. */
export function requireNativeOutboxCancelPermission(
	store: HubStore,
	registry: DeviceRegistry,
	authorizer: Authorizer,
	db: SqlReader,
	peer: NativeDevicePeer,
): DeviceGrant {
	try {
		registryStore.call(registry, store);
		authorizerStore.call(authorizer, store);
		nativePeerSpki(registry, peer);
		const grant = requirePeerDevice.call(authorizer, db, peer, "draft");
		const preset = registryFacts.call(registry, db, grant.deviceId)?.confirmedPreset;
		if (preset !== "desktop" && preset !== "cli") throw new AuthzError("UNAVAILABLE");
		assertCurrentGrant.call(authorizer, db, grant);
		return grant;
	} catch (error) {
		throw refusal(error);
	}
}
