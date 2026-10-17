import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ExecResult, exec, execSync, sleep } from "./exec.ts";
import { cacheDir, findPackageDir } from "./repo.ts";
import { type SkipContext, skipOrFail } from "./skip.ts";

export const DESKTOP_EXE = "C:/Program Files/Docker/Docker/Docker Desktop.exe";
export const LABEL = "org.draftyak.spike-kit=1";
// name[:tag]@sha256:<digest>, or a bare image id: never a tag that can move.
export const PINNED_IMAGE: RegExp = /^(?:([a-z0-9][\w./-]*(?::[\w.-]+)?)@)?sha256:[0-9a-f]{64}$/;

export class DockerUnavailableError extends Error {
	override name = "DockerUnavailableError";
}

export function findDocker(env: NodeJS.ProcessEnv = process.env): string | null {
	const file = process.platform === "win32" ? "docker.exe" : "docker";
	const dirs = (env.PATH ?? env.Path ?? "").split(path.delimiter).filter((dir) => dir !== "");
	if (process.platform === "win32") dirs.push("C:/Program Files/Docker/Docker/resources/bin");
	const found = dirs
		.map((dir) => path.join(dir, file))
		.find((candidate) => fs.existsSync(candidate));
	return found ?? null;
}

function cli(): string {
	const found = findDocker();
	if (found === null) throw new DockerUnavailableError("no docker CLI on PATH");
	return found;
}

const serverOs = (docker: string): string =>
	execSync(docker, ["version", "--format", "{{.Server.Os}}"], { timeoutMs: 15_000 }).stdout.trim();

// requires:docker: a docker CLI, and on Windows Docker Desktop (ensure() starts it and checks it
// runs Linux containers) or an engine that does. GitHub's Windows Server runners only run Windows ones.
export function linuxContainers(
	options: {
		readonly env?: NodeJS.ProcessEnv;
		readonly platform?: NodeJS.Platform;
		readonly desktop?: string;
		readonly engineOs?: (docker: string) => string;
	} = {},
): boolean {
	const { platform = process.platform, desktop = DESKTOP_EXE, engineOs = serverOs } = options;
	const docker = findDocker(options.env);
	if (docker === null) return false;
	return platform !== "win32" || fs.existsSync(desktop) || engineOs(docker) !== "windows";
}

export type EngineState =
	| { readonly serverVersion: string; readonly osType: string }
	| { readonly error: string };

async function probeEngine(timeoutMs: number): Promise<EngineState> {
	const info = await exec(cli(), ["info", "--format", "{{.ServerVersion}} {{.OSType}}"], {
		timeoutMs,
	});
	const [serverVersion = "", osType = ""] = info.stdout.trim().split(" ");
	if (info.code === 0 && /^\d/.test(serverVersion)) return { serverVersion, osType };
	const last = (info.stderr || info.stdout).trim().split(/\r?\n/).at(-1)?.trim();
	return {
		error: info.timedOut ? `no answer in ${timeoutMs} ms` : last || `exit code ${info.code}`,
	};
}

export interface EnsureOptions {
	readonly timeoutMs?: number;
	readonly pollMs?: number;
	readonly desktop?: string | null;
	readonly env?: NodeJS.ProcessEnv;
	readonly probe?: (timeoutMs: number) => Promise<EngineState>;
	readonly start?: (desktop: string, failed: (error: Error) => void) => void;
}

export interface DockerInfo {
	readonly serverVersion: string;
	readonly started: boolean;
	readonly waitedMs: number;
}

function launch(desktop: string, failed: (error: Error) => void): void {
	try {
		spawn(desktop, [], { detached: true, stdio: "ignore" }).once("error", failed).unref();
	} catch (error) {
		failed(error as Error);
	}
}

