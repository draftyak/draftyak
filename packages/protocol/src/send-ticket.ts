import * as z from "zod";
import { type HeaderList, headersSha256, sha256Hex } from "./hash.ts";
import { canonicalize, JcsError } from "./jcs.ts";
import { Sha256Hex, Ulid, UtcMs } from "./scalars.ts";

// Where the ticket rides: channel_send's `_meta`, then host/fetch's `sendTicket`, unchanged.
export const SEND_TICKET_META = "io.github.draftyak/send-ticket";
// A ticket lives at most 60 s (§4 Send verification, step 2) and never past the item's deliverBy,
// since no send may happen after it (§9.1 I1).
export const SEND_TICKET_TTL_MS = 60_000;
export const sendTicketExp = (mintedAt: number, deliverBy: number): number =>
	Math.min(mintedAt + SEND_TICKET_TTL_MS, deliverBy);

export const SEND_METHODS = ["POST", "PUT", "PATCH"] as const;
export type SendMethod = (typeof SEND_METHODS)[number];
export const SendMethod: z.ZodEnum<z.core.util.ToEnum<SendMethod>> = z.enum(SEND_METHODS);

// Percent-encoded octets in upper-case hex and never of an unreserved character (RFC 3986 §6.2.2),
// so a URL has one spelling and no encoding hides a dot segment.
const PCT_ENCODED = "%(?:[01][0-9A-F]|2[0-9A-CF]|3[A-F]|40|5[B-E]|60|7[BCDF]|[89A-F][0-9A-F])";
const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
// A lower-case DNS name whose last label starts with a letter, so never an IP address.
const HOST = `(?:${LABEL}[.])*[a-z](?:[a-z0-9-]*[a-z0-9])?`;
const PATH = `(?:[A-Za-z0-9._~!$&'()*+,;=:@/-]|${PCT_ENCODED})*`;
// Without the apostrophe, which a WHATWG URL parser percent-encodes in an https query.
const QUERY = `(?:[A-Za-z0-9._~!$&()*+,;=:@/?-]|${PCT_ENCODED})+`;
const SEND_URL = new RegExp(`^https:[/][/]${HOST}(?::[1-9][0-9]{0,4})?[/]${PATH}(?:[?]${QUERY})?$`);

// What the pattern can't state: no dot segment, no explicit 443 or port past 65535, and nothing a
// WHATWG URL parser, as fetch uses, would rewrite.
function isCanonicalUrl(url: string): boolean {
	const authority = url.slice("https://".length).split("/", 1)[0] ?? "";
	const port = authority.split(":")[1];
	if (port !== undefined && (port === "443" || Number(port) > 65_535)) return false;
	const path = url.slice("https://".length + authority.length).split("?", 1)[0] ?? "";
	if (path.split("/").some((segment) => segment === "." || segment === "..")) return false;
	try {
		return new URL(url).href === url;
	} catch {
		return false;
	}
}

// The hub-rendered URL in its one canonical form, so the request reaches exactly what it names.
export const SendUrl: z.ZodString = z
	.string()
	.max(8_192)
	.regex(SEND_URL)
	.refine(isCanonicalUrl, { message: "not canonical" })
	.meta({
		description:
			"A canonical https URL: a lower-case DNS host, no userinfo, no port 443, no dot " +
			"segments, percent-encoding in upper-case hex and never of an unreserved character, " +
			"and no fragment.",
	});

export const ContentType: z.ZodString = z
	.string()
	.min(1)
	.max(256)
	.regex(/^[!-~](?:[ -~]*[!-~])?$/)
	.meta({ description: "A Content-Type value: visible ASCII, spaces only between characters." });

export interface SendTicket {
	readonly id: string;
	readonly outboxId: string;
	readonly instanceId: string;
	readonly method: SendMethod;
	readonly url: string;
	readonly headersSha256: string;
	readonly contentType: string;
	readonly bodySha256: string;
	readonly exp: number;
}

export const SendTicket: z.ZodType<SendTicket> = z
	.strictObject({
		id: Ulid,
		outboxId: Ulid,
		instanceId: Ulid,
		method: SendMethod,
		url: SendUrl,
		headersSha256: Sha256Hex,
		contentType: ContentType,
		bodySha256: Sha256Hex,
		exp: UtcMs,
	})
	.meta({
		title: "SendTicket",
		description: "A one-shot broker ticket for one hub-rendered send request.",
	});

