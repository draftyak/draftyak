import { types } from "node:util";
import type { AccountMode } from "@draftyak/protocol/entities/common";
import type { HeaderList } from "@draftyak/protocol/hash";
import type { ChannelProfile } from "@draftyak/protocol/manifest";
import { TICKET_DISABLES_PLUGIN, type TicketMismatch } from "@draftyak/protocol/send-ticket";
import { SendTicketRefusal } from "../../../outbox/tickets.ts";
import { canonicalChannelUrl } from "./canonical.ts";
import { channelRequestHeaders } from "./headers.ts";
import {
	CHANNEL_METHODS,
	type ChannelMethod,
	type ChannelRequestClass,
	channelQueryDenial,
	classifyChannelRequest,
	PROFILE_CLASSES,
} from "./profiles.ts";

const DENIAL_CODES = [
	"method_invalid",
	"url_invalid",
	"off_profile",
	"gmail_batch",
	"slack_scheduling",
	"hub_only",
	"system_parameter",
	"query_credential",
	"headers_invalid",
	"method_override",
	"account_read_only",
	"ticket_missing",
	"ticket_off_profile",
	"ticket_unknown",
	"ticket_invalid",
	"ticket_altered",
	"ticket_expired",
	"ticket_instance_mismatch",
	"ticket_method_mismatch",
	"ticket_url_mismatch",
	"ticket_content_type_mismatch",
	"ticket_headers_mismatch",
	"ticket_body_mismatch",
	"ticket_state_changed",
	"ticket_unavailable",
] as const;
export type ChannelDenialCode = (typeof DENIAL_CODES)[number];
export const CHANNEL_DENIAL_CODES: readonly ChannelDenialCode[] = Object.freeze(DENIAL_CODES);

/** Why SendTicketLedger.redeem refused a presented ticket; UNAVAILABLE for any other failure. */
export type ChannelTicketReason = TicketMismatch | "SEND_STATE_CHANGED" | "UNAVAILABLE";
const TICKET_CODES: Readonly<Record<ChannelTicketReason, ChannelDenialCode>> = Object.freeze({
	TICKET_UNKNOWN: "ticket_unknown",
	TICKET_INVALID: "ticket_invalid",
	TICKET_ALTERED: "ticket_altered",
	TICKET_EXPIRED: "ticket_expired",
	TICKET_INSTANCE_MISMATCH: "ticket_instance_mismatch",
	TICKET_METHOD_MISMATCH: "ticket_method_mismatch",
	TICKET_URL_MISMATCH: "ticket_url_mismatch",
	TICKET_CONTENT_TYPE_MISMATCH: "ticket_content_type_mismatch",
	TICKET_HEADERS_MISMATCH: "ticket_headers_mismatch",
	TICKET_BODY_MISMATCH: "ticket_body_mismatch",
	SEND_STATE_CHANGED: "ticket_state_changed",
	UNAVAILABLE: "ticket_unavailable",
});

/** Native facts about the call, never host/fetch data: the reviewed profile and account mode. */
export interface ChannelBinding {
	readonly profile: ChannelProfile;
	readonly accountMode: AccountMode;
}
/** The method, URL and headers the plugin gave host/fetch. The transport checks the body. */
export interface ChannelRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: HeaderList;
}
/** SendTicketLedger.redeem's outcome for a presented ticket; absent when the plugin gave none. */
export type ChannelTicket =
	| { readonly state: "absent" }
	| { readonly state: "redeemed" }
	| { readonly state: "refused"; readonly reason: ChannelTicketReason };
export type ChannelDecision =
	| {
			readonly allowed: true;
			readonly class: ChannelRequestClass;
			readonly method: ChannelMethod;
			readonly url: string;
			/** Plugin headers to forward: none for a ticketed send, which carries the rendered set. */
			readonly headers: HeaderList;
			readonly ticketed: boolean;
	  }
	| {
			readonly allowed: false;
			readonly code: ChannelDenialCode;
			/** The plugin's own doing: its instance is to be disabled and devices alerted. */
			readonly disablePlugin: boolean;
	  };

