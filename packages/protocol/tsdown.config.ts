import type { UserConfig } from "tsdown";

// One .mjs and .d.mts per module. Declarations come from isolated declarations through Oxc, so no
// TypeScript API is loaded (TypeScript 7's package exports none).
const config: UserConfig = {
	entry: ["src/*.ts"],
	unbundle: true,
	format: "esm",
	platform: "node",
	fixedExtension: true,
	dts: { generator: "oxc" },
};

export default config;
