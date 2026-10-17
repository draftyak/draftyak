import { writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { check, formatProblem } from "./adr.ts";
import { renderIndex, renderReport } from "./render.ts";

const usage = [
	"usage: pnpm adr             check docs/adr: template, file names, header, sections, kept tests",
	"       pnpm adr --index     also write docs/adr/README.md",
	"       pnpm adr --report    print the M0 gate's spike table (m0-gate.md §1)",
].join("\n");

export function main(argv: readonly string[], root: string): number {
	let options: { index?: boolean; report?: boolean; help?: boolean };
	try {
		({ values: options } = parseArgs({
			// pnpm passes a leading `--` through from bash and cmd; PowerShell's pnpm.ps1 drops it.
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			options: {
				index: { type: "boolean" },
				report: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		console.error(`adr: ${error instanceof Error ? error.message : String(error)}\n${usage}`);
		return 2;
	}
	if (options.help) {
		console.log(usage);
		return 0;
	}
	if (options.index && options.report) {
		console.error(`adr: --index and --report can't be combined\n${usage}`);
		return 2;
	}
	const { adrs, problems } = check(root);
	const count = problems.length;
	const summary = `${adrs.length} ADR${adrs.length === 1 ? "" : "s"}, ${count} problem${count === 1 ? "" : "s"}`;
	if (count > 0) {
		for (const problem of problems) console.error(formatProblem(problem));
		console.error(summary);
		return 1;
	}
	if (options.report) {
		console.log(renderReport(adrs));
		return 0;
	}
	if (options.index) {
		writeFileSync(path.join(root, "docs", "adr", "README.md"), renderIndex(adrs));
		console.log("adr: wrote docs/adr/README.md");
	}
	console.log(summary);
	return 0;
}

if (import.meta.main) {
	process.exitCode = main(process.argv.slice(2), path.resolve(import.meta.dirname, "../../.."));
}
