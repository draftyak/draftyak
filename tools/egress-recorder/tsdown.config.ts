import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: ["src/index.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: true,
	dts: { generator: "oxc" },
	clean: true,
};

export default config;
