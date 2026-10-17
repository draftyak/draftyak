import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";

export default function config(env: ConfigEnv): ViteUserConfig {
	const base = spikeVitestConfig(env, {
		capabilities: {
			// CI runners are shared VMs billed by the minute (macOS at 10×): their timings aren't worth it.
			"bench-host": {
				description: "a developer machine for benchmarks (not CI)",
				detect: () => !process.env.CI,
			},
			// macOS unlinks temporary files at once and has no /proc to reach them through.
			"temp-file-scan": {
				description: "reading SQLite's open temporary files (Windows, or Linux through /proc)",
				detect: () => process.platform === "win32" || process.platform === "linux",
			},
		},
	});
	if (env.mode !== "heavy") return base;
	// The benchmark's idle check would otherwise see the Docker cases of load.heavy.test.ts.
	return { ...base, test: { ...base.test, fileParallelism: false } };
}
