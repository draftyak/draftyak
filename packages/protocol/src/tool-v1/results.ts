import { PluginErrorResult } from "../errors.ts";
import { canonicalize, JcsError, parseStrict } from "../jcs.ts";
import {
	type CanonicalTool,
	type CanonicalToolName,
	canonicalToolsV1,
	type ToolResultsV1,
} from "./kinds.ts";

export const TOOL_FRAME_MAX_BYTES = 65_536;

export type ToolFrame =
	| { readonly status: "ok"; readonly message: unknown }
	| { readonly status: "dropped"; readonly reason: "TOOL_FRAME_TOO_LARGE" | "TOOL_FRAME_INVALID" };

// The bytes of the frame's line terminator, LF or CR LF, if it ends in one.
function terminator(frame: string | Uint8Array): number {
	const last = (back: number): number | undefined =>
		typeof frame === "string" ? frame.charCodeAt(frame.length - back) : frame[frame.length - back];
	if (last(1) !== 0x0a) return 0;
	return last(2) === 0x0d ? 2 : 1;
}

// One message from a tool plugin, one line of its stdout: over 64 KiB without its line terminator it
// is dropped unparsed; otherwise parsed strictly.
export function parseToolFrame(frame: string | Uint8Array): ToolFrame {
	// UTF-16 length is a lower bound on UTF-8 bytes; at most two terminator bytes are excluded.
	if (typeof frame === "string" && frame.length > TOOL_FRAME_MAX_BYTES + 2) {
		return { status: "dropped", reason: "TOOL_FRAME_TOO_LARGE" };
	}
	const bytes = typeof frame === "string" ? Buffer.byteLength(frame, "utf8") : frame.byteLength;
	if (bytes - terminator(frame) > TOOL_FRAME_MAX_BYTES) {
		return { status: "dropped", reason: "TOOL_FRAME_TOO_LARGE" };
	}
	try {
		return { status: "ok", message: parseStrict(frame) };
	} catch (error) {
		if (error instanceof JcsError) return { status: "dropped", reason: "TOOL_FRAME_INVALID" };
		throw error;
	}
}

// Where an error result carries its PluginErrorResult, so structuredContent, when present, always
// matches the tool's outputSchema.
export const TOOL_ERROR_META_KEY = "io.github.draftyak/error";

export type ToolResultRefusal =
	| "TOOL_RESULT_INVALID"
	| "TOOL_RESULT_INPUT_REQUIRED"
	| "TOOL_RESULT_CONTENT"
	| "TOOL_RESULT_OFF_SCHEMA"
	| "TOOL_RESULT_TOO_LARGE";

export type ToolResultOutcome<T> =
	| { readonly status: "ok"; readonly value: T; readonly bytes: number }
	| { readonly status: "error"; readonly error: PluginErrorResult }
	| { readonly status: "refused"; readonly refusal: ToolResultRefusal };

export interface ToolResultOptions {
	// The manifest's output.maxBytes; the tool's ceiling applies whenever it is lower.
	readonly maxBytes?: number;
	// The result as an MCP client library returns it, without resultType and with content
	// defaulted, rather than exactly as the plugin sent it.
	readonly decoded?: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (block: unknown): boolean =>
	isRecord(block) && block.type === "text" && typeof block.text === "string";

function jcsBytes(value: unknown): number | undefined {
	try {
		return Buffer.byteLength(canonicalize(value), "utf8");
	} catch (error) {
		if (error instanceof JcsError) return undefined;
		throw error;
	}
}

// A tools/call result: resultType "complete" and content, which may hold text blocks only and is
// ignored. Only structuredContent is used, at most min(the tool's ceiling, maxBytes) bytes of
// canonical JSON and never truncated; an error carries its PluginErrorResult in _meta instead.
export function checkToolResult<N extends CanonicalToolName>(
	name: N,
	result: unknown,
	options: ToolResultOptions = {},
): ToolResultOutcome<ToolResultsV1[N]> {
	if (!Object.hasOwn(canonicalToolsV1, name)) throw new TypeError(`unknown tool: ${name}`);
	const tool = canonicalToolsV1[name] as CanonicalTool<N>;
	const { maxBytes = tool.maxBytes, decoded = false } = options;
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
		throw new RangeError(`maxBytes must be a whole number of bytes: ${maxBytes}`);
	}
	const refuse = (refusal: ToolResultRefusal) => ({ status: "refused", refusal }) as const;
	if (!isRecord(result)) return refuse("TOOL_RESULT_INVALID");
	const {
		resultType = decoded ? "complete" : undefined,
		content = decoded ? [] : undefined,
		isError = false,
		structuredContent,
		_meta,
	} = result;
	if (resultType === "input_required") return refuse("TOOL_RESULT_INPUT_REQUIRED");
	if (resultType !== "complete") return refuse("TOOL_RESULT_INVALID");
	if (!Array.isArray(content) || typeof isError !== "boolean") return refuse("TOOL_RESULT_INVALID");
	if (!content.every(isText)) return refuse("TOOL_RESULT_CONTENT");
	if (isError) {
		const error = isRecord(_meta) ? _meta[TOOL_ERROR_META_KEY] : undefined;
		const parsed = PluginErrorResult.safeParse(error);
		return parsed.success && structuredContent === undefined
			? { status: "error", error: parsed.data }
			: refuse("TOOL_RESULT_OFF_SCHEMA");
	}
	const bytes = isRecord(structuredContent) ? jcsBytes(structuredContent) : undefined;
	if (bytes === undefined) return refuse("TOOL_RESULT_OFF_SCHEMA");
	if (bytes > Math.min(tool.maxBytes, maxBytes)) {
		return refuse("TOOL_RESULT_TOO_LARGE");
	}
	const parsed = tool.result.safeParse(structuredContent);
	return parsed.success
		? { status: "ok", value: parsed.data, bytes }
		: refuse("TOOL_RESULT_OFF_SCHEMA");
}
