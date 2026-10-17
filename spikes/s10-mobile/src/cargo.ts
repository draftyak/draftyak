import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const spikeDir: string = path.resolve(import.meta.dirname, "..");
export const targetDir: string = path.join(spikeDir, "target");
export const SKELETON = "transport-skeleton";
export const APP = "draftyak-mobile";

export type Provider = "ring" | "aws-lc-rs";
export const providers: readonly Provider[] = ["ring", "aws-lc-rs"];

// ok: compiled (the skeleton: linked as a cdylib); fail: its own error; blocked: a dependency
// failed first; missing: the build passed without it, so the expected set is wrong.
export type Status = "ok" | "fail" | "blocked" | "missing";

export interface Crate {
	readonly name: string;
	readonly version: string | null;
	readonly status: Status;
	readonly reason?: string;
}

export interface CrateBuild {
	readonly target: string;
	readonly provider: Provider;
	readonly ok: boolean;
	readonly seconds: number;
	readonly crates: readonly Crate[];
	// The other provider's crates, compiled anyway.
	readonly strays: readonly string[];
	// aws-lc-sys build-script lines: its builder (CC or CMake) and whether NASM was missing.
	readonly notes: readonly string[];
	readonly log: string;
}

export interface Ran {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
	readonly ms: number;
}

// M1b's crate set (plan §2, §8); keyring 4's stores come in through keyring-core.
const COMMON = [
	"tokio",
	"tokio-rustls",
	"rustls",
	"hyper",
	"hyper-util",
	"tokio-tungstenite",
	"keyring-core",
	"p256",
	"ecdsa",
	"hmac",
	"sha2",
	"rcgen",
	"serde_json_canonicalizer",
	"jiff",
	"jiff-tzdb",
];
const PROVIDER_CRATES: Readonly<Record<Provider, readonly string[]>> = {
	ring: ["ring"],
	"aws-lc-rs": ["aws-lc-sys", "aws-lc-rs"],
};

const STORES = ["android-native-keyring-store", "apple-native-keyring-store"];

// Table rows: the providers' crates, the common set, the stores, then the linked skeleton.
export const crateOrder: readonly string[] = [
	...PROVIDER_CRATES.ring,
	...PROVIDER_CRATES["aws-lc-rs"],
	...COMMON,
	...STORES,
	SKELETON,
];

export function storeCrates(target: string): string[] {
	if (target.endsWith("-android")) return STORES.slice(0, 1);
	return target.includes("-apple-ios") ? STORES.slice(1) : [];
}

export function expectedCrates(target: string, provider: Provider): string[] {
	return [...PROVIDER_CRATES[provider], ...COMMON, ...storeCrates(target), SKELETON];
}

export const featureArgs = (provider: Provider): string[] =>
	provider === "ring" ? [] : ["--no-default-features", "--features", "aws-lc-rs"];

// Builds stay inside the spike, whatever CARGO_TARGET_DIR the shell has.
export function cargoEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
	return { ...process.env, CARGO_TARGET_DIR: targetDir, CARGO_TERM_COLOR: "never", ...extra };
}

// Never through a shell: Windows can't start .cmd shims without one.
export function run(
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number },
): Promise<Ran> {
	const started = performance.now();
	const child = spawn(command, args, {
		cwd: options.cwd ?? spikeDir,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	const stdout: string[] = [];
	const stderr: string[] = [];
	child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout.push(chunk));
	child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
	const timer = options.timeoutMs ? setTimeout(() => child.kill(), options.timeoutMs) : undefined;
	return new Promise((resolve, reject) => {
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			const ms = performance.now() - started;
			resolve({ code: code ?? -1, stdout: stdout.join(""), stderr: stderr.join(""), ms });
		});
	});
}

export const tail = (text: string, lines = 40): string =>
	text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");

