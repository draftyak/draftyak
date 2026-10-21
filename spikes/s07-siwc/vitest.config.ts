import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { reservedOffConfig, reservedSpikeOff } from "../kit/off.ts";

// The unit tier (mode "test") runs offline through test/offline.ts.
export default async function config(env: ConfigEnv): Promise<ViteUserConfig> {
	if (reservedSpikeOff(import.meta.dirname)) return reservedOffConfig();
	const { spikeVitestConfig } = await import("@draftyak/spike-kit/vitest");
	const base = spikeVitestConfig(env);
	if (env.mode !== "test") return base;
	return { ...base, test: { ...base.test, setupFiles: ["./test/offline.ts"] } };
}
