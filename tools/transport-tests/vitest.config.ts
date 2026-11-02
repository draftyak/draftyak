import { fileURLToPath } from "node:url";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";
import { admitNative } from "./src/admission.ts";
import { nativeConfig } from "./src/config.ts";
import { linuxCaseNames } from "./src/linux-store.ts";
import { hostCaseNames } from "./src/native.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

export default async function config(env: ConfigEnv): Promise<ViteUserConfig> {
	return nativeConfig(
		env,
		() => admitNative(root),
		(store) => (store === "secret-service" ? linuxCaseNames() : hostCaseNames(store)),
	);
}