// A path's folders may hold spaces (each ends at a separator); its last name may not, so the
// words after an unquoted path survive. <<root>> marks a known root already cut out, <<url:n>>
// a URL set aside; neither can reach a path, which never holds < or >.
const NAME = String.raw`[^\\/\s'"\x60<>|*?:]+`;
const TAIL = String.raw`(?:${NAME}(?: ${NAME})*[\\/]+)*(?:${NAME})?`;
const PATHS = new RegExp(
	[
		String.raw`<<root>>(?:[\\/]+${TAIL})?`,
		String.raw`[A-Za-z]:(?:\\+|/(?!/))${TAIL}`,
		`/(?:home|Users|tmp|var|opt|private|usr|root|mnt|Library)/${TAIL}`,
	].join("|"),
	"g",
);
const QUOTED = /(["'`])(?:<<root>>|[A-Za-z]:[\\/]|\/)[^"'`\r\n]*\1/g;
const URL = /\b(?!file:)[A-Za-z][\w+.-]*:\/\/[^\s'"`<>]*/g;
const MARKS = /<<(?:root|url:\d+)>>/g;

function localRoots(): string[] {
	const env = process.env;
	const repo = path.resolve(spikeDir, "..", "..");
	const roots = [os.homedir(), env.CARGO_HOME, env.RUSTUP_HOME, env.GITHUB_WORKSPACE, repo];
	return [...roots, env.RUNNER_TEMP, env.RUNNER_TOOL_CACHE, os.tmpdir()].filter(
		(root): root is string => !!root && path.isAbsolute(root) && root.length > 3,
	);
}

const literal = (text: string): RegExp =>
	new RegExp(text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&"), "gi");

// One line for a table cell or evidence: no local paths, at most 160 characters. URLs (but file:
// ones) are set aside; known roots go first, literally, since a home folder can hold spaces; then
// quoted paths, then the rest.
export function clean(text: string, roots: readonly string[] = localRoots()): string {
	const urls: string[] = [];
	let out = text.slice(0, 4000).replace(MARKS, "");
	out = out.replace(URL, (url) => `<<url:${urls.push(url) - 1}>>`);
	const variants = roots.flatMap((root) => [
		root.replaceAll("\\", "/"),
		root.replaceAll("/", "\\"),
	]);
	for (const root of [...new Set(variants)].toSorted((a, b) => b.length - a.length)) {
		out = out.replace(literal(root), "<<root>>");
	}
	out = out.replace(QUOTED, "$1[path]$1").replace(PATHS, "[path]");
	out = out.replace(/<<url:(\d+)>>/g, (_, index: string) => urls[Number(index)] ?? "");
	return out.replace(/\s+/g, " ").trim().slice(0, 160);
}

// registry+…#name@1.2.3, path+file:///…/dir#0.1.0 or path+file:///…/dir#name@0.1.0.
export function packageOf(id: string): { readonly name: string; readonly version: string } {
	const hash = id.lastIndexOf("#");
	const fragment = id.slice(hash + 1);
	const at = fragment.lastIndexOf("@");
	if (at > 0) return { name: fragment.slice(0, at), version: fragment.slice(at + 1) };
	return { name: id.slice(id.lastIndexOf("/", hash) + 1, hash), version: fragment };
}

// The first line of each build script's stderr that isn't the panic location.
export function buildScriptFailures(stderr: string): Map<string, string> {
	const found = new Map<string, string>();
	for (const block of stderr.split(/^error: failed to run custom build command for `/m).slice(1)) {
		const name = /^(\S+) v/.exec(block)?.[1];
		if (!name) continue;
		const lines = (block.split("--- stderr")[1] ?? "")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("note:") && !line.includes("panicked at"));
		found.set(name, clean(lines[0] ?? "the build script failed"));
	}
	return found;
}

// aws-lc-sys's build script prints which builder it took ("Building with: CC", or "CMake" when it
// fell back to cmake) and whether NASM was missing. Cargo shows a registry crate's warnings only
// when its script fails, so they come from stderr or the script's output file.
export function buildNotes(text: string): string[] {
	const notes = text.matchAll(/cargo:warning=(Building with: \w+|NASM command not found[^\r\n]*)/g);
	return [...new Set([...notes].map(([, note]) => note ?? ""))];
}

interface CargoMessage {
	readonly reason?: string;
	readonly package_id?: string;
	readonly target?: { readonly kind?: readonly string[] };
	readonly message?: { readonly level?: string; readonly message?: string };
	readonly success?: boolean;
	readonly out_dir?: string;
}

function parse(line: string): CargoMessage {
	try {
		return line.startsWith("{") ? (JSON.parse(line) as CargoMessage) : {};
	} catch {
		return {};
	}
}

interface Table {
	readonly ok: boolean;
	readonly crates: Crate[];
	readonly built: ReadonlyMap<string, string>;
	// Each build script that ran: its package's OUT_DIR.
	readonly scripts: ReadonlyMap<string, string>;
}

// cargo's JSON messages (stdout) and its own errors (stderr) as one row per expected crate.
export function crateTable(stdout: string, stderr: string, expected: readonly string[]): Table {
	const built = new Map<string, string>();
	const scripts = new Map<string, string>();
	const failed = buildScriptFailures(stderr);
	let ok = false;
	for (const line of stdout.split(/\r?\n/)) {
		const message = parse(line);
		if (message.reason === "build-finished") ok = message.success === true;
		if (!message.package_id) continue;
		const { name, version } = packageOf(message.package_id);
		if (message.reason === "compiler-artifact" && !message.target?.kind?.includes("custom-build")) {
			built.set(name, version);
		} else if (message.reason === "build-script-executed" && message.out_dir) {
			scripts.set(name, message.out_dir);
		} else if (message.reason === "compiler-message" && message.message?.level === "error") {
			if (!failed.has(name)) failed.set(name, clean(message.message.message ?? "error"));
		}
	}
	const crates = expected.map((name): Crate => {
		const version = built.get(name) ?? null;
		if (version !== null) return { name, version, status: "ok" };
		const reason = failed.get(name);
		if (reason !== undefined) return { name, version, status: "fail", reason };
		return { name, version, status: ok ? "missing" : "blocked" };
	});
	return { ok, crates, built, scripts };
}

const BUILD_MS = 25 * 60_000;

// The skeleton linked as a cdylib for one target: every crate compiled, the calls kept by the
// exported draftyak_transport_check. --keep-going builds whatever doesn't depend on a failure.
// The host build skips --target, so cargo test and clippy reuse its dependencies.
export async function crateBuild(
	target: string,
	provider: Provider,
	extraEnv: Readonly<Record<string, string>> = {},
): Promise<CrateBuild> {
	const cross = target === hostTarget() ? [] : ["--target", target];
	const args = ["rustc", "-p", SKELETON, "--lib", "--crate-type", "cdylib", ...cross];
	const flags = ["--locked", "--keep-going", "--message-format", "json", ...featureArgs(provider)];
	const ran = await run("cargo", [...args, ...flags], {
		env: cargoEnv(extraEnv),
		timeoutMs: BUILD_MS,
	});
	const table = crateTable(ran.stdout, ran.stderr, expectedCrates(target, provider));
	const other = PROVIDER_CRATES[provider === "ring" ? "aws-lc-rs" : "ring"];
	const outDir = table.scripts.get("aws-lc-sys");
	const output = outDir === undefined ? "" : path.join(path.dirname(outDir), "output");
	const script = output !== "" && existsSync(output) ? readFileSync(output, "utf8") : "";
	return {
		target,
		provider,
		ok: table.ok && ran.code === 0,
		seconds: Math.round(ran.ms / 1000),
		crates: table.crates,
		strays: [...table.built.keys()].filter((name) => other.includes(name)),
		notes: buildNotes(`${script}\n${ran.stderr}`),
		log: tail(ran.stderr),
	};
}

// cargo <args> --locked <provider features> [-- <rest>]
export function cargo(
	args: readonly string[],
	provider: Provider,
	rest: readonly string[] = [],
): Promise<Ran> {
	const tool = rest.length > 0 ? ["--", ...rest] : [];
	return run("cargo", [...args, "--locked", ...featureArgs(provider), ...tool], {
		env: cargoEnv(),
		timeoutMs: BUILD_MS,
	});
}

function rustc(...args: string[]): string {
	const result = spawnSync("rustc", args, { cwd: spikeDir, encoding: "utf8", windowsHide: true });
	return result.status === 0 ? result.stdout : "";
}

export const hostTarget = (): string => /^host: (\S+)$/m.exec(rustc("-vV"))?.[1] ?? "";

export const rustcVersion = (): string => rustc("--version").trim();

// rustup keeps each installed target's std under <sysroot>/lib/rustlib/<target>.
export function rustTargetInstalled(target: string): boolean {
	const sysroot = rustc("--print", "sysroot").trim();
	return sysroot !== "" && existsSync(path.join(sysroot, "lib", "rustlib", target, "lib"));
}
