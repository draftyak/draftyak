// The hub side of a python plugin's fd-3 host channel in S11's sessions. Since M0.12 the plugin's
// Node opens fd 3 as its IPC channel (PLUGIN_CHANNEL_ENV) and the hub reads it as a plain pipe
// through S2b's decoder, which ends the channel and kills the plugin on any hostile byte.
// attachHostChannel answers host/fetch with the broker stub's verdict only, while the shim needs a
// fetch result ({status, headers, bodyBase64}), so S11 dispatches the decoded messages itself:
// host/fetch to the test's broker stand-in, notifications (host/log) to the caller. Imports only
// node: built-ins and M0.12's host-channel.ts, so the Docker runners load it unchanged.
import type { ChildProcess } from "node:child_process";
import type { Duplex } from "node:stream";
import {
	createChannelDecoder,
	encodeChannelMessage,
	type HostViolation,
} from "@draftyak/spike-s02-plugin-sandbox/src/host-channel.ts";

export interface HostHandlers {
	readonly fetch: (params: Record<string, unknown>) => Record<string, unknown>;
	readonly notify?: (method: string, params: Record<string, unknown>) => void;
}

export interface HostSide {
	readonly violations: readonly HostViolation[];
}

const record = (value: unknown): Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};

export function serveHostChannel(child: ChildProcess, handlers: HostHandlers): HostSide {
	const stream = child.stdio[3] as Duplex | null | undefined;
	if (stream == null) throw new Error("the plugin has no fd-3 host channel");
	const framed = process.platform === "win32";
	const violations: HostViolation[] = [];
	const write = (message: object): void => {
		if (stream.destroyed || !stream.writable) return;
		stream.write(encodeChannelMessage(message, framed), () => {});
	};
	const decoder = createChannelDecoder({
		framed,
		onMessage: (message) => {
			const { id, method } = message;
			const params = record(message.params);
			const hasId = typeof id === "string" || typeof id === "number";
			if (method === "host/fetch" && hasId) {
				write({ jsonrpc: "2.0", id, result: handlers.fetch(params) });
			} else if (typeof method === "string" && !("id" in message)) {
				handlers.notify?.(method, params);
			} else if (typeof method === "string" && hasId) {
				write({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
			}
		},
		onViolation: (violation) => {
			violations.push(violation);
			child.kill("SIGKILL");
			stream.destroy();
		},
	});
	stream.on("data", (chunk: Buffer) => decoder.push(chunk));
	stream.on("error", () => {});
	// A plugin that dies mid-write must not surface EPIPE as an uncaught error in the harness.
	child.stdin?.on("error", () => {});
	return { violations };
}
