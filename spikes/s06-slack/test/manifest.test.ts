import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { METHODS, type Method } from "../src/api.ts";
import { parseYaml } from "./yaml.ts";

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = parseYaml(read("../manifest.yaml"));
const sources = readdirSync(new URL("../src/", import.meta.url)).map((file) => ({
	file,
	text: read(`../src/${file}`),
}));

const SCOPES = [
	"channels:history",
	"channels:read",
	"groups:history",
	"groups:read",
	"im:history",
	"im:read",
	"mpim:history",
	"mpim:read",
];
const EVENTS = ["message.channels", "message.groups", "message.im", "message.mpim"];

const history = ["channels:history", "groups:history", "im:history", "mpim:history"];
const metadata = ["channels:read", "groups:read", "im:read", "mpim:read"];

// The user-token scopes each read needs for all four conversation types, and each event's scope,
// from their reference pages (https://docs.slack.dev/reference/, read 2026-10-17).
const METHOD_SCOPES: Readonly<Record<Method, readonly string[]>> = {
	"apps.connections.open": [],
	"auth.test": [],
	"users.conversations": metadata,
	"conversations.history": history,
	"conversations.replies": history,
	"conversations.info": metadata,
};
const EVENT_SCOPES: Readonly<Record<string, string>> = {
	"message.channels": "channels:history",
	"message.groups": "groups:history",
	"message.im": "im:history",
	"message.mpim": "mpim:history",
};

// The methods src calls by name, plus conversations.info, which M0.25's live test calls through
// callSlack for its rate-limit headers.
const CALLED: readonly string[] = [
	...new Set([
		...sources.flatMap(({ text }) =>
			[...text.matchAll(/\b(?:callSlack|this\.call)\(\s*"([\w.]+)"/g)].map((match) => match[1]),
		),
		"conversations.info",
	]),
]
	.flatMap((method) => method ?? [])
	.sort();

describe("manifest.yaml", () => {
	it("describes an internal Socket Mode app with a user token and user events only", () => {
		expect(manifest).toEqual({
			_metadata: { major_version: 1 },
			display_information: {
				name: "DraftYak S6 spike",
				description: expect.any(String),
			},
			oauth_config: { scopes: { user: SCOPES } },
			settings: {
				event_subscriptions: { user_events: EVENTS },
				org_deploy_enabled: false,
				socket_mode_enabled: true,
				token_rotation_enabled: false,
				is_mcp_enabled: false,
			},
		});
		const { name, description } = (manifest as { display_information: Record<string, string> })
			.display_information;
		expect(name?.length).toBeLessThanOrEqual(35);
		expect(description?.length).toBeLessThanOrEqual(140);
	});

	it("asks for the fewest scopes: read-only, and only what the called methods and events need", () => {
		for (const scope of SCOPES) {
			expect(scope).toMatch(/^(?:channels|groups|im|mpim):(?:history|read)$/);
		}
		expect(CALLED).toEqual(Object.keys(METHODS).sort());
		const needed = new Set([
			...CALLED.flatMap((method) => METHOD_SCOPES[method as Method]),
			...Object.values(EVENT_SCOPES),
		]);
		expect([...needed].sort()).toEqual(SCOPES);
		for (const event of EVENTS) expect(SCOPES).toContain(EVENT_SCOPES[event]);
	});

	it("is parsed strictly, so nothing hides outside the checked subset", () => {
		expect(() => parseYaml("a:\n\tb: 1\n")).toThrow("tabs");
		expect(() => parseYaml("a: [b]\n")).toThrow("unsupported scalar");
		expect(() => parseYaml("a: 1\na: 2\n")).toThrow("duplicate");
		expect(() => parseYaml("a:\n  - b\n   c: 1\n")).toThrow("odd indentation");
		expect(parseYaml("a:\n  b: true\n  c:\n    - x y\n")).toEqual({ a: { b: true, c: ["x y"] } });
	});
});

describe("guardrail 6 in the spike's code", () => {
	it("calls only the slack-v1 profile's read methods and apps.connections.open", () => {
		// Plan §4 Profiles, slack-v1: history, replies, list, info, users, auth.test,
		// apps.connections.open. The spike lists the owner's conversations with users.conversations
		// where the profile names conversations.list (notes/rate-limits.md). It sends nothing.
		expect(Object.keys(METHODS).sort()).toEqual([
			"apps.connections.open",
			"auth.test",
			"conversations.history",
			"conversations.info",
			"conversations.replies",
			"users.conversations",
		]);
		for (const [method, spec] of Object.entries(METHODS)) {
			expect(spec.token, method).toBe(method === "apps.connections.open" ? "app" : "user");
		}
	});

	it("imports only node: built-ins and its own files, and reaches only slack.com", () => {
		for (const { file, text } of sources) {
			// Nothing loads code around the static imports checked below.
			expect(text, file).not.toMatch(/\bimport\s*\(|require|getBuiltinModule|node:module|dlopen/i);
		}
		const specifiers = sources.flatMap(({ text }) =>
			[...text.matchAll(/\b(?:from|import)\s*(["'`])(.*?)\1/g)].map((match) => match[2] ?? ""),
		);
		expect(specifiers.length).toBeGreaterThan(0);
		for (const specifier of specifiers) {
			expect(specifier).toMatch(/^(?:node:[a-z/_]+|\.\/[\w-]+\.ts)$/);
		}
		const hosts = sources.flatMap(({ text }) =>
			[...text.matchAll(/\b(?:https?|wss?):\/\/([\w.-]+)/g)].map((match) => match[1] ?? ""),
		);
		for (const host of hosts) expect(["slack.com", "docs.slack.dev"]).toContain(host);
	});

	it("reads conversations only through the owner's user token and never the search or MCP surfaces", () => {
		const code = sources.map(({ text }) => text).join("\n");
		expect(code).not.toMatch(/\bsearch\.|search:read|mcp/i);
		expect(JSON.stringify(manifest)).not.toMatch(/search|bot|admin|chat:write|distribut/i);
	});
});
