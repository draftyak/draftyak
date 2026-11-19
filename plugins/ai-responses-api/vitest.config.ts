import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { heavyVitestConfig } from "../../vitest.shared.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	const base = heavyVitestConfig(env);
	return { ...base, test: { ...base.test, maxWorkers: 1 } };
}
