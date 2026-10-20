import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: ["src/*.ts"],
	unbundle: true,
	format: "esm",
	platform: "node",
	fixedExtension: true,
	deps: { neverBundle: ["@draftyak/protocol", "openai", "zod"] },
	dts: { generator: "oxc" },
};
export default config;
