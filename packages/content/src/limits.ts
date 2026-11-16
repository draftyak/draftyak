export const MAX_TEXT_BYTES = 1_048_576;
// Match the shared MIME renderer's raw-message ceiling, including base64 overhead.
export const MAX_MAIL_BYTES: number = 35 * 1_048_576;
export const MAX_TEXT_CHARS = 40_000;

export type ContentErrorCode =
	| "INPUT_LIMIT"
	| "OUTPUT_LIMIT"
	| "STRUCTURE_LIMIT"
	| "INVALID_INPUT"
	| "TIMEOUT"
	| "STARTUP_TIMEOUT"
	| "ABORTED"
	| "BUSY"
	| "WORKER_FAILED";

const MESSAGES: Readonly<Record<ContentErrorCode, string>> = {
	INPUT_LIMIT: "Content exceeds the input limit.",
	OUTPUT_LIMIT: "Content exceeds the output limit.",
	STRUCTURE_LIMIT: "Content exceeds the structure limit.",
	INVALID_INPUT: "Content is invalid.",
	TIMEOUT: "Content processing timed out.",
	STARTUP_TIMEOUT: "Content worker startup timed out.",
	ABORTED: "Content processing was cancelled.",
	BUSY: "Content processing is busy.",
	WORKER_FAILED: "Content processing failed.",
};

export class ContentError extends Error {
	readonly code: ContentErrorCode;
	constructor(code: ContentErrorCode, _message?: string) {
		super(MESSAGES[code]);
		this.name = "ContentError";
		this.code = code;
	}
}

export function contentErrorCode(value: unknown): ContentErrorCode | undefined {
	return typeof value === "string" && Object.hasOwn(MESSAGES, value)
		? (value as ContentErrorCode)
		: undefined;
}

export function boundedText(
	value: unknown,
	maximum: number = MAX_TEXT_BYTES,
): asserts value is string {
	if (typeof value !== "string" || !value.isWellFormed()) throw new ContentError("INVALID_INPUT");
	if (Buffer.byteLength(value, "utf8") > maximum) throw new ContentError("INPUT_LIMIT");
}
