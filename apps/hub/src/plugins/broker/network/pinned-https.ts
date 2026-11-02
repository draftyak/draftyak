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
	networkRefused,
	type PinnedAddress,
	validateEgressAnswers,
} from "./addresses.ts";
import { networkTestHooks, takeNetworkAttempt } from "./test-context.ts";

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
	const observation = takeNetworkAttempt(host, port, pin);
	const checked = (() => {
		try {
			policy = captureEgressPolicy(policy);
			egressHost(host, policy.allowLocal);
			egressPort(port, policy);
			const checked = validateEgressAnswers([pin], policy);
			// Node dials an IP-literal host directly, so it must equal the pin.
			if (
				isIP(host) !== 0 &&
				(isIP(host) !== checked.family || canonicalAddress(host) !== checked.address)
			)
				throw networkRefused();
			if (observation && !observation.resolved) {
				observation.attempt.policyAllowed();
				observation.attempt.resolved();
			}
			return checked;
		} catch {
			if (observation) {
				try {
					if (observation.resolved) observation.attempt.failed();
					else observation.attempt.policyRefused();
				} catch {
					observation.attempt.failed();
				}
			}
			throw networkRefused();
		}
	})();
	const hooks = networkTestHooks();
	const dial = (() => {
		try {
			return hooks?.dial?.(checked, port) ?? { ...checked, port };
		} catch {
			observation?.attempt.failed();
			throw networkRefused();
		}
	})();
	const agent = new Agent({ keepAlive: false, maxSockets: 1, maxCachedSessions: 0, proxyEnv: {} });
	let settled = false;
	let guarded: ClientRequest | undefined;
	const finish = (succeeded: boolean): void => {
		if (settled) return;
		settled = true;
		observation?.attempt.signal.removeEventListener("abort", aborted);
		if (succeeded) observation?.attempt.succeeded();
		else observation?.attempt.failed();
	};
	const aborted = (): void => {
		finish(false);
		guarded?.destroy();
		agent.destroy();
	};
	observation?.attempt.signal.addEventListener("abort", aborted, { once: true });
	if (observation?.attempt.signal.aborted) {
		aborted();
		throw networkRefused();
	}
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
			if (observation && guarded) {
				hooks?.observer?.fail();
				request.destroy();
				return;
			}
			guarded = request;
			if (observation?.attempt.signal.aborted) {
				aborted();
				fail();
				return;
			}
			if (observation) request.once("error", () => finish(false));
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
				if (observation) tls.once("close", () => finish(false));
				tls.once("secureConnect", () => {
					try {
						if (
							expired() ||
							!tls.authorized ||
							tls.remoteAddress === undefined ||
							canonicalAddress(tls.remoteAddress) !== canonicalAddress(dial.address)
						)
							throw new Error("Network request refused");
						finish(true);
						ready();
					} catch {
						finish(false);
						fail();
					}
				});
			});
		},
		destroy(): void {
			finish(false);
			agent.destroy();
		},
	});
}
