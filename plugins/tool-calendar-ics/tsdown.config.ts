import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: ["src/*.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: true,
	deps: { neverBundle: ["ical.js", "@draftyak/protocol"] },
	dts: { generator: "oxc" },
};

export default config;
