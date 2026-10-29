import { accessSync, constants, statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { heavyVitestConfig } from "../../vitest.shared.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	const config = heavyVitestConfig(env, {
		"temp-file-scan": {
			description: "reading live SQLite temporary files on Windows or Linux /proc",
			detect: () => {
				if (process.platform === "win32") return true;
				if (process.platform !== "linux") return false;
				try {
					accessSync("/proc/self/fd", constants.R_OK | constants.X_OK);
					return true;
				} catch {
					return false;
				}
			},
		},
		ext4: {
			description: "an ext4 temporary folder (statfs type 0xEF53, which ext2 and ext3 share)",
			detect: () => statfsSync(tmpdir()).type === 0xef53,
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
