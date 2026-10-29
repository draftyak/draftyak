import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, rmSync } from "node:fs";
import path from "node:path";
import { appendSummary, runCli, setOutputs } from "./lib.ts";

export const nativeStoreFile = "apps/hub/test/store/temp-files.heavy.test.ts";
export const nativeStoreCase =
	"observes live plaintext FILE controls and no temporary files under production MEMORY";
const repository = "draftyak/draftyak";
const owner = "nicksavov";
const workflowRef = `${repository}/.github/workflows/native-store.yml@refs/heads/m0`;
const sha = /^(?!0{40}$)[0-9a-f]{40}$/;
const positive = /^[1-9][0-9]{0,8}$/;
const maxMetadata = 256 * 1024;
const maxReport = 1024 * 1024;
const sourceTreeArgs = [
	"diff",
	"--quiet",
	"HEAD",
	"--",
	".",
	":(exclude)*siwc*",
	":(exclude)*dynamic-agent*",
	":(exclude)*dynamic_agent*",
] as const;

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as RecordValue)
		: {};

export class NativeStoreError extends Error {}
const refuse = (message: string): never => {
	throw new NativeStoreError(message);
};

export interface NativeStoreContext {
	readonly event: string;
	readonly repository: string;
	readonly actor: string;
	readonly triggeringActor: string;
	readonly ref: string;
	readonly sha: string;
	readonly workflowRef: string;
	readonly workflowSha: string;
	readonly runnerOs: string;
	readonly platform: string;
	readonly workspace: string;
	readonly temporary: string;
	readonly pr: string;
	readonly head: string;
}

export interface NativeStoreSource {
	readonly pr: string;
	readonly head: string;
}

export function nativeStoreContext(
	env: NodeJS.ProcessEnv,
	platform: string = process.platform,
): NativeStoreContext {
	return {
		event: env.GITHUB_EVENT_NAME ?? "",
		repository: env.GITHUB_REPOSITORY ?? "",
		actor: env.GITHUB_ACTOR ?? "",
		triggeringActor: env.GITHUB_TRIGGERING_ACTOR ?? "",
		ref: env.GITHUB_REF ?? "",
		sha: env.GITHUB_SHA ?? "",
		workflowRef: env.GITHUB_WORKFLOW_REF ?? "",
		workflowSha: env.GITHUB_WORKFLOW_SHA ?? "",
		runnerOs: env.RUNNER_OS ?? "",
		platform,
		workspace: env.GITHUB_WORKSPACE ?? "",
		temporary: env.RUNNER_TEMP ?? "",
		pr: env.NATIVE_STORE_PR ?? "",
		head: env.NATIVE_STORE_HEAD ?? "",
	};
}

export function checkNativeStoreContext(context: NativeStoreContext): NativeStoreSource {
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
		context.platform !== "darwin" ||
		!path.isAbsolute(context.workspace) ||
		!path.isAbsolute(context.temporary)
	)
		refuse("Native store requires the owner-only trusted m0 macOS workflow");
	if (!positive.test(context.pr) || !sha.test(context.head))
		refuse("Native store requires a PR number and exact head SHA");
	return { pr: context.pr, head: context.head };
}

export function checkNativeStorePull(value: unknown, source: NativeStoreSource): NativeStoreSource {
	const pull = record(value);
	const head = record(pull.head);
	const base = record(pull.base);
	if (
		pull.number !== Number(source.pr) ||
		pull.state !== "open" ||
		record(pull.user).login !== owner ||
		record(head.repo).full_name !== repository ||
		record(head.repo).private !== false ||
		record(base.repo).full_name !== repository ||
		base.ref !== "m2" ||
		head.sha !== source.head
	)
		refuse("Native store requires the current open owner PR head from this repository into m2");
	return source;
}

export type NativeStoreGit = (args: readonly string[], cwd: string) => string;
const git: NativeStoreGit = (args, cwd) => {
	const result = spawnSync("git", [...args], {
		cwd,
		encoding: "utf8",
		maxBuffer: 64 * 1024,
		windowsHide: true,
	});
	if (result.error || result.status !== 0) refuse("Native store source checkout is unavailable");
	return result.stdout.trim();
};

function checkControl(context: NativeStoreContext, readGit: NativeStoreGit): NativeStoreSource {
	const source = checkNativeStoreContext(context);
	if (readGit(["rev-parse", "HEAD"], context.workspace) !== context.sha)
		refuse("Native store control checkout does not match the workflow SHA");
	return source;
}

export type NativeStoreFetch = (url: string, options: RequestInit) => Promise<Response>;

