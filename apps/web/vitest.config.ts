import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { heavyVitestConfig } from "../../vitest.shared.ts";

type WebVitestConfig = ViteUserConfig & {
	test: NonNullable<ViteUserConfig["test"]>;
};

export default function webVitestConfig(env: ConfigEnv): WebVitestConfig {
	const config = heavyVitestConfig(env);
	return { ...config, test: { ...config.test, passWithNoTests: false } };
}
