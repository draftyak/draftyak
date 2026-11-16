import { ModelId } from "@draftyak/protocol/ai-provider-v1";
import { data, fail, keys, string } from "./boundary.ts";

export type CompatibleFormat = "json_schema" | "json_object" | "ollama";
export type CompatibleDestination = "local" | "local-network" | "cloud";
export interface CompatibleConfig {
	readonly endpoint: string;
	readonly modelsEndpoint: string;
	readonly model: string;
	readonly format: CompatibleFormat;
	readonly destination: CompatibleDestination;
}

export const LOCAL_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	ollama: Object.freeze(["http://127.0.0.1:11434/v1/chat/completions"]),
	lmStudio: Object.freeze(["http://127.0.0.1:1234/v1/chat/completions"]),
	llamaCpp: Object.freeze([
		"http://127.0.0.1:8080/v1/chat/completions",
		"http://127.0.0.1:9931/v1/chat/completions",
	]),
	vllm: Object.freeze(["http://127.0.0.1:8000/v1/chat/completions"]),
});

export function compatibleConfig(input: unknown, trustedResolution: unknown): CompatibleConfig {
	try {
		const value = data(input);
		keys(value, ["endpoint", "model", "format", "allowPlaintextLan"]);
		const resolution = data(trustedResolution);
		keys(resolution, ["hostname", "destination"]);
		const endpoint = string(value.endpoint, 2048);
		const url = new URL(endpoint);
		const format = value.format;
		if (format !== "json_schema" && format !== "json_object" && format !== "ollama") fail();
		const path = format === "ollama" ? "/api/chat" : "/v1/chat/completions";
		if (
			url.href !== endpoint ||
			endpoint !== `${url.origin}${path}` ||
			url.username ||
			url.password ||
			url.search ||
			url.hash ||
			url.pathname !== path
		)
			fail();
		if (resolution.hostname !== url.hostname) fail();
		const destination = resolution.destination;
		if (destination !== "local" && destination !== "local-network" && destination !== "cloud")
			fail();
		if (value.allowPlaintextLan !== undefined && typeof value.allowPlaintextLan !== "boolean")
			fail();
		if (
			url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				(destination === "local" ||
					(destination === "local-network" && value.allowPlaintextLan === true))
			)
		)
			fail();
		const model = ModelId.safeParse(value.model);
		if (!model.success) fail();
		return Object.freeze({
			endpoint,
			modelsEndpoint: `${url.origin}${format === "ollama" ? "/api/tags" : "/v1/models"}`,
			model: model.data,
			format,
			destination,
		});
	} catch {
		return fail("INVALID_CONFIG");
	}
}
