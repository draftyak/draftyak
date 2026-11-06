import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { heavyVitestConfig } from "../../vitest.shared.ts";
import { tempFileScanSupported } from "./test/store/temp-file-observer.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	const config = heavyVitestConfig(env, {
		"temp-file-scan": {
			description: "required native SQLite temporary-file observation on Windows, Linux and macOS",
			detect: () => tempFileScanSupported(process.platform),
		},
		ext4: {
			description: "an ext4 temporary folder (statfs type 0xEF53, which ext2 and ext3 share)",
			detect: () => {
				if (process.platform !== "linux") return false;
				try {
					return statfsSync(tmpdir()).type === 0xef53;
				} catch {
					return false;
				}
			},
		},
	});
	config.test = {
		...config.test,
		execArgv: [
			"--require",
			fileURLToPath(new URL("./test/helpers/loopback-preload.cjs", import.meta.url)),
		],
	};
	return config;
}
