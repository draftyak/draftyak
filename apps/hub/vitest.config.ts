import { accessSync, constants } from "node:fs";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { heavyVitestConfig } from "../../vitest.shared.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	return heavyVitestConfig(env, {
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
	});
}
