import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { writeEvidence } from "@draftyak/spike-kit";
import { afterAll, describe, expect, it } from "vitest";
import {
	ANDROID_TARGET,
	type AndroidSdk,
	androidSdk,
	manifestViolations,
	ndkEnv,
	permissions,
	unexpectedPermissions,
	usesCleartext,
	zipEntry,
} from "../src/android.ts";
import {
	APP,
	type CrateBuild,
	cargo,
	cargoEnv,
	crateBuild,
	hostTarget,
	type Provider,
	providers,
	type Ran,
	run,
	rustcVersion,
	rustTargetInstalled,
	SKELETON,
	spikeDir,
	tail,
} from "../src/cargo.ts";
import { appInfo, IOS_SIMULATOR } from "../src/ios.ts";
import { appendSummary, crateTableMarkdown } from "../src/report.ts";
import { androidProject, cleanGen, genDir, LIB, TRANSPORT_MARKER, tauri } from "../src/tauri.ts";
import { recording } from "../src/toolchain.ts";

// Everything shares the spike's target dir, so cases run one at a time: mobile first, while the
// job's timeout is fresh. ring is the plan's provider and must build everywhere; an aws-lc-rs
// failure is ADR 0012's answer, so it goes into the summary instead of failing the run.
const APP_ID = "com.draftyak.client";
const minutes = (count: number): number => count * 60_000;
const output = (ran: Ran): string => tail(`${ran.stdout}\n${ran.stderr}`);
const sha256 = (file: string): string =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
const bytes = (size: number): string => `${size.toLocaleString("en-US")} bytes`;

// One summary table per target, written as soon as both providers have built.
function crateTable(title: string, target: string, env: () => Record<string, string>): void {
	describe(target, () => {
		const builds: CrateBuild[] = [];
		afterAll(() => {
			if (builds.length > 0) appendSummary(crateTableMarkdown(`${title} (${target})`, builds));
		});
		for (const provider of providers) {
			it(`${provider}: the transport skeleton links as a cdylib`, async () => {
				expect(rustTargetInstalled(target), `the Rust target ${target}`).toBe(true);
				const build = await crateBuild(target, provider, env());
				builds.push(build);
				expect(build.strays).toEqual([]);
				if (provider === "ring") expect(build.ok, build.log).toBe(true);
				if (build.ok) expect(build.crates.filter((crate) => crate.status !== "ok")).toEqual([]);
			});
		}
	});
}

