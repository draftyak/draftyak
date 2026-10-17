import { describe, expect, it } from "vitest";
import {
	API_ORIGIN,
	FALLBACK_BETA,
	KEY_PLACEHOLDER,
	type OutgoingRequest,
	type Pin,
	verifyRequest,
} from "../src/verify.ts";
import { fakeKey } from "./harness.ts";

type Body = Record<string, unknown> & {
	messages: Record<string, unknown>[];
	output_config: Record<string, unknown>;
};

const schema = {
	type: "object",
	properties: { body: { type: "string" } },
	required: ["body"],
	additionalProperties: false,
};

// The shape the SDK builds for a draft (test/draft.test.ts checks the SDK-built requests).
function request(
	edit: (body: Body, headers: Headers) => void = () => {},
	target: Partial<Pick<OutgoingRequest, "method" | "url">> = {},
): OutgoingRequest {
	const body: Body = {
		model: "claude-opus-5-5",
		max_tokens: 16_000,
		system: "Draft a reply in the owner's voice.",
		messages: [{ role: "user", content: "<thread>Can we meet Tuesday?</thread>" }],
		output_config: { effort: "medium", format: { type: "json_schema", schema } },
		fallbacks: "default",
	};
	const headers = new Headers({
		accept: "application/json",
		"content-type": "application/json",
		"user-agent": "Anthropic/JS 0.135.0",
		"anthropic-version": "2023-06-01",
		"anthropic-beta": FALLBACK_BETA,
		"x-api-key": KEY_PLACEHOLDER,
		"x-stainless-retry-count": "0",
		"x-stainless-timeout": "600",
	});
	edit(body, headers);
	return { method: "POST", url: `${API_ORIGIN}/v1/messages?beta=true`, headers, body, ...target };
}

const problems = (outgoing: OutgoingRequest, pin?: Pin): readonly string[] => {
	const verdict = verifyRequest(outgoing, pin);
	return verdict.ok ? [] : verdict.problems;
};

const withoutFallbacks = (body: Body, headers: Headers): void => {
	delete body.fallbacks;
	headers.delete("anthropic-beta");
};

describe("verifyRequest passes", () => {
	it("the draft shape, with fallbacks and their beta", () => {
		expect(verifyRequest(request())).toEqual({ ok: true });
	});

	it("the shape for a model without server-side fallback", () => {
		const haiku = request((body, headers) => {
			body.model = "claude-haiku-5-5";
			withoutFallbacks(body, headers);
		});
		expect(verifyRequest(haiku)).toEqual({ ok: true });
	});

	it("streaming, text-block prompts, an assistant turn, retries and the GA path", () => {
		const variant = request((body, headers) => {
			body.stream = true;
			body.system = [{ type: "text", text: "Draft a reply." }];
			body.messages.push(
				{ role: "assistant", content: [{ type: "text", text: "{" }] },
				{ role: "user", content: [{ type: "text", text: "Answer with JSON only." }] },
			);
			body.output_config = { format: { type: "json_schema", schema } };
			headers.set("x-stainless-helper-method", "stream");
			headers.set("x-stainless-retry-count", "2");
		});
		expect(verifyRequest(variant)).toEqual({ ok: true });
		expect(verifyRequest({ ...variant, url: `${API_ORIGIN}/v1/messages` })).toEqual({ ok: true });
	});
});

