import { randomUUID } from "node:crypto";
import path from "node:path";
import type { NativeContext, NativeSuite } from "./native.ts";
import type { Outcome } from "./outcome.ts";
import { requireOneTest, requireSuccess } from "./outcome.ts";
import { transportCommands } from "./suite.ts";

const LABEL = "org.draftyak.native-store";
const ENDPOINT = "unix:///var/run/docker.sock";
const FAILURE = "key_store::linux_environment::native_store_unavailable_has_no_fallback";
const STATES = ["no-bus", "no-service", "no-collection", "locked"] as const;
const FAILURE_STAGES = new Set([
	"setup",
	"bus",
	"service",
	"default-alias",
	"collections",
	"collections-query",
	"collections-shape",
	"collections-empty",
	"unlocked",
	"lock",
	"locked",
	"command",
]);
const FAILURE_SIGNALS = new Set(["SIGTERM", "SIGKILL", "SIGINT", "SIGABRT", "SIGSEGV"]);
const FIXTURE = "tools/transport-tests/fixtures/linux-store";
const COMMON_NAMES = [
	"stored mock identity",
	"clippy native-store",
	"clippy native-store,mock-store",
	"successful_platform_io_is_not_a_constant_refusal",
	"only_no_entry_becomes_missing",
	"platform_read_failures_never_create_or_replace_identity",
	"platform_write_failures_stop_before_readback",
	"platform_failure_diagnostics_do_not_format_backend_errors",
	"healthy native store roundtrip",
] as const;

export function linuxCaseNames(): readonly string[] {
	return [
		"isolated image",
		"locked dependencies",
		...COMMON_NAMES,
		...STATES.map((state) => `${state} native refusal`),
	].map((name) => `linux: ${name}`);
}

/** Only fixed diagnostic fields escape; captured native/backend text stays private. */
function containerFailure(result: Outcome, state: string | undefined): Error {
	const selected =
		state === "healthy" ? "healthy" : (STATES.find((value) => value === state) ?? "command");
	const markers = result.stdout
		.split(/\r?\n/)
		.filter((line) => line.startsWith("DYTEST linux-store verified state="));
	const stateVerified =
		selected !== "command" &&
		markers.length === 1 &&
		markers[0] === `DYTEST linux-store verified state=${selected}`;
	const prefix = "DYTEST linux-store failed stage=";
	const failures = [result.stdout, result.stderr].flatMap((output) =>
		output.split(/\r?\n/).filter((line) => line.startsWith(prefix)),
	);
	const token = failures.length === 1 ? failures[0]?.slice(prefix.length) : undefined;
	const stage = token !== undefined && FAILURE_STAGES.has(token) ? token : "unknown";
	const code =
		result.code !== null && Number.isInteger(result.code) && result.code >= 0 && result.code <= 255
			? result.code
			: "unknown";
	const signal =
		result.signal === null
			? "none"
			: FAILURE_SIGNALS.has(result.signal)
				? result.signal
				: "unknown";
	return new Error(
		`Native-store test command failed (state=${selected}; code=${code}; signal=${signal}; started=${result.started === true}; timedOut=${result.timedOut === true}; overflow=${result.overflow === true}; processError=${result.processError === true}; terminationFailed=${result.terminationFailed === true}; stateVerified=${stateVerified}; stage=${stage})`,
	);
}

