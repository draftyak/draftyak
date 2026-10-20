import { stdioHost } from "../../src/stdio.ts";

const host = stdioHost();
try {
	await host.request("host/fetch", { method: "GET", url: "https://example.invalid/", headers: [] });
	await host.request("host/ws.open", { url: "wss://example.invalid/" });
	await host.request("host/ws.send", { socketId: "s", envelopeId: "e" });
	await host.request("host/ws.close", { socketId: "s" });
	await host.request("host/kv.get", { key: "key" });
	await host.request("host/kv.set", { key: "key", value: "safe" });
	await host.request("host/kv.delete", { key: "key" });
	await host.request("host/changed", {});
	await host.request("host/log", { level: "info", message: "safe" });
	await host.request("host/progress", { token: "t", progress: 1 });
	process.stdout.write('{"jsonrpc":"2.0","id":"done","result":null}\n', () => { host.close(); process.exit(0); });
} catch { host.close(); process.exitCode = 1; }
