import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { vitestConfig } from "../../vitest.shared.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	return { ...vitestConfig(env), test: { ...vitestConfig(env).test, fileParallelism: false } };
}
