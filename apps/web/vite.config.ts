import { fileURLToPath } from "node:url";
import type { UserConfig } from "vite";
import { reactPlugins } from "./config/react-plugins.mjs";
import { verifyBrowserBundle } from "./scripts/verify-build.ts";

const config: UserConfig = {
	envDir: false,
	plugins: [
		...reactPlugins(),
		{
			name: "verify-browser-bundle",
			generateBundle(_options, bundle) {
				for (const output of Object.values(bundle)) {
					if (output.type === "chunk") {
						verifyBrowserBundle(output.code, output.imports, output.dynamicImports);
					}
				}
			},
		},
	],
	build: {
		lib: {
			entry: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
			formats: ["es"],
			fileName: "flags",
		},
		rolldownOptions: {
			external: [/^react(?:\/.*)?$/],
		},
	},
};

export default config;
