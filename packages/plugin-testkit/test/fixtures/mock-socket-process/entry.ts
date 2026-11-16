import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginArgv } from "@draftyak/protocol/plugin-argv";
import { serve } from "@draftyak/sdk";
import { socketProcessPlugin } from "./plugin.ts";

const entry = fileURLToPath(import.meta.url);
if (checkPluginArgv([...process.execArgv, ...process.argv.slice(1)], {
	pluginDir: path.dirname(entry), entry,
}).length || !process.permission || process.permission.has("net")) {
	throw new Error("DYTEST plugin launch refused");
}
serve(socketProcessPlugin().entry);
