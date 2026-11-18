import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import { reactPlugins } from "./config/react-plugins.mjs";

const config: UserConfig = {
	root: fileURLToPath(new URL("./e2e", import.meta.url)),
	envDir: false,
	publicDir: false,
	plugins: reactPlugins(),
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	preview: {
		headers: {
			"Content-Security-Policy": [
				"default-src 'none'",
				"script-src 'self'",
				"style-src 'self'",
				"connect-src 'none'",
				"img-src 'none'",
				"frame-src 'none'",
				"object-src 'none'",
				"form-action 'none'",
				"base-uri 'none'",
				"frame-ancestors 'none'",
			].join("; "),
		},
	},
};

export default config;
