import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { cargoEnv, type Ran, run, spikeDir } from "./cargo.ts";

export const tauriDir: string = path.join(spikeDir, "src-tauri");
export const LIB = "draftyak_mobile_lib";
// The pairing exporter label: a constant only the linked transport code refers to, so it outlives
// symbol stripping and dead-code removal in the final library or executable.
export const TRANSPORT_MARKER = "EXPERIMENTAL-draftyak-pair-v1";
const cli = path.join(spikeDir, "node_modules", "@tauri-apps", "cli", "tauri.js");

export const genDir = (platform: "android" | "apple"): string =>
	path.join(tauriDir, "gen", platform);

// gen/ comes from tauri-cli's templates at build time and is never committed (ADR 0012).
export function cleanGen(platform: "android" | "apple"): void {
	rmSync(genDir(platform), { recursive: true, force: true });
}

// Gradle and Xcode call back into `pnpm tauri <platform> …-script` (package.json's tauri
// script): tauri-cli writes that command into gen/ when pnpm's user agent is set.
export function tauri(
	args: readonly string[],
	env: Readonly<Record<string, string>>,
	timeoutMs: number,
): Promise<Ran> {
	const agent = process.env.npm_config_user_agent ?? "";
	const pnpm: Record<string, string> = agent.startsWith("pnpm/")
		? {}
		: { npm_config_user_agent: "pnpm/11" };
	return run(process.execPath, [cli, ...args, "--ci"], {
		env: cargoEnv({ ...pnpm, ...env }),
		timeoutMs,
	});
}

export interface AndroidProject {
	readonly agp: string | null;
	readonly kotlin: string | null;
	readonly gradle: string | null;
	readonly wrapperSha256: boolean;
	readonly compileSdk: string | null;
	readonly targetSdk: string | null;
}

// What tauri-cli's template generated, for the summary and M10's pins.
export function androidProject(dir: string = genDir("android")): AndroidProject {
	const read = (file: string): string => {
		const full = path.join(dir, file);
		return existsSync(full) ? readFileSync(full, "utf8") : "";
	};
	const [root, app] = [read("build.gradle.kts"), read("app/build.gradle.kts")];
	const wrapper = read("gradle/wrapper/gradle-wrapper.properties");
	return {
		agp: /com\.android\.tools\.build:gradle:([\w.-]+)/.exec(root)?.[1] ?? null,
		kotlin: /kotlin-gradle-plugin:([\w.-]+)/.exec(root)?.[1] ?? null,
		gradle: /gradle-([\d.]+)-(?:bin|all)\.zip/.exec(wrapper)?.[1] ?? null,
		wrapperSha256: /^distributionSha256Sum=/m.test(wrapper),
		compileSdk: /compileSdk = (\d+)/.exec(app)?.[1] ?? null,
		targetSdk: /targetSdk = (\d+)/.exec(app)?.[1] ?? null,
	};
}
