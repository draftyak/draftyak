import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { heavyVitestConfig, vitestConfig } from "../../vitest.shared.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	return env.mode === "heavy" ? heavyVitestConfig(env) : vitestConfig(env);
}
