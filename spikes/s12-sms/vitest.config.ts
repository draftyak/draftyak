import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spikeVitestConfig } from "@draftyak/spike-kit/vitest";
import type { ConfigEnv, ViteUserConfig } from "vitest/config";

// What the probe build (test/probe-build.heavy.test.ts) needs, as problems; none means present.
export function androidToolchainProblems(env: NodeJS.ProcessEnv = process.env): string[] {
	const problems: string[] = [];
	const jdk = env.JAVA_HOME ?? "";
	const releaseFile = path.join(jdk, "release");
	const release = jdk && existsSync(releaseFile) ? readFileSync(releaseFile, "utf8") : "";
	if (!/^JAVA_VERSION="21[."]/m.test(release)) problems.push("JAVA_HOME isn't a JDK 21");
	const sdk = env.ANDROID_HOME || env.ANDROID_SDK_ROOT || "";
	const packages = ["platforms/android-37.0/android.jar", "build-tools/37.0.0/package.xml"];
	for (const file of packages) {
		if (!sdk || !existsSync(path.join(sdk, file))) problems.push(`ANDROID_HOME has no ${file}`);
	}
	return problems;
}

// A GitHub spikes run (spikes.yml: strict skips, setup-java and setup-android from ci.json) always
// has the capability, so a missing JDK or SDK fails the build test there instead of routing it
// away. Elsewhere, ci.yml's full job included, the test runs only where the toolchain is present.
const githubSpikesRun = (env: NodeJS.ProcessEnv): boolean =>
	env.GITHUB_ACTIONS === "true" && env.DRAFTYAK_STRICT_SKIPS === "1";

export default function config(env: ConfigEnv): ViteUserConfig {
	return spikeVitestConfig(env, {
		capabilities: {
			"android-sdk": {
				description:
					"JDK 21 in JAVA_HOME, and platforms;android-37.0 and build-tools;37.0.0 in ANDROID_HOME",
				detect: () =>
					githubSpikesRun(process.env) || androidToolchainProblems(process.env).length === 0,
			},
		},
	});
}
