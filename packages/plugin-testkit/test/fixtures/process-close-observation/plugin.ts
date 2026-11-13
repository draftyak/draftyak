import { HOST_MAX_FRAME_BYTES } from "@draftyak/protocol/host-channel";
import { validateManifest } from "@draftyak/protocol/manifest";
import type { MockPlugin } from "../../../src/types.ts";
import { channelFixture } from "../channel/plugin.ts";

export const CLOSE_MODES = ["malformed", "oversized", "stderr"] as const;
export type CloseMode = (typeof CLOSE_MODES)[number];
export const CLOSE_ACCOUNT = "00000000-0000-4000-8000-000000000171";
export const CLOSE_SOCKET = "wss://wss-primary.slack.com/DYTEST-close-observation";

export function closeObservationPlugin(mode: CloseMode, onCall: () => void = () => {}): MockPlugin {
	const base = channelFixture(async (_input, context) => {
		onCall();
		await context.ws.open(CLOSE_SOCKET);
		if (mode === "malformed") process.stdout.write("{invalid-json}\n");
		else if (mode === "oversized") process.stdout.write(`${"x".repeat(HOST_MAX_FRAME_BYTES + 1)}\n`);
		else process.stderr.write("synthetic failure\n".repeat(65_536));
		return new Promise<never>(() => {});
	}, CLOSE_ACCOUNT);
	const checked = validateManifest(base.manifest);
	if (!checked.ok || checked.manifest.kind !== "channel") throw new Error("DYTEST channel manifest required");
	const manifest = {
		...checked.manifest,
		kind: "channel" as const,
		egress: { profile: "slack-v1" as const },
		dataClasses: ["slack.content"],
	};
	delete manifest.send;
	return { manifest, entry: base.entry };
}
