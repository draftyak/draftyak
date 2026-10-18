import { data, keys } from "./validation.ts";

export type SlackRequestClass = "read" | "send" | "hub-only" | "deny";

const READS: Readonly<
	Record<string, { readonly method: string; readonly params: readonly string[] }>
> = {
	"conversations.history": {
		method: "GET",
		params: ["channel", "oldest", "latest", "inclusive", "limit", "cursor"],
	},
	"conversations.replies": {
		method: "GET",
		params: ["channel", "ts", "oldest", "latest", "inclusive", "limit", "cursor"],
	},
	"conversations.info": {
		method: "GET",
		params: ["channel", "include_locale", "include_num_members"],
	},
	"users.conversations": {
		method: "GET",
		params: ["types", "exclude_archived", "limit", "cursor"],
	},
	"conversations.list": { method: "GET", params: ["types", "exclude_archived", "limit", "cursor"] },
	"users.info": { method: "GET", params: ["user", "include_locale"] },
	"users.list": { method: "GET", params: ["limit", "cursor", "include_locale"] },
	"auth.test": { method: "POST", params: [] },
	"apps.connections.open": { method: "POST", params: [] },
};

export function classifySlackRequest(input: unknown): SlackRequestClass {
	try {
		const value = data(input);
		keys(value, ["method", "url"]);
		if (typeof value.url !== "string" || value.url.length > 4096 || !value.url.isWellFormed())
			return "deny";
		const url = new URL(value.url);
		if (
			url.href !== value.url ||
			url.origin !== "https://slack.com" ||
			url.username ||
			url.password ||
			value.url.includes("#")
		)
			return "deny";
		if (!/^\/api\/[A-Za-z]+(?:\.[A-Za-z]+)+$/.test(url.pathname)) return "deny";
		const method = url.pathname.slice(5);
		const hasQuery = value.url.includes("?");
		if (method === "auth.revoke") return value.method === "POST" && !hasQuery ? "hub-only" : "deny";
		if (method === "chat.postMessage")
			return value.method === "POST" && !hasQuery ? "send" : "deny";
		const rule = READS[method];
		if (!rule || value.method !== rule.method || (rule.params.length === 0 && hasQuery))
			return "deny";
		const seen = new Set<string>();
		for (const key of url.searchParams.keys()) {
			if (seen.has(key) || !rule.params.includes(key)) return "deny";
			seen.add(key);
		}
		return "read";
	} catch {
		return "deny";
	}
}
