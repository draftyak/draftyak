import { defineConfig, type UserConfig } from "tsdown";

// One .mjs and .d.mts per module directly under src/; hono and @hono/node-server stay dependencies.
const config: UserConfig = defineConfig({
	entry: ["src/*.ts"],
	format: "esm",
	platform: "node",
	dts: { generator: "oxc" },
});

export default config;
