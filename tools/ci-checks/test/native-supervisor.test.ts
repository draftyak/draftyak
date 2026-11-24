import type { SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const blocked = vi.hoisted(() => {
	const deny = (..._args: unknown[]): never => {
		throw new Error("Unexpected process execution");
	};
	const spawn = vi.fn<(...args: unknown[]) => unknown>(deny),
		other = vi.fn(deny);
	const request = vi.fn(() => Promise.reject(new Error("Unexpected network request")));
	vi.stubGlobal("fetch", request);
	return {
		spawn,
		other,
		deny,
		request,
		receiptModes: new Map<number, number>(),
		receiptOpen: vi.fn(),
	};
});
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	spawnSync: blocked.spawn,
	spawn: blocked.other,
	exec: blocked.other,
	execFile: blocked.other,
	execSync: blocked.other,
	execFileSync: blocked.other,
	fork: blocked.other,
}));
vi.mock("node:fs", async (original) => {
	const fs = await original<typeof import("node:fs")>();
	return {
		...fs,
		openSync(...args: Parameters<typeof fs.openSync>) {
			const [file, flags, mode] = args;
			const descriptor = fs.openSync(...args);
			if (typeof file === "string" && file.endsWith("native-supervisor-receipt.json")) {
				blocked.receiptOpen(file, flags, mode);
				blocked.receiptModes.set(
					descriptor,
					typeof mode === "number" ? mode : Number.parseInt(mode ?? "666", 8),
				);
			}
			return descriptor;
		},
		fstatSync(descriptor: number, options?: Parameters<typeof fs.fstatSync>[1]) {
			const stat = fs.fstatSync(descriptor, options);
			const mode = blocked.receiptModes.get(descriptor);
			// Model POSIX permissions from the actual requested creation mode, including wrong modes.
			if (mode !== undefined && typeof stat.mode === "bigint")
				stat.mode = (stat.mode & ~0o777n) | BigInt(mode);
			return stat;
		},
		closeSync(descriptor: number) {
			blocked.receiptModes.delete(descriptor);
			return fs.closeSync(descriptor);
		},
	};
});

import {
	admitNativeSupervisor,
	checkNativeSupervisorContext,
	checkNativeSupervisorPull,
	checkNativeSupervisorReport,
	type NativeSupervisorCommand,
	type NativeSupervisorFetch,
	type NativeSupervisorGit,
	type NativeSupervisorReportIo,
	nativeSupervisorCases,
	nativeSupervisorContext,
	nativeSupervisorFile,
	nativeSupervisorReceiptFile,
	readNativeSupervisorReport,
	runNativeSupervisor,
	verifyNativeSupervisorSource,
} from "../src/native-supervisor.ts";

const CONTROL = "a".repeat(40),
	HEAD = "b".repeat(40),
	TREE = "c".repeat(40);
