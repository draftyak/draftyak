import { headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import {
	boolean,
	channelId,
	data,
	hasControls,
	invalid,
	keys,
	slackTimestamp,
	text,
} from "./validation.ts";

export const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
export const MAX_TEXT_CHARACTERS = 40_000;
export const MAX_REQUEST_BYTES = 131_072;

export interface SlackPostMessage {
	readonly channel: string;
	readonly thread_ts?: string;
	readonly text: string;
	readonly unfurl_links: false;
	readonly unfurl_media: false;
	readonly reply_broadcast: boolean;
}

export interface SlackRenderedRequest {
	readonly method: "POST";
	readonly url: typeof SLACK_POST_MESSAGE_URL;
	readonly contentType: "application/json";
	readonly headers: readonly (readonly [string, string])[];
	readonly body: string;
	readonly bodySha256: string;
	readonly headersSha256: string;
}

export function renderSlackPostMessage(input: unknown): SlackPostMessage {
	const value = data(input);
	keys(value, ["channelId", "threadTs", "broadcast", "text", "origin"]);
	const channel = channelId(value.channelId);
	const thread =
		value.threadTs === undefined || value.threadTs === null
			? undefined
			: slackTimestamp(value.threadTs);
	const broadcast = value.broadcast === undefined ? false : boolean(value.broadcast);
	if (broadcast && thread === undefined) invalid();
	if (value.origin !== "owner" && value.origin !== "machine" && value.origin !== "mcp") invalid();
	const source = text(value.text, MAX_TEXT_CHARACTERS * 2);
	if (!source.trim() || hasControls(source, true) || source.normalize("NFC") !== source) invalid();
	const rendered =
		value.origin === "owner"
			? source
			: source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	if ([...rendered].length > MAX_TEXT_CHARACTERS) invalid("TEXT_TOO_LONG");
	const payload: SlackPostMessage = {
		channel,
		...(thread === undefined ? {} : { thread_ts: thread }),
		text: rendered,
		unfurl_links: false,
		unfurl_media: false,
		reply_broadcast: broadcast,
	};
	if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > MAX_REQUEST_BYTES)
		invalid("REQUEST_TOO_LARGE");
	return Object.freeze(payload);
}

export function renderSlackRequest(input: unknown): SlackRenderedRequest {
	const body = JSON.stringify(renderSlackPostMessage(input));
	const headers: readonly (readonly [string, string])[] = Object.freeze([
		Object.freeze(["content-type", "application/json"] as const),
	]);
	return Object.freeze({
		method: "POST",
		url: SLACK_POST_MESSAGE_URL,
		contentType: "application/json",
		headers,
		body,
		bodySha256: sha256Hex(body),
		headersSha256: headersSha256(headers),
	});
}
