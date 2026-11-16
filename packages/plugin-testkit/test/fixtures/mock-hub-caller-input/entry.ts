import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginArgv } from "@draftyak/protocol/plugin-argv";
import { serve } from "@draftyak/sdk/serve";
import { callerInputPlugin } from "./plugin.ts";

const entry = fileURLToPath(import.meta.url);
if (checkPluginArgv([...process.execArgv, ...process.argv.slice(1)], {
	pluginDir: path.dirname(entry), entry,
}).length !== 0 || process.permission?.has("net") !== false) {
	throw new Error("DYTEST production invocation required");
}
serve(callerInputPlugin().entry);
