import { snapshotArgv } from "./argv.ts";
import { commandNames, loadCommand } from "./command-loader.ts";
import { isCliExitCode } from "./payload-contract.ts";
import { diagnostic } from "./refusal.ts";

export async function main(argv: readonly string[]): Promise<number> {
	try {
		const args = snapshotArgv(argv);
		const name = args.length === 0 || args[0] === "--help" || args[0] === "-h" ? "help" : args[0];
		const names = commandNames();
		if (name === undefined || !names.includes(name)) {
			diagnostic();
			return 2;
		}
		if (name === "help") for (const installed of names) await loadCommand(installed);
		const command = await loadCommand(name);
		const exit = await command.run(
			args,
			Object.freeze({
				commands: names,
				stderr: (text: string): void => {
					process.stderr.write(text);
				},
			}),
		);
		if (!isCliExitCode(exit)) {
			diagnostic();
			return 1;
		}
		return exit;
	} catch {
		diagnostic();
		return 1;
	}
}
