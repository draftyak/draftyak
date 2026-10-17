import { existsSync, globSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { type Captured, capture, type RunOptions, run } from "./lib/spawn.ts";
import { telemetryOff } from "./lib/tools.ts";

// pnpm m0:prefetch, and the M0 environment verify:m0 checks. profiles/m0.ts imports this file, so
// it imports only node: built-ins and relative files.
const win = process.platform === "win32";

export interface Exec {
	run(command: string, args: readonly string[], options?: RunOptions): Promise<number>;
	capture(command: string, args: readonly string[], options?: RunOptions): Promise<Captured>;
}

type Deps = Readonly<Record<string, string>>;
export interface Manifest {
	readonly name?: string;
	readonly scripts?: Deps;
	readonly dependencies?: Deps;
	readonly devDependencies?: Deps;
}

// The `packages:` list of pnpm-workspace.yaml, read line by line, since verify runs before install.
function workspaceGlobs(root: string): string[] {
	const lines = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8").split(/\r?\n/);
	const block = lines.slice(lines.indexOf("packages:") + 1);
	const end = block.findIndex((line) => !/^\s+-\s/.test(line));
	return block
		.slice(0, end === -1 ? block.length : end)
		.map((line) => line.replace(/^\s+-\s+|["']/g, "").trim());
}

export function workspacePackages(root: string): { dir: string; manifest: Manifest }[] {
	const globs = workspaceGlobs(root).map((glob) => `${glob}/package.json`);
	return globSync(globs, { cwd: root })
		.toSorted()
		.map((file) => ({
			dir: path.dirname(file).split(path.sep).join("/"),
			manifest: JSON.parse(readFileSync(path.join(root, file), "utf8")) as Manifest,
		}));
}

function isFile(file: string | undefined): file is string {
	try {
		return !!file && statSync(file).isFile();
	} catch {
		return false;
	}
}

// PATH, then the usual install, then the override variable: the order of M0.3's zizmor step and M0.5.
function find(name: string, env: NodeJS.ProcessEnv, ...fallbacks: (string | undefined)[]) {
	const dirs = (env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== "");
	const onPath = dirs.map((dir) => path.join(dir, win ? `${name}.exe` : name));
	return [...onPath, ...fallbacks].find(isFile);
}

const under = (base: string | undefined, ...parts: string[]): string | undefined =>
	win && base ? path.join(base, ...parts) : undefined;
const winget = "Microsoft/WinGet/Packages/astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe";

type Locate = (env: NodeJS.ProcessEnv) => string | undefined;
export const tools: Readonly<Record<"docker" | "uv" | "gpgv", Locate>> = {
	docker: (env) =>
		find("docker", env, under(env.ProgramFiles, "Docker/Docker/resources/bin/docker.exe")),
	uv: (env) => find("uvx", env, under(env.LOCALAPPDATA, winget, "uvx.exe"), env.DRAFTYAK_UV),
	gpgv: (env) =>
		find("gpgv", env, under(env.ProgramFiles, "Git/usr/bin/gpgv.exe"), env.DRAFTYAK_GPG),
};

export interface NodeTarget {
	readonly version: string;
	readonly platform: string;
	readonly arch: string;
}

const fetchNode = (root: string): string =>
	path.join(root, "tools", "fetch-node", "fetch-node.mjs");

// Both Nodes of versions.json for the host and for Linux (the Docker cases); undefined before M0.5.
export function nodeTargets(
	root: string,
	host: { readonly platform: string; readonly arch: string } = process,
): NodeTarget[] | undefined {
	const file = path.join(root, "tools", "fetch-node", "versions.json");
	if (!existsSync(file) || !existsSync(fetchNode(root))) return undefined;
	const versions = JSON.parse(readFileSync(file, "utf8")) as { minimum: string; bundled: string };
	const os = host.platform === "win32" ? "win" : host.platform === "darwin" ? "darwin" : "linux";
	const arch = host.arch === "arm64" ? "arm64" : "x64";
	return [...new Set([versions.minimum, versions.bundled])].flatMap((version) =>
		[...new Set([os, "linux"])].map((platform) => ({ version, platform, arch })),
	);
}

export function fetchNodeArgs(root: string, target: NodeTarget, ...extra: string[]): string[] {
	const { version, platform, arch } = target;
	return [fetchNode(root), "--version", version, "--platform", platform, "--arch", arch, ...extra];
}

export const label = (target: NodeTarget): string =>
	`${target.version} ${target.platform}-${target.arch}`;

const imageRef =
	/(?:[a-z0-9][a-z0-9._-]*\/)*[a-z0-9][a-z0-9._-]*(?::\w[\w.-]{0,127})?@sha256:[a-f0-9]{64}/g;

export const imageRefs = (text: string): string[] => [...new Set(text.match(imageRef) ?? [])];

// Items pin images by digest at first use, written as name[:tag]@sha256:<64 hex> in tools/ or spikes/.
export async function pinnedImages(root: string, exec: Exec): Promise<string[]> {
	const listed = await exec.capture("git", ["ls-files", "-z", "--", "tools", "spikes"], {
		cwd: root,
	});
	if (listed.code !== 0) throw new Error(`git ls-files failed: ${listed.stderr.trim()}`);
	const files = listed.stdout
		.split("\0")
		.filter((file) => /\.(?:[cm]?[jt]s|json|ya?ml|toml)$|(?:^|\/)Dockerfile$/.test(file))
		.filter((file) => !/(?:^|\/)(?:evidence|vendor|fixtures)\//.test(file))
		.filter((file) => existsSync(path.join(root, file)));
	const refs = files.flatMap((file) => imageRefs(readFileSync(path.join(root, file), "utf8")));
	return [...new Set(refs)].toSorted();
}

export function spikesWithPrefetch(root: string): string[] {
	const dir = path.join(root, "spikes");
	if (!existsSync(dir)) return [];
	const has = (name: string): boolean => existsSync(path.join(dir, name, "prefetch.ts"));
	return readdirSync(dir).filter(has).toSorted();
}

const ensure = [
	"const kit = await import(process.argv[1]);",
	"const ensure = kit.ensure ?? kit.docker?.ensure;",
	'if (typeof ensure !== "function") throw new Error("spikes/kit/docker.ts exports no ensure()");',
	"await ensure();",
].join("\n");

// docker hangs when its daemon accepts connections but never answers, so docker queries run through
// this script: it kills the command after <ms> and exits 124.
const within = [
	'import { spawnSync } from "node:child_process";',
	"const [ms, command, ...args] = process.argv.slice(1);",
	'const options = { encoding: "utf8", timeout: Number(ms), windowsHide: true };',
	"const result = spawnSync(command, args, options);",
	'process.stdout.write(result.stdout ?? "");',
	'process.stderr.write(result.stderr ?? "");',
	'process.exitCode = result.error?.code === "ETIMEDOUT" ? 124 : (result.status ?? 1);',
].join("\n");

export const dockerTimeoutMs = 20_000;

export function bounded(ms: number, command: string, args: readonly string[]): [string, string[]] {
	return [process.execPath, ["--input-type=module", "-e", within, String(ms), command, ...args]];
}

export function inspectImage(
	exec: Exec,
	docker: string,
	image: string,
	options?: RunOptions,
): Promise<Captured> {
	const args = ["image", "inspect", "--format", "{{.Id}}", image];
	return exec.capture(...bounded(dockerTimeoutMs, docker, args), options);
}

// Docker through the spike kit (M0.6a), whose ensure() starts Docker Desktop when it isn't running.
// `docker` is set only when Docker answers.
export async function dockerState(
	root: string,
	exec: Exec,
	env: NodeJS.ProcessEnv,
): Promise<{ docker?: string; detail: string }> {
	const kit = path.join(root, "spikes", "kit", "docker.ts");
	if (existsSync(kit)) {
		console.log("docker: making sure Docker runs, through the spike kit (up to 2 min)");
		const args = ["--input-type=module", "-e", ensure, pathToFileURL(kit).href];
		const code = await exec.run(process.execPath, args, { cwd: root, env });
		if (code !== 0) return { detail: `the spike kit couldn't start Docker (exit code ${code})` };
	}
	const docker = tools.docker(env);
	if (docker === undefined) return { detail: "docker not found: install Docker Desktop" };
	const args = ["info", "--format", "{{.ServerVersion}}"];
	const info = await exec.capture(...bounded(dockerTimeoutMs, docker, args), { cwd: root, env });
	if (info.code === 0) return { docker, detail: `Docker ${info.stdout.trim()}` };
	if (info.code === 124) {
		return { detail: `docker info didn't answer within ${dockerTimeoutMs / 1000} s` };
	}
	return {
		detail: existsSync(kit)
			? "docker info still fails after the kit's ensure()"
			: "Docker isn't running: start Docker Desktop and wait for `docker info` (about 1 min); verify:m0 starts it through spikes/kit once that lands",
	};
}

export async function prefetch(root: string, exec: Exec, env: NodeJS.ProcessEnv): Promise<number> {
	const failed: string[] = [];
	const at = { cwd: root, env };
	const step = async (what: string, command: string, args: string[], options = at) => {
		const code = await exec.run(command, args, options);
		if (code !== 0) failed.push(`${what}: exit code ${code}`);
	};

	console.log("m0:prefetch: Node binaries");
	const targets = nodeTargets(root);
	if (targets === undefined)
		console.log("  skipped: tools/fetch-node isn't in the tree yet (M0.5)");
	for (const target of targets ?? []) {
		await step(`Node ${label(target)}`, process.execPath, fetchNodeArgs(root, target));
	}

	console.log("m0:prefetch: pinned images");
	const images = await pinnedImages(root, exec);
	const { docker, detail } =
		images.length > 0 ? await dockerState(root, exec, env) : { detail: "" };
	if (images.length === 0)
		console.log("  skipped: no digest-pinned image in tools/ or spikes/ yet");
	else if (docker === undefined) failed.push(`images: ${detail}`);
	else {
		for (const image of images) {
			const present = (await inspectImage(exec, docker, image, at)).code === 0;
			console.log(`  ${present ? "present" : "pulling"}: ${image}`);
			if (!present) await step(`docker pull ${image}`, docker, ["pull", image]);
		}
	}

	console.log("m0:prefetch: spike caches");
	const spikes = spikesWithPrefetch(root);
	if (spikes.length === 0) console.log("  skipped: no spike has a prefetch.ts yet");
	for (const id of spikes) {
		const cwd = path.join(root, "spikes", id);
		await step(`spikes/${id}/prefetch.ts`, process.execPath, ["prefetch.ts"], { cwd, env });
	}

	for (const failure of failed) console.error(`m0:prefetch: failed: ${failure}`);
	console.log(`m0:prefetch: ${failed.length === 0 ? "done" : `${failed.length} failed`}`);
	return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	// pnpm passes a leading `--` through from bash and cmd; PowerShell's pnpm.ps1 drops it.
	const args = process.argv.slice(2).filter((arg, index) => index > 0 || arg !== "--");
	const usage =
		"usage: pnpm m0:prefetch   (both Nodes, pinned images, then each spike's prefetch.ts)";
	const unknown = args.find((arg) => arg !== "--help" && arg !== "-h");
	if (unknown !== undefined) {
		console.error(`m0:prefetch: unknown argument ${unknown}\n${usage}`);
		process.exitCode = 2;
	} else if (args.length > 0) {
		console.log(usage);
	} else {
		Object.assign(process.env, telemetryOff);
		const exec: Exec = {
			run: (command, args, options) => run({ command, args }, options),
			capture: (command, args, options) => capture({ command, args }, options),
		};
		const root = path.resolve(import.meta.dirname, "..", "..");
		process.exitCode = await prefetch(root, exec, process.env).catch((error: unknown) => {
			console.error(`m0:prefetch: ${error instanceof Error ? error.message : String(error)}`);
			return 1;
		});
	}
}