// Starts Docker Desktop when `docker info` fails and waits up to 120 s (the owner is in docker-users).
// Not inside turbo: turbo ends a task's processes with it, Docker Desktop included.
export async function ensure(options: EnsureOptions = {}): Promise<DockerInfo> {
	const { probe = probeEngine, timeoutMs = 120_000, pollMs = 2_000, env = process.env } = options;
	const begun = performance.now();
	const elapsed = (): number => Math.round(performance.now() - begun);
	const ready = (state: EngineState, started: boolean): DockerInfo | null => {
		if ("error" in state) return null;
		if (state.osType !== "linux") {
			const what = `${state.osType || "unknown"} containers`;
			throw new DockerUnavailableError(`the engine runs ${what}: switch it to Linux containers`);
		}
		return { serverVersion: state.serverVersion, started, waitedMs: started ? elapsed() : 0 };
	};
	let state = await probe(20_000);
	const running = ready(state, false);
	if (running !== null) return running;
	const failure = (why: string): DockerUnavailableError =>
		new DockerUnavailableError(
			`docker info failed (${"error" in state ? state.error : ""}); ${why}`,
		);
	const known = process.platform === "win32" ? DESKTOP_EXE : null;
	const desktop = options.desktop === undefined ? known : options.desktop;
	const context = env.DOCKER_CONTEXT ?? "";
	if (env.DOCKER_HOST || !/^(?:|default|desktop-linux)$/.test(context)) {
		throw failure(
			"DOCKER_HOST or DOCKER_CONTEXT names another engine, so Docker Desktop stays off",
		);
	}
	if (desktop === null || !fs.existsSync(desktop)) {
		throw failure("there is no Docker Desktop to start");
	}
	if (env.TURBO_HASH) {
		throw failure("the kit doesn't start Docker Desktop inside turbo: start it first");
	}
	let launchError: Error | undefined;
	(options.start ?? launch)(desktop, (error) => {
		launchError = error;
	});
	while (elapsed() < timeoutMs) {
		await sleep(pollMs);
		if (launchError) throw failure(`starting Docker Desktop failed: ${launchError.message}`);
		state = await probe(Math.max(1_000, Math.min(20_000, timeoutMs - elapsed())));
		const started = ready(state, true);
		if (started !== null) return started;
	}
	throw failure(`Docker Desktop didn't start within ${Math.round(timeoutMs / 1000)} s`);
}

// For heavy tests: Docker running, or skipOrFail (a failure under DRAFTYAK_STRICT_SKIPS=1).
export async function needDocker(ctx: SkipContext, options?: EnsureOptions): Promise<DockerInfo> {
	try {
		return await ensure(options);
	} catch (error) {
		if (!(error instanceof DockerUnavailableError)) throw error;
		return skipOrFail(ctx, `Docker unavailable: ${error.message}`);
	}
}

export type DockerMount =
	| { readonly source: string; readonly target: string }
	| { readonly volume: string; readonly target: string };

