import { aiProviderV1, type DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { CONTEXT_IDS, DraftOutputV1 } from "@draftyak/protocol/draft-output";
import { exportedSchema } from "@draftyak/protocol/extension";
import { headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import { array, data, fail, keys } from "./boundary.ts";
import type { CompatibleConfig } from "./config.ts";

export const MAX_REQUEST_BYTES = 8_388_608;
export interface CompatibleRequest {
	readonly method: "POST" | "GET";
	readonly url: string;
	readonly redirect: "error";
	readonly headers: Readonly<Record<string, string>>;
	readonly body: string;
	readonly bodySha256: string;
	readonly headersSha256: string;
}

export function draftRequest(value: unknown, config: CompatibleConfig): DraftRequest {
	try {
		const input = data(value);
		const contextIds = array(input.contextIds, CONTEXT_IDS.length);
		const parsed = aiProviderV1.tools.ai_draft_generate.input.safeParse({ ...input, contextIds });
		if (!parsed.success || parsed.data.model !== config.model) fail();
		return parsed.data;
	} catch {
		return fail();
	}
}

function schema(): Record<string, unknown> {
	const unsupported = new Set([
		"$id",
		"$schema",
		"maxLength",
		"minLength",
		"maxItems",
		"minItems",
		"uniqueItems",
	]);
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip);
		if (value === null || typeof value !== "object") return value;
		return Object.fromEntries(
			Object.entries(value)
				.filter(([key]) => !unsupported.has(key))
				.map(([key, item]) => [key, strip(item)]),
		);
	};
	return strip(exportedSchema("schemas/draft-output-v1.schema.json", DraftOutputV1)) as Record<
		string,
		unknown
	>;
}

export function makeRequest(method: "POST" | "GET", url: string, body: string): CompatibleRequest {
	if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) fail();
	const values: Record<string, string> = {};
	if (method === "POST") values["content-type"] = "application/json";
	const headers: Readonly<Record<string, string>> = Object.freeze(values);
	return Object.freeze({
		method,
		url,
		redirect: "error",
		headers,
		body,
		bodySha256: sha256Hex(body),
		headersSha256: headersSha256(Object.entries(headers)),
	});
}

export function buildRequest(config: CompatibleConfig, input: unknown): CompatibleRequest {
	const request = draftRequest(input, config);
	const messages = [
		{ role: "system", content: request.system },
		{ role: "user", content: request.prompt },
	];
	const body =
		config.format === "ollama"
			? { model: config.model, messages, format: schema(), stream: false }
			: {
					model: config.model,
					messages,
					response_format:
						config.format === "json_object"
							? { type: "json_object" }
							: {
									type: "json_schema",
									json_schema: { name: "draft_output_v1", strict: true, schema: schema() },
								},
					stream: false,
				};
	return makeRequest("POST", config.endpoint, JSON.stringify(body));
}

export function detachedVerifier(expected: CompatibleRequest): (candidate: unknown) => boolean {
	const pin = { ...expected, headers: { ...expected.headers } };
	return (candidate: unknown): boolean => {
		try {
			const value = data(candidate);
			keys(value, ["method", "url", "redirect", "headers", "body", "bodySha256", "headersSha256"]);
			const headers = data(value.headers);
			keys(headers, Object.keys(pin.headers));
			return (
				Object.keys(headers).length === Object.keys(pin.headers).length &&
				Object.entries(pin.headers).every(([key, value]) => headers[key] === value) &&
				value.method === pin.method &&
				value.url === pin.url &&
				value.redirect === "error" &&
				value.body === pin.body &&
				value.bodySha256 === pin.bodySha256 &&
				value.headersSha256 === pin.headersSha256
			);
		} catch {
			return false;
		}
	};
}
