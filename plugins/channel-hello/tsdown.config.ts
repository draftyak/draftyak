import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: ["src/server.ts"],
	format: "esm",
	platform: "node",
	fixedExtension: true,
	noExternal: [/.*/],
};
export default config;
