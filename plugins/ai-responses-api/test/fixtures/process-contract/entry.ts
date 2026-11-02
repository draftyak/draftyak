import { fileURLToPath } from "node:url";
import { checkPluginArgv } from "@draftyak/protocol/plugin-argv";
import { startPlugin } from "../../../src/plugin.ts";

const entry = fileURLToPath(import.meta.url);
if (
	checkPluginArgv([...process.execArgv, ...process.argv.slice(1)], {
		pluginDir: import.meta.dirname,
		entry,
	}).length !== 0 ||
	!process.permission ||
	process.permission.has("net")
)
	throw new Error("Provider process fixture requires production permissions");

startPlugin();
