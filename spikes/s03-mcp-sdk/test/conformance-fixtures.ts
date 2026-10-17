import { randomBytes } from "node:crypto";
import {
	acceptedContent,
	type CallToolResult,
	CLIENT_CAPABILITIES_META_KEY,
	completable,
	createRequestStateCodec,
	fromJsonSchema,
	type InputRequest,
	inputRequired,
	inputResponse,
	type McpServer,
	ResourceTemplate,
	type ServerContext,
} from "@modelcontextprotocol/server";
import * as z from "zod";
import { createMcpServer, type ServerFactory } from "../src/server.ts";

// Fixture names the suites ask for that this profile doesn't serve; conformance-baseline.json
// gives each scenario's reason. Everything this profile does serve, it adds to src/server.ts's
// surface only here (§13: a test profile that release-guard rejects).
export const NOT_SERVED: readonly string[] = [
	"test_tool_with_logging",
	"test_sampling",
	"test_elicitation",
	"test_elicitation_sep1034_defaults",
	"test_elicitation_sep1330_enums",
	"test://watched-resource",
	"test_reconnection",
	"test_trigger_tool_change",
	"test_trigger_prompt_change",
];

// A 1x1 PNG and a 44-byte WAV header with no samples.
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const WAV = "UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=";

type JsonSchema = Parameters<typeof fromJsonSchema>[0];

const JSON_SCHEMA_2020_12 = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	type: "object",
	$defs: {
		address: {
			$anchor: "addressDef",
			type: "object",
			properties: { street: { type: "string" }, city: { type: "string" } },
		},
	},
	properties: {
		name: { type: "string" },
		address: { $ref: "#/$defs/address" },
		contactMethod: { type: "string", enum: ["phone", "email"] },
		phone: { type: "string" },
		email: { type: "string" },
	},
	allOf: [{ anyOf: [{ required: ["phone"] }, { required: ["email"] }] }],
	if: { properties: { contactMethod: { const: "phone" } }, required: ["contactMethod"] },
	// biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword the suite checks for.
	then: { required: ["phone"] },
	else: { required: ["email"] },
	additionalProperties: false,
};

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
const ask = (message: string, field: string, type = "string"): InputRequest =>
	inputRequired.elicit({
		message,
		requestedSchema: {
			type: "object",
			properties: { [field]: { type } },
			required: [field],
		} as never,
	});
const sample = (prompt: string, maxTokens: number): InputRequest =>
	inputRequired.createMessage({
		messages: [{ role: "user", content: { type: "text", text: prompt } }],
		maxTokens,
	});

interface FlowState {
	readonly flow: string;
	readonly round: number;
}

// The request's own declaration (the envelope keeps the reserved keys as they were sent).
function declared(ctx: ServerContext): Record<string, unknown> {
	const envelope = (ctx.mcpReq.envelope ?? {}) as Record<string, unknown>;
	return (envelope[CLIENT_CAPABILITIES_META_KEY] ?? {}) as Record<string, unknown>;
}

