export interface Mailbox {
	readonly address: string;
	readonly name?: string;
}

export interface Attachment {
	readonly filename: string;
	readonly contentType: string;
	readonly content: Uint8Array;
}

export interface MimeInput {
	readonly from: Mailbox;
	readonly to: readonly Mailbox[];
	readonly cc?: readonly Mailbox[];
	readonly bcc?: readonly Mailbox[];
	readonly subject: string;
	readonly text: string;
	readonly inReplyTo?: string;
	readonly references?: readonly string[];
	readonly list?: Readonly<Partial<Record<ListHeader, string>>>;
	readonly attachments?: readonly Attachment[];
}

export interface ClaimStamp {
	readonly messageId: string;
	readonly dateMs: number;
	readonly mimeBoundary: string;
	readonly uploadBoundary: string;
}

export interface RenderedMime {
	readonly raw: Buffer;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly subject: string;
	readonly textSha256: string;
}

export type ListHeader =
	| "archive"
	| "help"
	| "id"
	| "owner"
	| "post"
	| "subscribe"
	| "unsubscribe"
	| "unsubscribe-post";

export const MAX_BYTES = 36_700_160;
export const MAX_RECIPIENTS = 500;
export const MAX_ATTACHMENTS = 100;
export const MAX_REFERENCES = 1000;
export const MAX_LINE_BYTES = 998;
export const MAX_HEADER_INPUT_BYTES = 16_384;

export type MimeErrorCode =
	| "BAD_INPUT"
	| "BCC_UNAVAILABLE"
	| "HEADER_CRLF"
	| "HEADER_CONTROL"
	| "HEADER_UNICODE"
	| "BAD_ADDRESS"
	| "BAD_MESSAGE_ID"
	| "BAD_LIST_HEADER"
	| "BAD_ATTACHMENT"
	| "BAD_STAMP"
	| "BAD_THREAD_ID"
	| "BOUNDARY_COLLISION"
	| "NO_RECIPIENTS"
	| "TOO_MANY_RECIPIENTS"
	| "TOO_MANY_ATTACHMENTS"
	| "TOO_MANY_REFERENCES"
	| "TOO_LARGE"
	| "LINE_TOO_LONG"
	| "COMPOSE_FAILED";

export class MimeError extends Error {
	readonly code: MimeErrorCode;
	constructor(code: MimeErrorCode) {
		super(`gmail: ${code}`);
		this.name = "MimeError";
		this.code = code;
	}
}