export interface DockerRunSpec {
	readonly image: string;
	readonly network: "none" | "bridge";
	readonly cmd: readonly string[];
	readonly mounts?: readonly DockerMount[];
	readonly platform?: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly workdir?: string;
	// The sandbox is nobody (65534) on a read-only root with a noexec /tmp tmpfs, no capabilities,
	// no new privileges, 1024 processes and 4 GiB. Opt out only where a spike must (M0.21's cargo).
	readonly user?: string;
	readonly writableRoot?: boolean;
	readonly memory?: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

function containerPath(target: string): string {
	if (!/^\/[\w./-]*$/.test(target)) {
		throw new Error(`bad container path: ${JSON.stringify(target)}`);
	}
	return target;
}

function mountArg(mount: DockerMount): string {
	const target = containerPath(mount.target);
	if ("volume" in mount) {
		if (!/^\w[\w.-]*$/.test(mount.volume)) throw new Error(`bad volume name: ${mount.volume}`);
		return `type=volume,source=${mount.volume},target=${target}`;
	}
	const source = path.resolve(mount.source);
	if (!path.isAbsolute(mount.source) || /[\p{Cc},"]/u.test(mount.source)) {
		throw new Error("bind sources are absolute paths without commas, quotes or control characters");
	}
	const fold = (dir: string): string => (process.platform === "win32" ? dir.toLowerCase() : dir);
	if (fold(fs.realpathSync(source)) !== fold(source)) {
		throw new Error(`bind source runs through a link; mount a stageForDocker() copy: ${source}`);
	}
	return `type=bind,source=${source},target=${target},readonly`;
}

// Unnamed --rm containers in the sandbox; binds are always read-only; images are pinned.
export function dockerRunArgs(spec: DockerRunSpec, cidfile: string): string[] {
	if (!PINNED_IMAGE.test(spec.image)) {
		throw new Error(`pin the image by digest (name@sha256:<hex>) or image id: ${spec.image}`);
	}
	if (spec.network !== "none" && spec.network !== "bridge") {
		throw new Error(`network is none or bridge, not ${spec.network}`);
	}
	const { user = "65534:65534", memory = "4g" } = spec;
	if (!/^\w[\w.-]*(?::\w[\w.-]*)?$/.test(user)) throw new Error(`bad user: ${user}`);
	if (!/^\d+[kmg]?$/.test(memory)) throw new Error(`bad memory limit: ${memory}`);
	const args = ["run", "--rm", "--cidfile", cidfile, "--label", LABEL, "--network", spec.network];
	args.push("--user", user, "--cap-drop=ALL", "--security-opt=no-new-privileges");
	args.push("--pids-limit=1024", `--memory=${memory}`);
	if (!spec.writableRoot) args.push("--read-only", "--tmpfs", "/tmp");
	if (spec.platform) args.push("--platform", spec.platform);
	if (spec.workdir) args.push("--workdir", containerPath(spec.workdir));
	for (const [name, value] of Object.entries(spec.env ?? {})) {
		if (!/^[A-Za-z_]\w*$/.test(name) || value.includes("\0")) throw new Error(`bad env: ${name}`);
		args.push("--env", `${name}=${value}`);
	}
	for (const mount of spec.mounts ?? []) args.push("--mount", mountArg(mount));
	return [...args, spec.image, ...spec.cmd];
}

export interface DockerResult extends ExecResult {
	readonly containerId: string;
}

// Kills the container when the run times out (default 240 s, inside the heavy tier's 300 s) or
// `signal` aborts (pass the test's ctx.signal).
export async function runInDocker(spec: DockerRunSpec): Promise<DockerResult> {
	const docker = cli();
	const cidfile = path.join(os.tmpdir(), `draftyak-cid-${randomBytes(6).toString("hex")}`);
	const args = dockerRunArgs(spec, cidfile);
	const containerId = (): string =>
		fs.existsSync(cidfile) ? fs.readFileSync(cidfile, "utf8").trim() : "";
	let result: ExecResult | undefined;
	try {
		const options = { timeoutMs: spec.timeoutMs ?? 240_000, signal: spec.signal };
		result = await exec(docker, args, options);
		return { ...result, containerId: containerId() };
	} finally {
		const id = containerId();
		if (id !== "" && (result === undefined || result.timedOut)) {
			await exec(docker, ["kill", id], { timeoutMs: 30_000 }).catch(() => undefined);
		}
		fs.rmSync(cidfile, { force: true });
	}
}

export interface StageSpec {
	readonly name: string;
	readonly from: string;
	readonly packages?: readonly string[];
	readonly files?: readonly string[];
}

export interface Stage extends Disposable {
	readonly dir: string;
	remove(): void;
}

function copyInto(source: string, target: string): void {
	const filter = (item: string): boolean =>
		item === source || path.basename(item) !== "node_modules";
	fs.cpSync(source, target, { recursive: true, dereference: true, filter });
}

// Copies the named packages (realpath-resolved from `from`) and fixtures into a link-free folder
// under the cache dir: pnpm's junctions and win32-only binaries don't work in Linux containers.
export function stageForDocker(
	spec: StageSpec,
	options: { readonly cacheDir?: string } = {},
): Stage {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(spec.name)) throw new Error("stage names are kebab-case");
	const bad = spec.packages?.find((name) => !/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name));
	if (bad !== undefined) throw new Error(`stageForDocker: not a package name: ${bad}`);
	const root = path.join(options.cacheDir ?? cacheDir(), "docker-stage");
	fs.mkdirSync(root, { recursive: true });
	for (const entry of fs.readdirSync(root)) {
		const stats = fs.statSync(path.join(root, entry), { throwIfNoEntry: false });
		if (stats && stats.mtimeMs < Date.now() - 86_400_000) {
			fs.rmSync(path.join(root, entry), { recursive: true, force: true });
		}
	}
	const dir = fs.mkdtempSync(path.join(root, `${spec.name}-`));
	const remove = (): void => fs.rmSync(dir, { recursive: true, force: true });
	try {
		// mkdtemp makes it 0700; the container's nobody user has to read it on Linux hosts.
		fs.chmodSync(dir, 0o755);
		for (const name of spec.packages ?? []) {
			const found = findPackageDir(name, spec.from);
			if (found === null) {
				throw new Error(`stageForDocker: ${name} isn't installed for ${spec.from}`);
			}
			copyInto(fs.realpathSync(found), path.join(dir, "node_modules", name));
		}
		for (const file of spec.files ?? []) {
			const relative = path.normalize(file);
			if (path.isAbsolute(relative) || relative.startsWith("..")) {
				throw new Error(`stageForDocker: files are paths inside ${spec.from}: ${file}`);
			}
			copyInto(path.join(spec.from, relative), path.join(dir, relative));
		}
		for (const entry of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
			const stats = fs.lstatSync(path.join(dir, entry));
			if (stats.isSymbolicLink() || (stats.isFile() && stats.nlink > 1)) {
				throw new Error(`stageForDocker: ${entry} is still a link`);
			}
		}
		return { dir, remove, [Symbol.dispose]: remove };
	} catch (error) {
		remove();
		throw error;
	}
}
