import path from "node:path";
import { reservedTurboArgs, withoutReservedTests } from "../../../reserved-tests.ts";
import type { Profile, StepContext } from "./registry.ts";
import { capture, type Invocation, type RunOptions, run } from "./spawn.ts";
import { resolveBiome, resolvePnpm, resolveTurbo } from "./tools.ts";

const root = path.resolve(import.meta.dirname, "..", "..", "..");

function lazy<T>(resolve: () => T): () => T {
	let value: T | undefined;
	return () => {
		value ??= resolve();
		return value;
	};
}

// Every child of a verify step starts here, from the repository root. A child's env leaves
// DRAFTYAK_RESERVED_TESTS out unless the call itself sets it, and each turbo run leaves the reserved
// packages out unless that child's env has the flag on. `start` runs the children and `env` is the
// parent's; tests pass their own, and their own `turboArgs`. verify.ts loads this file only after
// its input gate has passed.
export function context(
	profile: Profile,
	start: typeof run = run,
	env: NodeJS.ProcessEnv = process.env,
	turboArgs: typeof reservedTurboArgs = reservedTurboArgs,
): StepContext {
	const at = (options?: RunOptions): RunOptions => ({
		cwd: root,
		...options,
		env: { ...env, ...withoutReservedTests(env), ...options?.env },
	});
	const pnpm = lazy(() => resolvePnpm(env));
	const turbo = lazy(() => resolveTurbo(root));
	const biome = lazy(() => resolveBiome(root));
	const withArgs = (base: Invocation, args: readonly string[]): Invocation => ({
		command: base.command,
		args: [...base.args, ...args],
	});
	const heavyFilters = profile.heavyFilters?.(root);
	return {
		root,
		profile: profile.name,
		env,
		...(heavyFilters === undefined ? {} : { heavyFilters }),
		run: (command, args, options) => start({ command, args }, at(options)),
		capture: (command, args, options) => capture({ command, args }, at(options)),
		node: (args, options) => start({ command: process.execPath, args }, at(options)),
		pnpm: (args, options) => start(withArgs(pnpm(), args), at(options)),
		turbo: async (args, options) => {
			const child = at(options);
			const filtered = turboArgs(args, child.env ?? {}, root);
			return start({ command: turbo(), args: filtered }, child);
		},
		biome: (args, options) => start({ command: biome(), args }, at(options)),
	};
}
