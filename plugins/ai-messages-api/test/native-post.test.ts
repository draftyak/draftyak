import {
	type AiCandidateRequest,
	type AiRequestBinding,
	createBuiltinAiProfileRegistry,
	snapshotVerifiedAiRequest,
	verifyAiRequest,
} from "@draftyak/hub";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, draftCall, readDraft } from "../src/index.ts";
import { draft, input, message, pin } from "./helpers.ts";

// Synthetic native inputs test verifier compatibility, not runtime or credential authorization.
const modes = ["parse", "beta.parse", "create", "beta.create", "stream", "beta.stream"] as const;
type Mode = (typeof modes)[number];
const registry = createBuiltinAiProfileRegistry();
const encoder = new TextEncoder();
const nativeMaxTokens = 1_234;
let globalFetchCalls = 0;
beforeEach(() => {
	globalFetchCalls = 0;
	vi.stubGlobal("fetch", async () => {
		globalFetchCalls++;
		throw new Error("Unexpected global fetch in native verifier fixture");
	});
});
afterEach(() => {
	vi.unstubAllGlobals();
	expect(globalFetchCalls).toBe(0);
});

function nativeBinding(mode: Mode): AiRequestBinding {
	// These facts are chosen before observing the candidate and never copied from its body.
	return {
		draft: {
			model: pin.model,
			system: input.system,
			prompt: input.prompt,
			contextIds: ["c1"],
		},
		settings: {
			kind: "messages",
			effort: pin.effort,
			maxTokens: nativeMaxTokens,
			stream: mode.includes("stream") ? true : "omit",
			fallback: true,
		},
		endpoint: `https://api.anthropic.com/v1/messages${mode.startsWith("beta.") ? "?beta=true" : ""}`,
		answers: [{ address: "8.8.8.8", family: 4 }],
		policy: { allowLocal: false, deniedAddresses: [], deniedPorts: [] },
	};
}

function completed(fields: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: "msg_synthetic",
		type: "message",
		role: "assistant",
		stop_sequence: null,
		...message(fields),
	};
}

function response(stream: boolean): Response {
	if (!stream) return Response.json(completed());
	const events = [
		{
			type: "message_start",
			message: completed({
				content: [],
				stop_reason: null,
				usage: { input_tokens: 300, output_tokens: 0 },
			}),
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: JSON.stringify(draft) },
		},
		{ type: "content_block_stop", index: 0 },
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 100 },
		},
		{ type: "message_stop" },
	];
	const frames = events
		.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("");
	return new Response(frames, {
		headers: { "content-type": "text/event-stream" },
	});
}

async function recorded(mode: Mode): Promise<{
	candidate: AiCandidateRequest;
	binding: AiRequestBinding;
}> {
	const binding = nativeBinding(mode);
	const candidates: AiCandidateRequest[] = [];
	const client = createClient(
		async (target, init = {}) => {
			if (typeof init.body !== "string")
				throw new Error("SDK fixture requires its actual JSON body");
			const candidate: AiCandidateRequest = {
				method: init.method ?? "GET",
				url: typeof target === "string" ? target : target instanceof URL ? target.href : target.url,
				headers: [...new Headers(init.headers)],
				body: encoder.encode(init.body),
			};
			candidates.push(candidate);
			const verified = verifyAiRequest(registry, "messages-api-v1", candidate, binding);
			const snapshot = snapshotVerifiedAiRequest(verified);
			expect(snapshot).toEqual({ profile: "messages-api-v1", ...candidate });
			expect(snapshot.body).not.toBe(candidate.body);
			return response(mode.includes("stream"));
		},
		{ maxRetries: 0 },
	);
	const { params, headers } = draftCall(input, {
		model: pin.model,
		effort: pin.effort,
		maxTokens: nativeMaxTokens,
	});
	let result: unknown;
	switch (mode) {
		case "parse":
			result = await client.messages.parse(params, { headers });
			break;
		case "beta.parse":
			result = await client.beta.messages.parse(params, { headers });
			break;
		case "create":
			result = await client.messages.create(params, { headers });
			break;
		case "beta.create":
			result = await client.beta.messages.create(params, { headers });
			break;
		case "stream":
			result = await client.messages.stream(params, { headers }).finalMessage();
			break;
		case "beta.stream":
			result = await client.beta.messages.stream(params, { headers }).finalMessage();
			break;
	}
	expect(readDraft(result, ["c1"])).toMatchObject({ kind: "draft", output: draft });
	expect(candidates).toHaveLength(1);
	const candidate = candidates[0];
	if (!candidate) throw new Error("SDK fixture did not produce its request");
	return { candidate, binding };
}

function changedBody(
	candidate: AiCandidateRequest,
	change: (body: Record<string, unknown>) => void,
): AiCandidateRequest {
	const body = JSON.parse(new TextDecoder().decode(candidate.body)) as Record<string, unknown>;
	change(body);
	return { ...candidate, body: encoder.encode(JSON.stringify(body)) };
}

describe("Messages SDK POST compatibility with the native verifier", () => {
	it.each(modes)(
		"verifies the actual %s SDK request against independent native fixture facts",
		async (mode) => {
			await recorded(mode);
		},
	);
	it.each(["prompt", "model", "header", "schema"] as const)(
		"refuses an altered %s while the original captured request remains valid",
		async (field) => {
			const { candidate, binding } = await recorded("create");
			let modified: AiCandidateRequest;
			if (field === "header") {
				modified = {
					...candidate,
					headers: candidate.headers.map(
						([name, value]) =>
							[name, name === "anthropic-version" ? "DYTEST-wrong-version" : value] as const,
					),
				};
			} else {
				modified = changedBody(candidate, (body) => {
					if (field === "model") body.model = "claude-other-model";
					else if (field === "prompt") {
						const messages = body.messages as { content: string }[];
						const first = messages[0];
						if (!first) throw new Error("Missing SDK fixture message");
						first.content = "DYTEST changed prompt";
					} else {
						const output = body.output_config as { format: { schema: Record<string, unknown> } };
						output.format.schema.additionalProperties = true;
					}
				});
			}
			let refused: unknown;
			try {
				verifyAiRequest(registry, "messages-api-v1", modified, binding);
			} catch (error) {
				refused = error;
			}
			expect(refused).toMatchObject({ code: "AI_REQUEST_REFUSED" });
			expect(() => verifyAiRequest(registry, "messages-api-v1", candidate, binding)).not.toThrow();
		},
	);
});
