import { runDoctor } from "@draftyak/doctor";
import type { Command, CommandContext } from "../command-contract.ts";

export const command: Command = Object.freeze({
	name: "doctor",
	async run(argv: readonly string[], context: CommandContext): Promise<number> {
		return runDoctor(argv.slice(1), context.stderr);
	},
});
