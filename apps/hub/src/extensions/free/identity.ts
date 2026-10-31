import type { IdentityProvider, User } from "@draftyak/extensions";
import { type AuthorityState, DeviceRegistry, isDeviceRegistry } from "../../identity/devices.ts";
import { refuse } from "../errors.ts";

export const SINGLE_OWNER_IDENTITY: string = "single-owner";

const currentState = DeviceRegistry.prototype.currentState;

function ownerState(registry: DeviceRegistry): AuthorityState {
	try {
		return currentState.call(registry);
	} catch {
		return refuse("unavailable");
	}
}

/** Identity projections only; the native device registry retains every approval and access decision. */
export function singleOwnerIdentity(registry: DeviceRegistry): IdentityProvider {
	if (!isDeviceRegistry(registry)) refuse("unavailable");
	ownerState(registry);
	return Object.freeze(
		Object.assign(Object.create(null) as object, {
			id: SINGLE_OWNER_IDENTITY,
			users: async (): Promise<readonly User[]> => {
				const owner = ownerState(registry).ownerUserId;
				return Object.freeze(owner === null ? [] : [Object.freeze({ id: owner })]);
			},
			maxOwners: (): number => {
				ownerState(registry);
				return 1;
			},
		}),
	) as IdentityProvider;
}
