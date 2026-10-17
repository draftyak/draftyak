import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";

// The unit tier (mode "test") runs offline through test/offline.ts.
export default function config(env: ConfigEnv): ViteUserConfig {
	const base = spikeVitestConfig(env);
	if (env.mode !== "test") return base;
	return { ...base, test: { ...base.test, setupFiles: ["./test/offline.ts"] } };
}
