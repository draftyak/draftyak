import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import { reactPlugins } from "./config/react-plugins.mjs";

const config: UserConfig = {
	root: fileURLToPath(new URL("./e2e", import.meta.url)),
	envDir: false,
	publicDir: false,
	plugins: reactPlugins(),
	build: {
		outDir: "dist/inbox-workspace",
		emptyOutDir: true,
		rolldownOptions: {
			input: fileURLToPath(new URL("./e2e/inbox-workspace.html", import.meta.url)),
		},
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
				"require-trusted-types-for 'script'",
				"trusted-types 'none'",
			].join("; "),
		},
	},
};
export default config;
