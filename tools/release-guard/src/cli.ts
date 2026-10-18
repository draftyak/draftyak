import path from "node:path";
import { parseArgs } from "node:util";
import { guardRelease } from "./guard.ts";
import { localPath, read } from "./integrity.ts";

const usage = `usage: pnpm guard:release --manifest <release.json> --root <staged-directory> [--repo <repository>] [--scope full|artifacts] [--json]
  Read-only inspection. The manifest must live outside the staged directory.
  Default scope full fails until every release gate has a real product inspector.
  Scope artifacts validates supplied artifacts only; success is not release approval.
  No arguments: usage and exit 2. --help: exit 0. Findings: exit 1. Input errors: exit 2.`;

export async function main(argv: readonly string[]): Promise<number> {
	try {
		const { values } = parseArgs({
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			options: {
				manifest: { type: "string" },
				root: { type: "string" },
				repo: { type: "string" },
				scope: { type: "string", default: "full" },
				json: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
		});
		if (values.help) {
			console.log(usage);
			return 0;
		}
		if (
			!values.manifest ||
			!values.root ||
			(values.scope !== "full" && values.scope !== "artifacts")
		) {
			console.error(usage);
			return 2;
		}
		const input = localPath(values.manifest);
		const root = localPath(values.root);
		const repo = localPath(values.repo ?? process.cwd());
		const report = await guardRelease(
			JSON.parse(read(path.dirname(input), path.basename(input)).toString("utf8")),
			{
				root,
				repo,
				scope: values.scope,
			},
		);
		if (values.json) console.log(JSON.stringify(report, null, 2));
		else {
			for (const finding of report.findings) console.log(`${finding.check}: ${finding.reason}`);
			console.log(
				`release-guard: ${report.findings.length} findings; ${report.checks.length} checks passed; scope ${report.scope}${report.scope === "artifacts" ? " (not release readiness)" : ""}`,
			);
		}
		return report.findings.length ? 1 : 0;
	} catch (error) {
		console.error(`release-guard: ${error instanceof Error ? error.message : String(error)}`);
		return 2;
	}
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
