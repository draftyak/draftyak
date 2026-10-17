// A template MCP plugin over stdio, run under the hub's production flags (plan §4 Validators): zod in
// jitless mode, and the cf-worker JSON Schema validator for the server (jsonSchemaValidator) and for
// the JSON-Schema tool, so neither validator needs code generation from strings. S2b bundles it with
// link-free copies of @modelcontextprotocol/server, @modelcontextprotocol/core and zod.
import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import * as z from "zod";

z.config({ jitless: true });

const validator = new CfWorkerJsonSchemaValidator();
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

const countInput = fromJsonSchema(
	{
		type: "object",
		properties: { text: { type: "string", maxLength: 4096 } },
		required: ["text"],
		additionalProperties: false,
	},
	validator,
);
const countOutput = fromJsonSchema(
	{
		type: "object",
		properties: { chars: { type: "integer", minimum: 0 } },
		required: ["chars"],
		additionalProperties: false,
	},
	validator,
);

serveStdio(
	() => {
		const server = new McpServer(
			{ name: "draftyak-template-plugin", version: "0.0.0" },
			{ capabilities: { tools: { listChanged: false } }, jsonSchemaValidator: validator },
		);
		server.registerTool(
			"echo",
			{
				title: "Echo",
				description: "Returns its text argument unchanged (fake data).",
				inputSchema: z.object({ text: z.string().max(4096) }),
				outputSchema: z.object({ text: z.string(), length: z.number().int().min(0) }),
				annotations,
			},
			(args) => ({
				content: [{ type: "text", text: args.text }],
				structuredContent: { text: args.text, length: args.text.length },
			}),
		);
		server.registerTool(
			"count",
			{
				title: "Count",
				description: "Counts the code points in its text argument (fake data).",
				inputSchema: countInput,
				outputSchema: countOutput,
				annotations,
			},
			(args) => {
				const chars = [...args.text].length;
				return { content: [{ type: "text", text: String(chars) }], structuredContent: { chars } };
			},
		);
		return server;
	},
	// Plugins speak the 2026 era only (plan §4 MCP extension contracts): a legacy opening is refused.
	{ legacy: "reject" },
);
