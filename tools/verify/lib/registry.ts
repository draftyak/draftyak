import { readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Captured, RunOptions } from "./spawn.ts";

export type StepOutcome =
	| { readonly status: "passed" }
	| { readonly status: "failed" | "skipped"; readonly reason: string };

// Every spawn goes through these helpers: no shell, no .cmd shims, cwd at the repo root.
export interface StepContext {
	readonly root: string;
	readonly profile: string;
	readonly env: NodeJS.ProcessEnv;
	run(command: string, args: readonly string[], options?: RunOptions): Promise<number>;
	capture(command: string, args: readonly string[], options?: RunOptions): Promise<Captured>;
	node(args: readonly string[], options?: RunOptions): Promise<number>;
	pnpm(args: readonly string[], options?: RunOptions): Promise<number>;
	turbo(args: readonly string[], options?: RunOptions): Promise<number>;
	biome(args: readonly string[], options?: RunOptions): Promise<number>;
}

// One file per step in steps/, exporting `step`, and per profile in profiles/, exporting `profile`;
// `name` must match the file name. verify imports every one of them before it picks a profile, even
// before pnpm install, so they import only node: built-ins and relative files and run tools via ctx.
export interface Step {
	readonly name: string;
	readonly order: number;
	readonly profiles: readonly string[];
	run(ctx: StepContext): Promise<StepOutcome>;
}

export interface Profile {
	readonly name: string;
	readonly description: string;
	select(steps: readonly Step[]): readonly Step[];
}

export function fromExitCode(code: number): StepOutcome {
	return code === 0 ? { status: "passed" } : { status: "failed", reason: `exit code ${code}` };
}

export function stepsFor(profile: string, steps: readonly Step[]): readonly Step[] {
	return steps
		.filter((step) => step.profiles.includes(profile))
		.toSorted((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

function isStep(value: unknown): value is Step {
	const step = value as Partial<Step> | undefined;
	return (
		typeof step?.name === "string" &&
		typeof step.order === "number" &&
		Array.isArray(step.profiles) &&
		typeof step.run === "function"
	);
}

function isProfile(value: unknown): value is Profile {
	const profile = value as Partial<Profile> | undefined;
	return (
		typeof profile?.name === "string" &&
		typeof profile.description === "string" &&
		typeof profile.select === "function"
	);
}

async function loadAll<T extends { readonly name: string }>(
	dir: string,
	key: string,
	valid: (value: unknown) => value is T,
): Promise<T[]> {
	const files = readdirSync(dir)
		.filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts") && !file.endsWith(".d.ts"))
		.toSorted();
	const loaded: T[] = [];
	for (const file of files) {
		const name = path.basename(file, ".ts");
		const exported: Record<string, unknown> = await import(
			pathToFileURL(path.join(dir, file)).href
		);
		const value = exported[key];
		if (!valid(value) || value.name !== name) {
			throw new Error(`${path.join(dir, file)} must export a ${key} named "${name}"`);
		}
		loaded.push(value);
	}
	return loaded;
}

export function loadSteps(dir: string): Promise<Step[]> {
	return loadAll(dir, "step", isStep);
}

export function loadProfiles(dir: string): Promise<Profile[]> {
	return loadAll(dir, "profile", isProfile);
}
