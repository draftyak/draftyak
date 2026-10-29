import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { absolutePath, bundleOutputPath, diagnosticMessage } from "./files.mjs";
import { planMcpbBundle, readMcpbPlan, writeMcpbBundle } from "./index.mjs";

export function main(args = process.argv.slice(2)) {
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(
			"Usage: node tools/mcpb/cli.mjs --plan ABSOLUTE_JSON [--output NEW_ABSOLUTE_FILE.mcpb]\n",
		);
		return 0;
	}
	try {
		if (
			(args.length !== 2 && args.length !== 4) ||
			args[0] !== "--plan" ||
			(args.length === 4 && args[2] !== "--output")
		)
			throw new Error();
		absolutePath(args[1]);
		if (args.length === 4) bundleOutputPath(args[3]);
		const plan = planMcpbBundle(readMcpbPlan(args[1]));
		if (args.length === 4) writeMcpbBundle(plan, args[3]);
		process.stdout.write(`${JSON.stringify(plan.summary)}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`${diagnosticMessage(error)}\n`);
		return 2;
	}
}
let entry = false;
try {
	entry =
		!!process.argv[1] &&
		realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
	// Importing the CLI does not require the caller's entry path to exist.
}
if (entry) process.exitCode = main();
