import { Agent } from "node:https";
import { TLSSocket } from "node:tls";
import {
	createPinnedHttpsConnection,
	type EgressPolicy,
	type PinnedAddress,
	type PinnedHttpsConnection,
} from "../network/index.ts";

/** Fixed errors never carry a URL, header, credential, response or backend exception. */
export class NativeChannelHostError extends Error {
	readonly code = "NATIVE_CHANNEL_HOST_REFUSED";
	constructor() {
		super("Native channel request unavailable");
		this.name = "NativeChannelHostError";
	}
}
const refused = (): NativeChannelHostError => new NativeChannelHostError();
/** Resource provenance only; none of these methods grants a caller or credential permission. */
export interface NativeMetadataConnection extends PinnedHttpsConnection {
	destroyAndDrain(): Promise<void>;
}

/** Wraps only the unique native Agent created by the shared, unchanged DNS/TLS pin path. */
export function createNativeMetadataConnection(
	host: string,
	port: number,
	pin: PinnedAddress,
	policy: EgressPolicy,
): NativeMetadataConnection {
	const connection = createPinnedHttpsConnection(host, port, pin, policy);
	const agent = connection.options.agent;
	if (!(agent instanceof Agent)) {
		try {
			connection.destroy();
		} catch {
			/* No request has been started; an unknown resource shape is never admitted. */
		}
		throw refused();
	}
	// No request or await occurs before all original operations are captured.
	const originalCreate = agent.createConnection;
	const originalAgentDestroy = agent.destroy;
	const originalDestroy = connection.destroy;
	const originalGuard = connection.guard;
	if (
		typeof originalCreate !== "function" ||
		typeof originalAgentDestroy !== "function" ||
		typeof originalDestroy !== "function" ||
		typeof originalGuard !== "function"
	)
		throw refused();
	const sockets = new Set<TLSSocket>();
	const observed = new WeakSet<TLSSocket>();
	let closing = false;
	let destroying = false;
	let uncertain = false;
	let creating = 0;
	const drained = Promise.withResolvers<void>();
	const checkDrained = (): void => {
		if (closing && !destroying && creating === 0 && sockets.size === 0) drained.resolve();
	};
	const observe = (candidate: unknown): void => {
		if (!(candidate instanceof TLSSocket)) {
			uncertain = true;
			return;
		}
		if (observed.has(candidate)) return;
		observed.add(candidate);
		sockets.add(candidate);
		const closed = (): void => {
			sockets.delete(candidate);
			checkDrained();
		};
		candidate.once("close", closed);
		if (candidate.closed) {
			candidate.removeListener("close", closed);
			closed();
		}
		if (closing) {
			try {
				candidate.destroy();
			} catch {
				uncertain = true;
			}
		}
	};
	const destroy = (): void => {
		closing = true;
		if (destroying) return;
		destroying = true;
		try {
			try {
				Reflect.apply(originalDestroy, connection, []);
			} catch {
				uncertain = true;
			}
			// The original connection also invokes agent.destroy. Its wrapped reentrant call
			// is fenced above; this captured native operation performs the actual teardown.
			try {
				Reflect.apply(originalAgentDestroy, agent, []);
			} catch {
				uncertain = true;
			}
			for (const socket of sockets) {
				try {
					socket.destroy();
				} catch {
					uncertain = true;
				}
			}
		} finally {
			destroying = false;
			checkDrained();
		}
	};
	agent.createConnection = (...args: Parameters<typeof originalCreate>) => {
		if (closing) throw refused();
		creating++;
		try {
			const socket = Reflect.apply(originalCreate, agent, args) as ReturnType<
				typeof originalCreate
			>;
			observe(socket);
			return socket;
		} catch {
			uncertain = true;
			throw refused();
		} finally {
			creating--;
			checkDrained();
		}
	};
	// Shared-path aborts also reach this owned Agent and must fence future queued creations.
	agent.destroy = destroy;
	return Object.freeze({
		options: connection.options,
		guard(...args: Parameters<PinnedHttpsConnection["guard"]>): void {
			if (closing) {
				try {
					args[0].destroy();
				} catch {
					uncertain = true;
				}
				args[3]();
				return;
			}
			Reflect.apply(originalGuard, connection, [
				args[0],
				() => closing || args[1](),
				() => {
					if (closing) args[3]();
					else args[2]();
				},
				args[3],
			]);
		},
		destroy,
		async destroyAndDrain(): Promise<void> {
			destroy();
			if (uncertain) throw refused();
			await drained.promise;
			if (uncertain) throw refused();
		},
	});
}
