import * as z from "zod";
import { fromBase64Url, Ulid, UtcMs } from "../scalars.ts";

export const GMAIL_FLOW_CALLBACK_PATH = "/oauth/google/callback";
export const GOOGLE_AUTHORIZATION_ORIGIN = "https://accounts.google.com";
export const GOOGLE_AUTHORIZATION_PATH = "/o/oauth2/v2/auth";
export const OAUTH_RELAY_RESPONSE_BYTES = 8192;

function visibleAscii(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const code = text.charCodeAt(index);
		if (code < 0x21 || code > 0x7e) return false;
	}
	return true;
}

const visible = (value: unknown, max: number): boolean =>
	typeof value === "string" && value.length >= 1 && value.length <= max && visibleAscii(value);

interface UrlParts {
	readonly scheme: string;
	readonly userinfo: string | undefined;
	readonly host: string;
	readonly path: string;
	readonly query: string | undefined;
	readonly fragment: string | undefined;
}

// RFC 3986's split of an absolute URL, on visible ASCII only, so Rust cuts at the same places.
function splitUrl(text: string): UrlParts | undefined {
	if (!visibleAscii(text)) return undefined;
	const schemeEnd = text.indexOf("://");
	if (schemeEnd < 0) return undefined;
	let rest = text.slice(schemeEnd + 3);
	const hash = rest.indexOf("#");
	const fragment = hash < 0 ? undefined : rest.slice(hash + 1);
	if (hash >= 0) rest = rest.slice(0, hash);
	const mark = rest.indexOf("?");
	const query = mark < 0 ? undefined : rest.slice(mark + 1);
	if (mark >= 0) rest = rest.slice(0, mark);
	const slash = rest.indexOf("/");
	const authority = slash < 0 ? rest : rest.slice(0, slash);
	const at = authority.lastIndexOf("@");
	return {
		scheme: text.slice(0, schemeEnd),
		userinfo: at < 0 ? undefined : authority.slice(0, at),
		host: authority.slice(at + 1),
		path: slash < 0 ? "" : rest.slice(slash),
		query,
		fragment,
	};
}

function checkPort(port: string): boolean {
	if (port.length === 0 || port.length > 5 || !/^[0-9]+$/.test(port)) return false;
	if (port.length > 1 && port.startsWith("0")) return false;
	const number = Number(port);
	return number >= 1 && number <= 65535;
}

/** Exactly `http://127.0.0.1:<port>/oauth/google/callback`, port 1-65535 without a leading zero. */
export function checkLoopbackRedirectUri(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const url = splitUrl(value);
	if (url === undefined || url.scheme !== "http") return false;
	if (url.userinfo !== undefined) return false;
	if (url.query !== undefined) return false;
	if (url.fragment !== undefined) return false;
	if (url.path !== GMAIL_FLOW_CALLBACK_PATH) return false;
	const colon = url.host.lastIndexOf(":");
	return (
		colon >= 0 && url.host.slice(0, colon) === "127.0.0.1" && checkPort(url.host.slice(colon + 1))
	);
}

/** 43 canonical base64url characters, which decode to exactly 32 bytes. */
export function checkOAuthState(value: unknown): boolean {
	return typeof value === "string" && value.length === 43 && fromBase64Url(value)?.length === 32;
}

export const checkAuthorizationCode = (value: unknown): boolean => visible(value, 256);
export const checkOAuthClientId = (value: unknown): boolean => visible(value, 512);
export const checkOAuthClientSecret = (value: unknown): boolean => visible(value, 4096);

