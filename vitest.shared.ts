import { type ConfigEnv, defaultExclude, type ViteUserConfig } from "vitest/config";

export type Tier = "unit" | "heavy" | "live" | "device";

export const tierFiles: Readonly<Record<Tier, string>> = {
	unit: "**/*.test.ts",
	heavy: "**/*.heavy.test.ts",
	live: "**/*.live.test.ts",
	device: "**/*.device.test.ts",
};

// The tier is Vitest's --mode (default "test" = unit): a plain flag, the same in every shell.
export function tierFromMode(mode: string): Tier {
	if (mode === "test") return "unit";
	if (mode === "heavy" || mode === "live" || mode === "device") return mode;
	throw new Error(`unknown test tier "${mode}": use --mode heavy, live or device`);
}

// Vitest 5 never reads a parent folder's config, so each package's vitest.config.ts returns this.
// This file is outside every package's rootDir: a tsconfig that emits must leave vitest.config.ts
// out (include src/ only, or use a separate tsconfig.build.json).
export function vitestConfig(env: ConfigEnv): ViteUserConfig {
	const tier = tierFromMode(env.mode);
	const otherTiers = [tierFiles.heavy, tierFiles.live, tierFiles.device];
	return {
		// No .env loading: live secrets reach tests only through the spike kit.
		envDir: false,
		test: {
			include: [tierFiles[tier]],
			exclude: tier === "unit" ? [...defaultExclude, ...otherTiers] : defaultExclude,
			passWithNoTests: tier !== "unit",
			// Many tests spawn git or a CLI, which can outlast Vitest's 5 s default on 2-core CI runners.
			testTimeout: 30_000,
			hookTimeout: 30_000,
		},
	};
}
