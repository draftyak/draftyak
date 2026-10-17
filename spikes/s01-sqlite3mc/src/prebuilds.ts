import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const PACKAGE = "better-sqlite3-multiple-ciphers";
// The N-API prebuilds the package ships in prebuilds/<target>.node.
export const TARGETS = [
	"darwin-arm64",
	"darwin-x64",
	"linux-arm64",
	"linux-x64",
	"linuxmusl-arm64",
	"linuxmusl-x64",
	"win32-arm64",
	"win32-x64",
] as const;
export type Target = (typeof TARGETS)[number];

export const spikeDir: string = path.resolve(import.meta.dirname, "..");
export const bundleDir: string = path.join(spikeDir, "bundle");

export interface ProcessReport {
	readonly header: { readonly glibcVersionRuntime?: string };
	readonly sharedObjects: readonly string[];
}

export function processReport(): ProcessReport {
	return process.report.getReport() as unknown as ProcessReport;
}

// The target the package's own loader picks: musl where the process reports no glibc.
export function targetFor(platform: string, arch: string, glibc: string | undefined): Target {
	const target = `${platform === "linux" && !glibc ? "linuxmusl" : platform}-${arch}`;
	const known: readonly string[] = TARGETS;
	if (!known.includes(target)) throw new Error(`${PACKAGE} ships no prebuild for ${target}`);
	return target as Target;
}

export function hostTarget(): Target {
	const linux = process.platform === "linux";
	const glibc = linux ? processReport().header.glibcVersionRuntime : undefined;
	return targetFor(process.platform, process.arch, glibc);
}

// The installed package's real folder: pnpm links it in from its store.
export function packageDir(): string {
	const require = createRequire(path.join(spikeDir, "package.json"));
	return fs.realpathSync(path.dirname(require.resolve(`${PACKAGE}/package.json`)));
}

// The NAPI_VERSION every prebuild is compiled with, from the package's binding.gyp.
export function napiVersion(dir: string = packageDir()): number {
	const found = /NAPI_VERSION=(\d+)/.exec(fs.readFileSync(path.join(dir, "binding.gyp"), "utf8"));
	if (!found?.[1]) throw new Error(`${PACKAGE}'s binding.gyp defines no NAPI_VERSION`);
	return Number(found[1]);
}

export interface Prebuild {
	readonly target: Target;
	readonly file: string;
	readonly bytes: number;
	readonly sha256: string;
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function sha256File(file: string): string {
	return sha256(fs.readFileSync(file));
}

// The bytes every copy of each target must hold: the installed package's prebuilds.
export function prebuildHashes(dir: string = packageDir()): Record<Target, string> {
	const entries = TARGETS.map((target) => [
		target,
		sha256File(path.join(dir, "prebuilds", `${target}.node`)),
	]);
	return Object.fromEntries(entries) as Record<Target, string>;
}

function sameContent(file: string, digest: string): boolean {
	try {
		return sha256File(file) === digest;
	} catch {
		return false;
	}
}

// Copies prebuilds/<target>.node out of the installed package, whose bytes pnpm-lock.yaml pins by
// sha512, to <bundle>/prebuilds/, and reads the copy back. An identical copy stays: Windows can't
// replace a loaded addon.
export function copyPrebuild(target: Target, bundle: string = bundleDir): Prebuild {
	const bytes = fs.readFileSync(path.join(packageDir(), "prebuilds", `${target}.node`));
	const digest = sha256(bytes);
	const file = path.join(bundle, "prebuilds", `${target}.node`);
	if (!sameContent(file, digest)) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const temp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			fs.writeFileSync(temp, bytes);
			fs.renameSync(temp, file);
		} catch (error) {
			if (!sameContent(file, digest)) throw error;
		} finally {
			fs.rmSync(temp, { force: true });
		}
		if (!sameContent(file, digest)) throw new Error(`${file} doesn't hold the ${target} prebuild`);
	}
	return { target, file, bytes: bytes.length, sha256: digest };
}
