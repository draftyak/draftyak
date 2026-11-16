import { type PluginEntry, serve } from "@draftyak/sdk/serve";
import manifest from "../draftyak.plugin.json" with { type: "json" };
import { createMessagesPlugin } from "./plugin.ts";

export function createPlugin(): PluginEntry {
	return createMessagesPlugin(manifest);
}

export function startPlugin(options?: Parameters<typeof serve>[1]): ReturnType<typeof serve> {
	return serve(createPlugin(), options);
}

if (import.meta.main) startPlugin();
