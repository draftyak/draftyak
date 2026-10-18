import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";

export default function config(env: ConfigEnv): ViteUserConfig {
	return spikeVitestConfig(env);
}