const invalid = (): TypeError => new TypeError("Channel policy input is invalid");
function plain(value: unknown): object {
	if (value === null || typeof value !== "object" || types.isProxy(value)) throw invalid();
	const prototype: unknown = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw invalid();
	return value;
}
// Each field is read once, as a plain data value, so no getter can answer two checks differently.
function own(source: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(source, key);
	return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}
const deny = (code: ChannelDenialCode, disablePlugin = false): ChannelDecision =>
	Object.freeze({ allowed: false, code, disablePlugin });
const allow = (
	found: ChannelRequestClass,
	method: ChannelMethod,
	url: string,
	headers: HeaderList,
	ticketed: boolean,
): ChannelDecision =>
	Object.freeze({
		allowed: true,
		class: found,
		method,
		url,
		headers: Object.freeze(headers),
		ticketed,
	});

/** The ticket outcome for whatever SendTicketLedger.redeem threw. */
export function refusedChannelTicket(error: unknown): ChannelTicket {
	const reason: unknown = error instanceof SendTicketRefusal ? error.reason : undefined;
	return Object.freeze({
		state: "refused",
		reason:
			typeof reason === "string" && Object.hasOwn(TICKET_CODES, reason)
				? (reason as ChannelTicketReason)
				: "UNAVAILABLE",
	});
}

/**
 * Decides one channel host/fetch request. A presented ticket is redeemed first, as the testkit
 * does, so a refused one decides the answer; then the URL must be canonical and match the profile,
 * a send needs a redeemed ticket, organize and send need a full-mode account, a redeemed send meets
 * the query rule reads and organize met in classification, and an unticketed request forwards only
 * allowlisted headers.
 */
export function decideChannelRequest(
	binding: ChannelBinding,
	request: ChannelRequest,
	ticket: ChannelTicket,
): ChannelDecision {
	const facts = plain(binding),
		outcome = plain(ticket),
		asked = plain(request);
	const profile = own(facts, "profile"),
		mode = own(facts, "accountMode"),
		state = own(outcome, "state"),
		reason = own(outcome, "reason");
	if (
		typeof profile !== "string" ||
		!Object.hasOwn(PROFILE_CLASSES, profile) ||
		(mode !== "full" && mode !== "read_only") ||
		(state !== "absent" && state !== "redeemed" && state !== "refused") ||
		(state === "refused" && (typeof reason !== "string" || !Object.hasOwn(TICKET_CODES, reason)))
	)
		throw invalid();
	const method = own(asked, "method"),
		url = own(asked, "url"),
		headers = own(asked, "headers");
	if (state === "refused") {
		const why = reason as ChannelTicketReason;
		return deny(TICKET_CODES[why], (TICKET_DISABLES_PLUGIN as readonly string[]).includes(why));
	}
	if (typeof method !== "string" || !(CHANNEL_METHODS as readonly string[]).includes(method))
		return deny("method_invalid");
	const canonical = canonicalChannelUrl(url);
	if (!canonical) return deny("url_invalid");
	const channel = profile as ChannelProfile;
	const found = classifyChannelRequest(channel, method as ChannelMethod, canonical);
	if ("denied" in found) return deny(found.denied);
	const ticketed = state === "redeemed",
		permitted = PROFILE_CLASSES[channel].includes(found.class);
	// An unticketed send is the plugin's own doing on every profile, one without sends included.
	if (found.class === "send" && !ticketed) return deny("ticket_missing", true);
	if (ticketed && (found.class !== "send" || !permitted)) return deny("ticket_off_profile");
	if (!permitted) return deny("off_profile");
	if (found.class !== "read" && mode !== "full") return deny("account_read_only");
	if (ticketed) {
		const query = channelQueryDenial(channel, canonical);
		if (query) return deny(query);
		return allow(found.class, method as ChannelMethod, canonical.href, [], true);
	}
	const forwarded = channelRequestHeaders(channel, headers);
	if ("denied" in forwarded) return deny(forwarded.denied);
	return allow(found.class, method as ChannelMethod, canonical.href, forwarded.headers, false);
}
