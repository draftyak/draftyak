import path from "node:path";
import { parseArgs } from "node:util";
import type { StartProblem } from "./lib/bootstrap.ts";
import type { GateResult } from "./lib/gate.ts";
import type { Profile, Step, StepContext, StepOutcome } from "./lib/registry.ts";

// Static imports are node: built-ins and types only. main() parses its arguments, then runs the
// start check, the flag check and the input gate on this checkout, in that order, and only then
// loads the registry, which imports every step and profile, and the steps' context; every child of a
// step gets DRAFTYAK_GATE_ROOT.

const here = import.meta.dirname;
const root = path.resolve(here, "..", "..");
const usage = [
	"usage: pnpm verify [--profile <name>] [--list]",
	"       node tools/verify/verify.ts --profile docs   (before pnpm install)",
].join("\n");

export interface Dirs {
	readonly steps: string;
	readonly profiles: string;
}

interface Result {
	readonly step: Step;
	readonly outcome: StepOutcome;
	readonly ms: number;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function duration(ms: number): string {
	return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

async function runStep(step: Step, ctx: StepContext, label: string): Promise<Result> {
	console.log(`\nverify: ${label}`);
	const started = performance.now();
	let outcome: StepOutcome;
	try {
		outcome = await step.run(ctx);
	} catch (error) {
		outcome = { status: "failed", reason: message(error) };
	}
	const ms = performance.now() - started;
	const reason = outcome.status === "passed" ? "" : ` (${outcome.reason})`;
	console.log(`verify: ${label} ${outcome.status} in ${duration(ms)}${reason}`);
	return { step, outcome, ms };
}

function list(profiles: readonly Profile[], steps: readonly Step[]): void {
	for (const profile of profiles) {
		const names = profile.select(steps).map((step) => step.name);
		console.log(`${profile.name}: ${profile.description}`);
		console.log(`  steps: ${names.join(", ") || "none"}`);
	}
}

export interface VerifyDeps {
	// checkStart on this entry and HELPERS.verify; by default the inline start check, then that.
	readonly startCheck?: () => readonly StartProblem[];
	// The input gate on this checkout; by default lib/gate.ts's runGate.
	readonly gate?: () => Promise<GateResult>;
}

export async function main(
	argv: readonly string[],
	dirs: Dirs = { steps: path.join(here, "steps"), profiles: path.join(here, "profiles") },
	deps: VerifyDeps = {},
): Promise<number> {
	let options: { profile: string; list: boolean; help: boolean };
	try {
		({ values: options } = parseArgs({
			// pnpm passes a leading `--` through from bash and cmd; PowerShell's pnpm.ps1 drops it.
			args: argv[0] === "--" ? argv.slice(1) : [...argv],
			options: {
				profile: { type: "string", default: "default" },
				list: { type: "boolean", default: false },
				help: { type: "boolean", short: "h", default: false },
			},
		}));
	} catch (error) {
		console.error(`verify: ${message(error)}\n${usage}`);
		return 2;
	}
	if (options.help) {
		console.log(usage);
		return 0;
	}
	// The start check before any helper loads, a refused flag value before any step, and the
	// input gate before the registry loads the steps and profiles.
	if (deps.startCheck === undefined) {
		const early = startCheckLines(root);
		if (early.length > 0) {
			for (const line of early) console.error(line);
			return 1;
		}
	}
	const bootstrap = await import("./lib/bootstrap.ts");
	const startCheck =
		deps.startCheck ??
		(() =>
			bootstrap.checkStart(
				bootstrap.realRoot(here, 2),
				process.argv[1] ?? "",
				bootstrap.HELPERS.verify,
			));
	const problems = startCheck();
	if (problems.length > 0) {
		for (const line of bootstrap.startLines(problems)) console.error(line);
		return 1;
	}
	const { reservedTestsOn } = await import("../../reserved-tests.ts");
	try {
		reservedTestsOn(process.env);
	} catch (error) {
		console.error(`verify: ${message(error)}`);
		return 2;
	}
	const gate =
		deps.gate ??
		(async () => (await import("./lib/gate.ts")).runGate({ root: bootstrap.realRoot(here, 2) }));
	let result: GateResult | null;
	try {
		result = await gate();
	} catch {
		result = null;
	}
	const listing = result?.ok === true ? result.listing : null;
	if (listing === null) {
		for (const line of result?.lines ?? [bootstrap.GATE_FAILED, bootstrap.START_STOP_LINE]) {
			console.error(line);
		}
		return 1;
	}
	for (const line of result?.lines ?? []) console.log(line);

	const [{ loadProfiles, loadSteps }, { context }, { run }, { telemetryOff }] = await Promise.all([
		import("./lib/registry.ts"),
		import("./lib/context.ts"),
		import("./lib/spawn.ts"),
		import("./lib/tools.ts"),
	]);
	Object.assign(process.env, telemetryOff);

	let steps: Step[];
	let profiles: Profile[];
	try {
		[steps, profiles] = await Promise.all([loadSteps(dirs.steps), loadProfiles(dirs.profiles)]);
	} catch (error) {
		console.error(`verify: ${message(error)}`);
		return 2;
	}
	if (options.list) {
		list(profiles, steps);
		return 0;
	}
	const profile = profiles.find((candidate) => candidate.name === options.profile);
	if (profile === undefined) {
		const known = profiles.map((candidate) => candidate.name).join(", ");
		console.error(`verify: unknown profile "${options.profile}" (known: ${known})`);
		return 2;
	}

	const selected = profile.select(steps);
	console.log(
		`verify: profile ${profile.name}: ${selected.map((s) => s.name).join(", ") || "no steps"}`,
	);
	// The steps' children, and turbo's tasks through them, get the launcher marker.
	const ctx = context(profile, run, { ...process.env, [bootstrap.GATE_ROOT_ENV]: listing.root });
	const results: Result[] = [];
	for (const [index, step] of selected.entries()) {
		results.push(await runStep(step, ctx, `[${index + 1}/${selected.length}] ${step.name}`));
	}

	const width = Math.max(0, ...results.map((result) => result.step.name.length));
	const statusWidth = Math.max(7, ...results.map((result) => result.outcome.status.length));
	console.log(`\nverify: summary (profile ${profile.name})`);
	for (const { step, outcome, ms } of results) {
		const reason = outcome.status === "passed" ? "" : `  ${outcome.reason}`;
		const status = outcome.status.padEnd(statusWidth);
		console.log(`  ${status}  ${step.name.padEnd(width)}  ${duration(ms)}${reason}`);
	}
	const count = (status: StepOutcome["status"]): number =>
		results.filter((result) => result.outcome.status === status).length;
	const [passed, failed, skipped] = [count("passed"), count("failed"), count("skipped")];
	const incomplete = count("incomplete");
	const total = results.reduce((sum, result) => sum + result.ms, 0);
	console.log(`verify: total ${duration(total)}`);
	const notes = [
		...(incomplete > 0 ? [`, ${incomplete} incomplete`] : []),
		...(skipped > 0 ? [`, ${skipped} skipped`] : []),
	];
	console.log(`verify: ${passed}/${passed + failed + incomplete} steps passed${notes.join("")}`);
	// An incomplete step is never a pass (the reserved files' maintainer's run is missing), and
	// 3 tells it apart from a failure.
	return failed > 0 ? 1 : incomplete > 0 ? 3 : 0;
}

// start check
function startCheckLines(root: string): string[] {
	const nodeFs = process.getBuiltinModule("node:fs");
	const nodePath = process.getBuiltinModule("node:path");
	const fold = (file: string): string => {
		const slashed = file.split(nodePath.sep).join("/");
		if (process.platform === "win32") return slashed.toLowerCase();
		return process.platform === "darwin" ? slashed.normalize("NFC").toLowerCase() : slashed;
	};
	const stopped = [
		"reserved tripwire: 1 start file(s) or folder(s) failed their kind check; nothing was loaded",
		"reserved tripwire: stopped before anything was built or tested. Reserved code may sit only in the allowed reserved roots, and no Rust or Cargo may use a reserved name or feature, until that code has its own reviewed gating design; every listed file, every file one of them names and every file a tool would pick up from a folder it scans must be a regular, listed file of this checkout, inside real folders. Don't open the files or follow the links: send this log's path to the reserved files' maintainer.",
	];
	// From the root's real path down: a link or 8.3 alias above the root changes nothing below it.
	let folder: string;
	try {
		folder = nodeFs.realpathSync.native(root);
	} catch {
		return stopped;
	}
	for (const [index, name] of ["tools", "verify", "lib", "bootstrap.ts"].entries()) {
		const at = nodePath.join(folder, name);
		let plain = false;
		try {
			const entry = nodeFs
				.readdirSync(folder, { withFileTypes: true })
				.find((item) => fold(item.name) === fold(name));
			const stat = nodeFs.lstatSync(at, { bigint: true });
			const kind = index === 3 ? stat.isFile() && stat.nlink === 1n : stat.isDirectory();
			plain =
				entry !== undefined &&
				!entry.isSymbolicLink() &&
				!stat.isSymbolicLink() &&
				kind &&
				fold(nodeFs.realpathSync.native(at)) === fold(at);
		} catch {
			plain = false;
		}
		if (!plain) return stopped;
		folder = at;
	}
	return [];
}
// end start check

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
