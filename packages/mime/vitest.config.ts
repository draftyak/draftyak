import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { vitestConfig } from "../../vitest.shared.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	const base = vitestConfig(env);
	return { ...base, test: { ...base.test, maxWorkers: 1 } };
}
