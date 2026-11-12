import { isProxy } from "node:util/types";
import { addressFacts, networkRefused } from "./address-facts.ts";
import {
	captureEgressPolicy,
	type EgressPolicy,
	type PinnedAddress,
	resolveEgressAnswers,
} from "./addresses.ts";

export interface EndpointClassification {
	readonly origin: string;
	readonly hostname: string;
	readonly destination: "local" | "local-network" | "cloud";
	readonly addresses: readonly PinnedAddress[];
}

const apply = Reflect.apply;
const throwIfAborted = AbortSignal.prototype.throwIfAborted;

function active(signal: AbortSignal): void {
	if (signal === null || typeof signal !== "object" || isProxy(signal)) throw networkRefused();
	apply(throwIfAborted, signal, []);
}

/** Resolved endpoint facts only; the caller owns policy, authorization and the pins' lifetime. */
export async function classifyEndpoint(
	endpoint: string,
	policy: EgressPolicy,
	signal: AbortSignal,
): Promise<EndpointClassification> {
	try {
		if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 2048)
			throw networkRefused();
		const url = new URL(endpoint);
		if (
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			(endpoint !== url.origin && endpoint !== `${url.origin}/`)
		)
			throw networkRefused();
		const origin = url.origin;
		const hostname = url.hostname;
		const host = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
		const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
		const captured = captureEgressPolicy(policy);
		active(signal);
		const addresses = await resolveEgressAnswers(host, port, captured, signal);
		active(signal);
		let destination: EndpointClassification["destination"] | undefined;
		for (const answer of addresses) {
			const locality = addressFacts(answer.address).locality;
			let next: EndpointClassification["destination"];
			switch (locality) {
				case "public":
					next = "cloud";
					break;
				case "loopback":
					next = "local";
					break;
				case "private":
				case "carrier-grade-nat":
				case "link-local":
					next = "local-network";
					break;
				default:
					throw networkRefused();
			}
			if (destination !== undefined && destination !== next) throw networkRefused();
			destination = next;
		}
		if (destination === undefined) throw networkRefused();
		return Object.freeze({ origin, hostname, destination, addresses });
	} catch {
		throw networkRefused();
	}
}
