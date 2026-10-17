import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { assertSpawnable, type Invocation } from "./spawn.ts";

const exe = process.platform === "win32" ? ".exe" : "";
const scriptFile = /\.[cm]?js$/i;

// Set by verify and turbo.ts for every turbo run; turbo passes both on to its tasks.
export const telemetryOff: Readonly<Record<string, string>> = {
	DO_NOT_TRACK: "1",
	TURBO_TELEMETRY_DISABLED: "1",
};

function entry(file: string): Invocation {
	assertSpawnable(file);
	return scriptFile.test(file)
		? { command: process.execPath, args: [file] }
		: { command: file, args: [] };
}

// pnpm sets npm_execpath to its own entry script; without it (plain `node verify.ts`), the pnpm
// package installed beside a pnpm found on PATH is used, or a native pnpm executable.
export function resolvePnpm(env: NodeJS.ProcessEnv = process.env): Invocation {
	const execPath = env.npm_execpath;
	if (execPath) {
		assertSpawnable(execPath);
		if (path.basename(execPath).toLowerCase().startsWith("pnpm")) return entry(execPath);
	}
	for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
		if (dir === "") continue;
		for (const script of ["pnpm.mjs", "pnpm.cjs"]) {
			const beside = path.join(dir, "node_modules", "pnpm", "bin", script);
			if (existsSync(beside)) return entry(beside);
		}
		const bin = path.join(dir, `pnpm${exe}`);
		if (existsSync(bin)) return entry(realpathSync(bin));
	}
	throw new Error("pnpm not found: run through pnpm (pnpm verify) or put pnpm on PATH");
}

function nativeBinary(root: string, pkg: string, binary: string): string {
	try {
		const fromRoot = createRequire(path.join(root, "package.json"));
		return createRequire(fromRoot.resolve(`${pkg}/package.json`)).resolve(binary);
	} catch {
		throw new Error(`${pkg}: ${binary} not found; run pnpm install`);
	}
}

export function resolveTurbo(root: string): string {
	const os = process.platform === "win32" ? "windows" : process.platform;
	const arch = process.arch === "x64" ? "64" : process.arch;
	return nativeBinary(root, "turbo", `@turbo/${os}-${arch}/bin/turbo${exe}`);
}

function isMusl(): boolean {
	const report = process.report.getReport() as { header?: { glibcVersionRuntime?: string } };
	return report.header?.glibcVersionRuntime === undefined;
}

export function resolveBiome(root: string): string {
	const libc = process.platform === "linux" && isMusl() ? "-musl" : "";
	const binary = `@biomejs/cli-${process.platform}-${process.arch}${libc}/biome${exe}`;
	return nativeBinary(root, "@biomejs/biome", binary);
}
