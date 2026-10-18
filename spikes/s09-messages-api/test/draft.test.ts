import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecordedRequest } from "../src/client.ts";
import {
	DEFAULT_MODEL,
	DRAFT_EFFORT,
	type DraftParams,
	draft,
	draftCall,
	draftFormat,
	draftOutputSchema,
	parser,
	readDraft,
} from "../src/draft.ts";
import { FALLBACK_BETA } from "../src/verify.ts";
import { message, replies, SAMPLE_DRAFT, type Script } from "./fake-messages-api.ts";
import { failure, type Harness, harness } from "./harness.ts";

const input = {
	system: "Draft a reply in the owner's voice.",
	prompt: "<thread>Can we meet Tuesday?</thread>",
};
const model = DEFAULT_MODEL;
const cutOff = '{"body":"Thanks, Tuesday at 10 wo';

let open: Harness | undefined;
const start = async (options?: Parameters<typeof harness>[0]): Promise<Harness> => {
	open = await harness(options);
	return open;
};
const answer =
	(reply: ReturnType<Script>): Script =>
	() =>
		reply;
const problemsOf = (request: RecordedRequest | undefined): readonly string[] =>
	request?.verdict.ok === false ? request.verdict.problems : [];
const sentBody = (request: RecordedRequest | undefined): Record<string, unknown> => {
	if (typeof request?.body !== "object" || request.body === null)
		throw new Error("no request body");
	return request.body as Record<string, unknown>;
};

afterEach(async () => {
	vi.restoreAllMocks();
	await open?.close();
	open = undefined;
});

