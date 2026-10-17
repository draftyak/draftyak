import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";

// The heavy files run in turn in one worker, so their evidence shares one fingerprint.
export default function config(env: ConfigEnv): ViteUserConfig {
	const base = spikeVitestConfig(env);
	if (env.mode !== "heavy") return base;
	return { ...base, test: { ...base.test, fileParallelism: false, isolate: false } };
}