// RFC 3986 query characters, with each percent sign starting a two-digit escape.
const QUERY = /^(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*$/;

/** Google's fixed authorization origin and path; no userinfo or fragment; an RFC 3986 query. */
export function checkGoogleAuthorizationUrl(value: unknown): boolean {
	if (typeof value !== "string") return false;
	const url = splitUrl(value);
	if (url === undefined) return false;
	if (url.userinfo !== undefined) return false;
	if (url.fragment !== undefined) return false;
	if (`${url.scheme}://${url.host}` !== GOOGLE_AUTHORIZATION_ORIGIN) return false;
	if (url.path !== GOOGLE_AUTHORIZATION_PATH) return false;
	return url.query === undefined || QUERY.test(url.query);
}

// The checks run in zod; JSON Schema gets the same rule as a pattern, which the tests compare.
const field = (check: (value: unknown) => boolean, json: Record<string, unknown>): z.ZodString =>
	z.string().refine(check, { message: "outside its form" }).meta(json);
const visibleField = (
	check: (value: unknown) => boolean,
	max: number,
	description: string,
): z.ZodString => field(check, { description, pattern: "^[!-~]+$", minLength: 1, maxLength: max });

export const LoopbackRedirectUri: z.ZodString = field(checkLoopbackRedirectUri, {
	description: "The desktop's loopback callback, http://127.0.0.1:<port>/oauth/google/callback.",
	pattern:
		"^http://127\\.0\\.0\\.1:(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])/oauth/google/callback$",
	maxLength: 44,
});
export const OAuthState: z.ZodString = field(checkOAuthState, {
	description: "The hub's state: 32 bytes as canonical, unpadded base64url.",
	pattern: "^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$",
	minLength: 43,
	maxLength: 43,
});
export const AuthorizationCode: z.ZodString = visibleField(
	checkAuthorizationCode,
	256,
	"Google's code, visible ASCII.",
);
export const OAuthClientId: z.ZodString = visibleField(
	checkOAuthClientId,
	512,
	"The OAuth client's ID.",
);
export const OAuthClientSecret: z.ZodString = visibleField(
	checkOAuthClientSecret,
	4096,
	"The OAuth client's secret.",
);
export const GoogleAuthorizationUrl: z.ZodString = field(checkGoogleAuthorizationUrl, {
	description: "Google's authorization endpoint with the hub's query.",
	pattern:
		"^https://accounts\\.google\\.com/o/oauth2/v2/auth(?:\\?(?:[A-Za-z0-9._~!$&'()*+,;=:@/?-]|%[0-9A-Fa-f]{2})*)?$",
});

export interface GmailFlowClient {
	readonly clientId: string;
	readonly clientSecret: string | null;
}
export interface GmailFlowClientRequest {
	readonly flowId: string;
	readonly client: GmailFlowClient;
	readonly redirectUri: string;
}
export const GmailFlowClientRequest: z.ZodType<GmailFlowClientRequest> = z
	.strictObject({
		flowId: Ulid,
		client: z.strictObject({
			clientId: OAuthClientId,
			clientSecret: OAuthClientSecret.nullable(),
		}),
		redirectUri: LoopbackRedirectUri,
	})
	.meta({ id: "draftyak.oauth-relay.GmailFlowClientRequest" });

export interface GmailFlowAuthorizeRequest {
	readonly flowId: string;
}
export const GmailFlowAuthorizeRequest: z.ZodType<GmailFlowAuthorizeRequest> = z
	.strictObject({ flowId: Ulid })
	.meta({ id: "draftyak.oauth-relay.GmailFlowAuthorizeRequest" });

export interface GmailFlowRelayRequest {
	readonly flowId: string;
	readonly state: string;
	readonly code: string;
	readonly redirectUri: string;
}
export const GmailFlowRelayRequest: z.ZodType<GmailFlowRelayRequest> = z
	.strictObject({
		flowId: Ulid,
		state: OAuthState,
		code: AuthorizationCode,
		redirectUri: LoopbackRedirectUri,
	})
	.meta({ id: "draftyak.oauth-relay.GmailFlowRelayRequest" });

export interface GmailFlowAuthorization {
	readonly id: string;
	readonly authorizationUrl: string;
	readonly expiresAt: number;
	readonly remainingMs: number;
}
export const GmailFlowAuthorization: z.ZodType<GmailFlowAuthorization> = z
	.strictObject({
		id: Ulid,
		authorizationUrl: GoogleAuthorizationUrl,
		expiresAt: UtcMs,
		remainingMs: z.int().min(0),
	})
	.meta({ id: "draftyak.oauth-relay.GmailFlowAuthorization" });

export type GmailFlowView = Readonly<Record<string, unknown>>;
/**
 * For the JSON Schema export. Check a flow view with checkOAuthRelayResponse,
 * checkOAuthRelayResponseBytes or parseOAuthRelayResponseBytes: this record copies its input and
 * drops a "__proto__" member, which the route checks keep.
 */
export const GmailFlowView: z.ZodType<GmailFlowView> = z.record(z.string(), z.unknown()).meta({
	id: "draftyak.oauth-relay.GmailFlowView",
	description:
		"The hub's flow view, which carries no secret, code or token. This contract checks only that it is a JSON object within the cap.",
});
