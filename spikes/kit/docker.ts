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
const BUILD_LABEL = "org.draftyak.spike-kit.build";
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

// Whether the engine is Docker Desktop's, on any OS. Its VM forwards host.docker.internal to the
// host's loopback; other engines reach the host at the bridge gateway.
export async function dockerDesktop(): Promise<boolean> {
	const info = await exec(cli(), ["info", "--format", "{{.OperatingSystem}}"], {
		timeoutMs: 20_000,
	});
	if (info.code !== 0) throw new DockerUnavailableError(`docker info failed: ${lastLine(info)}`);
	return /\bDocker Desktop\b/.test(info.stdout);
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
	return runArgs(spec, cidfile, []);
}

function runArgs(spec: DockerRunSpec, cidfile: string, extra: readonly string[]): string[] {
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
	return [...args, ...extra, spec.image, ...spec.cmd];
}

export interface DockerStartSpec extends Omit<DockerRunSpec, "timeoutMs"> {
	// Container TCP ports to publish, each on a port Docker picks on the host's 127.0.0.1 only.
	readonly publish?: readonly number[];
	// Maps host.docker.internal to the host, as Docker Desktop already does and Linux engines don't.
	readonly hostGateway?: boolean;
	// The container ends itself this long after it starts, even when the process that started it is
	// killed (default 10 minutes). cmd runs under the image's `timeout` (busybox or coreutils).
	readonly lifetimeMs?: number;
	// For `docker run --detach` itself, which pulls a missing image (default 120 s).
	readonly startTimeoutMs?: number;
}

export const START_LIFETIME_MS = 600_000;

// The sandboxed run of dockerRunArgs, detached; publishing and the host name need the bridge network.
export function dockerStartArgs(spec: DockerStartSpec, cidfile: string): string[] {
	const publish = spec.publish ?? [];
	if (spec.network !== "bridge" && (publish.length > 0 || spec.hostGateway)) {
		throw new Error("published ports and host.docker.internal need the bridge network");
	}
	const lifetime = spec.lifetimeMs ?? START_LIFETIME_MS;
	if (!Number.isInteger(lifetime) || lifetime < 1_000) throw new Error(`bad lifetime: ${lifetime}`);
	if (spec.cmd.length === 0) throw new Error("startInDocker needs a cmd to run for its lifetime");
	// Docker's init is PID 1, so `timeout` can end cmd: PID 1 ignores a SIGKILL from its own namespace.
	const extra = ["--detach", "--init"];
	for (const port of publish) {
		if (!Number.isInteger(port) || port < 1 || port > 65_535) {
			throw new Error(`bad container port: ${port}`);
		}
		extra.push("--publish", `127.0.0.1::${port}/tcp`);
	}
	if (spec.hostGateway) extra.push("--add-host", "host.docker.internal:host-gateway");
	const cmd = ["timeout", "-s", "KILL", String(Math.ceil(lifetime / 1_000)), ...spec.cmd];
	return runArgs({ ...spec, cmd }, cidfile, extra);
}

export interface StartedContainer extends AsyncDisposable {
	readonly containerId: string;
	// The host port on 127.0.0.1 that publishes a container port.
	port(containerPort: number): number;
	// What the container has written so far, stdout then stderr.
	logs(): Promise<string>;
	// `docker inspect --format`, such as the bridge address a server behind the container sees.
	inspect(format: string): Promise<string>;
	// Kills the container; --rm then removes it.
	stop(): Promise<void>;
}

// A process that exits normally removes the containers it left running. One that is killed runs no
// hook, so its containers end themselves when their lifetime runs out.
const started = new Set<string>();
let exitHook = false;

function removeAtExit(docker: string, id: string): void {
	started.add(id);
	if (exitHook) return;
	exitHook = true;
	process.once("exit", () => {
		for (const left of started) {
			try {
				execSync(docker, ["rm", "--force", left], { timeoutMs: 15_000 });
			} catch {}
		}
	});
}

