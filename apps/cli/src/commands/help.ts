import type { Command, CommandContext } from "../command-contract.ts";

export const command: Command = Object.freeze({
	name: "help",
	async run(argv: readonly string[], context: CommandContext): Promise<number> {
		if (argv.length > 1) return 2;
		context.stderr(`Usage: draftyak <command>\nCommands:\n${context.commands.join("\n")}\n`);
		return 0;
	},
});
