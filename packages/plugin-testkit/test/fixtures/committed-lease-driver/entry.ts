import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginArgv } from "@draftyak/protocol/plugin-argv";
import { serve } from "@draftyak/sdk/serve";
import { stdioHost } from "@draftyak/sdk/stdio";
import { committedLeasePlugin, LEASE_SCENARIOS } from "./plugin.ts";

const entry = fileURLToPath(import.meta.url);
const argv = [...process.execArgv, ...process.argv.slice(1)];
const scenario = LEASE_SCENARIOS.find((candidate) => checkPluginArgv(argv, {
	pluginDir: path.dirname(entry), entry, entryArgs: [candidate],
}).length === 0);
if (scenario === undefined || process.permission?.has("net") !== false)
	throw new Error("DYTEST production invocation required");

const host = stdioHost();
if (scenario === "error-flag") {
	const send = host.transport.send.bind(host.transport);
	host.transport.send = async (message, options) => {
		if ("result" in message && message.result && typeof message.result === "object" &&
			"structuredContent" in message.result && message.result.structuredContent &&
			typeof message.result.structuredContent === "object" && "leaseMs" in message.result.structuredContent) {
			return send({ ...message, result: { ...message.result, isError: true } }, options);
		}
		return send(message, options);
	};
}
serve(committedLeasePlugin(undefined, host, undefined, scenario).entry, { host });
