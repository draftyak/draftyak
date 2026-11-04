import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	mkdtempSync,
	openSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { appendSummary, runCli, setOutputs } from "./lib.ts";
import {
	type NativeStoreCommand,
	type NativeStoreContext,
	type NativeStoreExecute,
	type NativeStoreFetch,
	type NativeStoreGit,
	type NativeStoreReportIo,
	type NativeStoreSource,
	nativeStoreContext,
	readNativePullMetadata,
	readNativeStoreReport,
} from "./native-store.ts";

export const nativeSupervisorFile = "apps/hub/test/plugins/supervisor-platform.heavy.test.ts";
const nativeSupervisorTargets = [
	["Linux and macOS", "refuses handle sends on both reinstated FIFO descriptors with ENOTSOCK"],
	["macOS", "drains exited stdout and stderr FIFOs to EOF"],
] as const;
export const nativeSupervisorCases: readonly string[] = nativeSupervisorTargets.map((parts) =>
	parts.join(" "),
);
const nativeSupervisorTaskPattern = `^(?:${nativeSupervisorTargets
	.map((parts) => parts.join(" > ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
	.join("|")})$`;
export const nativeSupervisorReceiptFile = "native-supervisor-receipt.json";
const repository = "draftyak/draftyak";
const owner = "nicksavov";
const workflowRef = `${repository}/.github/workflows/native-supervisor.yml@refs/heads/m0`;
const sha = /^(?!0{40}$)[0-9a-f]{40}$/;
const positive = /^[1-9][0-9]{0,8}$/;
const runIdentity = /^[1-9][0-9]{0,15}$/;
const maxReceipt = 4096;
const commandTimeout = 300_000;
const inputs = [
	".node-version",
	"package.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"turbo.json",
	"vitest.shared.ts",
	"apps/hub/package.json",
	"apps/hub/vitest.config.ts",
	"apps/hub/tsdown.config.ts",
	"apps/hub/turbo.json",
	nativeSupervisorFile,
] as const;
const exclusions = [":(exclude)*siwc*", ":(exclude)*dynamic-agent*", ":(exclude)*dynamic_agent*"];
const cleanArgs = ["diff", "--quiet", "HEAD", "--", ".", ...exclusions];
const untrackedArgs = ["ls-files", "--others", "--exclude-standard", "--", ".", ...exclusions];
const record = (value: unknown): Record<string, unknown> =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const digest = (value: unknown): string =>
	createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Failure = "context" | "pull" | "source" | "report" | "command" | "receipt";
export class NativeSupervisorError extends Error {
	readonly code: Failure;
	constructor(code: Failure) {
		super(`Native supervisor ${code} refused`);
		this.code = code;
	}
}
function refuse(code: Failure): never {
	throw new NativeSupervisorError(code);
}

