import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";

// Everything in src/ imports only node: built-ins and relative files, so the checks run in CI
// before (or without) pnpm install.

export class UsageError extends Error {}

// Native executables only (git.exe, gh.exe), never through a shell.
export function exec(command: string, args: readonly string[], cwd?: string): string {
	const result = spawnSync(command, [...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 256 * 1024 * 1024,
		windowsHide: true,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = result.stderr.trim() || `exit code ${result.status}`;
		throw new Error(`${command} ${args.join(" ")}: ${detail}`);
	}
	return result.stdout;
}

export function git(args: readonly string[], cwd?: string): string {
	return exec("git", args, cwd);
}

// A revision from env or argv, refused if git could read it as an option.
export function revision(value: string | undefined, name: string): string {
	if (!value || !/^[\w./@^~{}-]+$/.test(value) || value.startsWith("-")) {
		throw new UsageError(`${name} must be a git revision, got ${JSON.stringify(value ?? "")}`);
	}
	return value;
}

// String options only. pnpm passes a leading `--` through from bash and cmd; PowerShell's
// pnpm.ps1 drops it.
export function cliArgs(
	argv: readonly string[],
	names: readonly string[],
): Record<string, string | undefined> {
	const options: ParseArgsOptionsConfig = {};
	for (const name of names) options[name] = { type: "string" };
	try {
		const { values } = parseArgs({ args: argv[0] === "--" ? argv.slice(1) : [...argv], options });
		return values as Record<string, string | undefined>;
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
}

// Step outputs for GitHub Actions; a no-op elsewhere.
export function setOutputs(
	values: Record<string, string>,
	file: string | undefined = process.env.GITHUB_OUTPUT,
): void {
	if (!file) return;
	let text = "";
	for (const [key, value] of Object.entries(values)) {
		const delimiter = `EOF_${randomUUID()}`;
		text += value.includes("\n")
			? `${key}<<${delimiter}\n${value}\n${delimiter}\n`
			: `${key}=${value}\n`;
	}
	appendFileSync(file, text);
}

export function appendSummary(
	markdown: string,
	file: string | undefined = process.env.GITHUB_STEP_SUMMARY,
): void {
	if (file) appendFileSync(file, `${markdown}\n`);
}

// Exit codes: 0 passed, 1 the check failed, 2 a usage or tool error.
export async function runCli(name: string, main: () => number | Promise<number>): Promise<void> {
	try {
		process.exitCode = await main();
	} catch (error) {
		console.error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 2;
	}
}
