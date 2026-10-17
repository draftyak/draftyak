import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { spikeVitestConfig } from "./vitest.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	return spikeVitestConfig(env);
}
