import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { heavyVitestConfig } from "../../vitest.shared.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	return heavyVitestConfig(env);
}
