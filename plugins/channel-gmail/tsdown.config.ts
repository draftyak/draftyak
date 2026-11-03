import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: [
		"src/history/page.ts",
		"src/history/reduce.ts",
		"src/history/read.ts",
		"src/boundary.ts",
		"src/decode.ts",
		"src/read.ts",
	],
	root: "src",
	unbundle: true,
	format: "esm",
	platform: "node",
	fixedExtension: true,
	dts: { generator: "oxc" },
};
export default config;