async function metadata(response: Response): Promise<unknown> {
	const length = response.headers.get("content-length");
	if (
		response.status !== 200 ||
		response.redirected ||
		!response.headers.get("content-type")?.startsWith("application/json") ||
		(length !== null && (!/^\d+$/.test(length) || Number(length) > maxMetadata)) ||
		!response.body
	) {
		await response.body?.cancel();
		return refuse("Native store PR metadata is unavailable");
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxMetadata) refuse("Native store PR metadata is unavailable");
			chunks.push(value);
		}
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
	} finally {
		await reader.cancel();
	}
}

export async function admitNativeStore(
	context: NativeStoreContext,
	readGit: NativeStoreGit = git,
	request: NativeStoreFetch = fetch,
): Promise<NativeStoreSource> {
	const source = checkControl(context, readGit);
	try {
		const response = await request(
			`https://api.github.com/repos/${repository}/pulls/${source.pr}`,
			{
				method: "GET",
				redirect: "error",
				signal: AbortSignal.timeout(10_000),
				headers: { Accept: "application/vnd.github+json" },
			},
		);
		return checkNativeStorePull(await metadata(response), source);
	} catch (error) {
		if (error instanceof NativeStoreError) throw error;
		return refuse("Native store PR metadata is unavailable");
	}
}

export function verifyNativeStoreSource(
	context: NativeStoreContext,
	readGit: NativeStoreGit = git,
): NativeStoreSource {
	const source = checkControl(context, readGit);
	const directory = path.join(context.workspace, "source");
	if (
		readGit(["rev-parse", "HEAD"], directory) !== source.head ||
		readGit(["ls-files", "--error-unmatch", "--", nativeStoreFile], directory) !== nativeStoreFile
	)
		refuse("Native store source checkout does not match the admitted head and target");
	try {
		if (readGit(sourceTreeArgs, directory) !== "")
			refuse("Native store source tree differs from the admitted head");
	} catch {
		refuse("Native store source tree differs from the admitted head");
	}
	return source;
}

export interface NativeStoreReportStat {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}
export interface NativeStoreReportIo {
	lstat(file: string): NativeStoreReportStat;
	open(file: string, flags: number): number;
	fstat(descriptor: number): NativeStoreReportStat;
	read(
		descriptor: number,
		buffer: Buffer,
		offset: number,
		length: number,
		position: number,
	): number;
	close(descriptor: number): void;
}
const reportIo: NativeStoreReportIo = {
	lstat: (file) => lstatSync(file, { bigint: true }),
	open: (file, flags) => openSync(file, flags),
	fstat: (descriptor) => fstatSync(descriptor, { bigint: true }),
	read: (descriptor, buffer, offset, length, position) =>
		readSync(descriptor, buffer, offset, length, position),
	close: (descriptor) => closeSync(descriptor),
};
const regularReport = (stat: NativeStoreReportStat): boolean =>
	stat.isFile() && !stat.isSymbolicLink() && stat.size >= 0n && stat.size <= BigInt(maxReport);
const sameReportStat = (a: NativeStoreReportStat, b: NativeStoreReportStat): boolean =>
	regularReport(a) &&
	regularReport(b) &&
	a.dev === b.dev &&
	a.ino === b.ino &&
	a.size === b.size &&
	a.mtimeNs === b.mtimeNs &&
	a.ctimeNs === b.ctimeNs;

/** Hold the regular file, cap every read, and refuse growth or pathname replacement. */
export function readNativeStoreReport(file: string, io: NativeStoreReportIo = reportIo): unknown {
	let descriptor: number | undefined;
	try {
		const namedBefore = io.lstat(file);
		if (!regularReport(namedBefore)) refuse("Native store execution report is unavailable");
		descriptor = io.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		const before = io.fstat(descriptor);
		if (!sameReportStat(namedBefore, before))
			refuse("Native store execution report is unavailable");
		const capacity = maxReport + 1;
		const buffer = Buffer.alloc(capacity);
		let bytes = 0;
		while (bytes < capacity) {
			const count = io.read(descriptor, buffer, bytes, capacity - bytes, bytes);
			if (!Number.isSafeInteger(count) || count < 0 || count > capacity - bytes)
				refuse("Native store execution report is unavailable");
			if (count === 0) break;
			bytes += count;
		}
		if (bytes > maxReport) refuse("Native store execution report is unavailable");
		const after = io.fstat(descriptor);
		const namedAfter = io.lstat(file);
		if (
			!sameReportStat(before, after) ||
			!sameReportStat(before, namedAfter) ||
			BigInt(bytes) !== before.size
		)
			refuse("Native store execution report is unavailable");
		return JSON.parse(buffer.subarray(0, bytes).toString("utf8")) as unknown;
	} catch (error) {
		if (error instanceof NativeStoreError) throw error;
		return refuse("Native store execution report is unavailable");
	} finally {
		if (descriptor !== undefined) {
			try {
				io.close(descriptor);
			} catch {
				refuse("Native store execution report is unavailable");
			}
		}
	}
}

