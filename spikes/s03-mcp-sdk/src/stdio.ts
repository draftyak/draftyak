import type { Transport } from "@modelcontextprotocol/server";
import { type StdioServerHandle, serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./server.ts";

// 2026-era serving only: a 2025 `initialize` gets the SDK's readable unsupported-version error and
// the connection stays open for a modern opening.
export function startStdio(transport?: Transport): StdioServerHandle {
	return serveStdio(() => createMcpServer(), {
		legacy: "reject",
		...(transport ? { transport } : {}),
	});
}

if (import.meta.main) startStdio();
