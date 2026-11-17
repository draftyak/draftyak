import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: ["src/index.ts"],
	format: "esm",
	platform: "browser",
	fixedExtension: true,
	dts: { generator: "oxc" },
};

export default config;