describe("verifyRequest refuses", () => {
	it.each([
		["temperature", 0.2],
		["top_p", 0.9],
		["top_k", 40],
		["tool_choice", { type: "any" }],
		["tool_choice", { type: "tool", name: "submit_draft" }],
		["tool_choice", { type: "auto" }],
		["tools", [{ name: "submit_draft", input_schema: { type: "object" } }]],
		["metadata", { user_id: "owner" }],
		["thinking", { type: "adaptive" }],
		["stop_sequences", ["END"]],
		["service_tier", "auto"],
		["speed", "fast"],
		["cache_control", { type: "ephemeral" }],
		["container", "container_1"],
		["mcp_servers", [{ type: "url", url: "https://mcp.example.com", name: "x" }]],
		["context_management", { edits: [] }],
		["inference_geo", "us"],
		["diagnostics", { previous_message_id: null }],
		["output_format", { type: "json_schema", schema }],
		["fallback_credit_token", "token"],
		["compaction", {}],
		["betas", [FALLBACK_BETA]],
	])("the field %s", (field, value) => {
		expect(problems(request((body) => Object.assign(body, { [field]: value })))).toContain(
			`body.${field}: not allowed`,
		);
	});

	it.each([
		["max_tokens 0", (body: Body) => Object.assign(body, { max_tokens: 0 }), "max_tokens"],
		[
			"max_tokens over the cap",
			(body: Body) => Object.assign(body, { max_tokens: 16_001 }),
			"max_tokens",
		],
		[
			"a fractional max_tokens",
			(body: Body) => Object.assign(body, { max_tokens: 1.5 }),
			"max_tokens",
		],
		[
			"a string max_tokens",
			(body: Body) => Object.assign(body, { max_tokens: "16000" }),
			"max_tokens",
		],
		["a missing model", (body: Body) => delete body.model, "model"],
		["another vendor's model", (body: Body) => Object.assign(body, { model: "gpt-5" }), "model"],
		[
			"an unknown effort",
			(body: Body) => Object.assign(body.output_config, { effort: "extreme" }),
			"output_config.effort",
		],
		[
			"a null effort",
			(body: Body) => Object.assign(body.output_config, { effort: null }),
			"output_config.effort",
		],
		[
			"a task budget",
			(body: Body) =>
				Object.assign(body.output_config, { task_budget: { type: "tokens", total: 20_000 } }),
			"output_config.task_budget",
		],
		[
			"a text format",
			(body: Body) => Object.assign(body.output_config, { format: { type: "text" } }),
			"output_config.format",
		],
		[
			"extra format keys",
			(body: Body) =>
				Object.assign(body.output_config, {
					format: { type: "json_schema", schema, strict: true },
				}),
			"output_config.format.(unknown)",
		],
		[
			"a string output_config",
			(body: Body) => Object.assign(body, { output_config: "medium" }),
			"output_config",
		],
		[
			"a list output_config",
			(body: Body) => Object.assign(body, { output_config: [{ effort: "medium" }] }),
			"output_config",
		],
		[
			"a fallback list",
			(body: Body) => Object.assign(body, { fallbacks: [{ model: "claude-opus-4-8" }] }),
			"fallbacks",
		],
		["a non-boolean stream", (body: Body) => Object.assign(body, { stream: "yes" }), "stream"],
		["no messages", (body: Body) => Object.assign(body, { messages: [] }), "messages"],
		[
			"a system-role message",
			(body: Body) => body.messages.push({ role: "system", content: "x" }),
			"messages[1].role",
		],
		[
			"an image block",
			(body: Body) =>
				Object.assign(body.messages[0] ?? {}, {
					content: [
						{ type: "image", source: { type: "url", url: "https://img.example.com/a.png" } },
					],
				}),
			"messages[0].content[0]",
		],
		[
			"a document block",
			(body: Body) =>
				Object.assign(body.messages[0] ?? {}, {
					content: [
						{ type: "document", source: { type: "url", url: "https://doc.example.com/a.pdf" } },
					],
				}),
			"messages[0].content[0]",
		],
		[
			"a cached text block",
			(body: Body) =>
				Object.assign(body.messages[0] ?? {}, {
					content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }],
				}),
			"messages[0].content[0].cache_control",
		],
		[
			"an extra message key",
			(body: Body) => Object.assign(body.messages[0] ?? {}, { name: "owner" }),
			"messages[0].(unknown)",
		],
		[
			"a message that clears the system prompt",
			(body: Body) => Object.assign(body.messages[0] ?? {}, { clear_at: "never" }),
			"messages[0].clear_at",
		],
		[
			"a system block with citations",
			(body: Body) => Object.assign(body, { system: [{ type: "text", text: "x", citations: [] }] }),
			"system[0].citations",
		],
	])("%s", (_name, edit, field) => {
		expect(problems(request(edit)).some((problem) => problem.startsWith(`${field}:`))).toBe(true);
	});

	it("fallbacks for a model without server-side fallback, or without their beta", () => {
		const haiku = request((body) => Object.assign(body, { model: "claude-haiku-5-5" }));
		expect(problems(haiku)).toContain("fallbacks: the model has no server-side fallback");
		const noBeta = request((_body, headers) => headers.delete("anthropic-beta"));
		expect(problems(noBeta)).toEqual([`fallbacks and the ${FALLBACK_BETA} beta go together`]);
		const betaOnly = request((body) => delete body.fallbacks);
		expect(problems(betaOnly)).toEqual([`fallbacks and the ${FALLBACK_BETA} beta go together`]);
	});

	it.each([
		"authorization",
		"x-stainless-os",
		"x-stainless-arch",
		"x-stainless-runtime",
		"x-stainless-runtime-version",
		"x-stainless-lang",
		"x-stainless-package-version",
		"x-stainless-helper",
		"traceparent",
		"anthropic-dangerous-direct-browser-access",
		"anthropic-workspace-id",
	])("the header %s, by name", (name) => {
		expect(problems(request((_body, headers) => headers.set(name, "1")))).toEqual([
			`header ${name}: not allowed`,
		]);
	});

	it.each(["idempotency-key", "x-draft-note", "constructor", "__proto__"])(
		"the header %s, as an unknown name",
		(name) => {
			expect(problems(request((_body, headers) => headers.set(name, "1")))).toEqual([
				"header (unknown): not allowed",
			]);
		},
	);

	it.each([
		["anthropic-beta", `${FALLBACK_BETA},structured-outputs-2025-12-15`],
		["anthropic-beta", "server-side-fallback-2026-06-01"],
		["anthropic-beta", "files-api-2025-04-14"],
		["anthropic-version", "2024-01-01"],
		["content-type", "text/plain"],
		["accept", "text/html"],
		["user-agent", "curl/8.9.1"],
		["x-stainless-helper-method", "parse"],
		["x-stainless-retry-count", "x"],
		["x-stainless-timeout", "x"],
		["x-stainless-timeout", "1234567"],
	])("the %s value %s", (name, value) => {
		expect(problems(request((_body, headers) => headers.set(name, value)))).toEqual([
			expect.stringMatching(new RegExp(`^header ${name}: value not allowed`)),
		]);
	});

	it("a key the plugin supplies itself, and missing required headers", () => {
		const ownKey = request((_body, headers) => headers.set("x-api-key", fakeKey()));
		expect(problems(ownKey)).toEqual(["header x-api-key: value not allowed"]);
		const bare = request((_body, headers) => {
			headers.delete("x-api-key");
			headers.delete("anthropic-version");
			headers.delete("content-type");
		});
		expect(problems(bare)).toEqual([
			"header content-type: missing",
			"header anthropic-version: missing",
			"header x-api-key: missing",
		]);
	});

	it("names the known betas it refuses, and no other", () => {
		const both = request((_body, headers) =>
			headers.set("anthropic-beta", `${FALLBACK_BETA},structured-outputs-2025-12-15`),
		);
		expect(problems(both)).toEqual([
			`header anthropic-beta: value not allowed (${FALLBACK_BETA}, structured-outputs-2025-12-15)`,
		]);
		const other = request((_body, headers) =>
			headers.set("anthropic-beta", `${FALLBACK_BETA}, files-api-2025-04-14`),
		);
		expect(problems(other)).toEqual([
			`header anthropic-beta: value not allowed (${FALLBACK_BETA}, (unknown))`,
		]);
	});

	it.each([
		["GET", `${API_ORIGIN}/v1/messages`],
		["POST", `${API_ORIGIN}/v1/messages/batches`],
		["POST", `${API_ORIGIN}/v1/messages/count_tokens`],
		["POST", `${API_ORIGIN}/v1/complete`],
		["POST", "https://api.anthropic.com.example.net/v1/messages"],
		["POST", "http://api.anthropic.com/v1/messages"],
		["POST", `${API_ORIGIN}/v1/messages?beta=true&extra=1`],
		["POST", "https://user:pass@api.anthropic.com/v1/messages"],
		["POST", `${API_ORIGIN}/v1/messages#draft`],
		["POST", "not a url"],
	])("%s %s", (method, url) => {
		expect(problems(request(undefined, { method, url })).length).toBeGreaterThan(0);
	});

	it("without echoing request content, even when it looks like a name", () => {
		const hostile = request((body, headers) => {
			Object.assign(body, { "Dear Sam, my PIN is 4921": true, "482913": true, "sam.jones": 1 });
			Object.assign(body.messages[0] ?? {}, { otp_482913: "x", "sam.lee": "y" });
			body.messages.push({
				role: "user",
				content: [{ type: "image", source: { type: "base64", data: "UElOIDQ5MjE=" } }],
			});
			Object.assign(body.output_config, { "code-482913": true });
			headers.set("x-note", "PIN 4921");
			headers.set("x-otp-482913", "1");
			headers.set("anthropic-beta", `sam.jones-4921,Dear Sam,${FALLBACK_BETA}`);
		});
		const found = problems(hostile);
		expect(found).toEqual(
			expect.arrayContaining([
				"body.(unknown): not allowed",
				"messages[0].(unknown): not allowed",
				"output_config.(unknown): not allowed",
				"header (unknown): not allowed",
				`header anthropic-beta: value not allowed ((unknown), (unknown), ${FALLBACK_BETA})`,
			]),
		);
		expect(found.join("\n")).not.toMatch(/sam|4921|482913|otp|code|UElO|note/i);
	});
});

describe("verifyRequest with the instance's pin", () => {
	const pin: Pin = { model: "claude-opus-5-5", effort: "medium" };

	it("passes the pinned model and effort", () => {
		expect(verifyRequest(request(), pin)).toEqual({ ok: true });
	});

	it.each([
		[
			"another model",
			(body: Body) => Object.assign(body, { model: "claude-fable-5-1" }),
			"model: not the instance's model",
		],
		[
			"a higher effort",
			(body: Body) => Object.assign(body.output_config, { effort: "max" }),
			"output_config.effort: not the instance's effort",
		],
		[
			"no effort, which the API would run at its default",
			(body: Body) => delete body.output_config.effort,
			"output_config.effort: not the instance's effort",
		],
	])("refuses %s", (_name, edit, problem) => {
		expect(problems(request(edit), pin)).toEqual([problem]);
	});
});