// What the broker holds when a plugin's send-class request arrives.
export interface TicketedRequest {
	// The ticket as the plugin presented it, if it did.
	readonly ticket: unknown;
	// The calling plugin instance (§4 Egress broker, step 1).
	readonly instanceId: string;
	readonly method: string;
	readonly url: string;
	// The Content-Type the plugin gave; the broker drops it with every other plugin header.
	readonly contentType: string;
	// The hub-rendered headers, the only ones the broker sends besides the credential.
	readonly headers: HeaderList;
	readonly body: Uint8Array;
}

// The id the broker looks the minted ticket up by, among those it hasn't burned.
export function presentedTicketId(presented: unknown): string | undefined {
	const id =
		typeof presented === "object" && presented !== null
			? (presented as { id?: unknown }).id
			: undefined;
	return typeof id === "string" ? id : undefined;
}

// In the order they are checked, so every implementation names the same first failure.
export const TICKET_CHECKS = [
	"TICKET_UNKNOWN",
	"TICKET_INVALID",
	"TICKET_ALTERED",
	"TICKET_EXPIRED",
	"TICKET_INSTANCE_MISMATCH",
	"TICKET_METHOD_MISMATCH",
	"TICKET_URL_MISMATCH",
	"TICKET_CONTENT_TYPE_MISMATCH",
	"TICKET_HEADERS_MISMATCH",
	"TICKET_BODY_MISMATCH",
] as const;
export type TicketMismatch = (typeof TICKET_CHECKS)[number];

// What the plugin did, which also disables it and alerts devices. Expiry, and a ticket or headers
// the hub got wrong, fail the request alone.
const notThePlugins: readonly string[] = [
	"TICKET_INVALID",
	"TICKET_EXPIRED",
	"TICKET_HEADERS_MISMATCH",
];
export const TICKET_DISABLES_PLUGIN: readonly TicketMismatch[] = TICKET_CHECKS.filter(
	(code) => !notThePlugins.includes(code),
);

function sameJson(a: unknown, b: unknown): boolean {
	try {
		return canonicalize(a) === canonicalize(b);
	} catch (error) {
		if (error instanceof JcsError) return false;
		throw error;
	}
}

// The rendered headers hash to the ticket's headersSha256 and carry its content type exactly once.
function headersMatch(ticket: SendTicket, headers: HeaderList): boolean {
	try {
		if (headersSha256(headers) !== ticket.headersSha256) return false;
	} catch {
		return false;
	}
	const types = headers.filter(([name]) => name.toLowerCase() === "content-type");
	return types.length === 1 && types[0]?.[1] === ticket.contentType;
}

// Why `request` doesn't match `minted`, the unburned ticket the broker found by the presented id
// (undefined when it found none), at `now` (UTC ms); undefined when it matches. Either way the
// broker burns a ticket it found.
export function ticketMismatch(
	minted: SendTicket | undefined,
	request: TicketedRequest,
	now: number,
): TicketMismatch | undefined {
	if (minted === undefined) return "TICKET_UNKNOWN";
	if (!SendTicket.safeParse(minted).success || !Number.isSafeInteger(now)) return "TICKET_INVALID";
	if (!sameJson(request.ticket, minted)) return "TICKET_ALTERED";
	if (now > minted.exp) return "TICKET_EXPIRED";
	if (request.instanceId !== minted.instanceId) return "TICKET_INSTANCE_MISMATCH";
	if (request.method !== minted.method) return "TICKET_METHOD_MISMATCH";
	if (request.url !== minted.url) return "TICKET_URL_MISMATCH";
	if (request.contentType !== minted.contentType) return "TICKET_CONTENT_TYPE_MISMATCH";
	if (!headersMatch(minted, request.headers)) return "TICKET_HEADERS_MISMATCH";
	const body = request.body instanceof Uint8Array ? request.body : undefined;
	if (body === undefined || sha256Hex(body) !== minted.bodySha256) return "TICKET_BODY_MISMATCH";
	return undefined;
}

export const ticketMatches = (...args: Parameters<typeof ticketMismatch>): boolean =>
	ticketMismatch(...args) === undefined;
