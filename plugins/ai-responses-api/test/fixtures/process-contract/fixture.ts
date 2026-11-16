import {
	createRecorder,
	createResponsesApiDraftFake,
	type ResponsesApiFake,
	type ResponsesApiStep,
	type StreamingRecorder,
} from "@draftyak/fakes";
import type { AiProviderFixtures } from "@draftyak/plugin-testkit/contracts/ai-provider";
import type { DraftOutcome, DraftRequest } from "@draftyak/protocol/ai-provider-v1";

const MODEL = "m79-process-fixture-model";
const SYSTEM = "Write a draft reply using only the supplied synthetic context.";
const PROMPT = "Context c1: The sample is ready.\nAsk the recipient to confirm a delivery window.";

/** A new finite script, not an invocation of the response converter under test. */
function draftStep(): ResponsesApiStep {
	return {
		kind: "sse",
		events: [
			{
				event: "response.completed",
				data: {
					type: "response.completed",
					response: {
						status: "completed",
						model: MODEL,
						usage: { input_tokens: 13, output_tokens: 17 },
						output: [
							{
								type: "message",
								role: "assistant",
								status: "completed",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											body: "The sample is ready — please confirm a delivery window.",
											ownerNotes: "Synthetic process-contract fixture.",
											needsOwnerInput: ["Which delivery window works?"],
											suspectedInstructions: false,
											contextRefs: ["c1"],
										}),
									},
								],
							},
						],
					},
				},
			},
		],
	};
}

/** Each registered contract check receives its own original fake and recorder. */
export async function makeProcessContractFixtures(): Promise<AiProviderFixtures> {
	const request: DraftRequest = {
		model: MODEL,
		system: SYSTEM,
		prompt: PROMPT,
		contextIds: ["c1"],
	};
	const expected: Extract<DraftOutcome, { kind: "draft" }> = {
		kind: "draft",
		model: MODEL,
		fallback: false,
		usage: { input: 13, output: 17 },
		output: {
			body: "The sample is ready — please confirm a delivery window.",
			ownerNotes: "Synthetic process-contract fixture.",
			needsOwnerInput: ["Which delivery window works?"],
			suspectedInstructions: false,
			contextRefs: ["c1"],
		},
	};
	const recorder = createRecorder({
		headerValues: ["content-type"],
		maxBodyBytes: 65_536,
	});
	let upstream: ResponsesApiFake | undefined;
	const routingRecorder: StreamingRecorder = {
		begin(incoming) {
			const fake = upstream;
			if (fake === undefined) throw new Error("Synthetic upstream is not initialized");
			const target = new URL(incoming.url);
			const path = target.pathname + target.search;
			if (incoming.method === "GET" && path === "/v1/models") {
				fake.enqueue({
					kind: "json",
					body: { object: "list", data: [{ object: "model", id: MODEL }] },
				});
			} else if (incoming.method === "GET" && path === "/v1/models/" + MODEL) {
				fake.enqueue({ kind: "json", body: { object: "model", id: MODEL } });
			} else if (incoming.method === "POST" && path === "/v1/responses") {
				fake.enqueue(draftStep());
			}
			// begin runs before this capped fake can admit the request to its app.
			// Endpoint admission and recording stay with the original fake.
			return recorder.begin(incoming);
		},
		record: (incoming) => recorder.record(incoming),
		takeRequests: () => recorder.takeRequests(),
	};
	upstream = createResponsesApiDraftFake({ recorder: routingRecorder });
	return {
		upstreams: [upstream],
		// Trusted comparisons are literal fixture inputs, never reconstructed
		// from a plugin-produced request or its recorded bytes.
		responsesHttp: [
			{ operation: "ai_models_list", origin: "https://api.openai.com" },
			{ operation: "ai_probe", origin: "https://api.openai.com", model: MODEL },
			{
				operation: "ai_draft_generate",
				origin: "https://api.openai.com",
				draft: {
					model: MODEL,
					system: SYSTEM,
					prompt: PROMPT,
					contextIds: ["c1"],
				},
			},
		],
		request,
		expected,
		// One immediate report; no fake delay or extra chunk waits. The original
		// contract's timing and exact notification checks remain unchanged.
		progress: [{ progress: 0 }],
	};
}
