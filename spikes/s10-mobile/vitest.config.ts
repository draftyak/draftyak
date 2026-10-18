import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { capabilities } from "./src/toolchain.ts";

// The mobile capabilities probe rustc, so only the heavy tier, whose tests use them, asks: in the
// unit tier a rustup proxy could install the pinned toolchain on a runner that has none.
export default function config(env: ConfigEnv): ViteUserConfig {
	return spikeVitestConfig(env, env.mode === "heavy" ? { capabilities: capabilities() } : {});
}
