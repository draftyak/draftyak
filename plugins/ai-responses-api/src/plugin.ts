import { defineAiProviderPlugin, type PluginEntry, PluginError, serve } from "@draftyak/sdk";
import manifest from "../draftyak.plugin.json" with { type: "json" };
import { MODES } from "./modes.ts";

/** Production entry: the accepted SDK initializes validation before mounting the provider. */
export function createPlugin(mode = "api-key"): PluginEntry {
	const handlers = typeof mode === "string" && Object.hasOwn(MODES, mode) ? MODES[mode] : undefined;
	if (!handlers) throw new PluginError("UNSUPPORTED");
	return defineAiProviderPlugin({ manifest, ...handlers });
}

export function startPlugin(
	mode = "api-key",
	options?: Parameters<typeof serve>[1],
): ReturnType<typeof serve> {
	return serve(createPlugin(mode), options);
}

if (import.meta.main) startPlugin();
