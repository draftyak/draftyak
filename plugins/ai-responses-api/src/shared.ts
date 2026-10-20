export type ResponsesErrorCode =
	| "INVALID_INPUT"
	| "INVALID_RESPONSE"
	| "TRANSPORT_FAILED"
	| "ABORTED";
export class ResponsesError extends Error {
	readonly code: ResponsesErrorCode;
	constructor(code: ResponsesErrorCode) {
		super(`responses: ${code}`);
		this.name = "ResponsesError";
		this.code = code;
	}
}
export const record = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
