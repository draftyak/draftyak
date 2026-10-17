import { inCode, type Rule } from "../src/rules.ts";

const manifest = (scope: string): string =>
	`oauth_config:\n  scopes:\n    user:\n      - ${scope}\n      - im:history\n`;

// Guardrail 6.
export const slack: readonly Rule[] = [
	{
		id: "slack-rts",
		kind: "vendor",
		reason:
			"Slack's Real-time Search API: an assistant.search.* method or a search:read.* scope (guardrail 6)",
		patterns: [
			/\bassistant\.search\.[a-z]\w*/i,
			/\bsearch:read\.(?:public|private|im|mpim|files|users)\b/i,
		],
		bad: [
			inCode('await client.apiCall("assistant.search.context", { query });'),
			{ path: "spikes/s06-slack/manifest.yaml", text: manifest("search:read.im") },
		],
		good: [
			inCode("await client.conversations.history({ channel });"),
			{ path: "spikes/s06-slack/manifest.yaml", text: manifest("mpim:history") },
		],
	},
	{
		id: "slack-mcp",
		kind: "vendor",
		reason: "Slack's MCP server (guardrail 6)",
		patterns: [/\bmcp\.slack\.com\b/i],
		bad: [inCode('const server = "https://mcp.slack.com/mcp";')],
		good: [inCode('const socket = "https://slack.com/api/apps.connections.open";')],
	},
];
