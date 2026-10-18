import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";

export default function config(env: ConfigEnv): ViteUserConfig {
	const base = spikeVitestConfig(env);
	if (env.mode !== "heavy") return base;
	// The benchmarks and the inspector's fixed port hold the machine lock, so heavy files run one at
	// a time and never load the machine during another file's idle check.
	return { ...base, test: { ...base.test, fileParallelism: false } };
}