describe("the draft request", () => {
	it("is what the SDK sends, it passes the verifier, and the API accepts its schema", async () => {
		const { fake, stub, client } = await start();
		expect(await draft(client, input)).toMatchObject({
			kind: "draft",
			model,
			output: SAMPLE_DRAFT,
		});
		const [sent] = stub.requests;
		expect(sent?.verdict).toEqual({ ok: true });
		expect(Object.keys(sentBody(sent)).sort()).toEqual([
			"fallbacks",
			"max_tokens",
			"messages",
			"model",
			"output_config",
			"system",
		]);
		expect(sent?.body).toMatchObject({
			model: "claude-opus-5-5",
			max_tokens: 16_000,
			fallbacks: "default",
			output_config: { effort: "medium", format: { type: "json_schema" } },
		});
		expect(sent?.headers["anthropic-beta"]).toBe(FALLBACK_BETA);
		expect(fake.received[0]?.body).toEqual(sent?.body);
	});

	it("carries the SDK's schema transform: limits and enums move into descriptions", async () => {
		const { stub, client } = await start();
		await draft(client, input);
		const { schema } = (sentBody(stub.requests[0]).output_config as { format: { schema: object } })
			.format;
		expect(schema).toMatchObject({
			type: "object",
			additionalProperties: false,
			description: expect.stringContaining("$schema"),
			properties: {
				body: { type: "string", description: "{maxLength: 8000}" },
				contextRefs: { type: "array", items: { $ref: expect.stringMatching(/^#\/\$defs\//) } },
			},
		});
		expect(Object.values((schema as { $defs: object }).$defs)).toContainEqual({
			type: "string",
			description: '{enum: ["c1","c2","c3"]}',
		});
	});

	it.each([
		["claude-opus-5-5", true],
		["claude-opus-5", true],
		["claude-sonnet-5-5", true],
		["claude-fable-5-1", true],
		["claude-haiku-5-5", false],
		["claude-opus-4-8", false],
	])("for %s passes the verifier, with fallbacks: %s", async (name, fallbacks) => {
		const { stub, client } = await start();
		expect((await draft(client, { ...input, model: name })).kind).toBe("draft");
		const [sent] = stub.requests;
		expect(sent?.verdict).toEqual({ ok: true });
		expect("fallbacks" in sentBody(sent)).toBe(fallbacks);
		expect(sent?.headers["anthropic-beta"]).toBe(fallbacks ? FALLBACK_BETA : undefined);
	});

	it("needs its beta pinned: the SDK's beta parse adds structured-outputs-2025-12-15", async () => {
		const { fake, stub, client } = await start();
		const params = { ...draftCall(input).params, betas: [FALLBACK_BETA] };
		const error = await failure(client.beta.messages.parse(params));
		expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
		expect(problemsOf(stub.requests[0])).toEqual([
			`header anthropic-beta: value not allowed (${FALLBACK_BETA}, structured-outputs-2025-12-15)`,
		]);
		expect(fake.received).toHaveLength(0);
	});

	it("streams with the same shape, and the final message goes through the same gate", async () => {
		const parse = vi.spyOn(parser, "parse");
		const { stub, client } = await start();
		const { params, headers } = draftCall(input);
		const streamed = await client.beta.messages.stream(params, { headers }).finalMessage();
		expect(readDraft(streamed)).toMatchObject({ kind: "draft", output: SAMPLE_DRAFT });
		expect(stub.requests[0]?.verdict).toEqual({ ok: true });
		expect(stub.requests[0]?.body).toMatchObject({ stream: true });
		expect(stub.requests[0]?.headers["x-stainless-helper-method"]).toBe("stream");
		expect(parse).toHaveBeenCalledTimes(1);
	});

	it("also works through beta.messages.create, which adds no beta and parses nothing itself", async () => {
		const { fake, stub, client } = await start();
		const { params } = draftCall(input);
		const format = { type: "json_schema" as const, schema: draftFormat.schema };
		const call = () =>
			client.beta.messages.create({
				...params,
				output_config: { effort: DRAFT_EFFORT, format },
				betas: [FALLBACK_BETA],
			});
		expect(readDraft(await call())).toMatchObject({ kind: "draft", output: SAMPLE_DRAFT });
		await draft(client, input);
		const [created, parsed] = stub.requests;
		expect(created?.verdict).toEqual({ ok: true });
		expect(created?.headers).toEqual(parsed?.headers);
		expect(created?.body).toEqual(parsed?.body);
		fake.script = answer(replies.truncated(model, cutOff, 16_000));
		expect(readDraft(await call())).toMatchObject({ kind: "truncated", stopReason: "max_tokens" });
	});
});

describe("stop_reason comes before the parser", () => {
	it("a refusal returns its stop_details and is never parsed", async () => {
		const parse = vi.spyOn(parser, "parse");
		const { client } = await start({ script: answer(replies.refusal(model, "cyber")) });
		expect(await draft(client, input)).toEqual({
			kind: "refusal",
			model,
			fallback: false,
			category: "cyber",
			explanation: "This request was declined (cyber).",
			recommendedModel: null,
			usage: { input: 1_200, output: 0 },
		});
		expect(parse).not.toHaveBeenCalled();
	});

	it("a refusal after partial output, or without a category, is never parsed", async () => {
		const parse = vi.spyOn(parser, "parse");
		const { fake, client } = await start({ script: answer(replies.refusal(model, "bio", cutOff)) });
		expect(await draft(client, input)).toMatchObject({ kind: "refusal", category: "bio" });
		fake.script = answer(replies.refusal(model, null));
		expect(await draft(client, input)).toMatchObject({
			kind: "refusal",
			category: null,
			explanation: null,
		});
		expect(parse).not.toHaveBeenCalled();
	});

	it("a streamed refusal is never parsed", async () => {
		const parse = vi.spyOn(parser, "parse");
		const { client } = await start({ script: answer(replies.refusal(model, "cyber", cutOff)) });
		const { params, headers } = draftCall(input);
		const streamed = await client.beta.messages.stream(params, { headers }).finalMessage();
		expect(readDraft(streamed)).toMatchObject({ kind: "refusal", category: "cyber" });
		expect(parse).not.toHaveBeenCalled();
	});

	it("max_tokens truncation is never parsed", async () => {
		const parse = vi.spyOn(parser, "parse");
		const { fake, client } = await start({
			script: answer(replies.truncated(model, cutOff, 16_000)),
		});
		expect(await draft(client, input)).toMatchObject({
			kind: "truncated",
			stopReason: "max_tokens",
			usage: { output: 16_000 },
		});
		const exceeded = message(model, {
			content: [{ type: "text", text: cutOff }],
			stop_reason: "model_context_window_exceeded",
		});
		fake.script = answer({ body: exceeded });
		expect(await draft(client, input)).toMatchObject({
			kind: "truncated",
			stopReason: "model_context_window_exceeded",
		});
		expect(parse).not.toHaveBeenCalled();
	});

	it("is needed: the SDK's own parse throws on a cut-off answer before stop_reason can be read", async () => {
		const { client } = await start({ script: answer(replies.truncated(model, cutOff, 16_000)) });
		const { params, headers } = draftCall(input);
		const standard = {
			...params,
			output_config: {
				effort: params.output_config.effort,
				format: betaZodOutputFormat(draftOutputSchema),
			},
		};
		const error = await failure(client.beta.messages.parse(standard, { headers }));
		expect(error).toBeInstanceOf(Anthropic.AnthropicError);
		expect(String(error)).toMatch(/Failed to parse structured output/);
	});

	it.each(["tool_use", "pause_turn", "stop_sequence", "compaction"])(
		"stop_reason %s is never parsed",
		async (stop) => {
			const parse = vi.spyOn(parser, "parse");
			const body = message(model, {
				content: [{ type: "text", text: JSON.stringify(SAMPLE_DRAFT) }],
				stop_reason: stop,
			});
			const { client } = await start({ script: answer({ body }) });
			expect(await draft(client, input)).toMatchObject({ kind: "unexpected", stopReason: stop });
			expect(parse).not.toHaveBeenCalled();
		},
	);
});

describe("an end_turn answer", () => {
	const chains = [
		["one fallback", [model, "claude-opus-4-8"]],
		["two fallbacks", [model, "claude-sonnet-5-5", "claude-opus-4-8"]],
	] as const;

	it.each(chains)(
		"served after %s is the text after the fallback blocks",
		async (_name, models) => {
			const { client } = await start({ script: answer(replies.fallback(models)) });
			expect(await draft(client, input)).toMatchObject({
				kind: "draft",
				model: "claude-opus-4-8",
				fallback: true,
				output: SAMPLE_DRAFT,
			});
		},
	);

	it.each(chains)("streamed with %s mid-output joins each model's text", async (_name, models) => {
		const { client } = await start({ script: answer(replies.fallback(models)) });
		const { params, headers } = draftCall(input);
		const streamed = await client.beta.messages.stream(params, { headers }).finalMessage();
		expect(streamed.content.map((block) => block.type)).toEqual(
			models.flatMap((_model, index) => (index === 0 ? ["text"] : ["fallback", "text"])),
		);
		expect(readDraft(streamed)).toMatchObject({
			kind: "draft",
			model: "claude-opus-4-8",
			fallback: true,
			output: SAMPLE_DRAFT,
		});
	});

	it.each([
		["an unknown id", ["c1", "c9"], ["c1"]],
		["a differently cased id", ["C2"], ["c2"]],
		["a repeated id", ["c1", "c1", "c1", "c1"], ["c1"]],
		["an id that isn't a string", [1, null, "c3"], ["c3"]],
	])("drops %s from contextRefs and keeps the draft", async (_name, refs, kept) => {
		const output = { ...SAMPLE_DRAFT, contextRefs: refs };
		const { client } = await start({ script: answer(replies.draft(model, output)) });
		expect(await draft(client, input)).toMatchObject({
			kind: "draft",
			output: { ...SAMPLE_DRAFT, contextRefs: kept },
		});
	});

	it("keeps only the job's own context ids", async () => {
		const output = { ...SAMPLE_DRAFT, contextRefs: ["c3", "c1", "c2"] };
		const { client } = await start({ script: answer(replies.draft(model, output)) });
		expect(await draft(client, { ...input, contextIds: ["c1", "c3"] })).toMatchObject({
			kind: "draft",
			output: { ...SAMPLE_DRAFT, contextRefs: ["c1", "c3"] },
		});
		expect(await draft(client, { ...input, contextIds: [] })).toMatchObject({
			kind: "draft",
			output: { ...SAMPLE_DRAFT, contextRefs: [] },
		});
	});

	const { ownerNotes: _dropped, ...withoutNotes } = SAMPLE_DRAFT;
	it.each([
		["a body over its limit", { ...SAMPLE_DRAFT, body: "x".repeat(8_001) }, ["body: too_big"]],
		[
			"too many owner questions",
			{ ...SAMPLE_DRAFT, needsOwnerInput: ["1", "2", "3", "4", "5", "6"] },
			["needsOwnerInput: too_big"],
		],
		[
			"contextRefs that isn't a list",
			{ ...SAMPLE_DRAFT, contextRefs: "c1" },
			["contextRefs: invalid_type"],
		],
		["an extra field", { ...SAMPLE_DRAFT, sendNow: true }, ["output: unrecognized_keys"]],
		["a missing field", withoutNotes, ["ownerNotes: invalid_type"]],
	])("with %s is invalid", async (_name, output, problems) => {
		const { client } = await start({ script: answer(replies.draft(model, output)) });
		expect(await draft(client, input)).toMatchObject({ kind: "invalid", problems });
	});

	it("that isn't JSON, or isn't one text block per model, is invalid without echoing it", async () => {
		const prose = "Sure! Here's a reply for Sam: see you Tuesday.";
		const { fake, client } = await start({ script: answer(replies.text(model, prose)) });
		const result = await draft(client, input);
		expect(result).toMatchObject({ kind: "invalid", problems: ["output: not JSON"] });
		expect(JSON.stringify(result)).not.toContain("Sam");
		const twice = { type: "text", text: JSON.stringify(SAMPLE_DRAFT) };
		fake.script = answer({ body: message(model, { content: [twice, twice] }) });
		expect(await draft(client, input)).toMatchObject({
			kind: "invalid",
			problems: ["output: 2 text blocks"],
		});
		const hop = { type: "fallback", from: { model }, to: { model: "claude-opus-4-8" } };
		fake.script = answer({ body: message(model, { content: [hop, twice, twice] }) });
		expect(await draft(client, input)).toMatchObject({
			kind: "invalid",
			problems: ["output: 2 text blocks"],
		});
		fake.script = answer({ body: message(model, { content: [hop] }) });
		expect(await draft(client, input)).toMatchObject({
			kind: "invalid",
			problems: ["output: 0 text blocks"],
		});
	});
});

describe("injected fields", () => {
	const tool = { name: "submit_draft", input_schema: { type: "object" as const } };
	const injections: [string, (params: DraftParams) => DraftParams][] = [
		["temperature", (params) => ({ ...params, temperature: 0.2 })],
		["top_p", (params) => ({ ...params, top_p: 0.9 })],
		["top_k", (params) => ({ ...params, top_k: 40 })],
		["tool_choice", (params) => ({ ...params, tools: [tool], tool_choice: { type: "any" } })],
		[
			"tool_choice",
			(params) => ({ ...params, tools: [tool], tool_choice: { type: "tool", name: tool.name } }),
		],
		["tools", (params) => ({ ...params, tools: [tool] })],
		["metadata", (params) => ({ ...params, metadata: { user_id: "owner" } })],
		["thinking", (params) => ({ ...params, thinking: { type: "adaptive" } })],
		["stop_sequences", (params) => ({ ...params, stop_sequences: ["END"] })],
		["service_tier", (params) => ({ ...params, service_tier: "auto" })],
		["speed", (params) => ({ ...params, speed: "fast" })],
		["cache_control", (params) => ({ ...params, cache_control: { type: "ephemeral" } })],
		[
			"mcp_servers",
			(params) => ({
				...params,
				mcp_servers: [{ type: "url", url: "https://mcp.example.com", name: "x" }],
			}),
		],
		["context_management", (params) => ({ ...params, context_management: { edits: [] } })],
	];

	it.each(injections)("%s is refused before it leaves", async (field, inject) => {
		const { fake, stub, client } = await start();
		const { params, headers } = draftCall(input);
		const error = await failure(client.beta.messages.parse(inject(params), { headers }));
		expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
		expect(problemsOf(stub.requests[0])).toContain(`body.${field}: not allowed`);
		expect(fake.received).toHaveLength(0);
	});

	it.each([
		[
			"another beta",
			{ "anthropic-beta": `${FALLBACK_BETA},files-api-2025-04-14` },
			"header anthropic-beta: value not allowed",
		],
		[
			"a custom header",
			{ "anthropic-beta": FALLBACK_BETA, "x-draft-note": "1" },
			"header (unknown): not allowed",
		],
		[
			"a bearer token",
			{ "anthropic-beta": FALLBACK_BETA, authorization: "Bearer x" },
			"header authorization: not allowed",
		],
	])("%s is refused before it leaves", async (_name, headers, problem) => {
		const { fake, stub, client } = await start();
		const error = await failure(client.beta.messages.parse(draftCall(input).params, { headers }));
		expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
		expect(problemsOf(stub.requests[0]).some((text) => text.startsWith(problem))).toBe(true);
		expect(fake.received).toHaveLength(0);
	});

	it.each(injections.slice(0, 5))(
		"%s gets the API's 400 when nothing stops it",
		async (field, inject) => {
			const { fake, stub, client } = await start({ passThrough: true });
			const { params, headers } = draftCall(input);
			const error = await failure(client.beta.messages.parse(inject(params), { headers }));
			expect(error).toBeInstanceOf(Anthropic.BadRequestError);
			expect((error as InstanceType<typeof Anthropic.APIError>).type).toBe("invalid_request_error");
			expect(String(error)).toContain(field);
			expect(problemsOf(stub.requests[0])).toContain(`body.${field}: not allowed`);
			expect(fake.received).toHaveLength(1);
		},
	);
});
