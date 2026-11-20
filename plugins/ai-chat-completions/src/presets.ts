import { fail } from "./boundary.ts";

export type CompatiblePreset = "ollama" | "lmStudio" | "llamaCpp8080" | "llamaCpp9931" | "vllm";

const origins: Readonly<Record<CompatiblePreset, string>> = Object.freeze({
	ollama: "http://127.0.0.1:11434",
	lmStudio: "http://127.0.0.1:1234",
	llamaCpp8080: "http://127.0.0.1:8080",
	llamaCpp9931: "http://127.0.0.1:9931",
	vllm: "http://127.0.0.1:8000",
});

export const LOCAL_PRESETS: Readonly<Record<string, readonly string[]>> = Object.freeze({
	ollama: Object.freeze([`${origins.ollama}/v1/chat/completions`]),
	lmStudio: Object.freeze([`${origins.lmStudio}/v1/chat/completions`]),
	llamaCpp: Object.freeze([
		`${origins.llamaCpp8080}/v1/chat/completions`,
		`${origins.llamaCpp9931}/v1/chat/completions`,
	]),
	vllm: Object.freeze([`${origins.vllm}/v1/chat/completions`]),
});

export function presetEndpoint(
	preset: unknown,
	endpointPath: "/api/chat" | "/v1/chat/completions",
): string {
	if (typeof preset !== "string" || !Object.hasOwn(origins, preset)) fail();
	return `${origins[preset as CompatiblePreset]}${endpointPath}`;
}
