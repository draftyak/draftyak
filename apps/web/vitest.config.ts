import { type ConfigEnv, mergeConfig, type ViteUserConfig } from "vitest/config";
import { vitestConfig } from "../../vitest.shared.ts";
import webConfig from "./vite.config.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	const base = vitestConfig(env);
	return mergeConfig(webConfig, {
		...base,
		test: { ...base.test, environment: "jsdom" },
	});
}