describe("Android", { tags: ["requires:android-build"], timeout: minutes(30) }, () => {
	const sdk = (): AndroidSdk => {
		const found = androidSdk();
		if (found === null) throw new Error("needs JAVA_HOME, ANDROID_HOME and ci.json's NDK");
		return found;
	};

	it("tauri android build makes an APK without SMS or notification-listener entries", async () => {
		const env = ndkEnv(sdk());
		const args = ["android", "build", "--debug", "--target", "aarch64", "--apk"];
		cleanGen("android");
		const init = await tauri(["android", "init", "--skip-targets-install"], env, minutes(5));
		const build = init.code === 0 ? await tauri(args, env, minutes(22)) : init;
		const outputs = path.join(genDir("android"), "app", "build", "outputs", "apk");
		const apk = path.join(outputs, "universal", "debug", "app-universal-debug.apk");
		if (build.code !== 0 || !existsSync(apk)) {
			const step = init.code === 0 ? args.join(" ") : "android init";
			appendSummary(
				`### S10 Android build\n\nAndroid build: fail (\`tauri ${step}\` exit ${build.code})`,
			);
			expect(build.code, output(build)).toBe(0);
			expect.fail(`no APK at ${apk}`);
		}
		const aapt2 = path.join(sdk().buildTools, "aapt2");
		const dump = await run(aapt2, ["dump", "permissions", apk], {});
		const tree = await run(aapt2, ["dump", "xmltree", "--file", "AndroidManifest.xml", apk], {});
		const names = permissions(dump.stdout);
		const violations = manifestViolations(names, tree.stdout);
		const unexpected = unexpectedPermissions(names, APP_ID);
		// The library as the APK packages it, not cargo's copy in the target dir.
		const entry = `lib/arm64-v8a/lib${LIB}.so`;
		const packaged = zipEntry(readFileSync(apk), entry);
		const linked = packaged?.includes(TRANSPORT_MARKER) ?? false;
		const library =
			packaged === null
				? "missing"
				: `${bytes(packaged.length)}, holds the transport code: ${linked ? "yes" : "no"}`;
		const gen = androidProject();
		const wrapper = gen.wrapperSha256 ? "pinned" : "no distributionSha256Sum";
		appendSummary(
			[
				"### S10 Android build",
				"",
				`Android build: ok (\`tauri ${args.join(" ")}\`, ${Math.round(build.ms / 1000)} s)`,
				"",
				`- APK \`${path.basename(apk)}\`: ${bytes(statSync(apk).size)}, SHA-256 \`${sha256(apk)}\``,
				`- Merged-manifest permissions: ${names.map((name) => `\`${name}\``).join(", ") || "none"}`,
				`- SMS or notification-listener entries: ${violations.join(", ") || "none"}`,
				`- Permissions outside the allowlist: ${unexpected.join(", ") || "none"}`,
				`- usesCleartextTraffic: ${usesCleartext(tree.stdout)} (the template's debug build type)`,
				`- \`${entry}\` in the APK: ${library}`,
				`- gen/android: AGP ${gen.agp}, Kotlin ${gen.kotlin}, Gradle ${gen.gradle} (${wrapper}), compileSdk ${gen.compileSdk}, targetSdk ${gen.targetSdk}, minSdk ${sdk().minSdk}`,
			].join("\n"),
		);
		expect(dump.code, output(dump)).toBe(0);
		expect(tree.code, output(tree)).toBe(0);
		expect(dump.stdout).toMatch(/^package: com\.draftyak\.client$/m);
		expect(violations).toEqual([]);
		expect(unexpected).toEqual([]);
		expect(packaged, `${entry} in the APK`).not.toBeNull();
		expect(linked, `the transport code in the APK's ${entry}`).toBe(true);
	});

	crateTable("S10 crate table: Android", ANDROID_TARGET, () => ndkEnv(sdk()));
});

// Run B2 has 25 minutes: the simulator app first, then its crate table.
describe("iOS", { tags: ["requires:ios-build"], timeout: minutes(20) }, () => {
	const brew = { HOMEBREW_NO_AUTO_UPDATE: "1", HOMEBREW_NO_ANALYTICS: "1" };
	const version = (command: string, args: readonly string[]): Promise<string | null> =>
		run(command, args, {}).then(
			(ran) => (ran.code === 0 ? ran.stdout.trim().split(/\r?\n/).join(", ") : null),
			() => null,
		);

	it("tauri ios build --no-sign builds the iPhone and iPad simulator app", async () => {
		const args = ["ios", "build", "--debug", "--target", "aarch64-sim", "--no-sign"];
		cleanGen("apple");
		// tauri ios init installs a missing XcodeGen with Homebrew, unpinned (ADR 0012).
		const preinstalled = (await version("xcodegen", ["--version"])) !== null;
		const init = await tauri(["ios", "init", "--skip-targets-install"], brew, minutes(5));
		const build = init.code === 0 ? await tauri(args, brew, minutes(14)) : init;
		const app = path.join(genDir("apple"), "build", "arm64-sim", "DraftYak.app");
		const plist = await run("plutil", ["-convert", "json", "-o", "-", `${app}/Info.plist`], {});
		const info = build.code === 0 && plist.code === 0 ? appInfo(plist.stdout) : null;
		const binary = info === null ? "" : path.join(app, info.executable);
		const linked = info !== null && readFileSync(binary).includes(TRANSPORT_MARKER);
		const step = init.code === 0 ? args.join(" ") : "ios init";
		const seconds = Math.round(build.ms / 1000);
		const xcode = await version("xcodebuild", ["-version"]);
		const xcodegen = await version("xcodegen", ["--version"]);
		const origin = preinstalled ? "preinstalled" : "installed by tauri ios init with Homebrew";
		appendSummary(
			[
				"### S10 iOS build",
				"",
				`iOS simulator build: ${info === null ? "fail" : "ok"} (\`tauri ${step}\`, exit ${build.code}, ${seconds} s)`,
				"",
				`- Bundle id ${info?.bundleId}, UIDeviceFamily ${info?.deviceFamilies.join(",")} (1 iPhone, 2 iPad)`,
				`- The executable holds the transport code: ${linked ? "yes" : "no"}`,
				`- Xcode: ${xcode ?? "not found"}; XcodeGen: ${xcodegen ?? "not found"} (${origin})`,
			].join("\n"),
		);
		expect(build.code, output(build)).toBe(0);
		expect(info?.bundleId).toBe(APP_ID);
		expect(info?.deviceFamilies).toEqual([1, 2]);
		expect(linked, "the transport code in the app").toBe(true);
	});

	crateTable("S10 crate table: iOS", IOS_SIMULATOR, () => ({}));
});

