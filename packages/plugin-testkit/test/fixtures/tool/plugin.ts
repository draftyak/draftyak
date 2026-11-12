import { toolExtensionDeclaration, type ToolEgressRule } from "@draftyak/protocol/tool-v1";
import type { PluginTool } from "@draftyak/sdk";
import * as z from "zod";
import type { MockPlugin } from "../../../src/index.ts";

export function toolFixture(handler?: PluginTool["handler"], options: { readonly maxBytes?: number; readonly timeoutMs?: number; readonly outputMaxBytes?: number; readonly rules?: readonly ToolEgressRule[] } = {}): MockPlugin {
	return {
		manifest: {
			id: "@example/mock-tool", version: "1.0.0", kind: "tool", sdk: "1.0.0", runtime: "node", isolation: "standard",
			contract: { extension: "io.github.draftyak/tool", version: 1 }, auth: { kind: "url-secret", scopes: [], requiredGrantedScopes: [] }, credentials: { mode: "brokered", urlSecrets: [{ name: "calendarUrl", label: "Calendar", help: "Synthetic fixture address" }] }, permissions: {}, dataClasses: ["tool.kb.lookup"], license: "Apache-2.0",
			egress: { rules: options.rules ?? [{ class: "read", method: "GET", url: "secret://calendarUrl", maxBytes: options.maxBytes ?? 32 * 1024 ** 2, timeoutMs: options.timeoutMs ?? 15_000 }] },
			tool: { kinds: [{ kind: "kb.lookup", inputs: ["topic"], output: { dataClass: "tool.kb.lookup", maxBytes: options.outputMaxBytes ?? 4096 } }] },
		},
		entry: { name: "mock-tool", version: "1.0.0", plugin: "@example/mock-tool", extensions: { "io.github.draftyak/tool": toolExtensionDeclaration }, tools: [{ name: "kb.lookup", inputSchema: z.strictObject({ topic: z.string() }), handler: handler ?? (async (_input, context) => {
			const response = await context.fetch("secret://calendarUrl");
			const bytes = new Uint8Array(await response.arrayBuffer());
			return { entries: [{ label: "bytes", text: String(bytes.length) }, { label: "headers", text: [...response.headers.keys()].join(",") }] };
		}) }] },
	};
}
export const plugin: MockPlugin = toolFixture();
