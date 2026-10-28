import { loadRun, readJson, verifyCliPackage } from "./artifacts.ts";
import { evaluateRuns } from "./gate.ts";
import { ERAS } from "./policy.ts";

const usage = "Usage: node tools/mcp-conformance/cli.ts --legacy <directory> --modern <directory>";

/** Validation only: no server, subprocess, network request, environment read or file write. */
export async function main(argv: readonly string[]): Promise<number> {
	const args = argv[0] === "--" ? argv.slice(1) : argv.slice();
	if (args.length === 1 && args[0] === "--help") {
		process.stdout.write(`${usage}\n`);
		return 0;
	}
	if (
		args.length !== 4 ||
		args[0] !== "--legacy" ||
		args[2] !== "--modern" ||
		!args[1] ||
		!args[3]
	) {
		process.stderr.write(`${usage}\n`);
		return 2;
	}
	try {
		await verifyCliPackage();
		const baseline = await readJson(
			new URL("../../security/mcp-conformance-baseline.json", import.meta.url),
		);
		const report = evaluateRuns(baseline, [
			await loadRun(args[1], ERAS[0]),
			await loadRun(args[3], ERAS[1]),
		]);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		return report.passed ? 0 : 1;
	} catch {
		process.stderr.write(
			"Conformance artifacts refused; check the pin, receipts and suite outputs.\n",
		);
		return 2;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
