import { aiProviderV1, ModelId } from "@draftyak/protocol/ai-provider-v1";
import { fields } from "./boundary.ts";
import { type ResponsesMetadataBindingWithoutNetwork, refuse } from "./types.ts";

export function captureResponsesMetadataBinding(
	raw: unknown,
): ResponsesMetadataBindingWithoutNetwork {
	const value = fields(raw, ["operation", "configuration", "input"]);
	if (value.operation !== "ai_models_list" && value.operation !== "ai_probe") refuse();
	const configuration = fields(
		value.configuration,
		["profile", "endpoint", "model"],
		["profile", "endpoint"],
	);
	if (
		configuration.profile !== "responses-api-v1" ||
		configuration.endpoint !== "https://api.openai.com/v1"
	)
		refuse();
	if (
		Object.hasOwn(configuration, "model") &&
		!ModelId.safeParse(configuration.model, { jitless: true }).success
	)
		refuse();
	const input = fields(value.input, value.operation === "ai_probe" ? ["model"] : [], []);
	if (Object.hasOwn(input, "model") && !ModelId.safeParse(input.model, { jitless: true }).success)
		refuse();
	const parsed = aiProviderV1.tools[value.operation].input.safeParse(input, { jitless: true });
	if (!parsed.success) refuse();
	const binding: ResponsesMetadataBindingWithoutNetwork = Object.freeze({
		operation: value.operation,
		configuration: Object.freeze({
			profile: "responses-api-v1",
			endpoint: "https://api.openai.com/v1",
			...(Object.hasOwn(configuration, "model") ? { model: configuration.model as string } : {}),
		}),
		input: Object.freeze({ ...parsed.data }),
	});
	responsesMetadataEndpoint(binding);
	return binding;
}

export function responsesMetadataEndpoint(binding: ResponsesMetadataBindingWithoutNetwork): string {
	const root = `${binding.configuration.endpoint}/models`;
	if (binding.operation === "ai_models_list") return root;
	const model = binding.input.model ?? binding.configuration.model;
	if (model === undefined) refuse();
	const endpoint = `${root}/${encodeURIComponent(model)}`;
	// Dot segments have no canonical single-segment representation in a URL.
	if (new URL(endpoint).href !== endpoint) refuse();
	return endpoint;
}
