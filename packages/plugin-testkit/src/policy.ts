import type { HeaderList } from "@draftyak/protocol/hash";
import { HOST_MAX_STREAM_BYTES, HOST_REQUEST_TIMEOUT_MS } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import type { EgressRule } from "@draftyak/protocol/manifest/egress";
import { PathSegment } from "@draftyak/protocol/manifest/egress";
import {
	checkResponsesHttpRequest,
	type ResponsesHttpBinding,
} from "@draftyak/protocol/manifest/responses-http";
import { SendUrl } from "@draftyak/protocol/send-ticket";
import { checkUrlSecret, parseSecretRef, type ToolEgressRule } from "@draftyak/protocol/tool-v1";

export type MatchedRule = { readonly rule: EgressRule | ToolEgressRule; readonly url: string };

export interface ResponsesMatchContext {
	readonly bindings: readonly ResponsesHttpBinding[];
	readonly headers: HeaderList;
	readonly body: Uint8Array;
}

function matches(rule: EgressRule, url: URL): boolean {
	const expected = rule.pathTemplate === "/" ? [] : rule.pathTemplate.slice(1).split("/");
	const actual = url.pathname === "/" ? [] : url.pathname.slice(1).split("/");
	if (expected.length !== actual.length) return false;
	if (
		!expected.every((part, index) =>
			part.startsWith("{") ? PathSegment.safeParse(actual[index]).success : part === actual[index],
		)
	)
		return false;
	const allowed = rule.query ? Object.keys(rule.query) : [];
	const names = rule.query && Array.isArray(rule.query) ? rule.query : allowed;
	return [...url.searchParams.keys()].every(
		(name) => !name.startsWith("$") && names.includes(name),
	);
}

function profileRule(
	manifest: Extract<PluginManifestV1, { kind: "channel" }>,
	url: URL,
	method: string,
): EgressRule | undefined {
	if (!("profile" in manifest.egress)) return;
	const profile = manifest.egress.profile;
	const path = url.pathname;
	let classification: "read" | "organize" | "send" | undefined;
	if (
		profile.startsWith("gmail-") &&
		["gmail.googleapis.com", "www.googleapis.com"].includes(url.hostname)
	) {
		if (
			method === "GET" &&
			/^\/gmail\/v1\/users\/[^/]+\/(?:messages(?:\/[^/]+(?:\/attachments\/[^/]+)?)?|threads(?:\/[^/]+)?|history|labels(?:\/[^/]+)?)$/.test(
				path,
			)
		)
			classification = "read";
		if (
			profile === "gmail-v1" &&
			method === "POST" &&
			/^\/gmail\/v1\/users\/[^/]+\/(?:messages\/batchModify|(?:messages|threads)\/[^/]+\/modify)$/.test(
				path,
			)
		)
			classification = "organize";
		if (
			profile === "gmail-v1" &&
			method === "POST" &&
			/^\/upload\/gmail\/v1\/users\/[^/]+\/messages\/send$/.test(path)
		)
			classification = "send";
	} else if (profile === "slack-v1" && url.hostname === "slack.com") {
		const name = path.startsWith("/api/") ? path.slice(5) : "";
		if (
			["GET", "POST"].includes(method) &&
			[
				"conversations.history",
				"conversations.replies",
				"conversations.list",
				"conversations.info",
				"conversations.members",
				"users.list",
				"users.info",
				"auth.test",
				"apps.connections.open",
			].includes(name)
		)
			classification = "read";
		if (method === "POST" && name === "chat.postMessage") classification = "send";
	}
	if (!classification) return;
	// Fixed provider profiles still reject system parameters; other query values are provider data.
	if ([...url.searchParams.keys()].some((name) => name.startsWith("$"))) return;
	return {
		class: classification,
		method,
		host: url.hostname,
		pathTemplate: path,
		maxBytes: 35 * 1024 ** 2,
		timeoutMs: 30_000,
	} as EgressRule;
}

export function matchRequest(
	manifest: PluginManifestV1,
	requested: string,
	method: string,
	secrets: ReadonlyMap<string, string>,
	responses?: ResponsesMatchContext,
): MatchedRule | undefined {
	if (manifest.kind === "ai-provider") {
		if (manifest.egress.profile !== "responses-api-v1" || !responses) return;
		const request = { method, url: requested, headers: responses.headers, body: responses.body };
		if (!responses.bindings.some((binding) => checkResponsesHttpRequest(request, binding).ok))
			return;
		// The issued binding checks the original request before any host header filtering.
		// Its exact model URL may contain RFC 3986 path characters outside channel segments.
		const url = new URL(requested);
		return {
			url: requested,
			rule: {
				class: "read",
				method: method as "GET" | "POST",
				host: url.hostname,
				pathTemplate: url.pathname,
				maxBytes: HOST_MAX_STREAM_BYTES,
				timeoutMs: HOST_REQUEST_TIMEOUT_MS,
			},
		};
	}
	if (requested.startsWith("secret://")) {
		if (manifest.kind !== "tool") return;
		const name = parseSecretRef(requested);
		const secret = name === undefined ? undefined : secrets.get(name);
		if (!name || !secret) return;
		const checked = checkUrlSecret(secret);
		if (!checked.ok) return;
		const rule = manifest.egress.rules.find(
			(row) => row.method === method && "url" in row && row.url === requested,
		);
		return rule ? { rule, url: checked.url } : undefined;
	}
	if (!SendUrl.safeParse(requested).success) return;
	const url = new URL(requested);
	if (
		url.pathname !== "/" &&
		!url.pathname
			.slice(1)
			.split("/")
			.every((part) => PathSegment.safeParse(part).success)
	)
		return;
	if (manifest.kind === "tool") {
		const rule = manifest.egress.rules.find(
			(row) =>
				row.method === method && "host" in row && row.host === url.hostname && url.port === "",
		);
		return rule ? { rule, url: requested } : undefined;
	}
	if (manifest.kind !== "channel") return;
	if ("profile" in manifest.egress) {
		if (url.port !== "") return;
		const rule = profileRule(manifest, url, method);
		return rule ? { rule, url: requested } : undefined;
	}
	const rule = manifest.egress.rules.find(
		(row) =>
			row.method === method && row.host === url.hostname && url.port === "" && matches(row, url),
	);
	return rule ? { rule, url: requested } : undefined;
}
