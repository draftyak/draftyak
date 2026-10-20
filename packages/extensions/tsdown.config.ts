import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: ["src/*.ts", "src/points/*.ts"],
	unbundle: true,
	format: "esm",
	platform: "node",
	fixedExtension: true,
	dts: { generator: "oxc" },
};

export default config;