/** A successful command is insufficient: requires-routed skips and empty heavy runs can be green. */
export function checkNativeStoreReport(value: unknown, directory: string): number {
	const report = record(value);
	const suites = report.testResults;
	const suite = record(Array.isArray(suites) && suites.length === 1 ? suites[0] : null);
	const assertions = suite.assertionResults;
	const count = Array.isArray(assertions) ? assertions.length : 0;
	const expected = path.join(directory, nativeStoreFile).replaceAll("\\", "/");
	if (
		report.success !== true ||
		!Number.isSafeInteger(report.numTotalTestSuites) ||
		Number(report.numTotalTestSuites) < 1 ||
		report.numPassedTestSuites !== report.numTotalTestSuites ||
		report.numFailedTestSuites !== 0 ||
		report.numPendingTestSuites !== 0 ||
		report.numTotalTests !== count ||
		report.numPassedTests !== count ||
		report.numFailedTests !== 0 ||
		report.numPendingTests !== 0 ||
		report.numTodoTests !== 0 ||
		suite.name !== expected ||
		suite.status !== "passed" ||
		suite.message !== "" ||
		count < 1 ||
		!Array.isArray(assertions) ||
		assertions.some((item) => {
			const test = record(item);
			return (
				test.status !== "passed" ||
				!Number.isFinite(test.duration) ||
				Number(test.duration) <= 0 ||
				!Array.isArray(test.failureMessages) ||
				test.failureMessages.length !== 0
			);
		}) ||
		!assertions.some((item) => {
			const test = record(item);
			return test.title === nativeStoreCase && test.fullName === nativeStoreCase;
		})
	)
		refuse("Native store requires the actual target case to pass with no skipped or empty results");
	return count;
}

export interface NativeStoreCommand {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
}
export type NativeStoreExecute = (command: NativeStoreCommand) => number | null;
const execute: NativeStoreExecute = (command) => {
	const result = spawnSync(command.executable, [...command.args], {
		cwd: command.cwd,
		env: command.env,
		stdio: "inherit",
		timeout: 180_000,
		windowsHide: true,
	});
	return result.error ? null : result.status;
};

export function runNativeStore(
	context: NativeStoreContext,
	env: NodeJS.ProcessEnv,
	readGit: NativeStoreGit = git,
	run: NativeStoreExecute = execute,
): number {
	verifyNativeStoreSource(context, readGit);
	const directory = path.join(context.workspace, "source");
	const report = path.join(context.temporary, "native-store.json");
	rmSync(report, { force: true });
	const status = run({
		executable: process.execPath,
		args: [
			path.join(directory, "node_modules/vitest/vitest.mjs"),
			"run",
			"--mode=heavy",
			"--reporter=default",
			"--reporter=json",
			`--outputFile=${report}`,
			"test/store/temp-files.heavy.test.ts",
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
		env: {
			...env,
			GH_TOKEN: undefined,
			GITHUB_TOKEN: undefined,
			DO_NOT_TRACK: "1",
			TURBO_TELEMETRY_DISABLED: "1",
			DRAFTYAK_STRICT_SKIPS: "1",
		},
	});
	if (status !== 0) refuse("Native store test command failed");
	verifyNativeStoreSource(context, readGit);
	return checkNativeStoreReport(readNativeStoreReport(report), directory);
}

async function main(): Promise<number> {
	if (process.argv.length !== 3) refuse("Invalid native store command");
	const context = nativeStoreContext(process.env);
	switch (process.argv[2]) {
		case "admit":
			setOutputs({ ...(await admitNativeStore(context)) });
			return 0;
		case "verify-source":
			verifyNativeStoreSource(context);
			return 0;
		case "run": {
			const count = runNativeStore(context, process.env);
			appendSummary(
				`Native macOS store: ${count} passed, zero skipped.\n\nPR #${context.pr}: \`${context.head}\`\n\nControl: \`${context.sha}\``,
			);
			return 0;
		}
		default:
			return refuse("Invalid native store command");
	}
}

if (import.meta.main) {
	void runCli("native-store", async () => {
		try {
			return await main();
		} catch (error) {
			if (error instanceof NativeStoreError) throw error;
			return refuse("Native store verification failed");
		}
	});
}
