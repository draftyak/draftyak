import type { ClientRequest } from "node:http";
import { Agent, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { TLSSocket } from "node:tls";
import {
	canonicalAddress,
	captureEgressPolicy,
	type EgressPolicy,
	egressHost,
	egressPort,
	type PinnedAddress,
	validateEgressAnswers,
} from "./addresses.ts";
import { networkTestHooks } from "./test-context.ts";

export interface PinnedHttpsConnection {
	readonly options: RequestOptions & { readonly autoSelectFamily: false };
	guard(request: ClientRequest, expired: () => boolean, ready: () => void, fail: () => void): void;
	destroy(): void;
}
/** Shared TLS/pin path. The caller still validates method, URL, headers, body and authority. */
export function createPinnedHttpsConnection(
	host: string,
	port: number,
	pin: PinnedAddress,
	policy: EgressPolicy,
): PinnedHttpsConnection {
	policy = captureEgressPolicy(policy);
	egressHost(host, policy.allowLocal);
	egressPort(port, policy);
	const checked = validateEgressAnswers([pin], policy),
		hooks = networkTestHooks();
	const dial = hooks?.dial?.(checked, port) ?? { ...checked, port };
	const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: {} });
	const lookup: NonNullable<RequestOptions["lookup"]> = (_host, options, callback) => {
		if (options.all) callback(null, [{ address: checked.address, family: checked.family }]);
		else callback(null, checked.address, checked.family);
	};
	const authority = isIP(host) === 6 ? `[${host}]` : host;
	const options = Object.freeze<PinnedHttpsConnection["options"]>({
		protocol: "https:",
		hostname: host,
		port: dial.port,
		agent,
		family: checked.family,
		autoSelectFamily: false,
		servername: isIP(host) === 0 ? host : "",
		rejectUnauthorized: true,
		minVersion: "TLSv1.2",
		maxHeaderSize: 16384,
		headers: Object.freeze({ Host: port === 443 ? authority : `${authority}:${port}` }),
		...(hooks?.ca === undefined ? {} : { ca: hooks.ca }),
		lookup: (_host, lookupOptions, callback) => {
			hooks?.lookupObserved?.(lookupOptions);
			if (!hooks?.dial) return lookup(_host, lookupOptions, callback);
			// Observe the production pin result before the fixture redirects its TCP destination.
			lookup(_host, lookupOptions, (error, address, family) => {
				const actual = Array.isArray(address) ? address[0] : { address, family };
				if (
					error ||
					!actual ||
					actual.address !== checked.address ||
					actual.family !== checked.family
				) {
					callback(error ?? new Error("Fixture pin mismatch"), "", checked.family);
					return;
				}
				if (lookupOptions.all) callback(null, [{ address: dial.address, family: dial.family }]);
				else callback(null, dial.address, dial.family);
			});
		},
	});
	return Object.freeze({
		options,
		guard(
			request: ClientRequest,
			expired: () => boolean,
			ready: () => void,
			fail: () => void,
		): void {
			request.once("response", (response) => {
				if (
					response.statusCode !== undefined &&
					response.statusCode >= 300 &&
					response.statusCode < 400
				) {
					response.destroy();
					request.destroy();
					fail();
				}
			});
			request.once("socket", (socket) => {
				const tls = socket as TLSSocket;
				tls.once("secureConnect", () => {
					try {
						if (
							expired() ||
							!tls.authorized ||
							tls.remoteAddress === undefined ||
							canonicalAddress(tls.remoteAddress) !== canonicalAddress(dial.address)
						)
							throw new Error("Network request refused");
						ready();
					} catch {
						fail();
					}
				});
			});
		},
		destroy(): void {
			agent.destroy();
		},
	});
}
