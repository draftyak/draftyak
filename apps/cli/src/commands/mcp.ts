import type { Command, CommandContext } from "../command-contract.ts";
import { startBridge } from "../mcp/bridge.ts";
import { agentCredential, CLIENTS, LOCAL_MCP_URL } from "../mcp/credentials.ts";
import { BoundedStdio } from "../mcp/stdio.ts";

export const command: Command = Object.freeze({
	name: "mcp",
	async run(argv: readonly string[], context: CommandContext): Promise<number> {
		if (argv.length !== 3 || argv[1] !== "--client" || !CLIENTS.includes(argv[2] ?? "")) {
			context.stderr("Usage: draftyak mcp --client <name>\n");
			return 2;
		}
		let token: string;
		try {
			token = agentCredential(process.env.DRAFTYAK_TOKEN);
		} catch {
			context.stderr("draftyak: an existing agent token is required.\n");
			return 2;
		}
		try {
			const transport = new BoundedStdio();
			await startBridge(transport, { hub: { url: LOCAL_MCP_URL, token } });
			return await transport.completion;
		} catch {
			context.stderr("draftyak: the local MCP service is unavailable or refused this token.\n");
			return 1;
		}
	},
});
