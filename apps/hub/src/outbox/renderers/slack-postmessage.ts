import { isProxy } from "node:util/types";
import { DraftAuthor } from "@draftyak/protocol/entities/draft";
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
} from "../../channels/slack/validation.ts";

export const SLACK_POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";
export const MAX_TEXT_CHARACTERS = 40_000;
export const MAX_REQUEST_BYTES = 131_072;

const authorKinds: ReadonlySet<string> = new Set(DraftAuthor.shape.kind.options);
// SendSnapshotV1.source.authors admits at most 100 authors.
const MAX_AUTHORS = 100;

function ownerOnlyAuthors(value: unknown): boolean {
	if (
		!value ||
		typeof value !== "object" ||
		isProxy(value) ||
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype
	)
		invalid();
	if (
		value.length === 0 ||
		value.length > MAX_AUTHORS ||
		Reflect.ownKeys(value).length !== value.length + 1
	)
		invalid();
	let ownerOnly = true;
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (
			!descriptor ||
			!("value" in descriptor) ||
			!descriptor.enumerable ||
			typeof descriptor.value !== "string" ||
			!authorKinds.has(descriptor.value)
		)
			invalid();
		if (descriptor.value !== "owner") ownerOnly = false;
	}
	return ownerOnly;
}

export interface SlackPostMessage {
	readonly channel: string;
	readonly thread_ts?: string;
	readonly text: string;
	readonly unfurl_links: false;
	readonly unfurl_media: false;
	readonly reply_broadcast?: true;
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
	keys(value, ["channelId", "threadTs", "broadcast", "text", "footer", "authors"]);
	const channel = channelId(value.channelId);
	const thread =
		value.threadTs === undefined || value.threadTs === null
			? undefined
			: slackTimestamp(value.threadTs);
	const broadcast = boolean(value.broadcast);
	if (broadcast && thread === undefined) invalid();
	const ownerOnly = ownerOnlyAuthors(value.authors);
	const source = text(value.text, MAX_TEXT_CHARACTERS * 2);
	const footer = text(value.footer, MAX_TEXT_CHARACTERS * 2);
	if (!source.trim() || hasControls(source, true) || source.normalize("NFC") !== source) invalid();
	if (hasControls(footer, true) || footer.normalize("NFC") !== footer) invalid();
	const renderedBody = ownerOnly
		? source
		: source.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	const rendered =
		footer === ""
			? renderedBody
			: `${renderedBody}\n${footer.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}`;
	if ([...rendered].length > MAX_TEXT_CHARACTERS) invalid("TEXT_TOO_LONG");
	const payload: SlackPostMessage = {
		channel,
		...(thread === undefined ? {} : { thread_ts: thread }),
		text: rendered,
		unfurl_links: false,
		unfurl_media: false,
		...(broadcast ? { reply_broadcast: true as const } : {}),
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
