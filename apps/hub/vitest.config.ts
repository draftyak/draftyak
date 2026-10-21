import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { heavyVitestConfig } from "../../vitest.shared.ts";
import { tempFileScanSupported } from "./test/store/temp-file-observer.ts";

export default function config(env: ConfigEnv): ViteUserConfig {
	return heavyVitestConfig(env, {
		"temp-file-scan": {
			description: "required native SQLite temporary-file observation on Windows, Linux and macOS",
			detect: () => tempFileScanSupported(process.platform),
		},
	});
}
