import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";

export default function config(env: ConfigEnv): ViteUserConfig {
	const base = spikeVitestConfig(env);
	if (env.mode !== "heavy") return base;
	// The budgets hold the machine lock after its idle check, so heavy files run one at a time and
	// never load the machine while another file measures.
	return { ...base, test: { ...base.test, fileParallelism: false } };
}
