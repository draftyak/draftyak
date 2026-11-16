// The channel request policy for gmail-v1, gmail-readonly-v1 and slack-v1. It decides and audits;
// it binds no caller, redeems no ticket, disables no plugin and opens no connection itself.
export { auditChannelDenial, type ChannelCaller } from "./audit.ts";
export { type ChannelUrl, canonicalChannelUrl } from "./canonical.ts";
export {
	CHANNEL_DENIAL_CODES,
	type ChannelBinding,
	type ChannelDecision,
	type ChannelDenialCode,
	type ChannelRequest,
	type ChannelTicket,
	type ChannelTicketReason,
	decideChannelRequest,
	refusedChannelTicket,
} from "./decision.ts";
export {
	CHANNEL_REQUEST_HEADERS,
	type ChannelHeaderDenial,
	type ChannelHeaders,
	channelRequestHeaders,
	METHOD_OVERRIDE_HEADERS,
} from "./headers.ts";
export {
	CHANNEL_METHODS,
	type ChannelClassDenial,
	type ChannelClassification,
	type ChannelMethod,
	type ChannelRequestClass,
	classifyChannelRequest,
	PROFILE_CLASSES,
} from "./profiles.ts";