const SOURCE = { pr: "443", head: HEAD };
const RESULT = {
	passed: 2,
	failed: 0,
	skipped: 0,
	pending: 0,
	total: 24,
	filtered: 22,
	durations: [17, 23],
};
const FILE = "apps/hub/test/plugins/supervisor-platform.heavy.test.ts";
const RECEIPT = "native-supervisor-receipt.json";
const SELECTED = [
	"Linux and macOS refuses handle sends on both reinstated FIFO descriptors with ENOTSOCK",
	"macOS drains exited stdout and stderr FIFOs to EOF",
] as const;
// Only the two selected names confer credit; generated filtered names remain unique and uncredited.
const INPUTS = [
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
	FILE,
];
const GIT_EXCLUSIONS = [
	":(exclude)*siwc*",
	":(exclude)*dynamic-agent*",
	":(exclude)*dynamic_agent*",
];
const FORBIDDEN = [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"ACTIONS_RUNTIME_TOKEN",
	"ACTIONS_ID_TOKEN_REQUEST_TOKEN",
	"ACTIONS_ID_TOKEN_REQUEST_URL",
	"GITHUB_ENV",
	"GITHUB_OUTPUT",
	"GITHUB_PATH",
	"GITHUB_STEP_SUMMARY",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"GIT_SSH_COMMAND",
	"NODE_OPTIONS",
	"NODE_PATH",
	"NODE_EXTRA_CA_CERTS",
	"NPM_TOKEN",
	"NPM_CONFIG_USERCONFIG",
	"AWS_ACCESS_KEY_ID",
	"CUSTOM_TOKEN",
	"HTTPS_PROXY",
];
function replace(value: object, field: string, replacement: unknown): void {
	const keys = field.split(".");
	let parent = value as Record<string, unknown>;
	for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
	const key = keys.at(-1);
	if (!key) throw new Error("Fixture field missing");
	parent[key] = replacement;
}
function syntheticFailure(): never {
	throw new Error("Synthetic failure");
}
function response(body: string | null, status = 200, headers: Record<string, string> = {}) {
	return new Response(body, {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}
const metadataFaults: Record<string, (body: string) => Response> = {
	status: (body) => response(body, 503),
	redirect: (body) => Object.defineProperty(response(body), "redirected", { value: true }),
	type: (body) => response(body, 200, { "content-type": "text/plain" }),
	length: (body) => response(body, 200, { "content-length": "262145" }),
	oversize: () => response(" ".repeat(256 * 1024 + 1)),
	json: () => response("{"),
	empty: () => response(null),
	timeout: syntheticFailure,
};
function report(directory: string) {
	return {
		success: true,
		numTotalTestSuites: 7,
		numPassedTestSuites: 7,
		numFailedTestSuites: 0,
		numPendingTestSuites: 0,
		numRuntimeErrorTestSuites: 0,
		numTotalTests: RESULT.total,
		numPassedTests: RESULT.passed,
		numFailedTests: 0,
		numPendingTests: RESULT.filtered,
		numTodoTests: 0,
		testResults: [
			{
				name: path.join(directory, FILE).replaceAll("\\", "/"),
				status: "passed",
				message: "",
				assertionResults: Array.from({ length: RESULT.total }, (_, index) => {
					const selected = index === 3 || index === 8;
					const fullName =
						index === 3 ? SELECTED[0] : index === 8 ? SELECTED[1] : `filtered fixture ${index}`;
					return {
						fullName,
						title: selected
							? fullName.replace(/^(?:Linux and macOS|macOS) /, "")
							: `filtered ${index}`,
						ancestorTitles: selected ? [index === 3 ? "Linux and macOS" : "macOS"] : [],
						status: selected ? "passed" : "skipped",
						duration: selected ? (index === 8 ? 23 : 17) : 0,
						failureMessages: [] as string[],
					};
				}),
			},
		],
	};
}
type Stat = ReturnType<NativeSupervisorReportIo["lstat"]>;
function memoryReport(bytes: Buffer) {
	let expectedFile: string | undefined;
	const checked = <T>(file: string, value: T): T => {
		if (expectedFile !== undefined && file !== expectedFile)
			throw new Error("Unexpected report path");
		return value;
	};
	const stat: Stat = {
		dev: 1n,
		ino: 9n,
		size: BigInt(bytes.length),
		mtimeNs: 1n,
		ctimeNs: 1n,
		isFile: () => true,
		isSymbolicLink: () => false,
	};
	const io = {
		lstat: vi.fn((file: string) => checked(file, stat)),
		open: vi.fn((file: string, _flags: number) => checked(file, 7)),
		fstat: vi.fn(() => stat),
		read: vi.fn((_fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
			const count = Math.min(length, bytes.length - position);
			if (count > 0) bytes.copy(buffer, offset, position, position + count);
			return Math.max(0, count);
		}),
		close: vi.fn((_fd: number) => undefined),
	};
	return {
		io,
		stat,
		bind: (file: string) => {
			expectedFile = file;
		},
	};
}
const roots: string[] = [];
let defaultSpawnAllowed = false;
beforeEach(() => {
	defaultSpawnAllowed = false;
	blocked.spawn.mockReset().mockImplementation(blocked.deny);
	blocked.other.mockClear();
	blocked.request.mockClear();
	blocked.receiptOpen.mockClear();
	blocked.receiptModes.clear();
});
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
	if (!defaultSpawnAllowed) expect(blocked.spawn).not.toHaveBeenCalled();
	expect(blocked.other).not.toHaveBeenCalled();
	expect(blocked.request).not.toHaveBeenCalled();
});
class Fixture {
	readonly root = mkdtempSync(path.join(tmpdir(), "draftyak-supervisor-control-"));
	readonly workspace = path.join(this.root, "control");
	readonly temporary = path.join(this.root, "temporary");
	readonly directory = path.join(this.workspace, "source");
	readonly env: NodeJS.ProcessEnv = {
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_REPOSITORY: "draftyak/draftyak",
		GITHUB_ACTOR: "nicksavov",
		GITHUB_TRIGGERING_ACTOR: "nicksavov",
		GITHUB_REF: "refs/heads/m0",
		GITHUB_SHA: CONTROL,
		GITHUB_WORKFLOW_SHA: CONTROL,
		GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/native-supervisor.yml@refs/heads/m0",
		GITHUB_WORKSPACE: this.workspace,
		RUNNER_TEMP: this.temporary,
		RUNNER_OS: "macOS",
		RUNNER_ARCH: "ARM64",
		NATIVE_SUPERVISOR_PR: "443",
		NATIVE_SUPERVISOR_HEAD: HEAD,
		NATIVE_STORE_PR: "999",
		NATIVE_STORE_HEAD: CONTROL,
		GITHUB_RUN_ID: "123456",
		GITHUB_RUN_ATTEMPT: "2",
		GITHUB_JOB: "native-supervisor",
		PATH: path.join(this.root, "bin"),
	};
	readonly context = nativeSupervisorContext(this.env, "darwin", "arm64", "26.12.0");
	readonly pull = {
		number: 443,
		state: "open",
		draft: false,
		user: { login: "nicksavov" },
		head: { sha: HEAD, repo: { full_name: "draftyak/draftyak", private: false, fork: false } },
		base: { ref: "m2", repo: { full_name: "draftyak/draftyak", private: false, fork: false } },
	};
	readonly state = {
		control: CONTROL,
		head: HEAD,
		controlTree: "d".repeat(40),
		sourceTree: TREE,
		target: FILE,
		dirty: "",
		untracked: "",
		node: "26.12.0",
		manager: "pnpm@11.28.6",
		blob: new Map(INPUTS.map((p) => [p, createHash("sha1").update(p).digest("hex")])),
	};
	readonly git: NativeSupervisorGit = vi.fn((args: readonly string[], cwd: string) => {
		const { workspace, directory, state } = this;
		const command = args.join("\n");
		if (![workspace, directory].includes(cwd)) throw new Error("Unknown Git directory");
		if (command === "rev-parse\nHEAD") return cwd === workspace ? state.control : state.head;
		if (command === "rev-parse\nHEAD^{tree}")
			return cwd === workspace ? state.controlTree : state.sourceTree;
		if (args[0] === "diff" && args[1] === "--quiet") {
			expect(args).toEqual(["diff", "--quiet", "HEAD", "--", ".", ...GIT_EXCLUSIONS]);
			if (state.dirty) throw new Error("Synthetic changed tracked source");
			return "";
		}
		if (command === `ls-files\n--error-unmatch\n--\n${FILE}`) return state.target;
		if (args[0] === "ls-files" && args[1] === "--others") return state.untracked;
		if (command === "show\nHEAD:.node-version") return state.node;
		if (command === "show\nHEAD:package.json")
			return JSON.stringify({ packageManager: state.manager });
		if (args.length === 2 && args[0] === "rev-parse" && args[1]?.startsWith("HEAD:")) {
			const value = state.blob.get(args[1].slice(5));
			if (value) return value;
		}
		throw new Error("Unknown Git request");
	});
	readonly request: NativeSupervisorFetch = vi.fn(async () => response(JSON.stringify(this.pull)));
	readonly data = report(this.directory);
	readonly held = memoryReport(Buffer.from(JSON.stringify(this.data)));
	readonly commands: NativeSupervisorCommand[] = [];
	readonly receipt = path.join(this.temporary, RECEIPT);
	private action?: () => void;
	constructor() {
		roots.push(this.root);
		mkdirSync(this.directory, { recursive: true });
		mkdirSync(this.temporary);
		for (const key of FORBIDDEN) this.env[key] = "DYTEST-never-forward";
	}
	bindReport(args: readonly string[]) {
		const output = args.find((arg) => arg.startsWith("--outputFile="));
		if (output) this.held.bind(output.slice("--outputFile=".length));
	}
	readonly execute = vi.fn((command: NativeSupervisorCommand) => {
		this.commands.push(command);
		this.bindReport(command.args);
		if (this.commands.length === 3) this.action?.();
		return 0 as number | null;
	});
	afterTest(handler: () => void) {
		this.action = handler;
	}
	run() {
		const { context, env, git, execute, request, held } = this;
		return runNativeSupervisor(context, env, git, execute, request, held.io);
	}
	async expectRefusal() {
		await expect(this.run()).rejects.toThrow();
		expect(existsSync(this.receipt)).toBe(false);
	}
}
const fixture = () => new Fixture();
async function checkInstalledSelector(
	command: NativeSupervisorCommand,
	data: ReturnType<typeof report>,
) {
	const root = mkdtempSync(path.join(process.cwd(), "selector-fixture-"));
	roots.push(root);
	const file = path.join(root, FILE),
		cwd = path.dirname(path.dirname(path.dirname(file)));
	mkdirSync(path.dirname(file), { recursive: true });
	const groups = new Map<string, string[]>();
	for (const [index, item] of (data.testResults[0]?.assertionResults ?? []).entries()) {
		const suffix =
			index < 2 ? data.testResults[0]?.assertionResults[index === 0 ? 3 : 8] : undefined;
		const group =
			suffix?.ancestorTitles[0] ?? item.ancestorTitles[0] ?? `filtered group ${index % 4}`;
		const title = suffix ? `${suffix.title} suffix` : item.title;
		const body =
			item.status === "passed"
				? "await new Promise(resolve => setTimeout(resolve, 15)); expect(1).toBe(1);"
				: "throw new Error('Unselected fixture body executed');";
		const cases = groups.get(group) ?? [];
		cases.push(`it(${JSON.stringify(title)}, async () => { ${body} });`);
		groups.set(group, cases);
	}
	writeFileSync(
		file,
		'import {describe,it,expect} from "vitest";\n' +
			[...groups]
				.map(
					([name, cases]) => `describe(${JSON.stringify(name)}, () => {\n${cases.join("\n")}\n});`,
				)
				.join("\n"),
	);
	const { spawnSync } =
		await vi.importActual<typeof import("node:child_process")>("node:child_process");
	for (const positive of [false, true]) {
		const output = path.join(root, `${positive}.json`);
		const args = [...command.args];
		args[0] = path.resolve("../../node_modules/vitest/vitest.mjs");
		args[args.findIndex((arg) => arg.startsWith("--outputFile="))] = `--outputFile=${output}`;
		if (!positive) args[args.indexOf("-t") + 1] = `^(?:${SELECTED.join("|")})$`;
		args.push("--config", path.resolve("vitest.config.ts"));
		const child = spawnSync(process.execPath, args, {
			cwd,
			env: { ...command.env, PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
			windowsHide: true,
			timeout: 60_000,
			maxBuffer: 1024 * 1024,
		});
		writeFileSync(path.join(root, `${positive}.stdout.private`), child.stdout ?? "");
		writeFileSync(path.join(root, `${positive}.stderr.private`), child.stderr ?? "");
		expect(child.status).toBe(0);
		const actual = JSON.parse(readFileSync(output, "utf8"));
		expect(actual.numTotalTestSuites).toBe(7);
		if (positive) {
			expect(actual.numPassedTests).toBe(2);
			const result = checkNativeSupervisorReport(actual, root);
			expect(result).toMatchObject({ ...RESULT, durations: expect.any(Array) });
			expect(result.durations.every((value) => value > 0)).toBe(true);
		} else {
			expect(actual.numTotalTests).toBe(24);
			expect(actual.numPassedTests).toBe(0);
			expect(actual.numPendingTests).toBe(24);
			expect(() => checkNativeSupervisorReport(actual, root)).toThrow();
		}
	}
}
function invalidReport(field: string, value: unknown) {
	const f = fixture();
	replace(f.data, field, value);
	expect(() => checkNativeSupervisorReport(f.data, f.directory)).toThrow();
}

describe("native supervisor admission", () => {
	it("maps only the fixed owner workflow inputs and the actual runtime facts", () => {
		const f = fixture();
		expect(nativeSupervisorFile).toBe(FILE);
		expect(nativeSupervisorCases).toEqual(SELECTED);
		expect(nativeSupervisorReceiptFile).toBe(RECEIPT);
		expect(checkNativeSupervisorContext(f.context)).toEqual(SOURCE);
		expect(f.context).toMatchObject({
			platform: "darwin",
			arch: "arm64",
			node: "26.12.0",
			runnerOs: "macOS",
			runnerArch: "ARM64",
			runId: "123456",
			runAttempt: "2",
		});
	});
	it.each([
		["event", "pull_request"],
		["repository", "other/repository"],
		["actor", "other"],
		["triggeringActor", "other"],
		["ref", "refs/heads/main"],
		["sha", "0".repeat(40)],
		["workflowSha", HEAD],
		["workflowRef", "draftyak/draftyak/.github/workflows/native-supervisor.yml@refs/heads/main"],
		["runnerOs", "Linux"],
		["runnerArch", "X64"],
		["platform", "linux"],
		["platform", "win32"],
		["arch", "x64"],
		["node", "26.11.0"],
		["node", "v26.12.0"],
		["job", "native-store"],
		["runId", ""],
		["runId", "9007199254740992"],
		["runAttempt", "0"],
		["runAttempt", "01"],
		["workspace", "relative"],
		["temporary", ""],
		["pr", "0"],
		["pr", "443x"],
		["head", "B".repeat(40)],
		["head", "0".repeat(40)],
		["head", HEAD.slice(1)],
	] as const)("refuses context %s=%s before any port is used", (field, value) => {
		const f = fixture(),
			context = { ...f.context };
		replace(context, field, value);
		expect(() => checkNativeSupervisorContext(context)).toThrow();
	});
	it.each([
		["number", 444],
		["state", "closed"],
		["draft", true],
		["user.login", "other"],
		["head.sha", CONTROL],
		["head.repo.full_name", "other/repository"],
		["head.repo.private", true],
		["head.repo.fork", true],
		["base.ref", "main"],
		["base.repo.full_name", "other/repository"],
		["base.repo.private", true],
	] as const)("refuses current pull field %s", (field, value) => {
		const f = fixture();
		replace(f.pull, field, value);
		expect(() => checkNativeSupervisorPull(f.pull, SOURCE)).toThrow();
	});
	it("bounds and fixes the metadata request and admits only its matching response", async () => {
		const f = fixture();
		expect(await admitNativeSupervisor(f.context, f.git, f.request)).toEqual(SOURCE);
		expect(f.request).toHaveBeenCalledWith(
			"https://api.github.com/repos/draftyak/draftyak/pulls/443",
			expect.objectContaining({
				method: "GET",
				redirect: "error",
				signal: expect.any(AbortSignal),
			}),
		);
	});
	it.each(Object.entries(metadataFaults))(
		"refuses metadata %s without executing source",
		async (_fault, reply) => {
			const f = fixture();
			const request: NativeSupervisorFetch = async () => reply(JSON.stringify(f.pull));
			await expect(admitNativeSupervisor(f.context, f.git, request)).rejects.toThrow();
			expect(f.commands).toHaveLength(0);
		},
	);
});

describe("native supervisor result qualification", () => {
	it.each(["skipped", "pending"])(
		"credits two selected results and only filtered %s entries",
		(status) => {
			const f = fixture();
			for (const item of f.data.testResults[0]?.assertionResults ?? [])
				if (item.status !== "passed") item.status = status;
			expect(checkNativeSupervisorReport(f.data, f.directory)).toEqual(RESULT);
		},
	);
	it.each([
		["success", false],
		["numTotalTestSuites", 2],
		["numPassedTestSuites", 0],
		["numFailedTestSuites", 1],
		["numPendingTestSuites", 1],
		["numRuntimeErrorTestSuites", 1],
		["numTotalTests", 23],
		["numPassedTests", 3],
		["numFailedTests", 1],
		["numPendingTests", 21],
		["numTodoTests", 1],
		["testResults.0.status", "failed"],
		["testResults.0.name", "/synthetic/another.test.ts"],
		["testResults.0.message", "synthetic failure"],
	] as const)("refuses incoherent report field %s", invalidReport);
	it.each(["pending", "skipped", "failed", "todo"])(
		"never credits a selected %s result",
		(status) => invalidReport("testResults.0.assertionResults.3.status", status),
	);
	it.each([0, -1, 300_001, Number.NaN, Number.POSITIVE_INFINITY, "1", null])(
		"refuses selected duration %s",
		(duration) => invalidReport("testResults.0.assertionResults.8.duration", duration),
	);
	it.each(["passed", "failed", "todo", "unknown"])("refuses an unselected %s result", (status) => {
		const f = fixture();
		replace(f.data, "testResults.0.assertionResults.0.status", status);
		if (status === "passed") {
			f.data.numPassedTests = 3;
			f.data.numPendingTests = 21;
		}
		expect(() => checkNativeSupervisorReport(f.data, f.directory)).toThrow();
	});
	it.each(["missing", "duplicate", "title", "failure", "empty", "extra-file"])(
		"refuses %s result identity or failure data",
		(fault) => {
			const f = fixture(),
				suite = f.data.testResults[0];
			if (!suite) throw new Error("Fixture suite missing");
			if (fault === "missing") suite.assertionResults.splice(3, 1);
			if (fault === "duplicate")
				replace(f.data, "testResults.0.assertionResults.8", { ...suite.assertionResults[3] });
			if (fault === "title")
				replace(f.data, "testResults.0.assertionResults.3.title", "different case");
			if (fault === "failure")
				replace(f.data, "testResults.0.assertionResults.3.failureMessages", ["synthetic"]);
			if (fault === "empty") {
				suite.assertionResults = [];
				f.data.numTotalTests = 0;
				f.data.numPassedTests = 0;
				f.data.numPendingTests = 0;
			}
			if (fault === "extra-file")
				f.data.testResults.push({ ...suite, name: "/synthetic/extra.test.ts" });
			expect(() => checkNativeSupervisorReport(f.data, f.directory)).toThrow();
		},
	);
});

describe("native supervisor held report", () => {
	it("holds a regular report and closes its descriptor", () => {
		const f = fixture();
		expect(readNativeSupervisorReport("/synthetic/report.json", f.held.io)).toEqual(f.data);
		expect(f.held.io.close).toHaveBeenCalledWith(7);
	});
	it.each([
		"link",
		"directory",
		"oversize",
		"negative",
		"open",
		"held-identity",
		"replacement",
		"growth",
		"mtime",
		"short",
		"read-count",
		"read-error",
		"byte-overflow",
		"close",
		"json",
	])("refuses report %s without accepting detached bytes", (fault) => {
		const f = fixture(),
			{ io, stat } = f.held;
		if (fault === "link") io.lstat.mockReturnValue({ ...stat, isSymbolicLink: () => true });
		if (fault === "directory") io.lstat.mockReturnValue({ ...stat, isFile: () => false });
		if (fault === "oversize") io.lstat.mockReturnValue({ ...stat, size: 1_048_577n });
		if (fault === "negative") io.lstat.mockReturnValue({ ...stat, size: -1n });
		if (fault === "open") io.open.mockImplementation(syntheticFailure);
		if (fault === "held-identity") io.fstat.mockReturnValue({ ...stat, ino: 10n });
		if (fault === "replacement")
			io.lstat.mockReturnValueOnce(stat).mockReturnValue({ ...stat, ino: 10n });
		if (fault === "growth")
			io.fstat.mockReturnValueOnce(stat).mockReturnValue({ ...stat, size: stat.size + 1n });
		if (fault === "mtime")
			io.fstat.mockReturnValueOnce(stat).mockReturnValue({ ...stat, mtimeNs: 2n });
		if (fault === "short") io.read.mockReturnValue(0);
		if (fault === "read-count") io.read.mockReturnValue(-1);
		if (fault === "read-error") io.read.mockImplementation(syntheticFailure);
		if (fault === "close") io.close.mockImplementation(syntheticFailure);
		const reader =
			fault === "json"
				? memoryReport(Buffer.from("{"))
				: fault === "byte-overflow"
					? memoryReport(Buffer.alloc(1_048_577))
					: f.held;
		if (fault === "byte-overflow") {
			const declared = { ...reader.stat, size: 1_048_576n };
			reader.io.lstat.mockReturnValue(declared);
			reader.io.fstat.mockReturnValue(declared);
		}
		expect(() => readNativeSupervisorReport("/synthetic/report.json", reader.io)).toThrow();
		if (!["link", "directory", "oversize", "negative", "open"].includes(fault))
			expect(reader.io.close).toHaveBeenCalledWith(7);
	});
});

describe("native supervisor controlled execution", () => {
	it("installs, builds and selects exactly the two real cases before issuing a bounded receipt", async () => {
		const f = fixture(),
			result = await f.run();
		expect(result).toEqual(RESULT);
		expect(f.commands).toHaveLength(3);
		expect(f.commands[0]?.args).toContain("--frozen-lockfile");
		expect(f.commands[1]?.args).toEqual(["--filter", "@draftyak/hub...", "build"]);
		const native = f.commands[2];
		if (!native) throw new Error("Fixture test command missing");
		expect(native.cwd).toBe(path.join(f.directory, "apps/hub"));
		expect(native.args[0]).toBe(path.join(f.directory, "node_modules/vitest/vitest.mjs"));
		expect(native.args).toEqual(expect.arrayContaining(["--reporter=default", "--reporter=json"]));
		expect(native.args).toContain("--mode=heavy");
		expect(native.args).toContain("test/plugins/supervisor-platform.heavy.test.ts");
		const reportArgument = native.args.find((arg) => arg.startsWith("--outputFile="));
		if (!reportArgument) throw new Error("Fixture report path missing");
		const reportFile = reportArgument.slice("--outputFile=".length);
		expect(path.basename(reportFile)).toBe("report.json");
		expect(path.dirname(path.dirname(reportFile))).toBe(f.temporary);
		expect(path.basename(path.dirname(reportFile))).toMatch(/^native-supervisor-/);
		expect(f.held.io.open).toHaveBeenCalledWith(reportFile, expect.any(Number));
		const selector =
			native.args[native.args.findIndex((arg) => ["-t", "--testNamePattern"].includes(arg)) + 1];
		if (!selector) throw new Error("Fixture selector missing");
		await checkInstalledSelector(native, f.data);
		for (const pattern of ["**/*siwc*/**", "**/*siwc*", "**/*dynamic-agent*", "**/*dynamic_agent*"])
			expect(native.args).toContain(pattern);
		for (const command of f.commands) {
			for (const key of FORBIDDEN) expect(command.env[key], key).toBeUndefined();
			expect(command.env.DRAFTYAK_STRICT_SKIPS).toBe("1");
		}
		expect(f.request).toHaveBeenCalledTimes(2);
		const bytes = readFileSync(f.receipt),
			receipt = JSON.parse(bytes.toString("utf8"));
		expect(bytes.length).toBeLessThanOrEqual(4096);
		expect(blocked.receiptOpen).toHaveBeenCalledWith(f.receipt, expect.any(Number), 0o600);
		expect(receipt).toMatchObject({
			...RESULT,
			pr: SOURCE.pr,
			sourceHead: HEAD,
			controlSha: CONTROL,
			runId: "123456",
			runAttempt: "2",
			job: "native-supervisor",
		});
		expect(receipt.reportDataSha256).toBe(
			createHash("sha256").update(JSON.stringify(f.data)).digest("hex"),
		);
		expect(receipt.suiteBlob).toBe(f.state.blob.get(FILE));
		expect(receipt.reportSha256).toBeUndefined();
		const second = fixture();
		await second.run();
		expect(JSON.parse(readFileSync(second.receipt, "utf8")).commandSha256).toBe(
			receipt.commandSha256,
		);
		expect(bytes.toString()).not.toContain(f.workspace);
		expect(bytes.toString()).not.toContain("DYTEST-never-forward");
	});
	it("the default spawn adapter forwards the sanitized environment and bounded command options", async () => {
		const f = fixture();
		defaultSpawnAllowed = true;
		blocked.spawn.mockImplementation((_executable, args) => {
			f.bindReport(args as readonly string[]);
			return { status: 0, error: undefined, stdout: "", stderr: "" };
		});
		await runNativeSupervisor(f.context, f.env, f.git, undefined, f.request, f.held.io);
		expect(blocked.spawn).toHaveBeenCalledTimes(3);
		for (const call of blocked.spawn.mock.calls) {
			const options = call[2] as SpawnSyncOptions & Pick<NativeSupervisorCommand, "env">;
			expect(options.env).not.toBe(f.env);
			expect(options.env).toBeDefined();
			for (const key of FORBIDDEN) expect(options.env[key], key).toBeUndefined();
			expect(options.env.DRAFTYAK_STRICT_SKIPS).toBe("1");
			expect(options.stdio).toBe("pipe");
			expect(options.timeout).toBeGreaterThan(0);
			expect(options.timeout).toBeLessThanOrEqual(300_000);
			expect(options.maxBuffer).toBeLessThanOrEqual(8 * 1024 * 1024);
		}
	});
	it.each([0, 1, 2])("refuses nonzero and timeout from command index %s", async (index) => {
		for (const status of [1, null]) {
			const f = fixture();
			f.execute.mockImplementation((command) => {
				f.commands.push(command);
				return f.commands.length - 1 === index ? status : 0;
			});
			await f.expectRefusal();
			expect(f.commands).toHaveLength(index + 1);
		}
	});
	it("the default Git adapter also strips parent tokens and bounds metadata commands", () => {
		const f = fixture();
		defaultSpawnAllowed = true;
		for (const key of FORBIDDEN) vi.stubEnv(key, "DYTEST-never-forward");
		blocked.spawn.mockImplementation((executable, args, options) => {
			expect(executable).toBe("git");
			const command = options as { cwd: string };
			return { status: 0, stdout: f.git(args as readonly string[], command.cwd), stderr: "" };
		});
		expect(verifyNativeSupervisorSource(f.context)).toEqual(SOURCE);
		expect(blocked.spawn).toHaveBeenCalled();
		for (const call of blocked.spawn.mock.calls) {
			const options = call[2] as SpawnSyncOptions & Pick<NativeSupervisorCommand, "env">;
			expect(options.timeout).toBe(10_000);
			for (const key of FORBIDDEN) expect(options.env[key], key).toBeUndefined();
		}
	});
	it.each(["control", "head", "dirty", "untracked", "node", "manager", "target"] as const)(
		"refuses pre-execution source/control %s mismatch",
		async (field) => {
			const f = fixture();
			f.state[field] = "synthetic mismatch";
			await f.expectRefusal();
			expect(f.commands).toHaveLength(0);
		},
	);
	it.each(["control", "head", "dirty", "untracked", "controlTree", "sourceTree"] as const)(
		"rechecks %s after source execution",
		async (field) => {
			const f = fixture();
			f.afterTest(() => replace(f.state, field, "synthetic mutation"));
			await f.expectRefusal();
		},
	);
	it.each(INPUTS)("refuses changed source input %s before a receipt", async (input) => {
		const f = fixture();
		f.afterTest(() => f.state.blob.set(input, "e".repeat(40)));
		await f.expectRefusal();
	});
	it("rechecks the current PR after commands, refusing a moved head without a receipt", async () => {
		const f = fixture();
		f.afterTest(() => replace(f.pull, "head.sha", CONTROL));
		await f.expectRefusal();
		expect(f.request).toHaveBeenCalledTimes(2);
	});
	it("refuses a stale receipt before any source command can give it fresh credit", async () => {
		const f = fixture();
		writeFileSync(f.receipt, "DYTEST-stale-receipt");
		f.execute.mockReturnValue(1);
		await expect(f.run()).rejects.toThrow();
		expect(f.execute).not.toHaveBeenCalled();
		expect(readFileSync(f.receipt, "utf8")).toBe("DYTEST-stale-receipt");
	});
	it("exclusive receipt creation refuses a pathname planted during execution", async () => {
		const f = fixture();
		f.afterTest(() => writeFileSync(f.receipt, "DYTEST-planted"));
		await expect(f.run()).rejects.toThrow();
		expect(readFileSync(f.receipt, "utf8")).toBe("DYTEST-planted");
	});
	it("never issues a receipt for a held report whose pathname was replaced", async () => {
		const f = fixture(),
			stat = f.held.stat;
		f.held.io.lstat.mockReturnValueOnce(stat).mockReturnValue({ ...stat, ino: 88n });
		await f.expectRefusal();
	});
	it("the explicit source verifier checks the admitted head before any source command", () => {
		const f = fixture();
		expect(verifyNativeSupervisorSource(f.context, f.git)).toEqual(SOURCE);
		f.state.head = CONTROL;
		expect(() => verifyNativeSupervisorSource(f.context, f.git)).toThrow();
	});
});
