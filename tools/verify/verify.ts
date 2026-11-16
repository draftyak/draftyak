import path from "node:path";
import { parseArgs } from "node:util";
import {
	loadProfiles,
	loadSteps,
	type Profile,
	type Step,
	type StepContext,
	type StepOutcome,
} from "./lib/registry.ts";
import {
	type ChildLifecycleEvent,
	capture,
	type Invocation,
	type RunOptions,
	run,
} from "./lib/spawn.ts";
import { resolveBiome, resolvePnpm, resolveTurbo, telemetryOff } from "./lib/tools.ts";

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

function lazy<T>(resolve: () => T): () => T {
	let value: T | undefined;
	return () => {
		value ??= resolve();
		return value;
	};
}

export type DirectInvocationTool = "run" | "capture" | "node" | "pnpm" | "turbo" | "biome";
export type DirectInvocationKind = DirectInvocationTool | "test/verify" | "test/remaining";

export function directInvocationKind(
	tool: DirectInvocationTool,
	step: string,
	args: readonly string[],
): DirectInvocationKind {
	if (
		tool === "turbo" &&
		step === "test" &&
		args.length === 3 &&
		args[0] === "run" &&
		args[1] === "test"
	) {
		if (args[2] === "--filter=@draftyak/verify") return "test/verify";
		if (args[2] === "--filter=!@draftyak/verify") return "test/remaining";
	}
	return tool;
}

function technicalName(value: string): string {
	return /^[a-z][a-z0-9-]{0,63}$/.test(value) ? value : "other";
}

/** Metadata from this direct child only; child output and command details are not inputs. */
export function childLifecycleLine(
	profile: string,
	step: string,
	kind: DirectInvocationKind,
	event: ChildLifecycleEvent,
): string {
	return (
		"verify: child " +
		JSON.stringify({
			version: 1,
			profile: technicalName(profile),
			step: technicalName(step),
			kind,
			event: event.type,
			invocationId: event.invocationId,
			pid: event.pid,
			code: event.type === "exit" || event.type === "close" ? event.code : null,
			signal: event.type === "exit" || event.type === "close" ? event.signal : null,
			errorCode: event.type === "error" ? event.errorCode : null,
		})
	);
}

function context(profile: Profile, activeStep: () => string): StepContext {
	const env = process.env;
	const at = (
		tool: DirectInvocationTool,
		args: readonly string[],
		options?: RunOptions,
	): RunOptions => {
		const step = activeStep();
		const kind = directInvocationKind(tool, step, args);
		const observer = options?.onLifecycle;
		return {
			cwd: root,
			...options,
			env: { ...env, ...options?.env },
			onLifecycle: (event) => {
				try {
					console.log(childLifecycleLine(profile.name, step, kind, event));
				} finally {
					observer?.(event);
				}
			},
		};
	};
	const pnpm = lazy(() => resolvePnpm(env));
	const turbo = lazy(() => resolveTurbo(root));
	const biome = lazy(() => resolveBiome(root));
	const withArgs = (base: Invocation, args: readonly string[]): Invocation => ({
		command: base.command,
		args: [...base.args, ...args],
	});
	return {
		root,
		profile: profile.name,
		env,
		run: (command, args, options) => run({ command, args }, at("run", args, options)),
		capture: (command, args, options) => capture({ command, args }, at("capture", args, options)),
		node: (args, options) => run({ command: process.execPath, args }, at("node", args, options)),
		pnpm: (args, options) => run(withArgs(pnpm(), args), at("pnpm", args, options)),
		turbo: (args, options) => run({ command: turbo(), args }, at("turbo", args, options)),
		biome: (args, options) => run({ command: biome(), args }, at("biome", args, options)),
	};
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

export async function main(
	argv: readonly string[],
	dirs: Dirs = { steps: path.join(here, "steps"), profiles: path.join(here, "profiles") },
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
	let activeStep = "none";
	const ctx = context(profile, () => activeStep);
	const results: Result[] = [];
	for (const [index, step] of selected.entries()) {
		activeStep = step.name;
		try {
			results.push(await runStep(step, ctx, `[${index + 1}/${selected.length}] ${step.name}`));
		} finally {
			activeStep = "none";
		}
	}

	const width = Math.max(0, ...results.map((result) => result.step.name.length));
	console.log(`\nverify: summary (profile ${profile.name})`);
	for (const { step, outcome, ms } of results) {
		const reason = outcome.status === "passed" ? "" : `  ${outcome.reason}`;
		console.log(
			`  ${outcome.status.padEnd(7)}  ${step.name.padEnd(width)}  ${duration(ms)}${reason}`,
		);
	}
	const count = (status: StepOutcome["status"]): number =>
		results.filter((result) => result.outcome.status === status).length;
	const [passed, failed, skipped] = [count("passed"), count("failed"), count("skipped")];
	const total = results.reduce((sum, result) => sum + result.ms, 0);
	console.log(`verify: total ${duration(total)}`);
	console.log(
		`verify: ${passed}/${passed + failed} steps passed${skipped > 0 ? `, ${skipped} skipped` : ""}`,
	);
	return failed > 0 ? 1 : 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
