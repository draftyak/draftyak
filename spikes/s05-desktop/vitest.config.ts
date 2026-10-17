import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";

export default function config(env: ConfigEnv): ViteUserConfig {
	const base = spikeVitestConfig(env);
	// ekm.heavy and sidecar.heavy each run cargo builds; one file at a time keeps them from competing.
	return { ...base, test: { ...base.test, fileParallelism: false } };
}
