import type {
	AiDescription,
	DraftOutcome,
	DraftRequest,
	ModelInfo,
} from "@draftyak/protocol/ai-provider-v1";
import type { ProbeResult } from "@draftyak/protocol/extension";
import { fail } from "./boundary.ts";
import { type CompatibleConfig, compatibleConfig } from "./config.ts";
import {
	buildRequest,
	type CompatibleRequest,
	detachedVerifier,
	draftRequest,
	makeRequest,
} from "./request.ts";
import { type CompatibleResponse, modelIds, readOutcome } from "./response.ts";

export type CompatibleTransport = (
	request: CompatibleRequest,
	signal?: AbortSignal,
) => Promise<CompatibleResponse>;
export interface CompatibleCore {
	readonly config: CompatibleConfig;
	describe(): AiDescription;
	build(request: unknown): CompatibleRequest;
	verifier(request: unknown): (candidate: unknown) => boolean;
	modelsRequest(): CompatibleRequest;
	modelsVerifier(): (candidate: unknown) => boolean;
	models(response: unknown): { readonly models: readonly ModelInfo[] };
	parse(request: unknown, response: unknown): DraftOutcome;
	generate(
		request: unknown,
		transport: CompatibleTransport,
		signal?: AbortSignal,
	): Promise<DraftOutcome>;
	probe(transport: CompatibleTransport, signal?: AbortSignal): Promise<ProbeResult>;
}

export function createCompatibleCore(input: unknown, trustedResolution: unknown): CompatibleCore {
	const config = compatibleConfig(input, trustedResolution);
	const build = (request: unknown): CompatibleRequest => buildRequest(config, request);
	const generate = async (
		input: unknown,
		transport: CompatibleTransport,
		signal?: AbortSignal,
	): Promise<DraftOutcome> => {
		const request = draftRequest(input, config);
		if (signal?.aborted) fail("ABORTED");
		let response: CompatibleResponse;
		try {
			response = await transport(build(request), signal);
		} catch {
			if (signal?.aborted) fail("ABORTED");
			return {
				kind: "unexpected",
				model: config.model,
				fallback: false,
				usage: { input: null, output: 0 },
				stopReason: "transport_error",
			};
		}
		if (signal?.aborted) fail("ABORTED");
		// The hub owns prompt construction and its one invalid-schema repair.
		return readOutcome(config, request, response);
	};
	return Object.freeze({
		config,
		describe: (): AiDescription => ({ name: "OpenAI-compatible", structuredOutput: "validated" }),
		build,
		verifier: (request: unknown): ((candidate: unknown) => boolean) =>
			detachedVerifier(build(request)),
		modelsRequest: (): CompatibleRequest => makeRequest("GET", config.modelsEndpoint, ""),
		modelsVerifier: (): ((candidate: unknown) => boolean) =>
			detachedVerifier(makeRequest("GET", config.modelsEndpoint, "")),
		models: (response: unknown): { readonly models: readonly ModelInfo[] } => ({
			models: modelIds(config, response).map((id) => ({ id, fallbacks: false })),
		}),
		parse: (request: unknown, response: unknown): DraftOutcome =>
			readOutcome(config, draftRequest(request, config), response),
		generate,
		probe: async (transport: CompatibleTransport, signal?: AbortSignal): Promise<ProbeResult> => {
			const request: DraftRequest = {
				model: config.model,
				system: "Check the connection with a neutral JSON draft.",
				prompt:
					"Return an empty body and notes, no questions, no suspected instructions, and no context refs.",
				contextIds: [],
			};
			const result = await generate(request, transport, signal);
			return result.kind === "draft"
				? { status: "ok" }
				: { status: "degraded", detail: `probe: ${result.kind}` };
		},
	});
}
