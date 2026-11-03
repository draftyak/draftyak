import { CHANNEL_V1 } from "@draftyak/protocol/channel-v1";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";

// User-token grants for the retained read methods, approval context and sending.
// Socket Mode's connections:write belongs to the separate app-level credential.
const userScopes = [
	"channels:history",
	"channels:read",
	"groups:history",
	"groups:read",
	"im:history",
	"im:read",
	"mpim:history",
	"mpim:read",
	"users:read",
	"chat:write",
];

const declaration: PluginManifestV1 = {
	id: "@draftyak/channel-slack",
	version: "0.0.0",
	kind: "channel",
	contract: { extension: CHANNEL_V1, version: 1 },
	sdk: "1.0.0",
	runtime: "node",
	isolation: "standard",
	auth: {
		kind: "manifest-app",
		scopes: userScopes,
		requiredGrantedScopes: [...userScopes],
	},
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	dataClasses: ["slack.metadata", "slack.content"],
	egress: { profile: "slack-v1" },
	send: { render: "slack-postmessage" },
	license: "Apache-2.0",
};

// This traversal sees only the declaration above, never caller or provider data.
function freezeDeclaration(value: unknown): void {
	if (value === null || typeof value !== "object") return;
	for (const child of Object.values(value)) freezeDeclaration(child);
	Object.freeze(value);
}
freezeDeclaration(declaration);

/** Declarations only; the host owns installation, credential and effect authority. */
export const SLACK_PLUGIN_MANIFEST: PluginManifestV1 = declaration;
