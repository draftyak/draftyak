// Stages what tauri-build needs before any cargo command (plan §7 Bundled sidecar): the official
// Node that fetch-node verified, as the external binary src-tauri/binaries/draftyak-node-<triple>,
// and as resources the host's SQLite3MC prebuild plus the package's JavaScript (lib/), which the
// stub hub loads with nativeBinding. It also copies the main window's ES modules from the pinned
// @tauri-apps/api and @tauri-apps/plugin-autostart into ui/vendor/, which the app embeds. All come
// from the installed packages by realpath, whose bytes pnpm-lock.yaml pins. An identical file is
// left alone: Windows can't replace a loaded .node, and an unchanged file keeps cargo from
// rerunning the build script.
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { nodeBinary, nodeVersions } from "@draftyak/spike-kit";

export const tauriDir: string = path.resolve(import.meta.dirname, "..", "src-tauri");
const PACKAGE = "better-sqlite3-multiple-ciphers";

// Rust host triple → fetch-node's platform and arch, and the package's prebuild name.
const HOSTS = {
	"x86_64-pc-windows-msvc": { platform: "win", arch: "x64", prebuild: "win32-x64" },
	"aarch64-pc-windows-msvc": { platform: "win", arch: "arm64", prebuild: "win32-arm64" },
	"x86_64-apple-darwin": { platform: "darwin", arch: "x64", prebuild: "darwin-x64" },
	"aarch64-apple-darwin": { platform: "darwin", arch: "arm64", prebuild: "darwin-arm64" },
	"x86_64-unknown-linux-gnu": { platform: "linux", arch: "x64", prebuild: "linux-x64" },
	"aarch64-unknown-linux-gnu": { platform: "linux", arch: "arm64", prebuild: "linux-arm64" },
} as const;

export interface Staged {
	readonly triple: string;
	readonly nodeVersion: string;
	readonly node: string;
	readonly prebuild: { readonly target: string; readonly file: string; readonly sha256: string };
	readonly updated: readonly string[];
}

export function hostTriple(): string {
	const options = { cwd: tauriDir, encoding: "utf8", windowsHide: true } as const;
	return execFileSync("rustc", ["--print", "host-tuple"], options).trim();
}

function sha256(file: string): string | null {
	try {
		return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
}

function place(from: string, to: string): boolean {
	const digest = sha256(from);
	if (digest === null) throw new Error(`${from} is missing`);
	if (sha256(to) === digest) return false;
	fs.mkdirSync(path.dirname(to), { recursive: true });
	const temp = `${to}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		fs.copyFileSync(from, temp);
		// Copies keep the source's mtime, which cargo's rerun-if-changed would take as unchanged.
		const now = new Date();
		fs.utimesSync(temp, now, now);
		fs.renameSync(temp, to);
	} finally {
		fs.rmSync(temp, { force: true });
	}
	if (sha256(to) !== digest) throw new Error(`${to} doesn't hold the bytes of ${from}`);
	return true;
}

const spikeRequire = createRequire(path.join(tauriDir, "..", "..", "package.json"));

function packageDir(): string {
	return fs.realpathSync(path.dirname(spikeRequire.resolve(`${PACKAGE}/package.json`)));
}

// The main window's modules, at the paths its import map names.
function uiModules(): (readonly [string, string])[] {
	const api = fs.realpathSync(path.dirname(spikeRequire.resolve("@tauri-apps/api/package.json")));
	// The plugin's exports list no package.json; its main entry sits beside the ES module.
	const autostart = fs.realpathSync(
		path.dirname(spikeRequire.resolve("@tauri-apps/plugin-autostart")),
	);
	const vendor = path.join(tauriDir, "..", "ui", "vendor");
	const tslib = ["external", "tslib", "tslib.es6.js"];
	return [
		[path.join(api, "core.js"), path.join(vendor, "api", "core.js")],
		[path.join(api, ...tslib), path.join(vendor, "api", ...tslib)],
		[path.join(autostart, "index.js"), path.join(vendor, "plugin-autostart", "index.js")],
	];
}

const filesBelow = (dir: string): string[] =>
	fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)));

export async function stageSidecar(): Promise<Staged> {
	const triple = hostTriple();
	const host = HOSTS[triple as keyof typeof HOSTS];
	if (!host) throw new Error(`no official Node build or SQLite3MC prebuild for ${triple}`);
	const nodeVersion = nodeVersions().bundled;
	const verified = await nodeBinary(nodeVersion, { platform: host.platform, arch: host.arch });
	const exe = host.platform === "win" ? ".exe" : "";
	const node = path.join(tauriDir, "binaries", `draftyak-node-${triple}${exe}`);
	const pkg = packageDir();
	const resources = path.join(tauriDir, "resources");
	const prebuild = path.join(resources, "prebuilds", `${host.prebuild}.node`);
	const wrapper = path.join(resources, "sqlite3mc");
	const copies: (readonly [string, string])[] = [
		[verified, node],
		[path.join(pkg, "prebuilds", `${host.prebuild}.node`), prebuild],
		[path.join(pkg, "package.json"), path.join(wrapper, "package.json")],
		[path.join(pkg, "LICENSE"), path.join(wrapper, "LICENSE")],
		...filesBelow(path.join(pkg, "lib")).map(
			(file) => [path.join(pkg, "lib", file), path.join(wrapper, "lib", file)] as const,
		),
		...uiModules(),
	];
	const updated = copies
		.filter(([from, to]) => place(from, to))
		.map(([, to]) => path.relative(tauriDir, to));
	const digest = sha256(prebuild) ?? "";
	return {
		triple,
		nodeVersion,
		node,
		prebuild: { target: host.prebuild, file: prebuild, sha256: digest },
		updated,
	};
}

if (import.meta.main) {
	const staged = await stageSidecar();
	const what = `Node ${staged.nodeVersion} for ${staged.triple} and ${staged.prebuild.target}.node`;
	console.log(`stage-sidecar: ${what}; ${staged.updated.length} file(s) updated`);
}