describe("host", { tags: ["requires:host-checks"], timeout: minutes(30) }, () => {
	const target = hostTarget();
	const builds = new Map<Provider, CrateBuild>();
	const passed = new Set<string>();
	const tests = new Map<Provider, number>();
	const pass = async (name: string, step: Promise<Ran>): Promise<Ran> => {
		const result = await step;
		expect(result.code, output(result)).toBe(0);
		passed.add(name);
		return result;
	};

	afterAll(async () => {
		if (builds.size === 0) return;
		appendSummary(crateTableMarkdown(`S10 crate table: host (${target})`, [...builds.values()]));
		if (recording()) await record();
	});

	// Only from a run that did every host case (`pnpm --filter @draftyak/spike-s10-mobile record`).
	async function record(): Promise<void> {
		const built = [...builds.values()].filter((build) => build.ok);
		const wanted = [
			"rustfmt",
			...built.flatMap(({ provider }) =>
				["test", "clippy", "clippy --lib"].map((step) => `${provider} ${step}`),
			),
			...(process.platform === "win32" ? ["app clippy"] : []),
		];
		const missing = wanted.filter((name) => !passed.has(name));
		if (builds.size < providers.length || missing.length > 0) {
			process.stderr.write(`evidence not recorded: missing ${missing.join(", ") || "builds"}\n`);
			return;
		}
		const file = path.join(spikeDir, "evidence", `host-${process.platform}-${process.arch}.json`);
		const written = await writeEvidence(file, {
			target,
			rustcVersion: rustcVersion(),
			awsLcRs: builds.get("aws-lc-rs")?.ok ? "builds" : "fails",
			builds: [...builds.values()].map(({ provider, ok, crates, strays, notes }) => ({
				provider,
				ok,
				crates: crates.map(({ name, version, status, reason }) =>
					reason === undefined ? { name, version, status } : { name, version, status, reason },
				),
				strays,
				awsLcSys: notes,
				tests: tests.get(provider) ?? 0,
			})),
			passed: [...passed].toSorted(),
		});
		process.stderr.write(`evidence: ${path.relative(spikeDir, written)}\n`);
	}

	it("rustfmt: the workspace is formatted", async () => {
		await pass("rustfmt", run("cargo", ["fmt", "--all", "--check"], { env: cargoEnv() }));
	});

	for (const provider of providers) {
		it(`${provider}: links as a cdylib, then cargo test and clippy pass`, async () => {
			const build = await crateBuild(target, provider);
			builds.set(provider, build);
			if (provider === "ring") expect(build.ok, build.log).toBe(true);
			if (!build.ok) return;
			expect(build.crates.filter((crate) => crate.status !== "ok")).toEqual([]);
			expect(build.strays).toEqual([]);
			const test = await pass(`${provider} test`, cargo(["test", "-p", SKELETON], provider));
			const counts = [...test.stdout.matchAll(/^test result: ok\. (\d+) passed/gm)];
			tests.set(
				provider,
				counts.reduce((sum, [, count]) => sum + Number(count), 0),
			);
			// The tests turn mock-store on; --lib lints the library as it ships, without it.
			const lint = ["clippy", "-p", SKELETON];
			await pass(
				`${provider} clippy`,
				cargo([...lint, "--all-targets"], provider, ["-D", "warnings"]),
			);
			await pass(
				`${provider} clippy --lib`,
				cargo([...lint, "--lib"], provider, ["-D", "warnings"]),
			);
		});
	}

	it("the app crate passes clippy", { tags: ["requires:windows"] }, async () => {
		const lint = ["clippy", "-p", APP, "--all-targets"];
		await pass("app clippy", cargo(lint, "ring", ["-D", "warnings"]));
	});
});
