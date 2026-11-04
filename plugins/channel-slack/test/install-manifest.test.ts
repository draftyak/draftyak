import { readFileSync } from "node:fs";
import {
	SLACK_INSTALL_MANIFEST,
	SLACK_INSTALL_URL,
} from "@draftyak/channel-slack/install-manifest";
import { describe, expect, it } from "vitest";

const artifact: unknown = JSON.parse(
	readFileSync(new URL("../manifest.yaml", import.meta.url), "utf8"),
);

function deeplyFrozen(value: unknown): boolean {
	return (
		value === null ||
		typeof value !== "object" ||
		(Object.isFrozen(value) && Object.values(value).every(deeplyFrozen))
	);
}

describe("Slack internal-app installation data", () => {
	it("exports the actual internal-app artifact separately from the plugin declaration", () => {
		expect(SLACK_INSTALL_MANIFEST).toEqual(artifact);
		expect(Object.keys(SLACK_INSTALL_MANIFEST).sort()).toEqual([
			"_metadata",
			"display_information",
			"oauth_config",
			"settings",
		]);
		expect(SLACK_INSTALL_MANIFEST._metadata).toEqual({ major_version: 1 });
		expect(SLACK_INSTALL_MANIFEST.display_information).toEqual({
			name: "DraftYak",
			description: "Read Slack conversations and send owner-approved replies from DraftYak.",
		});
	});

	it("requests exactly the ten retained USER scopes without a bot or app-level credential", () => {
		expect(SLACK_INSTALL_MANIFEST.oauth_config).toEqual({
			scopes: {
				user: [
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
				],
			},
		});
	});

	it("keeps the four USER events and explicit internal Socket Mode settings", () => {
		expect(SLACK_INSTALL_MANIFEST.settings).toEqual({
			event_subscriptions: {
				user_events: ["message.channels", "message.groups", "message.im", "message.mpim"],
			},
			org_deploy_enabled: false,
			socket_mode_enabled: true,
			token_rotation_enabled: false,
			is_mcp_enabled: false,
		});
	});

	it("keeps every manifest level immutable and the prefilled payload stable", () => {
		const before = JSON.stringify(SLACK_INSTALL_MANIFEST);
		expect(deeplyFrozen(SLACK_INSTALL_MANIFEST)).toBe(true);
		expect(Reflect.set(SLACK_INSTALL_MANIFEST.settings, "socket_mode_enabled", false)).toBe(false);
		expect(Reflect.set(SLACK_INSTALL_MANIFEST.oauth_config.scopes.user, "0", "admin")).toBe(false);
		expect(JSON.stringify(SLACK_INSTALL_MANIFEST)).toBe(before);
		expect(new URL(SLACK_INSTALL_URL).searchParams.get("manifest_json")).toBe(before);
	});

	it("prefills the real artifact using only the two fixed creation-link parameters", () => {
		const url = new URL(SLACK_INSTALL_URL);
		expect(url.origin).toBe("https://api.slack.com");
		expect(url.pathname).toBe("/apps");
		expect(url.username).toBe("");
		expect(url.password).toBe("");
		expect(url.hash).toBe("");
		expect([...url.searchParams.keys()].sort()).toEqual(["manifest_json", "new_app"]);
		expect(url.searchParams.get("new_app")).toBe("1");
		expect(JSON.parse(url.searchParams.get("manifest_json") ?? "")).toEqual(artifact);
	});
});