export interface NativeSupervisorContext extends NativeStoreContext {
	/** Externally admitted control restriction; matching it grants no execution authority. */
	readonly controlSha: string;
	readonly runnerArch: string;
	readonly arch: string;
	readonly node: string;
}
export type NativeSupervisorSource = NativeStoreSource;
export function nativeSupervisorContext(
	env: NodeJS.ProcessEnv,
	platform: string = process.platform,
	arch: string = process.arch,
	node: string = process.versions.node,
): NativeSupervisorContext {
	return {
		...nativeStoreContext(env, platform),
		controlSha: env.NATIVE_SUPERVISOR_CONTROL_SHA ?? "",
		runnerArch: env.RUNNER_ARCH ?? "",
		arch,
		node,
		pr: env.NATIVE_SUPERVISOR_PR ?? "",
		head: env.NATIVE_SUPERVISOR_HEAD ?? "",
	};
}
export function checkNativeSupervisorContext(
	context: NativeSupervisorContext,
): NativeSupervisorSource {
	if (
		typeof context.controlSha !== "string" ||
		context.controlSha.length !== 40 ||
		!sha.test(context.controlSha) ||
		context.controlSha !== context.sha ||
		context.controlSha !== context.workflowSha
	)
		refuse("context");
	if (
		context.event !== "workflow_dispatch" ||
		context.repository !== repository ||
		context.actor !== owner ||
		context.triggeringActor !== owner ||
		context.ref !== "refs/heads/m0" ||
		context.workflowRef !== workflowRef ||
		!sha.test(context.sha) ||
		context.workflowSha !== context.sha ||
		context.runnerOs !== "macOS" ||
		context.runnerArch !== "ARM64" ||
		context.platform !== "darwin" ||
		context.arch !== "arm64" ||
		context.node !== "26.12.0" ||
		context.job !== "native-supervisor" ||
		!runIdentity.test(context.runId) ||
		!Number.isSafeInteger(Number(context.runId)) ||
		!positive.test(context.runAttempt) ||
		!path.isAbsolute(context.workspace) ||
		!path.isAbsolute(context.temporary) ||
		!positive.test(context.pr) ||
		!sha.test(context.head)
	)
		refuse("context");
	return { pr: context.pr, head: context.head };
}
export function checkNativeSupervisorPull(
	value: unknown,
	source: NativeSupervisorSource,
): NativeSupervisorSource {
	const pull = record(value);
	const head = record(pull.head);
	const base = record(pull.base);
	const headRepo = record(head.repo);
	const baseRepo = record(base.repo);
	if (
		pull.number !== Number(source.pr) ||
		pull.state !== "open" ||
		pull.draft !== false ||
		record(pull.user).login !== owner ||
		head.sha !== source.head ||
		base.ref !== "m2" ||
		headRepo.full_name !== repository ||
		headRepo.private !== false ||
		headRepo.fork !== false ||
		baseRepo.full_name !== repository ||
		baseRepo.private !== false
	)
		refuse("pull");
	return source;
}
export type NativeSupervisorGit = NativeStoreGit;
export type NativeSupervisorFetch = NativeStoreFetch;
const git: NativeSupervisorGit = (args, cwd) => {
	const result = spawnSync("git", [...args], {
		cwd,
		env: childEnvironment(process.env),
		encoding: "utf8",
		maxBuffer: 64 * 1024,
		timeout: 10_000,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) refuse("source");
	return result.stdout.trim();
};
function checkControl(
	context: NativeSupervisorContext,
	readGit: NativeSupervisorGit,
): NativeSupervisorSource {
	const source = checkNativeSupervisorContext(context);
	if (
		readGit(["rev-parse", "HEAD"], context.workspace) !== context.sha ||
		readGit(cleanArgs, context.workspace) !== ""
	)
		refuse("source");
	return source;
}
export async function admitNativeSupervisor(
	context: NativeSupervisorContext,
	readGit: NativeSupervisorGit = git,
	request: NativeSupervisorFetch = fetch,
): Promise<NativeSupervisorSource> {
	try {
		const source = checkControl(context, readGit);
		const response = await request(
			`https://api.github.com/repos/${repository}/pulls/${source.pr}`,
			{
				method: "GET",
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
				headers: { Accept: "application/vnd.github+json" },
			},
		);
		return checkNativeSupervisorPull(await readNativePullMetadata(response), source);
	} catch (error) {
		if (error instanceof NativeSupervisorError) throw error;
		return refuse("pull");
	}
}
interface SourceSnapshot {
	readonly controlTree: string;
	readonly sourceTree: string;
	readonly inputSha256: string;
	readonly suiteBlob: string;
}
function sourceSnapshot(
	context: NativeSupervisorContext,
	readGit: NativeSupervisorGit,
): SourceSnapshot {
	try {
		checkControl(context, readGit);
		const directory = path.join(context.workspace, "source");
		if (
			readGit(["rev-parse", "HEAD"], directory) !== context.head ||
			readGit(["ls-files", "--error-unmatch", "--", nativeSupervisorFile], directory) !==
				nativeSupervisorFile ||
			readGit(cleanArgs, directory) !== "" ||
			readGit(untrackedArgs, directory) !== "" ||
			readGit(["show", "HEAD:.node-version"], directory).trim() !== "26.12.0" ||
			record(JSON.parse(readGit(["show", "HEAD:package.json"], directory))).packageManager !==
				"pnpm@11.28.6"
		)
			refuse("source");
		const blobs = inputs.map((file) => readGit(["rev-parse", `HEAD:${file}`], directory));
		const sourceTree = readGit(["rev-parse", "HEAD^{tree}"], directory);
		const controlTree = readGit(["rev-parse", "HEAD^{tree}"], context.workspace);
		if (!sha.test(sourceTree) || !sha.test(controlTree) || blobs.some((blob) => !sha.test(blob)))
			refuse("source");
		return {
			controlTree,
			sourceTree,
			inputSha256: digest(blobs),
			suiteBlob: blobs[blobs.length - 1] as string,
		};
	} catch {
		return refuse("source");
	}
}
export function verifyNativeSupervisorSource(
	context: NativeSupervisorContext,
	readGit: NativeSupervisorGit = git,
): NativeSupervisorSource {
	sourceSnapshot(context, readGit);
	return { pr: context.pr, head: context.head };
}
export type NativeSupervisorReportIo = NativeStoreReportIo;
export function readNativeSupervisorReport(file: string, io?: NativeSupervisorReportIo): unknown {
	try {
		return readNativeStoreReport(file, io);
	} catch {
		return refuse("report");
	}
}
export interface NativeSupervisorResult {
	readonly passed: 2;
	readonly failed: 0;
	readonly skipped: 0;
	readonly pending: 0;
	readonly filtered: number;
	readonly total: number;
	readonly durations: readonly number[];
}
export function checkNativeSupervisorReport(
	value: unknown,
	directory: string,
): NativeSupervisorResult {
	const report = record(value);
	const suites = report.testResults;
	const suite = record(Array.isArray(suites) && suites.length === 1 ? suites[0] : null);
	const assertions = suite.assertionResults;
	const expected = path.join(directory, nativeSupervisorFile).replaceAll("\\", "/");
	if (
		!Array.isArray(assertions) ||
		assertions.length !== 24 ||
		report.success !== true ||
		!Number.isSafeInteger(report.numTotalTestSuites) ||
		Number(report.numTotalTestSuites) <= 0 ||
		report.numPassedTestSuites !== report.numTotalTestSuites ||
		report.numFailedTestSuites !== 0 ||
		report.numPendingTestSuites !== 0 ||
		report.numTotalTests !== assertions.length ||
		report.numPassedTests !== 2 ||
		report.numFailedTests !== 0 ||
		report.numPendingTests !== assertions.length - 2 ||
		report.numTodoTests !== 0 ||
		(report.numRuntimeErrorTestSuites !== undefined && report.numRuntimeErrorTestSuites !== 0) ||
		suite.name !== expected ||
		suite.status !== "passed" ||
		suite.message !== ""
	)
		refuse("report");
	const names = new Set<string>();
	const durations = new Map<string, number>();
	for (const item of assertions) {
		const test = record(item);
		if (
			typeof test.fullName !== "string" ||
			!test.fullName ||
			names.has(test.fullName) ||
			!Array.isArray(test.failureMessages) ||
			test.failureMessages.length !== 0
		)
			refuse("report");
		names.add(test.fullName);
		const target = nativeSupervisorTargets.find((parts) => parts.join(" ") === test.fullName);
		if (target) {
			if (
				test.title !== target[1] ||
				test.status !== "passed" ||
				typeof test.duration !== "number" ||
				!Number.isFinite(test.duration) ||
				test.duration <= 0 ||
				test.duration > commandTimeout
			)
				refuse("report");
			durations.set(test.fullName, test.duration);
		} else if (test.status !== "pending" && test.status !== "skipped") refuse("report");
	}
	if (durations.size !== 2) refuse("report");
	return {
		passed: 2,
		failed: 0,
		skipped: 0,
		pending: 0,
		filtered: assertions.length - 2,
		total: assertions.length,
		durations: nativeSupervisorCases.map((name) => durations.get(name) as number),
	};
}
export type NativeSupervisorCommand = NativeStoreCommand;
export type NativeSupervisorExecute = NativeStoreExecute;
const execute: NativeSupervisorExecute = (command) => {
	const result = spawnSync(command.executable, [...command.args], {
		cwd: command.cwd,
		env: command.env,
		stdio: "pipe",
		maxBuffer: 8 * 1024 * 1024,
		timeout: commandTimeout,
		windowsHide: true,
	});
	return result.error ? null : result.status;
};
function childEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const clean: NodeJS.ProcessEnv = {};
	for (const name of [
		"PATH",
		"HOME",
		"TMPDIR",
		"TMP",
		"TEMP",
		"PNPM_HOME",
		"COREPACK_HOME",
		"LANG",
		"LC_ALL",
	])
		if (env[name] !== undefined) clean[name] = env[name];
	return {
		...clean,
		CI: "true",
		DO_NOT_TRACK: "1",
		TURBO_TELEMETRY_DISABLED: "1",
		DRAFTYAK_STRICT_SKIPS: "1",
	};
}
// A detached receipt proves no execution; primary run/job/step/artifact joins remain required.
function writeReceipt(context: NativeSupervisorContext, value: unknown): void {
	const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
	if (bytes.length > maxReceipt) refuse("receipt");
	let descriptor: number | undefined;
	try {
		descriptor = openSync(
			path.join(context.temporary, nativeSupervisorReceiptFile),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		);
		writeFileSync(descriptor, bytes);
		const held = fstatSync(descriptor, { bigint: true });
		const named = lstatSync(path.join(context.temporary, nativeSupervisorReceiptFile), {
			bigint: true,
		});
		if (
			!held.isFile() ||
			named.isSymbolicLink() ||
			!named.isFile() ||
			held.dev !== named.dev ||
			held.ino !== named.ino ||
			held.size !== BigInt(bytes.length) ||
			held.size !== named.size ||
			held.mtimeNs !== named.mtimeNs ||
			held.ctimeNs !== named.ctimeNs ||
			(held.mode & 0o777n) !== 0o600n
		)
			refuse("receipt");
	} catch {
		refuse("receipt");
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				refuse("receipt");
			}
		}
	}
}
export async function runNativeSupervisor(
	context: NativeSupervisorContext,
	env: NodeJS.ProcessEnv,
	readGit: NativeSupervisorGit = git,
	run: NativeSupervisorExecute = execute,
	request: NativeSupervisorFetch = fetch,
	reportIo?: NativeSupervisorReportIo,
): Promise<NativeSupervisorResult> {
	try {
		const before = sourceSnapshot(context, readGit);
		await admitNativeSupervisor(context, readGit, request);
		const directory = path.join(context.workspace, "source");
		const reportDirectory = mkdtempSync(path.join(context.temporary, "native-supervisor-"));
		const reportFile = path.join(reportDirectory, "report.json");
		try {
			lstatSync(path.join(context.temporary, nativeSupervisorReceiptFile));
			refuse("receipt");
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
				refuse("receipt");
		}
		const clean = childEnvironment(env);
		const commands: NativeSupervisorCommand[] = [
			{ executable: "pnpm", args: ["install", "--frozen-lockfile"], cwd: directory, env: clean },
			{
				executable: "pnpm",
				args: ["--filter", "@draftyak/hub...", "build"],
				cwd: directory,
				env: clean,
			},
			{
				executable: process.execPath,
				args: [
					path.join(directory, "node_modules/vitest/vitest.mjs"),
					"run",
					"--mode=heavy",
					"test/plugins/supervisor-platform.heavy.test.ts",
					"-t",
					nativeSupervisorTaskPattern,
					"--reporter=default",
					"--reporter=json",
					`--outputFile=${reportFile}`,
					"--exclude",
					"**/*siwc*/**",
					"--exclude",
					"**/*siwc*",
					"--exclude",
					"**/*dynamic-agent*",
					"--exclude",
					"**/*dynamic_agent*",
				],
				cwd: path.join(directory, "apps/hub"),
				env: clean,
			},
		];
		for (const command of commands) {
			if (run(command) !== 0) refuse("command");
		}
		if (JSON.stringify(sourceSnapshot(context, readGit)) !== JSON.stringify(before))
			refuse("source");
		const data = readNativeSupervisorReport(reportFile, reportIo);
		const result = checkNativeSupervisorReport(data, directory);
		await admitNativeSupervisor(context, readGit, request);
		if (JSON.stringify(sourceSnapshot(context, readGit)) !== JSON.stringify(before))
			refuse("source");
		writeReceipt(context, {
			version: 1,
			repository,
			workflowRef,
			ref: context.ref,
			actor: context.actor,
			triggeringActor: context.triggeringActor,
			controlSha: context.sha,
			sourceHead: context.head,
			pr: context.pr,
			...before,
			runId: context.runId,
			runAttempt: context.runAttempt,
			job: context.job,
			runnerOs: context.runnerOs,
			runnerArch: context.runnerArch,
			platform: context.platform,
			arch: context.arch,
			node: context.node,
			testFile: nativeSupervisorFile,
			cases: nativeSupervisorCases,
			...result,
			commandSha256: digest(
				commands.map((command) => ({
					executable: command.executable === process.execPath ? "node" : command.executable,
					args: command.args.map((arg) =>
						arg
							.replaceAll(reportFile, "<held-report>")
							.replaceAll(directory, "<source>")
							.replaceAll(context.temporary, "<temporary>"),
					),
					cwd: path.relative(directory, command.cwd) || ".",
				})),
			),
			reportDataSha256: digest(data),
			sourceUnchanged: true,
		});
		return result;
	} catch (error) {
		if (error instanceof NativeSupervisorError) throw error;
		return refuse("command");
	}
}
async function main(): Promise<number> {
	if (process.argv.length !== 3) refuse("context");
	const context = nativeSupervisorContext(process.env);
	switch (process.argv[2]) {
		case "admit":
			setOutputs({ ...(await admitNativeSupervisor(context)) });
			return 0;
		case "verify-source":
			verifyNativeSupervisorSource(context);
			return 0;
		case "run": {
			const result = await runNativeSupervisor(context, process.env);
			appendSummary(
				`Native supervisor: ${result.passed} selected passed, zero selected skipped.\n\nPR #${context.pr}: \`${context.head}\``,
			);
			setOutputs({ receipt: "ready" });
			return 0;
		}
		default:
			return refuse("context");
	}
}
if (import.meta.main)
	void runCli("native-supervisor", async () => {
		try {
			return await main();
		} catch (error) {
			if (error instanceof NativeSupervisorError) throw error;
			return refuse("command");
		}
	});