function registerContentFixtures(server: McpServer): void {
	const tool = (name: string, run: () => CallToolResult): void => {
		server.registerTool(name, { description: `Conformance fixture ${name}` }, run);
	};
	tool("test_simple_text", () => text("This is a simple text response for testing."));
	tool("test_image_content", () => ({
		content: [{ type: "image", data: PNG, mimeType: "image/png" }],
	}));
	tool("test_audio_content", () => ({
		content: [{ type: "audio", data: WAV, mimeType: "audio/wav" }],
	}));
	tool("test_embedded_resource", () => ({
		content: [
			{
				type: "resource",
				resource: {
					uri: "test://embedded-resource",
					mimeType: "text/plain",
					text: "This is an embedded resource content.",
				},
			},
		],
	}));
	tool("test_multiple_content_types", () => ({
		content: [
			{ type: "text", text: "Multiple content types test:" },
			{ type: "image", data: PNG, mimeType: "image/png" },
			{
				type: "resource",
				resource: {
					uri: "test://mixed-content-resource",
					mimeType: "application/json",
					text: JSON.stringify({ test: "data", value: 123 }),
				},
			},
		],
	}));
	tool("test_error_handling", () => ({
		isError: true,
		content: [{ type: "text", text: "This tool intentionally returns an error for testing" }],
	}));
	tool("test_logging_tool", () => text("logged nothing: the request set no log level"));
	server.registerTool(
		"test_tool_with_progress",
		{ description: "Conformance fixture test_tool_with_progress" },
		async (ctx) => {
			const token = ctx.mcpReq._meta?.progressToken;
			for (const progress of [0, 50, 100]) {
				if (token !== undefined) {
					const params = { progressToken: token, progress, total: 100 };
					await ctx.mcpReq.notify({ method: "notifications/progress", params });
				}
				if (progress < 100) await new Promise((done) => setTimeout(done, 50));
			}
			return text("progress done");
		},
	);
	server.registerTool(
		"json_schema_2020_12_tool",
		{
			description: "Conformance fixture with JSON Schema 2020-12 keywords",
			inputSchema: fromJsonSchema(JSON_SCHEMA_2020_12),
		},
		() => text("schema ok"),
	);
	server.registerTool(
		"test_custom_header",
		{
			description: "Conformance fixture mirroring a parameter into Mcp-Param-Region",
			inputSchema: fromJsonSchema<{ region: string }>({
				type: "object",
				properties: { region: { type: "string", "x-mcp-header": "Region" } },
				required: ["region"],
			} as JsonSchema),
		},
		({ region }) => text(`region ${region}`),
	);
	server.registerResource(
		"static-text",
		"test://static-text",
		{ description: "Static text fixture", mimeType: "text/plain" },
		(uri) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "text/plain",
					text: "This is the content of the static text resource.",
				},
			],
		}),
	);
	server.registerResource(
		"static-binary",
		"test://static-binary",
		{ description: "Static binary fixture", mimeType: "image/png" },
		(uri) => ({ contents: [{ uri: uri.href, mimeType: "image/png", blob: PNG }] }),
	);
	server.registerResource(
		"template-data",
		new ResourceTemplate("test://template/{id}/data", { list: undefined }),
		{ description: "Template fixture", mimeType: "application/json" },
		(uri, { id }) => ({
			contents: [
				{
					uri: uri.href,
					mimeType: "application/json",
					text: JSON.stringify({ id, templateTest: true, data: `Data for ID: ${String(id)}` }),
				},
			],
		}),
	);
	server.registerPrompt("test_simple_prompt", { description: "Simple prompt fixture" }, () => ({
		messages: [
			{ role: "user", content: { type: "text", text: "This is a simple prompt for testing." } },
		],
	}));
	server.registerPrompt(
		"test_prompt_with_arguments",
		{
			description: "Prompt fixture with arguments",
			argsSchema: z.object({
				arg1: completable(z.string().describe("First test argument"), (value) =>
					["paris", "park", "party"].filter((word) => word.startsWith(value)),
				),
				arg2: z.string().describe("Second test argument"),
			}),
		},
		({ arg1, arg2 }) => ({
			messages: [
				{
					role: "user",
					content: { type: "text", text: `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'` },
				},
			],
		}),
	);
	server.registerPrompt(
		"test_prompt_with_embedded_resource",
		{
			description: "Prompt fixture embedding a resource",
			argsSchema: z.object({ resourceUri: z.string().describe("URI of the resource to embed") }),
		},
		({ resourceUri }) => ({
			messages: [
				{
					role: "user",
					content: {
						type: "resource",
						resource: {
							uri: resourceUri,
							mimeType: "text/plain",
							text: "Embedded resource content for testing.",
						},
					},
				},
				{
					role: "user",
					content: { type: "text", text: "Please process the embedded resource above." },
				},
			],
		}),
	);
	server.registerPrompt(
		"test_prompt_with_image",
		{ description: "Prompt fixture with an image" },
		() => ({
			messages: [
				{ role: "user", content: { type: "image", data: PNG, mimeType: "image/png" } },
				{ role: "user", content: { type: "text", text: "Please analyze the image above." } },
			],
		}),
	);
}

