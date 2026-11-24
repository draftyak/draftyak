import type { RoutingDestination } from "@draftyak/protocol/entities/routing";
import {
	addressFacts,
	captureEgressPolicy,
	type EgressPolicy,
	type PinnedAddress,
	resolveEgressAnswers,
} from "../plugins/broker/network/index.ts";

export interface EndpointClassification {
	readonly endpoint: string;
	readonly resolution: {
		readonly hostname: string;
		readonly destination: Extract<RoutingDestination, "local" | "local-network" | "cloud">;
	};
	readonly answers: readonly PinnedAddress[];
}

/** Fixed and content-free: endpoint, resolver and cancellation details stay private. */
export class EndpointClassificationError extends Error {
	readonly code = "ENDPOINT_CLASSIFICATION_REFUSED";
	constructor() {
		super("Endpoint classification refused");
		this.name = "EndpointClassificationError";
	}
}

/**
 * Current native endpoint facts only. Reclassify for each disclosure; the existing broker must
 * independently revalidate and pin egress. These facts grant no permission or plaintext consent.
 */
export async function classifyEndpoint(
	endpoint: unknown,
	network: EgressPolicy,
	signal: AbortSignal,
): Promise<EndpointClassification> {
	try {
		if (typeof endpoint !== "string" || endpoint.length > 2048) throw new Error();
		const url = new URL(endpoint);
		if (
			url.href !== endpoint ||
			(url.protocol !== "http:" && url.protocol !== "https:") ||
			url.username ||
			url.password ||
			endpoint.includes("?") ||
			endpoint.includes("#")
		)
			throw new Error();
		const policy = captureEgressPolicy(network);
		signal.throwIfAborted();
		// URL keeps IPv6 authority brackets; the canonical native resolver expects the bare IP.
		const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
		const answers = await resolveEgressAnswers(
			host,
			Number(url.port || (url.protocol === "https:" ? 443 : 80)),
			policy,
			signal,
		);
		signal.throwIfAborted();
		// The shared resolver has validated every answer and refused unacceptable or mixed classes.
		const locality = addressFacts((answers[0] as PinnedAddress).address).locality;
		const destination =
			locality === "loopback" ? "local" : locality === "public" ? "cloud" : "local-network";
		return Object.freeze({
			endpoint,
			resolution: Object.freeze({ hostname: url.hostname, destination }),
			answers,
		});
	} catch {
		throw new EndpointClassificationError();
	}
}
