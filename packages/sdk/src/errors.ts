import { type PluginErrorCode, PluginErrorResult } from "@draftyak/protocol/errors";
import { TOOL_ERROR_META_KEY } from "@draftyak/protocol/tool-v1";
import type { CallToolResult } from "@modelcontextprotocol/server";

export class PluginError extends Error {
	readonly result: PluginErrorResult;
	constructor(
		code: PluginErrorCode,
		options: { readonly retryAfterMs?: number; readonly detail?: string } = {},
	) {
		super(code);
		this.name = "PluginError";
		this.result = PluginErrorResult.parse({ code, ...options });
	}
}
export function pluginErrorResult(
	error: unknown,
	envelope: "structured" | "tool" = "structured",
): CallToolResult {
	const result = error instanceof PluginError ? error.result : { code: "TRANSIENT" as const };
	return {
		isError: true,
		...(envelope === "tool"
			? { _meta: { [TOOL_ERROR_META_KEY]: result } }
			: { structuredContent: result }),
		content: [{ type: "text", text: JSON.stringify(result) }],
	};
}
