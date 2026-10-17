import { strictSkips } from "@draftyak/spike-kit";
import type { Capability } from "@draftyak/spike-kit/vitest";
import { ANDROID_TARGET, androidSdk, ndkHostTag } from "./android.ts";
import { rustTargetInstalled } from "./cargo.ts";
import { IOS_SIMULATOR, xcodeReady } from "./ios.ts";

// spikes-run: GitHub Actions with strict skips. CI's full job has GITHUB_ACTIONS too, but no
// strict skips.
export const spikesRun = (env: NodeJS.ProcessEnv): boolean =>
	env.GITHUB_ACTIONS === "true" && strictSkips(env);

// spikes-run's mobile jobs must build: there a capability counts as present on its own OS, so a
// missing toolchain fails its tests instead of a routed skip passing. CI's full job routes the
// mobile cases away.
export function mustBuild(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): boolean {
	return spikesRun(env) && process.platform === platform;
}

export function capabilities(env: NodeJS.ProcessEnv = process.env): Record<string, Capability> {
	return {
		"android-build": {
			description: `Linux x64 or macOS with JDK 21, the Android SDK with ci.json's NDK and build-tools, Rust ${ANDROID_TARGET}`,
			detect: () =>
				mustBuild(env, "linux") ||
				(ndkHostTag() !== null && androidSdk(env) !== null && rustTargetInstalled(ANDROID_TARGET)),
		},
		"ios-build": {
			description: `Xcode with the iOS simulator SDK, Rust ${IOS_SIMULATOR}`,
			detect: () =>
				mustBuild(env, "darwin") || (xcodeReady() && rustTargetInstalled(IOS_SIMULATOR)),
		},
		// spikes-run keeps its minutes for the mobile builds: CI's full job records the Linux host
		// table on the S10 PR, and S5's macOS run covers the macOS host.
		"host-checks": {
			description: "the host's transport checks, everywhere but spikes-run",
			detect: () => !spikesRun(env),
		},
	};
}

// Only `pnpm --filter @draftyak/spike-s10-mobile record` writes evidence; CI never does, so
// spikes-run uploads no artifact for S10 and its results go to the job summary.
export function recording(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.DRAFTYAK_RECORD_EVIDENCE ?? "";
	if (!["", "0", "1"].includes(value)) {
		throw new Error(`DRAFTYAK_RECORD_EVIDENCE is 1 or 0, not "${value}"`);
	}
	return value === "1" && !env.CI;
}
