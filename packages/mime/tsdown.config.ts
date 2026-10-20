import type { UserConfig } from "tsdown";

const config: UserConfig = {
	entry: ["src/*.ts"],
	unbundle: true,
	format: "esm",
	platform: "node",
	fixedExtension: true,
	dts: { generator: "oxc" },
	deps: { neverBundle: ["nodemailer", /^nodemailer\//] },
};

export default config;
