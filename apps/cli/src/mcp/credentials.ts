export const LOCAL_MCP_URL = "http://127.0.0.1:47613/mcp";
export const CLIENTS: readonly string[] = Object.freeze([
	"claude-desktop",
	"claude-code",
	"codex",
	"vscode",
]);

export class BridgeRefusal extends Error {
	constructor() {
		super("DraftYak MCP bridge refused.");
	}
}

/** The owner supplies an existing agent credential; this never mints or authorizes one. */
export function agentCredential(raw: unknown): string {
	if (typeof raw !== "string" || raw.length > 4096) throw new BridgeRefusal();
	const token = raw.trim();
	if (!/^[A-Za-z0-9._~+/-]+=*$/.test(token)) throw new BridgeRefusal();
	return token;
}

export function localEndpoint(raw: string): URL {
	const url = new URL(raw);
	if (
		url.protocol !== "http:" ||
		!["127.0.0.1", "[::1]"].includes(url.hostname) ||
		url.username ||
		url.password ||
		url.pathname !== "/mcp" ||
		url.search ||
		url.hash ||
		url.href !== raw
	)
		throw new BridgeRefusal();
	return url;
}
