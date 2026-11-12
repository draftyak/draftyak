import { serve } from "@draftyak/sdk";
import { type CompatibleFormat, createPlugin } from "../../../src/index.ts";

/** Fixed fixture configuration is DATA; the parent host still admits every request. */
export function start(format: CompatibleFormat): void {
	if (process.permission?.has("net") !== false)
		throw new Error("Compatible process fixture requires denied direct network.");
	const endpoint = `http://127.0.0.1/${format === "ollama" ? "api/chat" : "v1/chat/completions"}`;
	const instance = {
		id: "00000000000000000000000001",
		config: {
			endpoint,
			model: "dytest-compatible-sdk-model",
			format,
			resolution: { hostname: "127.0.0.1", destination: "local" },
		},
	};
	serve(createPlugin(instance), { instance: { id: instance.id, config: {} } });
}
