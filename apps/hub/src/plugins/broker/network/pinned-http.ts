import { Agent, type ClientRequest, type RequestOptions } from "node:http";
import { isIP, Socket } from "node:net";
import { addressFacts } from "./address-facts.ts";
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

export interface PinnedHttpConnection {
	readonly options: RequestOptions & { readonly autoSelectFamily: false };
	guard(request: ClientRequest, expired: () => boolean, ready: () => void, fail: () => void): void;
	destroy(): void;
}

/** The caller validates all fresh DNS answers, the complete request and its authority. */
export function createPinnedHttpConnection(
	host: string,
	port: number,
	pin: PinnedAddress,
	policy: EgressPolicy,
): PinnedHttpConnection {
	const observation = takeNetworkAttempt(host, port, pin);
	const checked = (() => {
		try {
			policy = captureEgressPolicy(policy);
			egressHost(host, policy.allowLocal);
			egressPort(port, policy);
			const checked = validateEgressAnswers([pin], policy);
			if (
				addressFacts(checked.address).locality !== "loopback" ||
				(isIP(host) !== 0 &&
					(isIP(host) !== checked.family || canonicalAddress(host) !== checked.address))
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
			const target = hooks?.dial?.(checked, port) ?? { ...checked, port };
			egressPort(target.port, policy);
			const facts = addressFacts(target.address);
			if (facts.locality !== "loopback" || isIP(target.address) !== target.family)
				throw networkRefused();
			return Object.freeze({ address: facts.address, family: facts.family, port: target.port });
		} catch {
			observation?.attempt.failed();
			throw networkRefused();
		}
	})();
	const agent = new Agent({ keepAlive: false, maxSockets: 1, proxyEnv: {} });
	let socket: Socket | undefined;
	let guarded: ClientRequest | undefined;
	let handoff: ((error: Error | null) => void) | undefined;
	let expired: (() => boolean) | undefined;
	let failure: (() => void) | undefined;
	let refused = false;
	let released = false;
	let settled = false;
	const finish = (succeeded: boolean): void => {
		if (settled) return;
		settled = true;
		observation?.attempt.signal.removeEventListener("abort", aborted);
		if (succeeded) observation?.attempt.succeeded();
		else observation?.attempt.failed();
	};
	const stop = (notify: boolean): void => {
		if (refused) return;
		refused = true;
		finish(false);
		socket?.destroy();
		agent.destroy();
		handoff?.(networkRefused());
		guarded?.destroy();
		if (notify) failure?.();
	};
	const refuse = (): void => stop(true);
	const aborted = (): void => refuse();
	const peerMatches = (): boolean =>
		socket?.remoteAddress !== undefined &&
		socket.remotePort === dial.port &&
		canonicalAddress(socket.remoteAddress) === dial.address &&
		addressFacts(socket.remoteAddress).locality === "loopback";
	const release = (): void => {
		if (refused || released || !guarded || !socket || socket.connecting) return;
		try {
			if (!expired || expired() || !peerMatches()) throw networkRefused();
			released = true;
			finish(true);
			handoff?.(null);
		} catch {
			refuse();
		}
	};
	observation?.attempt.signal.addEventListener("abort", aborted, { once: true });
	if (observation?.attempt.signal.aborted) {
		refuse();
		throw networkRefused();
	}
	// The Agent receives the connected socket only after its real peer has passed the guard.
	// Even an already queued request body cannot be written before this handoff.
	agent.createConnection = (_options, callback) => {
		if (refused || socket || !callback) throw networkRefused();
		const original = new Socket({ allowHalfOpen: false });
		socket = original;
		let delivered = false;
		handoff = (error) => {
			if (delivered) return;
			delivered = true;
			callback(error, original);
		};
		original.once("error", refuse);
		original.once("close", () => {
			if (!released) refuse();
		});
		original.once("connect", release);
		try {
			original.connect({
				host: dial.address,
				port: dial.port,
				family: dial.family,
				autoSelectFamily: false,
			});
		} catch {
			refuse();
		}
		return undefined;
	};
	const authority = isIP(host) === 6 ? `[${host}]` : host;
	const options = Object.freeze<PinnedHttpConnection["options"]>({
		protocol: "http:",
		hostname: host,
		port: dial.port,
		agent,
		family: checked.family,
		autoSelectFamily: false,
		maxHeaderSize: 16384,
		headers: Object.freeze({ Host: port === 80 ? authority : `${authority}:${port}` }),
	});
	return Object.freeze({
		options,
		guard(
			request: ClientRequest,
			isExpired: () => boolean,
			ready: () => void,
			fail: () => void,
		): void {
			if (guarded) {
				hooks?.observer?.fail();
				request.destroy();
				fail();
				return;
			}
			guarded = request;
			expired = isExpired;
			failure = fail;
			request.once("close", () => {
				if (!released) refuse();
			});
			request.once("response", (response) => {
				if (
					response.statusCode !== undefined &&
					response.statusCode >= 300 &&
					response.statusCode < 400
				) {
					response.destroy();
					refuse();
				}
			});
			request.once("socket", (assigned) => {
				try {
					if (refused || assigned !== socket || isExpired() || !peerMatches())
						throw networkRefused();
					ready();
				} catch {
					refuse();
				}
			});
			if (refused || observation?.attempt.signal.aborted) {
				refuse();
				fail();
				return;
			}
			release();
		},
		destroy(): void {
			stop(false);
		},
	});
}
