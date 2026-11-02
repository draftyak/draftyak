import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: ["src/reduce.ts", "src/poll.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: true,
	dts: { generator: "oxc" },
};

export default config;