/** Disposable local containers only; construction and imports have no external effects. */
export function createLinuxSuite(context: NativeContext): NativeSuite {
	if (
		context.platform !== "linux" ||
		context.docker === undefined ||
		![context.root, context.node, context.docker].every(
			(value) => path.posix.isAbsolute(value) && !/[\0\r\n,]/.test(value),
		)
	)
		throw new Error("Linux native-store suite requires absolute local paths and Docker");
	const docker = context.docker;
	const environment: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "HOME", "TMPDIR"])
		if (context.environment[key] !== undefined) environment[key] = context.environment[key];
	const steps = transportCommands(
		"/work",
		"/usr/local/cargo/bin/cargo",
		"secret-service",
		{},
		"/node/bin/node",
		"linux",
	);
	if (steps.length !== COMMON_NAMES.length) throw new Error("Linux native-store inventory differs");
	const names = linuxCaseNames();
	let owner: string | undefined;
	let image: string | undefined;
	let built = false;
	let fetched = false;
	let failed = false;
	let closed = false;
	let deadline: number | undefined;
	let containerSequence = 0;
	const volumes: string[] = [];
	const containers = new Set<string>();
	const invoke = (args: readonly string[], timeoutMs = 30_000): Promise<Outcome> => {
		const remaining = deadline === undefined ? 0 : Math.floor(deadline - performance.now());
		if (remaining < 1) throw new Error("Linux native-store command budget exhausted");
		return context.runner({
			executable: docker,
			args: ["--host", ENDPOINT, ...args],
			cwd: context.root,
			env: environment,
			timeoutMs: Math.min(timeoutMs, remaining),
		});
	};
	async function success(args: readonly string[], timeoutMs?: number): Promise<Outcome> {
		const result = await invoke(args, timeoutMs);
		requireSuccess(result);
		return result;
	}
	async function owned(kind: "container" | "volume" | "image", id: string): Promise<void> {
		const expression =
			kind === "image" ? ".Config.Labels" : kind === "volume" ? ".Labels" : ".Config.Labels";
		const result = await success([
			kind,
			"inspect",
			"--format",
			`{{ index ${expression} "${LABEL}" }}`,
			id,
		]);
		if (owner === undefined || result.stdout.trim() !== owner)
			throw new Error("Native-store resource ownership differs");
	}
	async function removeContainer(id: string): Promise<void> {
		await owned("container", id);
		await success(["container", "rm", "--force", id]);
		containers.delete(id);
	}
	async function container(
		args: readonly string[],
		network: "bridge" | "none",
		state?: string,
	): Promise<Outcome> {
		if (!built || owner === undefined || image === undefined || volumes.length !== 3)
			throw new Error("Linux native-store preparation did not complete");
		const containerName = `draftyak-native-store-${owner}-${++containerSequence}`;
		containers.add(containerName);
		const created = await success([
			"create",
			"--name",
			containerName,
			"--label",
			`${LABEL}=${owner}`,
			"--network",
			network,
			"--mount",
			`type=bind,source=${context.root},target=/work,readonly`,
			"--mount",
			`type=bind,source=${context.node},target=/node/bin/node,readonly`,
			"--mount",
			`type=volume,source=${volumes[0]},target=/target`,
			"--mount",
			`type=volume,source=${volumes[1]},target=/usr/local/cargo/registry`,
			"--mount",
			`type=volume,source=${volumes[2]},target=/usr/local/cargo/git`,
			"--workdir",
			"/work",
			"--env",
			"PATH=/node/bin:/usr/local/cargo/bin:/usr/bin:/bin",
			"--env",
			"CARGO_TARGET_DIR=/target",
			"--env",
			"CARGO_TERM_COLOR=never",
			"--env",
			`CARGO_NET_OFFLINE=${network === "none" ? "true" : "false"}`,
			image,
			...(state === undefined ? [] : ["/bin/sh", `/work/${FIXTURE}/linux-checks.sh`, state]),
			...args,
		]);
		const id = created.stdout.trim();
		if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Invalid owned native-store container id");
		try {
			const result = await invoke(["start", "--attach", id], 240_000);
			try {
				requireSuccess(result);
			} catch {
				throw containerFailure(result, state);
			}
			if (state !== undefined) {
				const markers = result.stdout
					.split(/\r?\n/)
					.filter((line) => line.startsWith("DYTEST linux-store verified state="));
				if (markers.length !== 1 || markers[0] !== `DYTEST linux-store verified state=${state}`)
					throw new Error("Required Linux native-store state was not verified");
			}
			return result;
		} finally {
			await removeContainer(containerName);
		}
	}
	const work = (run: () => Promise<void>) => async (): Promise<void> => {
		if (closed || failed) throw new Error("Linux native-store suite is closed or failed");
		if (deadline !== undefined) throw new Error("Linux native-store work is already active");
		deadline = performance.now() + 240_000;
		try {
			await run();
			if (performance.now() >= deadline)
				throw new Error("Linux native-store command budget exhausted");
		} catch (error) {
			failed = true;
			throw error;
		} finally {
			deadline = undefined;
		}
	};
	return {
		cases: [
			{
				name: names[0] as string,
				work: work(async () => {
					if (owner !== undefined) throw new Error("Linux native-store setup already ran");
					owner = randomUUID();
					image = `draftyak-native-store-${owner}:local`;
					await success(
						[
							"build",
							"--label",
							`${LABEL}=${owner}`,
							"--tag",
							image,
							"--file",
							`${FIXTURE}/Dockerfile`,
							FIXTURE,
						],
						240_000,
					);
					await owned("image", image);
					for (const suffix of ["target", "registry", "git"]) {
						const volume = `draftyak-native-store-${owner}-${suffix}`;
						await success(["volume", "create", "--label", `${LABEL}=${owner}`, volume]);
						volumes.push(volume);
						await owned("volume", volume);
					}
					built = true;
				}),
			},
			{
				name: names[1] as string,
				work: work(async () => {
					if (fetched) throw new Error("Linux locked dependencies already ran");
					await container(
						[
							"/usr/local/cargo/bin/cargo",
							"fetch",
							"--locked",
							"--manifest-path",
							"crates/Cargo.toml",
						],
						"bridge",
					);
					fetched = true;
				}),
			},
			...steps.map((step, index) => ({
				name: names[index + 2] as string,
				work: work(async () => {
					if (!fetched) throw new Error("Linux locked dependencies did not complete");
					const result = await container(
						[step.command.executable, ...step.command.args],
						"none",
						index === steps.length - 1 ? "healthy" : undefined,
					);
					if (step.expectedTest !== undefined) requireOneTest(result, step.expectedTest);
				}),
			})),
			...STATES.map((state, index) => ({
				name: names[index + 2 + steps.length] as string,
				work: work(async () => {
					if (!fetched) throw new Error("Linux locked dependencies did not complete");
					const result = await container(
						[
							"/usr/local/cargo/bin/cargo",
							"test",
							"--locked",
							"--offline",
							"--manifest-path",
							"crates/Cargo.toml",
							"-p",
							"draftyak-transport",
							"--no-default-features",
							"--features",
							"native-store",
							"--lib",
							FAILURE,
							"--",
							"--exact",
							"--test-threads=1",
							"--ignored",
						],
						"none",
						state,
					);
					requireOneTest(result, FAILURE);
				}),
			})),
		],
		async close() {
			if (closed) return;
			if (deadline !== undefined) throw new Error("Linux native-store work is still active");
			closed = true;
			const cleanupDeadline = performance.now() + 45_000;
			deadline = cleanupDeadline;
			let cleanupFailed = false;
			const clean = async (operation: () => Promise<void>): Promise<void> => {
				try {
					await operation();
				} catch {
					cleanupFailed = true;
				}
			};
			for (const id of containers) await clean(() => removeContainer(id));
			for (const volume of [...volumes].reverse())
				await clean(async () => {
					await owned("volume", volume);
					await success(["volume", "rm", "--force", volume]);
				});
			const ownedImage = image;
			if (ownedImage !== undefined)
				await clean(async () => {
					await owned("image", ownedImage);
					await success(["image", "rm", ownedImage]);
				});
			if (performance.now() >= cleanupDeadline) cleanupFailed = true;
			deadline = undefined;
			if (cleanupFailed) throw new Error("Owned Linux native-store cleanup did not complete");
		},
	};
}
