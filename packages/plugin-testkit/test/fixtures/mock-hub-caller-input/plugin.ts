import { CHANNEL_V1 } from "@draftyak/protocol/channel-v1";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { defineChannelPlugin } from "@draftyak/sdk/channel";
import { PluginError } from "@draftyak/sdk/errors";
import type { MockPlugin } from "../../../src/types.ts";

export const CALLER_INPUT_ACCOUNT = "00000000-0000-4000-8000-000000000114";
export const CALLER_INPUT_ENTERED = "DYTEST caller input entered";
export const CALLER_INPUT_URL = "https://caller.draftyak.example/probe";

const manifest: PluginManifestV1 = {
	id: "dytest-caller-input",
	version: "1.0.0",
	sdk: "1.0.0",
	kind: "channel",
	contract: { extension: CHANNEL_V1, version: 1 },
	isolation: "standard",
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	dataClasses: ["example.content"],
	egress: { rules: [{
		class: "read", host: "caller.draftyak.example", method: "GET", pathTemplate: "/probe",
		maxBytes: 128, timeoutMs: 10_000,
	}] },
	license: "MIT",
};

export function callerInputPlugin(onCall: () => void = () => {}): MockPlugin {
	const unsupported = (): never => { throw new PluginError("UNSUPPORTED"); };
	const entry = defineChannelPlugin({
		manifest,
		describe() {
			onCall();
			return { channel: "chat", mutations: [], attachments: false, listen: false };
		},
		async probe(_args, context) {
			onCall();
			await context.log("info", CALLER_INPUT_ENTERED);
			const response = await context.fetch(CALLER_INPUT_URL, { method: "GET", stream: false });
			if (!response.ok) throw new PluginError("TRANSIENT");
			await response.body?.cancel();
			return { status: "ok" };
		},
		sync: unsupported,
		fetchBody: unsupported,
		send: unsupported,
		reconcileSend: unsupported,
	});
	return { manifest, entry: Object.freeze({ ...entry, account: CALLER_INPUT_ACCOUNT }) };
}
