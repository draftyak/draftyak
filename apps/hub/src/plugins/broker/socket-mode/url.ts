import { isProxy } from "node:util/types";
import { parseStrict } from "@draftyak/protocol/jcs";
import { egressHost } from "../network/index.ts";
import { refuseSocketMode } from "./refusal.ts";

/** The host/ws.open `url` bound. */
export const SOCKET_MODE_URL_MAX_LENGTH = 8192;
export const SOCKET_MODE_OPEN_RESPONSE_MAX_BYTES = 65_536;

/** Where the native transport connects. The path carries the single-use ticket: never log it. */
export interface SocketModeEndpoint {
	readonly host: string;
	readonly port: 443;
	readonly path: string;
}

/** The native transport's response to the matched `apps.connections.open` request. */
export interface SocketModeOpenResponse {
	readonly status: number;
	readonly body: Uint8Array;
}

/**
 * Slack's own wss hosts only (`slack.com` and its subdomains) on port 443, written exactly as the
 * URL parser serializes them apart from an explicit `:443`: no userinfo, other port, fragment or
 * alternate spelling of the host.
 */
export function socketModeEndpoint(raw: unknown): SocketModeEndpoint {
	if (
		typeof raw !== "string" ||
		raw.length === 0 ||
		raw.length > SOCKET_MODE_URL_MAX_LENGTH ||
		raw.includes("#")
	)
		refuseSocketMode("URL_TARGET");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		refuseSocketMode("URL_TARGET");
	}
	const host = url.hostname;
	const origin = `wss://${host}`;
	const path = url.href.slice(origin.length);
	if (
		!url.href.startsWith(`${origin}/`) ||
		// The parser drops a written-out default port from `href`; nothing else may differ.
		(raw !== url.href && raw !== `${origin}:443${path}`) ||
		url.protocol !== "wss:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.port !== "" ||
		(host !== "slack.com" && !host.endsWith(".slack.com"))
	)
		refuseSocketMode("URL_TARGET");
	try {
		egressHost(host);
	} catch {
		refuseSocketMode("URL_TARGET");
	}
	return Object.freeze({ host, port: 443, path });
}

function ownValue(record: object, name: string): unknown {
	const field = Object.getOwnPropertyDescriptor(record, name);
	return field?.enumerable === true && Object.hasOwn(field, "value") ? field.value : undefined;
}

/**
 * The wss URL from a 200 `{"ok": true, "url": ...}` body: strict UTF-8 JSON without duplicate
 * names. Redirects and every other status are refused, never followed.
 */
export function socketModeOpenUrl(response: SocketModeOpenResponse): string {
	if (response === null || typeof response !== "object" || isProxy(response))
		refuseSocketMode("URL_RESPONSE");
	const status = ownValue(response, "status"),
		body = ownValue(response, "body");
	if (
		status !== 200 ||
		!(body instanceof Uint8Array) ||
		body.byteLength > SOCKET_MODE_OPEN_RESPONSE_MAX_BYTES
	)
		refuseSocketMode("URL_RESPONSE");
	let parsed: unknown;
	try {
		parsed = parseStrict(body);
	} catch {
		refuseSocketMode("URL_RESPONSE");
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		refuseSocketMode("URL_RESPONSE");
	const url = ownValue(parsed, "url");
	if (ownValue(parsed, "ok") !== true || typeof url !== "string") refuseSocketMode("URL_RESPONSE");
	socketModeEndpoint(url);
	return url;
}