function registerMrtrFixtures(
	server: McpServer,
	mint: (state: FlowState) => Promise<string>,
): void {
	const tool = (
		name: string,
		run: (
			ctx: ServerContext,
		) =>
			| CallToolResult
			| ReturnType<typeof inputRequired>
			| Promise<CallToolResult | ReturnType<typeof inputRequired>>,
	): void => {
		server.registerTool(name, { description: `Conformance fixture ${name}` }, run);
	};
	const state = (ctx: ServerContext, flow: string): number =>
		ctx.mcpReq.requestState<FlowState>()?.flow === flow
			? (ctx.mcpReq.requestState<FlowState>()?.round ?? 0)
			: 0;
	tool("test_input_required_result_elicitation", (ctx) => {
		const answer = acceptedContent(ctx.mcpReq.inputResponses, "user_name");
		if (typeof answer?.name === "string") return text(`Hello, ${answer.name}!`);
		return inputRequired({ inputRequests: { user_name: ask("What is your name?", "name") } });
	});
	tool("test_input_required_result_sampling", (ctx) => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "capital_question");
		if (view.kind === "sampling") return text(`Sampled: ${JSON.stringify(view.result.content)}`);
		return inputRequired({
			inputRequests: { capital_question: sample("What is the capital of France?", 100) },
		});
	});
	tool("test_input_required_result_list_roots", (ctx) => {
		const view = inputResponse(ctx.mcpReq.inputResponses, "client_roots");
		if (view.kind === "roots")
			return text(`Roots: ${view.roots.map((root) => root.uri).join(", ")}`);
		return inputRequired({ inputRequests: { client_roots: inputRequired.listRoots() } });
	});
	tool("test_input_required_result_request_state", async (ctx) => {
		const confirmed = acceptedContent(ctx.mcpReq.inputResponses, "confirm");
		if (state(ctx, "request_state") === 1 && confirmed !== undefined) return text("state-ok");
		return inputRequired({
			inputRequests: { confirm: ask("Please confirm", "ok", "boolean") },
			requestState: await mint({ flow: "request_state", round: 1 }),
		});
	});
	tool("test_input_required_result_multiple_inputs", async (ctx) => {
		const responses = ctx.mcpReq.inputResponses;
		const answered =
			acceptedContent(responses, "user_name") !== undefined &&
			inputResponse(responses, "greeting").kind === "sampling" &&
			inputResponse(responses, "client_roots").kind === "roots";
		if (state(ctx, "multiple") === 1 && answered) return text("all inputs received");
		return inputRequired({
			inputRequests: {
				user_name: ask("What is your name?", "name"),
				greeting: sample("Generate a greeting", 50),
				client_roots: inputRequired.listRoots(),
			},
			requestState: await mint({ flow: "multiple", round: 1 }),
		});
	});
	tool("test_input_required_result_multi_round", async (ctx) => {
		const round = state(ctx, "multi_round");
		const responses = ctx.mcpReq.inputResponses;
		if (round === 2 && acceptedContent(responses, "step2") !== undefined)
			return text("both steps done");
		if (round === 1 && acceptedContent(responses, "step1") !== undefined) {
			return inputRequired({
				inputRequests: { step2: ask("Step 2: What is your favorite color?", "color") },
				requestState: await mint({ flow: "multi_round", round: 2 }),
			});
		}
		return inputRequired({
			inputRequests: { step1: ask("Step 1: What is your name?", "name") },
			requestState: await mint({ flow: "multi_round", round: 1 }),
		});
	});
	tool("test_input_required_result_tampered_state", async (ctx) => {
		if (state(ctx, "tampered") === 1) return text("state verified");
		return inputRequired({
			inputRequests: { confirm: ask("Please confirm", "ok", "boolean") },
			requestState: await mint({ flow: "tampered", round: 1 }),
		});
	});
	tool("test_input_required_result_capabilities", (ctx) => {
		const capabilities = declared(ctx);
		const requests: Record<string, InputRequest> = {};
		if (capabilities.sampling) requests.question = sample("Say hello", 20);
		if (capabilities.elicitation) requests.confirm = ask("Please confirm", "ok", "boolean");
		const responses = ctx.mcpReq.inputResponses ?? {};
		if (
			Object.keys(requests).length === 0 ||
			Object.keys(requests).every((key) => key in responses)
		) {
			return text("capabilities respected");
		}
		return inputRequired({ inputRequests: requests });
	});
	tool("test_missing_capability", () =>
		inputRequired({ inputRequests: { question: sample("Needs sampling", 10) } }),
	);
	tool("test_streaming_elicitation", () =>
		inputRequired({ inputRequests: { confirm: ask("Continue?", "ok", "boolean") } }),
	);
	server.registerPrompt(
		"test_input_required_result_prompt",
		{ description: "Prompt fixture that needs elicitation" },
		(ctx) => {
			const answer = acceptedContent(ctx.mcpReq.inputResponses, "user_context");
			if (typeof answer?.context === "string") {
				return {
					messages: [
						{ role: "user", content: { type: "text", text: `Context: ${answer.context}` } },
					],
				};
			}
			return inputRequired({
				inputRequests: { user_context: ask("What context should the prompt use?", "context") },
			});
		},
	);
}

// The production factory plus every fixture, with an HMAC requestState codec for the MRTR flows.
export function conformanceFactory(): ServerFactory {
	const codec = createRequestStateCodec<FlowState>({ key: randomBytes(32) });
	return () => {
		const server = createMcpServer({ requestState: { verify: codec.verify } });
		registerContentFixtures(server);
		registerMrtrFixtures(server, (state) => codec.mint(state));
		return server;
	};
}
