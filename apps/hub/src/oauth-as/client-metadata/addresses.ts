import {
	canonicalAddress as canonical,
	HUB_DENIED_PORTS,
	type PinnedAddress,
	publicAddress,
	resolveEgress,
	validateEgressAnswers,
} from "../../plugins/broker/network/addresses.ts";
import { refused } from "./policy.ts";

export { type PinnedAddress, publicAddress };
export const METADATA_DENIED_PORTS: readonly number[] = HUB_DENIED_PORTS;
export function canonicalAddress(raw: string): string {
	try {
		return canonical(raw);
	} catch {
		throw refused();
	}
}
export function validateAnswers(
	answers: readonly PinnedAddress[],
	denied: readonly string[],
): PinnedAddress {
	try {
		return validateEgressAnswers(answers, {
			deniedAddresses: denied,
			deniedPorts: METADATA_DENIED_PORTS,
		});
	} catch {
		throw refused();
	}
}
export async function resolvePublic(
	host: string,
	denied: readonly string[],
	signal: AbortSignal,
): Promise<PinnedAddress> {
	try {
		return await resolveEgress(
			host,
			443,
			{ deniedAddresses: denied, deniedPorts: METADATA_DENIED_PORTS },
			signal,
		);
	} catch {
		throw refused();
	}
}
