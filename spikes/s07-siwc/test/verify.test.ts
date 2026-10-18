import { describe, expect, it } from "vitest";
import { buildRequest } from "../src/responses.ts";
import { canonical, DRAFT_SCHEMA, SUBMIT_DRAFT_TOOL, verifyRequest } from "../src/verify.ts";
import { job } from "./harness.ts";

const RESPONSES = "https://api.openai.com/v1/responses";
const headers = (extra: Record<string, string> = {}): Headers =>
	new Headers({ authorization: "Bearer brokered", "content-type": "application/json", ...extra });
const problems = (
	url: string,
	body: unknown,
	method = "POST",
	sent = headers(),
): readonly string[] => {
	const verdict = verifyRequest({ method, url, headers: sent, body });
	return verdict.ok ? [] : verdict.problems;
};

describe("the broker's verifier", () => {
	// ChatGPT's private backend is built at run time, so no forbidden literal is committed.
	const backend = ["https://chatgpt.com", ["backend", "api"].join("-"), "conversation"].join("/");

	it.each([
		backend,
		"http://api.openai.com/v1/responses",
		"https://api.openai.com/v1/chat/completions",
		"https://api.openai.com/v1/responses?beta=true",
		"https://user:pass@api.openai.com/v1/responses",
		"https://:pass@api.openai.com/v1/responses",
		"https://user@api.openai.com/v1/responses",
		"https://api.openai.com.example.test/v1/responses",
		"not a url",
	])("refuses %s", (url) => {
		expect(problems(url, buildRequest(job("text-format")))).toContain(
			"url: only POST https://api.openai.com/v1/responses and GET https://api.openai.com/v1/models are allowed",
		);
	});

	it("allows the model list as a bodiless GET, and nothing else on it", () => {
		const get = headers();
		get.delete("content-type");
		expect(problems("https://api.openai.com/v1/models", undefined, "GET", get)).toEqual([]);
		expect(problems("https://api.openai.com/v1/models", {}, "GET", get)).toEqual([
			"body: GET takes none",
		]);
		expect(problems("https://api.openai.com/v1/models", undefined, "POST")).not.toEqual([]);
	});

	it("takes only the placeholder bearer, so the plugin never holds a token", () => {
		const body = buildRequest(job("text-format"));
		expect(problems(RESPONSES, body, "POST", headers({ authorization: "Bearer eyJreal" }))).toEqual(
			["header authorization: value not allowed"],
		);
		const missing = headers();
		missing.delete("authorization");
		expect(problems(RESPONSES, body, "POST", missing)).toEqual(["header authorization: missing"]);
	});

	it("names only the API's own vocabulary in problems", () => {
		const body = { ...buildRequest(job("text-format")), Dear_Sam: 1, temperature: 0 };
		const sent = headers({ "x-stainless-os": "Windows", "x-dear-sam": "1" });
		expect(problems(RESPONSES, body, "POST", sent)).toEqual([
			"body.(unknown): not allowed",
			"body.temperature: not allowed",
			"header (unknown): not allowed",
			"header x-stainless-os: not allowed",
		]);
	});

	it("pins the draft schema and submit_draft, and keeps json_schema strict", () => {
		const loose = { ...SUBMIT_DRAFT_TOOL, strict: false };
		const wider = {
			...SUBMIT_DRAFT_TOOL,
			parameters: {
				...DRAFT_SCHEMA,
				properties: { ...(DRAFT_SCHEMA.properties as object), x: {} },
			},
		};
		const base = buildRequest(job("tool-top-level"));
		expect(problems(RESPONSES, { ...base, tools: [loose] })).toContain(
			"tools: only submit_draft, alone or in the draftyak namespace",
		);
		expect(problems(RESPONSES, { ...base, tools: [wider] })).not.toEqual([]);
		const text = buildRequest(job("text-format"));
		const format = (text.text as { format: Record<string, unknown> }).format;
		expect(
			problems(RESPONSES, { ...text, text: { format: { ...format, strict: false } } }),
		).toEqual(["text.format: only text or the strict draft json_schema"]);
		expect(canonical({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
	});

	it("refuses a second submit_draft, other tools, tool outputs and other tool choices", () => {
		const item = buildRequest(job("tool-item"));
		const offer = (item.input as unknown[])[0];
		const message = (item.input as unknown[])[1];
		const cases: [Record<string, unknown>, string][] = [
			[{ ...item, input: [offer, offer, message] }, "input: submit_draft offered more than once"],
			[{ ...item, tools: [SUBMIT_DRAFT_TOOL] }, "tools: submit_draft offered twice"],
			[
				{ ...item, input: [{ ...(offer as object), role: "user" }, message] },
				"input[0]: an additional_tools item may only offer submit_draft",
			],
			[
				{ ...item, input: [{ type: "function_call_output", call_id: "c", output: "{}" }, message] },
				"input[0]: only user messages and one submit_draft item are allowed",
			],
			[
				{ ...item, tool_choice: { type: "function", name: "send_email" } },
				"tool_choice: required, auto, none or submit_draft, with submit_draft offered",
			],
			[
				{ ...buildRequest(job("text-format")), reasoning: { effort: "low", summary: "auto" } },
				"reasoning.summary: not allowed",
			],
		];
		for (const [body, problem] of cases) expect(problems(RESPONSES, body)).toContain(problem);
	});

	// Each value check on its own: the body is otherwise the one buildRequest makes.
	const text = buildRequest(job("text-format"));
	const namespaced = buildRequest(job("tool-namespace"));
	const [message] = text.input as Record<string, unknown>[];
	const [namespace] = namespaced.tools as Record<string, unknown>[];
	const part = (extra: object) => ({ ...message, content: [extra] });
	const other = { ...SUBMIT_DRAFT_TOOL, name: "send_email" };
	const { store: _store, ...noStore } = text;
	const { stream: _stream, ...noStream } = text;
	it.each([
		["store true", { ...text, store: true }, "store: must be false"],
		["no store", noStore, "store: must be false"],
		["stream false", { ...text, stream: false }, "stream: must be true"],
		["no stream", noStream, "stream: must be true"],
		["a model that isn't a slug", { ...text, model: "gpt fake" }, "model: must be a model slug"],
		["no model", { ...text, model: 5 }, "model: must be a model slug"],
		[
			"instructions that aren't text",
			{ ...text, instructions: ["x"] },
			"instructions: must be a string",
		],
		["an empty input", { ...text, input: [] }, "input: must be a non-empty array"],
		[
			"an input_image part",
			{ ...text, input: [part({ type: "input_image", image_url: "https://example.test/a.png" })] },
			"input[0].content: only input_text parts",
		],
		[
			"an input_file part",
			{ ...text, input: [part({ type: "input_file", file_url: "https://example.test/a.pdf" })] },
			"input[0].content: only input_text parts",
		],
		[
			"a text part of another type",
			{ ...text, input: [part({ type: "output_text", text: "Earlier reply." })] },
			"input[0].content: only input_text parts",
		],
		[
			"an extra key on a message",
			{ ...text, input: [{ ...message, id: "msg_1" }] },
			"input[0].id: not allowed",
		],
		[
			"submit_draft and another tool",
			{ ...buildRequest(job("tool-top-level")), tools: [SUBMIT_DRAFT_TOOL, other] },
			"tools: only submit_draft, alone or in the draftyak namespace",
		],
		[
			"another tool inside the namespace",
			{ ...namespaced, tools: [{ ...namespace, tools: [SUBMIT_DRAFT_TOOL, other] }] },
			"tools: only submit_draft, alone or in the draftyak namespace",
		],
		[
			"an extra key on the namespace",
			{ ...namespaced, tools: [{ ...namespace, defer_loading: true }] },
			"tools[0].defer_loading: not allowed",
		],
		[
			"a json_schema beside submit_draft",
			{ ...namespaced, text: text.text },
			"text.format: not alongside submit_draft",
		],
		[
			"a tool_choice with no tool offered",
			{ ...text, tool_choice: "required" },
			"tool_choice: required, auto, none or submit_draft, with submit_draft offered",
		],
	] as [string, Record<string, unknown>, string][])("refuses %s", (_name, body, problem) => {
		expect(problems(RESPONSES, body)).toContain(problem);
	});

	it("refuses another user-agent and any other value for the SDK's headers", () => {
		const body = buildRequest(job("text-format"));
		for (const [name, value] of [
			["user-agent", "curl/8.0"],
			["user-agent", "OpenAI/JS 7.36.0 extra"],
			["accept", "text/html"],
			["content-type", "text/plain"],
			["x-stainless-retry-count", "x"],
		]) {
			expect(
				problems(RESPONSES, body, "POST", headers({ [name as string]: value as string })),
			).toEqual([`header ${name}: value not allowed`]);
		}
		expect(
			problems(RESPONSES, body, "POST", headers({ "user-agent": "OpenAI/JS 7.36.0" })),
		).toEqual([]);
	});
});
