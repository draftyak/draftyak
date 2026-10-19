import { pathToFileURL } from "node:url";
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
		const plan = planMcpbBundle(readMcpbPlan(args[1]));
		if (args.length === 4) writeMcpbBundle(plan, args[3]);
		process.stdout.write(`${JSON.stringify(plan.summary)}\n`);
		return 0;
	} catch {
		process.stderr.write("MCP bundle input or output refused.\n");
		return 2;
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main();
