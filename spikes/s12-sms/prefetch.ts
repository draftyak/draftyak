// The probe build's launcher, shared with test/probe-build.heavy.test.ts. Run directly, as
// `pnpm m0:prefetch` does, it builds the probe once, so Gradle 9.8.1, AGP, Kotlin and their
// dependencies are in Gradle's caches before verify:m0's heavy run; without JDK 21 and the SDK it
// skips, as the heavy test does.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidToolchainProblems } from "./vitest.config.ts";

export const PROBE: string = fileURLToPath(new URL("probe-android/", import.meta.url));
const WRAPPER = path.join(PROBE, "gradle", "wrapper");

// Gradle 9.8.1's wrapper as its own wrapper task writes it: the jar is the gradle-wrapper.jar
// inside the 9.8.1 distribution, and the properties pin gradle-9.8.1-bin.zip by its sha256
// (dce76f55...). gradlew and gradlew.bat run the same jar.
export const WRAPPER_SHA256: Readonly<Record<string, string>> = {
	"gradle-wrapper.jar": "3b8a25775a69158b5ad2b1d17a80a88dc7b40a352a73eb27d06c612a7ce68e98",
	"gradle-wrapper.properties": "b9c24447093e4fab2b1f37bfb461d2a1eb14157a4808dff50e0f954801a8f8f1",
};

// The wrapper files in <dir> that aren't the pinned ones; empty when all are.
export function wrapperProblems(dir: string = WRAPPER): string[] {
	const sha256 = (name: string): string =>
		createHash("sha256")
			.update(readFileSync(path.join(dir, name)))
			.digest("hex");
	return Object.entries(WRAPPER_SHA256)
		.filter(([name, pinned]) => sha256(name) !== pinned)
		.map(([name]) => `${name} isn't Gradle 9.8.1's`);
}

export interface Gradle {
	readonly code: number | null;
	readonly output: string;
}

// The pinned wrapper jar under JAVA_HOME's java, as gradlew and gradlew.bat start it, without a
// shell. With `inherit`, Gradle writes to this process's stdout and stderr.
export function gradle(
	args: readonly string[],
	options: { readonly signal?: AbortSignal; readonly inherit?: boolean } = {},
): Promise<Gradle> {
	const problems = wrapperProblems();
	if (problems.length > 0) {
		return Promise.reject(new Error(`refusing the Gradle wrapper: ${problems.join("; ")}`));
	}
	const exe = process.platform === "win32" ? "java.exe" : "java";
	const java = path.join(process.env.JAVA_HOME ?? "", "bin", exe);
	const jvm = ["-Xmx64m", "-Xms64m", "-Dorg.gradle.appname=gradlew", "-jar"];
	const child = spawn(java, [...jvm, path.join(WRAPPER, "gradle-wrapper.jar"), ...args], {
		cwd: PROBE,
		signal: options.signal,
		stdio: options.inherit ? ["ignore", "inherit", "inherit"] : ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	let output = "";
	const keep = (chunk: Buffer): void => {
		output = (output + chunk.toString("utf8")).slice(-20_000);
	};
	child.stdout?.on("data", keep);
	child.stderr?.on("data", keep);
	return new Promise((resolve) => {
		child.once("error", (error) => resolve({ code: null, output: `${output}\n${error.message}` }));
		child.once("close", (code) => resolve({ code, output }));
	});
}

if (import.meta.main) {
	const problems = androidToolchainProblems();
	if (problems.length > 0) {
		console.log(`s12-sms prefetch: skipped, no probe build here (${problems.join("; ")})`);
	} else {
		const tasks = [":app:assembleDebug", ":app:testDebugUnitTest"];
		console.log(`s12-sms prefetch: building the probe (${tasks.join(" ")})`);
		const run = await gradle(["--no-daemon", "--console=plain", ...tasks], { inherit: true }).catch(
			(error: Error) => ({ code: null, output: error.message }),
		);
		if (run.code !== 0) {
			const detail = run.output.trim();
			console.error(`s12-sms prefetch: the probe build failed${detail ? `: ${detail}` : ""}`);
		}
		process.exitCode = run.code ?? 1;
	}
}
