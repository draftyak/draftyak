/** Fixed internal-app configuration; declarations do not grant account or send authority. */
export interface SlackInstallManifest {
	readonly _metadata: { readonly major_version: 1 };
	readonly display_information: { readonly name: "DraftYak"; readonly description: string };
	readonly oauth_config: { readonly scopes: { readonly user: readonly string[] } };
	readonly settings: {
		readonly event_subscriptions: { readonly user_events: readonly string[] };
		readonly org_deploy_enabled: false;
		readonly socket_mode_enabled: true;
		readonly token_rotation_enabled: false;
		readonly is_mcp_enabled: false;
	};
}

export const SLACK_INSTALL_MANIFEST: SlackInstallManifest = Object.freeze({
	_metadata: Object.freeze({ major_version: 1 }),
	display_information: Object.freeze({
		name: "DraftYak",
		description: "Read Slack conversations and send owner-approved replies from DraftYak.",
	}),
	oauth_config: Object.freeze({
		scopes: Object.freeze({
			user: Object.freeze([
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
			]),
		}),
	}),
	settings: Object.freeze({
		event_subscriptions: Object.freeze({
			user_events: Object.freeze([
				"message.channels",
				"message.groups",
				"message.im",
				"message.mpim",
			]),
		}),
		org_deploy_enabled: false,
		socket_mode_enabled: true,
		token_rotation_enabled: false,
		is_mcp_enabled: false,
	}),
});

const creation = new URL("https://api.slack.com/apps");
creation.searchParams.set("new_app", "1");
creation.searchParams.set("manifest_json", JSON.stringify(SLACK_INSTALL_MANIFEST));

/** Prefilled configuration DATA only; opening or installing the app remains an explicit action. */
export const SLACK_INSTALL_URL: string = creation.href;
