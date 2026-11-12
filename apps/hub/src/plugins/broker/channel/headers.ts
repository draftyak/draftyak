import type { HeaderList } from "@draftyak/protocol/hash";
import { checkHeaders, HostHeaders } from "@draftyak/protocol/host-channel";
import type { ChannelProfile } from "@draftyak/protocol/manifest";

/** Refused outright, so the provider always runs the method the request was classified by. */
export const METHOD_OVERRIDE_HEADERS: readonly string[] = Object.freeze([
	"x-http-method-override",
	"x-http-method",
	"x-method-override",
]);
const CONTENT_HEADERS: readonly string[] = Object.freeze([
	"accept",
	"content-type",
	"if-modified-since",
	"if-none-match",
]);
/**
 * The plugin headers each profile forwards, as the testkit does. Everything else, credentials,
 * cookies, Host, framing and encoding included, is dropped; the transport sets its own.
 */
export const CHANNEL_REQUEST_HEADERS: Readonly<Record<ChannelProfile, readonly string[]>> =
	Object.freeze({
		"gmail-v1": CONTENT_HEADERS,
		"gmail-readonly-v1": CONTENT_HEADERS,
		"slack-v1": CONTENT_HEADERS,
	});
export type ChannelHeaderDenial = "headers_invalid" | "method_override";
export type ChannelHeaders =
	| { readonly headers: HeaderList }
	| { readonly denied: ChannelHeaderDenial };

const denied = (code: ChannelHeaderDenial): ChannelHeaders => Object.freeze({ denied: code });

/** The headers an unticketed request forwards, lower-cased, each at most once. */
export function channelRequestHeaders(profile: ChannelProfile, raw: unknown): ChannelHeaders {
	if (!Object.hasOwn(CHANNEL_REQUEST_HEADERS, profile))
		throw new TypeError("Unknown channel profile");
	let parsed: HeaderList;
	try {
		parsed = HostHeaders.parse(raw);
		checkHeaders(parsed);
	} catch {
		return denied("headers_invalid");
	}
	const rows = parsed.map(([name, value]) => [name.toLowerCase(), value] as const);
	if (rows.some(([name]) => METHOD_OVERRIDE_HEADERS.includes(name)))
		return denied("method_override");
	const allowed = CHANNEL_REQUEST_HEADERS[profile];
	const kept = rows.filter(([name]) => allowed.includes(name));
	if (new Set(kept.map(([name]) => name)).size !== kept.length) return denied("headers_invalid");
	return Object.freeze({ headers: Object.freeze(kept.map((row) => Object.freeze(row))) });
}
