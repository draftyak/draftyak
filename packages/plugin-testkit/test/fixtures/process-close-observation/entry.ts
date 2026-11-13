import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginArgv } from "@draftyak/protocol/plugin-argv";
import { serve } from "@draftyak/sdk/serve";
import { stdioHost } from "@draftyak/sdk/stdio";
import { CLOSE_MODES, closeObservationPlugin } from "./plugin.ts";

const entry = fileURLToPath(import.meta.url);
const argv = [...process.execArgv, ...process.argv.slice(1)];
const mode = CLOSE_MODES.find((candidate) => checkPluginArgv(argv, {
	pluginDir: path.dirname(entry), entry, entryArgs: [candidate],
}).length === 0);
if (mode === undefined || process.permission?.has("net") !== false)
	throw new Error("DYTEST production invocation required");

const host = stdioHost();
serve(closeObservationPlugin(mode).entry, { host });
