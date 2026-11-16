import { parseArgs } from "node:util";
import { type Finding, listFiles, loadAllow, scanCommits, scanFiles, toplevel } from "./scan.ts";

const usage = [
	"usage: pnpm guard [--json] [--commits <range>]",
	"  Checks the repository's tracked files, and untracked ones that aren't ignored, and their paths",
	"  for vendor references (guardrails 3-6), secret shapes, attribution lines, vendor marks in",
	"  identifiers and, under spikes/**/evidence/, content-shaped strings. Text that may be UTF-16 is",
	"  read as UTF-16 and UTF-8 alike, and compressed content (gzip, zstd, zip entries, PDF streams)",
	"  decompressed, up to 100 times the file's size within 1-64 MiB, 8 levels deep and 50,000",
	"  parts; secret and vendor rules also read lines with string escapes decoded. Files over 16 MiB",
	"  fail unread; compressed content past those caps, encrypted or damaged fails, and so does a",
	"  file whose readings and decoded lines come to over twice its expansion cap in characters,",
	"  each line counting 32 more.",
	"  --commits also checks the commit messages in <range>, such as origin/m0..HEAD. A vendor",
	"  match in a *.md file passes only through a reviewed tools/vendor-guard/allow.json entry",
	"  {path, rule, sha256, reason}, where sha256 is the line's, as its finding prints it. Findings",
	"  name file:line:column (line 0 is the path), the rule and the reason, never the matched text.",
	"  Exit codes: 0 none, 1 findings, 2 usage, git or read errors.",
].join("\n");

const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

function format(finding: Finding): string {
	const where = finding.file ?? `commit ${finding.commit}`;
	const allow = finding.lineSha256 ? ` (allow.json sha256 ${finding.lineSha256})` : "";
	return `${where}:${finding.line}:${finding.column}: ${finding.rule}: ${finding.reason}${allow}`;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;

export function main(argv: readonly string[], cwd: string = process.cwd()): number {
	let options: { json?: boolean; commits?: string; help?: boolean };
	try {
		({ values: options } = parseArgs({
			// pnpm passes a leading `--` through from bash and cmd; PowerShell's pnpm.ps1 drops it.
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			options: {
				json: { type: "boolean" },
				commits: { type: "string" },
				help: { type: "boolean", short: "h" },
			},
		}));
	} catch (error) {
		console.error(`vendor-guard: ${message(error)}\n${usage}`);
		return 2;
	}
	if (options.help) {
		console.log(usage);
		return 0;
	}
	const started = performance.now();
	try {
		const root = toplevel(cwd);
		const files = scanFiles(root, listFiles(root), loadAllow(root));
		const commits = options.commits === undefined ? undefined : scanCommits(root, options.commits);
		const findings = [...files.findings, ...(commits?.findings ?? [])];
		if (options.json) {
			const counts = { files: files.files, commits: commits?.commits ?? null };
			console.log(JSON.stringify({ findings, ...counts }, null, 2));
		} else {
			for (const finding of findings) console.log(format(finding));
			const scope =
				plural(files.files, "file") + (commits ? ` and ${plural(commits.commits, "commit")}` : "");
			const seconds = ((performance.now() - started) / 1000).toFixed(1);
			console.log(`vendor-guard: ${plural(findings.length, "finding")} in ${scope} (${seconds} s)`);
		}
		return findings.length > 0 ? 1 : 0;
	} catch (error) {
		console.error(`vendor-guard: ${message(error)}`);
		return 2;
	}
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
