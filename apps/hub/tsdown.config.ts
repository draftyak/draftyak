import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
	entry: ["src/index.ts"],
	format: "esm",
	platform: "node",
	dts: { generator: "oxc" },
});

export default config;
