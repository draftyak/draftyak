import type { HostFetchParams } from "@draftyak/protocol/host-channel";
import type { ChannelProfile } from "@draftyak/protocol/manifest";
import type { ChannelUrl } from "./canonical.ts";

export type ChannelMethod = HostFetchParams["method"];
export const CHANNEL_METHODS: readonly ChannelMethod[] = Object.freeze([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
]);
export type ChannelRequestClass = "read" | "organize" | "send";
export type ChannelClassDenial =
	| "off_profile"
	| "gmail_batch"
	| "slack_scheduling"
	| "hub_only"
	| "system_parameter"
	| "query_credential";
export type ChannelClassification =
	| { readonly class: ChannelRequestClass }
	| { readonly denied: ChannelClassDenial };

/** The classes each profile permits; gmail-readonly-v1 keeps the Gmail read rules only. */
export const PROFILE_CLASSES: Readonly<Record<ChannelProfile, readonly ChannelRequestClass[]>> =
	Object.freeze({
		"gmail-v1": Object.freeze(["read", "organize", "send"] as const),
		"gmail-readonly-v1": Object.freeze(["read"] as const),
		"slack-v1": Object.freeze(["read", "send"] as const),
	});

const templates = (...paths: string[]): readonly (readonly string[])[] =>
	Object.freeze(paths.map((path) => Object.freeze(path.slice(1).split("/"))));
const fits = (segments: readonly string[], template: readonly string[]): boolean =>
	segments.length === template.length &&
	template.every((part, index) => part.startsWith("{") || part === segments[index]);

const GMAIL_HOSTS: readonly string[] = Object.freeze([
	"gmail.googleapis.com",
	"www.googleapis.com",
]);
const GMAIL_READ = templates(
	"/gmail/v1/users/{user}/messages",
	"/gmail/v1/users/{user}/messages/{id}",
	"/gmail/v1/users/{user}/messages/{id}/attachments/{id}",
	"/gmail/v1/users/{user}/threads",
	"/gmail/v1/users/{user}/threads/{id}",
	"/gmail/v1/users/{user}/history",
	"/gmail/v1/users/{user}/labels",
	"/gmail/v1/users/{user}/labels/{id}",
);
const GMAIL_ORGANIZE = templates(
	"/gmail/v1/users/{user}/messages/batchModify",
	"/gmail/v1/users/{user}/messages/{id}/modify",
	"/gmail/v1/users/{user}/threads/{id}/modify",
);
// Every Gmail send endpoint, upload and draft forms included, matched in lower case whatever the
// method, so no spelling of one is read class. Only a ticket for the exact request admits a send.
const GMAIL_SEND = templates(
	"/gmail/v1/users/{user}/messages/send",
	"/gmail/v1/users/{user}/drafts/send",
	"/upload/gmail/v1/users/{user}/messages/send",
	"/upload/gmail/v1/users/{user}/drafts/send",
	"/resumable/upload/gmail/v1/users/{user}/messages/send",
	"/resumable/upload/gmail/v1/users/{user}/drafts/send",
);
const GMAIL_QUERY_CREDENTIALS: readonly string[] = Object.freeze([
	"access_token",
	"key",
	"oauth_token",
]);

const SLACK_READ: readonly string[] = Object.freeze([
	"conversations.history",
	"conversations.replies",
	"conversations.list",
	"conversations.info",
	"conversations.members",
	"users.list",
	"users.info",
	"auth.test",
	"apps.connections.open",
]);
// Lower case. The hub schedules sends itself (plan §3 Scheduler), and only the hub revokes tokens.
const SLACK_SCHEDULING: readonly string[] = Object.freeze([
	"chat.schedulemessage",
	"chat.deletescheduledmessage",
	"chat.scheduledmessages.list",
]);
const SLACK_QUERY_CREDENTIALS: readonly string[] = Object.freeze(["token"]);

const READ: ChannelClassification = Object.freeze({ class: "read" });
const ORGANIZE: ChannelClassification = Object.freeze({ class: "organize" });
const SEND: ChannelClassification = Object.freeze({ class: "send" });
const denied = (code: ChannelClassDenial): ChannelClassification => Object.freeze({ denied: code });

function gmailClass(method: ChannelMethod, url: ChannelUrl): ChannelClassification {
	if (!GMAIL_HOSTS.includes(url.host)) return denied("off_profile");
	const lower = url.segments.map((segment) => segment.toLowerCase());
	if (lower[0] === "batch") return denied("gmail_batch");
	if (GMAIL_SEND.some((template) => fits(lower, template))) return SEND;
	if (method === "GET" && GMAIL_READ.some((template) => fits(url.segments, template))) return READ;
	if (method === "POST" && GMAIL_ORGANIZE.some((template) => fits(url.segments, template)))
		return ORGANIZE;
	return denied("off_profile");
}

function slackClass(method: ChannelMethod, url: ChannelUrl): ChannelClassification {
	const [prefix = "", name = ""] = url.segments;
	if (url.host !== "slack.com" || url.segments.length !== 2) return denied("off_profile");
	if (prefix.toLowerCase() === "api") {
		const lower = name.toLowerCase();
		if (lower === "chat.postmessage") return SEND;
		if (SLACK_SCHEDULING.includes(lower)) return denied("slack_scheduling");
		if (lower === "auth.revoke") return denied("hub_only");
	}
	if (prefix === "api" && (method === "GET" || method === "POST") && SLACK_READ.includes(name))
		return READ;
	return denied("off_profile");
}

/**
 * The query rule every admitted request meets, a ticketed send included: no `$` system parameter
 * and no credential parameter under any spelling of its name's case. For a known profile only.
 */
export function channelQueryDenial(
	profile: ChannelProfile,
	url: ChannelUrl,
): ChannelClassDenial | undefined {
	if (url.queryNames.some((name) => name.startsWith("$"))) return "system_parameter";
	const credentials = profile === "slack-v1" ? SLACK_QUERY_CREDENTIALS : GMAIL_QUERY_CREDENTIALS;
	if (url.queryNames.some((name) => credentials.includes(name.toLowerCase())))
		return "query_credential";
	return undefined;
}

/**
 * What a canonical request is under its profile's provider rules; PROFILE_CLASSES says whether the
 * profile permits that class. A send is classified before the query rule, so it always needs a
 * ticket and decideChannelRequest applies the rule once one is redeemed; read and organize
 * requests meet it here.
 */
export function classifyChannelRequest(
	profile: ChannelProfile,
	method: ChannelMethod,
	url: ChannelUrl,
): ChannelClassification {
	if (!Object.hasOwn(PROFILE_CLASSES, profile)) throw new TypeError("Unknown channel profile");
	const found = profile === "slack-v1" ? slackClass(method, url) : gmailClass(method, url);
	if ("denied" in found || found.class === "send") return found;
	const query = channelQueryDenial(profile, url);
	return query ? denied(query) : found;
}
