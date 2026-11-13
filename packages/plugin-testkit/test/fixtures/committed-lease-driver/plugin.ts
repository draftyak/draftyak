import { CHANNEL_V1 } from "@draftyak/protocol/channel-v1";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { defineChannelPlugin } from "@draftyak/sdk/channel";
import { createPluginContext, type HostSocket, type PluginInstance } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostChannel } from "@draftyak/sdk/host";
import type { MockPlugin } from "../../../src/types.ts";

export const LEASE_ACCOUNT = "00000000-0000-4000-8000-000000000115";
export const LEASE_URL = "wss://wss-primary.slack.com/DYTEST-committed-lease";
export const LEASE_KV_DENIED = "00000000-0000-4000-8000-000000000116";
export const LEASE_KV_ALLOWED = "00000000-0000-4000-8000-000000000117";
export const LEASE_PROBE_ENTERED = "DYTEST committed lease probe entered";
export const LEASE_SCENARIOS = ["normal", "overlong", "error-flag", "probe-open", "probe-held", "capacity"] as const;
export type LeaseScenario = typeof LEASE_SCENARIOS[number];

const manifest: PluginManifestV1 = {
	id: "dytest-committed-lease",
	version: "1.0.0",
	sdk: "1.0.0",
	kind: "channel",
	contract: { extension: CHANNEL_V1, version: 1 },
	isolation: "standard",
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	dataClasses: ["slack.content"],
	egress: { profile: "slack-v1" },
	license: "MIT",
};

export function committedLeasePlugin(
	onCall: () => void = () => {},
	host?: HostChannel,
	instance?: PluginInstance,
	scenario: LeaseScenario = "normal",
): MockPlugin {
	const lifetime = new AbortController();
	host?.subscribe(() => {}, () => lifetime.abort());
	const context = host && createPluginContext(
		{ plugin: manifest.id, account: LEASE_ACCOUNT, ...(instance ? { instance } : {}) },
		host,
		lifetime.signal,
	);
	const sockets: HostSocket[] = [];
	const probeGate = Promise.withResolvers<void>();
	const unsupported = (): never => { throw new PluginError("UNSUPPORTED"); };
	const receive = (socket: HostSocket, text: string): void => {
		const work = async (): Promise<void> => {
			const event: unknown = JSON.parse(text);
			if (!event || typeof event !== "object" || !("action" in event))
				throw new Error("DYTEST event refused");
			if (event.action === "release-probe") { probeGate.resolve(); return; }
			if (!context) throw new Error("DYTEST child context required");
			if (event.action === "kv") {
				let denied = false;
				try { await context.kv.set("DYTEST-after-commit", true); }
				catch { denied = true; }
				await socket.sendAck(denied ? LEASE_KV_DENIED : LEASE_KV_ALLOWED);
				return;
			}
			if (event.action !== "ack" || !("envelopeId" in event) || typeof event.envelopeId !== "string")
				throw new Error("DYTEST event refused");
			await socket.sendAck(event.envelopeId);
			await context.changed();
		};
		// A denied background request is an observable fixture failure, without another RPC.
		void work().catch(() => { if (!lifetime.signal.aborted) process.exit(23); });
	};
	const open = async (): Promise<void> => {
		if (!context) throw new Error("DYTEST child context required");
		const count = scenario === "capacity" ? 16 : 1;
		for (let index = 0; index < count; index++) {
			const socket = await context.ws.open(LEASE_URL);
			sockets.push(socket);
			socket.subscribe((data) => receive(socket, data));
		}
	};
	const entry = defineChannelPlugin({
		manifest,
		describe() { onCall(); return { channel: "chat", mutations: [], attachments: false, listen: true }; },
		async probe(_args, caller) {
			onCall();
			await caller.log("info", LEASE_PROBE_ENTERED);
			if (scenario === "probe-open") await open();
			if (scenario === "probe-held") await probeGate.promise;
			return { status: "ok" };
		},
		async listen(args, caller) {
			onCall();
			if (!context) throw new Error("DYTEST child context required");
			await caller.kv.set("DYTEST-during-origin", true);
			if (sockets.length === 0 || scenario === "capacity") await open();
			return { leaseMs: scenario === "overlong" ? args.leaseMs + 1_000 : args.leaseMs };
		},
		sync: unsupported,
		fetchBody: unsupported,
		send: unsupported,
		reconcileSend: unsupported,
	});
	return { manifest, entry: Object.freeze({ ...entry, account: LEASE_ACCOUNT }) };
}