// A background container in the sandbox (unnamed, --rm, labelled, pinned image): for a server a
// test talks to, such as a proxy. Stop it when done (await using); the exit hook and the lifetime
// are last resorts.
export async function startInDocker(spec: DockerStartSpec): Promise<StartedContainer> {
	const docker = cli();
	const cidfile = path.join(os.tmpdir(), `draftyak-cid-${randomBytes(6).toString("hex")}`);
	const args = dockerStartArgs(spec, cidfile);
	const readId = (): string =>
		fs.existsSync(cidfile) ? fs.readFileSync(cidfile, "utf8").trim() : "";
	let containerId = "";
	const stop = async (): Promise<void> => {
		if (!started.has(containerId)) return;
		const removed = await exec(docker, ["rm", "--force", containerId], { timeoutMs: 60_000 });
		if (removed.code !== 0 && !/no such container/i.test(removed.stderr)) {
			throw new Error(`docker rm ${containerId.slice(0, 12)}: ${lastLine(removed)}`);
		}
		started.delete(containerId);
	};
	try {
		const options = { timeoutMs: spec.startTimeoutMs ?? 120_000, signal: spec.signal };
		const result = await exec(docker, args, options).finally(() => {
			containerId = readId();
			if (containerId !== "") removeAtExit(docker, containerId);
		});
		if (result.code !== 0 || !/^[0-9a-f]{64}$/.test(containerId)) {
			const how = result.timedOut ? "timed out" : `exit code ${result.code}`;
			throw new Error(`docker run failed (${how}): ${lastLine(result)}`);
		}
		const ports = new Map<number, number>();
		for (const containerPort of spec.publish ?? []) {
			const shown = await exec(docker, ["port", containerId, `${containerPort}/tcp`], {
				timeoutMs: 30_000,
			});
			const hostPort = /^127\.0\.0\.1:(\d+)\s*$/m.exec(shown.stdout)?.[1];
			if (shown.code !== 0 || hostPort === undefined) {
				throw new Error(`docker port ${containerPort}: ${lastLine(shown)}`);
			}
			ports.set(containerPort, Number(hostPort));
		}
		const port = (containerPort: number): number => {
			const hostPort = ports.get(containerPort);
			if (hostPort === undefined)
				throw new Error(`container port ${containerPort} isn't published`);
			return hostPort;
		};
		const logs = async (): Promise<string> => {
			const shown = await exec(docker, ["logs", containerId], { timeoutMs: 30_000 });
			return `${shown.stdout}${shown.stderr}`;
		};
		const inspect = async (format: string): Promise<string> => {
			const shown = await exec(docker, ["inspect", "--format", format, containerId], {
				timeoutMs: 30_000,
			});
			if (shown.code !== 0) throw new Error(`docker inspect: ${lastLine(shown)}`);
			return shown.stdout.trim();
		};
		return { containerId, port, logs, inspect, stop, [Symbol.asyncDispose]: stop };
	} catch (error) {
		await stop().catch(() => undefined);
		throw error;
	} finally {
		fs.rmSync(cidfile, { force: true });
	}
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

export interface BuildSpec {
	// The Dockerfile's text; the build sends no other context.
	readonly dockerfile: string;
	// The network RUN steps get: bridge (Docker's default build network) or none.
	readonly network: "none" | "bridge";
	readonly platform?: string;
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export interface BuiltImage extends AsyncDisposable {
	// sha256:<hex>, which runInDocker takes as a pinned image.
	readonly id: string;
	remove(): Promise<void>;
}

// Every FROM names a digest-pinned image or an earlier stage, and so does a syntax directive (its
// frontend is an image too). With no context, ADD and COPY have nothing to read, and RUN --mount
// would read one or pull an image (from=). An escape directive would change which lines are
// instructions, so it is refused too.
export function checkDockerfile(dockerfile: string): void {
	const stages = new Set<string>();
	let bases = 0;
	for (const line of dockerfile.replace(/\\\r?\n/g, " ").split(/\r?\n/)) {
		if (/^\s*#\s*escape\s*=/i.test(line)) throw new Error("buildImage takes no escape directive");
		const directive = /^\s*#\s*syntax\s*=\s*(\S+)/i.exec(line)?.[1];
		if (directive !== undefined && !PINNED_IMAGE.test(directive)) {
			throw new Error(`pin the syntax directive by digest: ${directive}`);
		}
		if (/^\s*RUN\s+(?:--\S+\s+)*--mount\b/i.test(line)) {
			throw new Error("RUN --mount reads a build context or an image; buildImage allows neither");
		}
		const [instruction = "", ...words] = line.trim().split(/\s+/);
		const keyword = instruction.toUpperCase();
		if (keyword === "ADD" || keyword === "COPY") {
			throw new Error(`${keyword} needs a build context, and buildImage sends none`);
		}
		if (keyword !== "FROM") continue;
		const [image = "", as, stage] = words.filter((word) => !word.startsWith("--"));
		if (!PINNED_IMAGE.test(image) && !stages.has(image.toLowerCase())) {
			throw new Error(`pin the image by digest (name@sha256:<hex>): FROM ${image}`);
		}
		if (as?.toUpperCase() === "AS" && stage) stages.add(stage.toLowerCase());
		bases++;
	}
	if (bases === 0) throw new Error("the Dockerfile has no FROM");
}

// An unnamed image (no tag) carrying the kit's label, with BuildKit's plain log for errors. The
// build's own label gives each build its own image, which shares the cached layers: a rebuild of the
// same Dockerfile would otherwise return the same image, and removing it would break other users.
export function dockerBuildArgs(
	spec: BuildSpec,
	context: string,
	metadataFile: string,
	build: string,
): string[] {
	checkDockerfile(spec.dockerfile);
	if (spec.network !== "none" && spec.network !== "bridge") {
		throw new Error(`network is none or bridge, not ${spec.network}`);
	}
	if (!/^[0-9a-f]{12}$/.test(build)) throw new Error(`a build id is 12 hex digits, not ${build}`);
	const network = spec.network === "bridge" ? "default" : "none";
	const args = ["build", "--metadata-file", metadataFile, "--label", LABEL];
	args.push("--label", `${BUILD_LABEL}=${build}`, "--network", network);
	args.push("--provenance=false", "--progress=plain");
	if (spec.platform) args.push("--platform", spec.platform);
	return [...args, context];
}

const lastLine = (result: ExecResult): string =>
	(result.stderr || result.stdout).trim().split(/\r?\n/).at(-1)?.trim() ?? "";

// --rm removes a stopped container a moment after `docker run` returns, and until then the
// container holds its image and volumes, so removal retries for up to 10 s.
async function removeWhenFree(docker: string, args: readonly string[], gone: RegExp) {
	for (let tries = 1; ; tries++) {
		const removed = await exec(docker, args, { timeoutMs: 60_000 });
		if (removed.code === 0 || gone.test(removed.stderr)) return;
		if (tries === 40) throw new Error(`docker ${args.join(" ")}: ${lastLine(removed)}`);
		await sleep(250);
	}
}

// The containerd image store names an image by its manifest digest, the classic store by its
// config digest; build metadata has both, and the store answers for one of them.
async function builtImageId(docker: string, metadataFile: string): Promise<string | undefined> {
	const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8")) as Record<string, unknown>;
	for (const key of ["containerimage.digest", "containerimage.config.digest"]) {
		const digest = metadata[key];
		if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) continue;
		const found = await exec(docker, ["image", "inspect", "--format", "{{.Id}}", digest], {
			timeoutMs: 60_000,
		});
		const id = found.stdout.trim();
		if (found.code === 0 && /^sha256:[0-9a-f]{64}$/.test(id)) return id;
	}
	return undefined;
}

// Builds from a context folder holding only the Dockerfile. Remove the image when done (await
// using): BuildKit's layer cache keeps a rebuild quick.
export async function buildImage(spec: BuildSpec): Promise<BuiltImage> {
	const docker = cli();
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "draftyak-build-"));
	try {
		const context = path.join(dir, "context");
		const metadataFile = path.join(dir, "metadata.json");
		fs.mkdirSync(context);
		fs.writeFileSync(path.join(context, "Dockerfile"), spec.dockerfile);
		const build = randomBytes(6).toString("hex");
		const args = dockerBuildArgs(spec, context, metadataFile, build);
		const options = { timeoutMs: spec.timeoutMs ?? 600_000, signal: spec.signal };
		const result = await exec(docker, args, options);
		const how = result.timedOut ? "timed out" : `exit code ${result.code}`;
		if (result.code !== 0) throw new Error(`docker build failed (${how}): ${lastLine(result)}`);
		const id = await builtImageId(docker, metadataFile);
		if (id === undefined) throw new Error("docker build: the built image isn't in the store");
		const remove = () => removeWhenFree(docker, ["image", "rm", id], /no such image/i);
		return { id, remove, [Symbol.asyncDispose]: remove };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

export interface DockerVolume {
	readonly name: string;
	remove(): Promise<void>;
}

// draftyak-<suffix>, a volume carrying the kit's label that outlives the run (a cache such as
// CARGO_HOME): created when missing, reused when the kit created it, refused otherwise.
export async function namedVolume(suffix: string): Promise<DockerVolume> {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(suffix)) throw new Error("volume names are kebab-case");
	const docker = cli();
	const name = `draftyak-${suffix}`;
	const created = await exec(docker, ["volume", "create", "--label", LABEL, name], {
		timeoutMs: 60_000,
	});
	if (created.code !== 0) throw new Error(`docker volume create: ${lastLine(created)}`);
	const [key, value] = LABEL.split("=");
	const format = `{{index .Labels "${key}"}}`;
	const label = await exec(docker, ["volume", "inspect", "--format", format, name], {
		timeoutMs: 60_000,
	});
	if (label.stdout.trim() !== value) throw new Error(`${name} exists without the kit's label`);
	const remove = () => removeWhenFree(docker, ["volume", "rm", name], /no such volume/i);
	return { name, remove };
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
