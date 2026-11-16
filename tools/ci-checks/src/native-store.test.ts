import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	constants,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	admitNativeStore,
	checkNativeStoreContext,
	checkNativeStorePull,
	checkNativeStoreReport,
	type NativeStoreCommand,
	type NativeStoreContext,
	NativeStoreError,
	type NativeStoreGit,
	type NativeStoreReportIo,
	type NativeStoreReportStat,
	nativeStoreCase,
	nativeStoreContext,
	nativeStoreFile,
	nativeStoreReceiptFile,
	readNativeStoreReport,
	runNativeStore,
	verifyNativeStoreSource,
} from "./native-store.ts";
import { checkWorkflow } from "./workflow-policy.ts";
import { parseYaml } from "./yaml.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const head = "a".repeat(40);
const control = "b".repeat(40);
const temporary = realpathSync(tmpdir());
const directories: string[] = [];
function directory(): string {
	const created = realpathSync(mkdtempSync(path.join(temporary, "draftyak-native-store-")));
	directories.push(created);
	return created;
}
afterEach(() => {
	for (const item of directories.splice(0)) {
		if (
			path.dirname(item) !== temporary ||
			!path.basename(item).startsWith("draftyak-native-store-") ||
			lstatSync(item).isSymbolicLink() ||
			realpathSync(item) !== item
		)
			throw new Error("Native store fixture root changed");
		rmSync(item, { recursive: true, force: true });
		expect(existsSync(item)).toBe(false);
	}
});

const context = (extra: Partial<NativeStoreContext> = {}): NativeStoreContext => ({
	event: "workflow_dispatch",
	repository: "draftyak/draftyak",
	actor: "nicksavov",
	triggeringActor: "nicksavov",
	ref: "refs/heads/m0",
	sha: control,
	workflowRef: "draftyak/draftyak/.github/workflows/native-store.yml@refs/heads/m0",
	workflowSha: control,
	runnerOs: "macOS",
	platform: "darwin",
	workspace: path.resolve("synthetic-native-store-control"),
	temporary,
	pr: "999999",
	head,
	runId: "999999001",
	runAttempt: "1",
	job: "native-store",
	...extra,
});
const source = { pr: "999999", head };
const pull = (): Record<string, unknown> => ({
	number: 999999,
	state: "open",
	user: { login: "nicksavov" },
	head: { sha: head, repo: { full_name: "draftyak/draftyak", private: false } },
	base: { ref: "m2", repo: { full_name: "draftyak/draftyak" } },
});
const readGit: NativeStoreGit = (args, cwd) => {
	if (args[0] === "diff") return "";
	if (args[0] === "ls-files") return nativeStoreFile;
	return path.basename(cwd) === "source" ? head : control;
};
const json = (value: unknown): Response =>
	new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

function report(workspace: string): Record<string, unknown> {
	return {
		success: true,
		numTotalTestSuites: 1,
		numPassedTestSuites: 1,
		numFailedTestSuites: 0,
		numPendingTestSuites: 0,
		numTotalTests: 1,
		numPassedTests: 1,
		numFailedTests: 0,
		numPendingTests: 0,
		numTodoTests: 0,
		testResults: [
			{
				name: path.join(workspace, "source", nativeStoreFile).replaceAll("\\", "/"),
				status: "passed",
				message: "",
				assertionResults: [
					{
						title: nativeStoreCase,
						fullName: nativeStoreCase,
						ancestorTitles: [],
						status: "passed",
						duration: 25,
						failureMessages: [],
					},
				],
			},
		],
	};
}
const reportSuite = (value: Record<string, unknown>): Record<string, unknown> =>
	(value.testResults as Record<string, unknown>[])[0] ?? {};
const assertion = (value: Record<string, unknown>): Record<string, unknown> =>
	(reportSuite(value).assertionResults as Record<string, unknown>[])[0] ?? {};

function sourceFixture(): {
	input: NativeStoreContext;
	change(file: string, staged: boolean): void;
} {
	const workspace = directory();
	const configuration = path.join(workspace, "gitconfig");
	writeFileSync(configuration, "[maintenance]\n\tauto = false\n");
	const at = (cwd: string, args: string[]): string => {
		const result = spawnSync("git", ["-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args], {
			cwd,
			encoding: "utf8",
			windowsHide: true,
			env: {
				...process.env,
				GIT_CONFIG_GLOBAL: configuration,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_AUTHOR_NAME: "Nick Savov",
				GIT_COMMITTER_NAME: "Nick Savov",
				GIT_AUTHOR_EMAIL: "nicksavov@protonmail.com",
				GIT_COMMITTER_EMAIL: "nicksavov@protonmail.com",
			},
		});
		if (result.status !== 0) throw new Error("Synthetic source repository setup failed");
		return result.stdout.trim();
	};
	at(workspace, ["init", "-q"]);
	writeFileSync(path.join(workspace, "control.txt"), "synthetic control");
	at(workspace, ["add", "control.txt"]);
	at(workspace, ["commit", "-qm", "test: initialize control"]);
	const controlSha = at(workspace, ["rev-parse", "HEAD"]);
	const sourceDirectory = path.join(workspace, "source");
	mkdirSync(sourceDirectory);
	at(sourceDirectory, ["init", "-q"]);
	for (const file of [
		nativeStoreFile,
		"apps/hub/vitest.config.ts",
		"apps/hub/test/store/fixtures/temp-files-child.ts",
	]) {
		mkdirSync(path.dirname(path.join(sourceDirectory, file)), { recursive: true });
		writeFileSync(path.join(sourceDirectory, file), "synthetic tracked source\n");
	}
	at(sourceDirectory, ["add", "."]);
	at(sourceDirectory, ["commit", "-qm", "test: initialize source"]);
	return {
		input: context({
			workspace,
			temporary: workspace,
			sha: controlSha,
			workflowSha: controlSha,
			head: at(sourceDirectory, ["rev-parse", "HEAD"]),
		}),
		change: (file, staged) => {
			writeFileSync(path.join(sourceDirectory, file), "changed synthetic tracked source\n");
			if (staged) at(sourceDirectory, ["add", "--", file]);
		},
	};
}

const access = (extra: Partial<NativeStoreReportIo> = {}): NativeStoreReportIo => ({
	lstat: (file) => lstatSync(file, { bigint: true }),
	open: (file, flags) => openSync(file, flags),
	fstat: (descriptor) => fstatSync(descriptor, { bigint: true }),
	read: (descriptor, buffer, offset, length, position) =>
		readSync(descriptor, buffer, offset, length, position),
	close: (descriptor) => closeSync(descriptor),
	...extra,
});

describe("native store held report read", () => {
	it("uses one regular descriptor with nofollow where available and always closes it", () => {
		const file = path.join(directory(), "report.json");
		writeFileSync(file, '{"passed":true}');
		let closed = 0;
		const io = access({
			open: (name, flags) => {
				expect(flags).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
				return openSync(name, flags);
			},
			close: (descriptor) => {
				closed++;
				closeSync(descriptor);
			},
		});
		expect(readNativeStoreReport(file, io)).toEqual({ passed: true });
		expect(closed).toBe(1);
	});

	it("refuses stale pathname size before reading from a different-sized descriptor", () => {
		const file = path.join(directory(), "report.json");
		writeFileSync(file, '{"passed":true}');
		const stat = lstatSync(file, { bigint: true });
		let reads = 0,
			closed = 0;
		const io = access({
			lstat: () => Object.assign(stat, { size: 0n }),
			read: () => {
				reads++;
				return 0;
			},
			close: (descriptor) => {
				closed++;
				closeSync(descriptor);
			},
		});
		expect(() => readNativeStoreReport(file, io)).toThrow("execution report is unavailable");
		expect(reads).toBe(0);
		expect(closed).toBe(1);
	});

	it("caps actual descriptor reads even when both size observations are stale", () => {
		const file = path.join(directory(), "report.json");
		writeFileSync(file, Buffer.alloc(1024 * 1024 + 512, 32));
		const stat = lstatSync(file, { bigint: true });
		const stale: NativeStoreReportStat = Object.assign(stat, { size: 0n });
		let bytes = 0,
			largest = 0,
			closed = 0;
		const io = access({
			lstat: () => stale,
			fstat: () => stale,
			read: (descriptor, buffer, offset, length, position) => {
				largest = Math.max(largest, length);
				const count = readSync(descriptor, buffer, offset, length, position);
				bytes += count;
				return count;
			},
			close: (descriptor) => {
				closed++;
				closeSync(descriptor);
			},
		});
		expect(() => readNativeStoreReport(file, io)).toThrow("execution report is unavailable");
		expect(largest).toBeLessThanOrEqual(1024 * 1024 + 1);
		expect(bytes).toBe(1024 * 1024 + 1);
		expect(closed).toBe(1);
	});

	it("refuses valid JSON whose held file grows during reading", () => {
		const file = path.join(directory(), "report.json");
		writeFileSync(file, '{"passed":true}');
		let grown = false,
			closed = 0;
		const io = access({
			read: (descriptor, buffer, offset, length, position) => {
				const count = readSync(descriptor, buffer, offset, length, position);
				if (!grown && count > 0) {
					appendFileSync(file, " ");
					grown = true;
				}
				return count;
			},
			close: (descriptor) => {
				closed++;
				closeSync(descriptor);
			},
		});
		expect(() => readNativeStoreReport(file, io)).toThrow("execution report is unavailable");
		expect(grown).toBe(true);
		expect(closed).toBe(1);
	});

	it("refuses a changed pathname identity after reading the held file", () => {
		const location = directory();
		const file = path.join(location, "report.json");
		const replacement = path.join(location, "replacement.json");
		writeFileSync(file, '{"passed":true}');
		writeFileSync(replacement, '{"passed":true}');
		let names = 0,
			closed = 0;
		const io = access({
			lstat: () => lstatSync(++names === 1 ? file : replacement, { bigint: true }),
			close: (descriptor) => {
				closed++;
				closeSync(descriptor);
			},
		});
		expect(() => readNativeStoreReport(file, io)).toThrow("execution report is unavailable");
		expect(names).toBe(2);
		expect(closed).toBe(1);
	});
});

describe("native store admission", () => {
	it("admits only the bound public owner PR and requests no authentication or alternate endpoint", async () => {
		let requested = 0;
		const admitted = await admitNativeStore(context(), readGit, async (url, options) => {
			requested++;
			expect(url).toBe("https://api.github.com/repos/draftyak/draftyak/pulls/999999");
			expect(options.method).toBe("GET");
			expect(options.redirect).toBe("error");
			expect(options.signal).toBeInstanceOf(AbortSignal);
			expect(options.headers).toEqual({ Accept: "application/vnd.github+json" });
			return json({ ...pull(), title: "synthetic ignored field", body: "synthetic ignored body" });
		});
		expect(admitted).toEqual(source);
		expect(requested).toBe(1);
	});

	it.each([
		["event", { event: "pull_request" }],
		["repository", { repository: "example/fork" }],
		["actor", { actor: "someone-else" }],
		["triggering actor", { triggeringActor: "someone-else" }],
		["control ref", { ref: "refs/heads/m2" }],
		[
			"workflow ref",
			{ workflowRef: "draftyak/draftyak/.github/workflows/other.yml@refs/heads/m0" },
		],
		["workflow SHA", { workflowSha: head }],
		["control SHA", { sha: "refs/heads/m0", workflowSha: "refs/heads/m0" }],
		["runner", { runnerOs: "Linux" }],
		["actual platform", { platform: "linux" }],
		["job", { job: "unrelated" }],
		["missing run", { runId: "" }],
		["noncanonical run", { runId: "01" }],
		["unsafe run", { runId: "9007199254740992" }],
		["missing attempt", { runAttempt: "" }],
		["noncanonical attempt", { runAttempt: "01" }],
		["relative workspace", { workspace: "relative" }],
		["relative report directory", { temporary: "relative" }],
		["PR ref", { pr: "refs/pull/999999/head" }],
		["noncanonical PR", { pr: "0999999" }],
		["head ref", { head: "refs/heads/m2" }],
		["zero head", { head: "0".repeat(40) }],
		["uppercase head", { head: head.toUpperCase() }],
	] as const)("refuses %s before any metadata request", async (_name, change) => {
		let requests = 0;
		await expect(
			admitNativeStore(context(change), readGit, async () => {
				requests++;
				return json(pull());
			}),
		).rejects.toBeInstanceOf(NativeStoreError);
		expect(requests).toBe(0);
	});

	it("refuses a different control checkout before fetching PR metadata", async () => {
		let requests = 0;
		await expect(
			admitNativeStore(
				context(),
				() => head,
				async () => {
					requests++;
					return json(pull());
				},
			),
		).rejects.toThrow("control checkout does not match");
		expect(requests).toBe(0);
	});

	it.each([
		["wrong PR", { number: 999998 }],
		["closed PR", { state: "closed" }],
		["wrong author", { user: { login: "someone-else" } }],
		["fork", { head: { sha: head, repo: { full_name: "example/fork", private: false } } }],
		["missing head repository", { head: { sha: head, repo: null } }],
		[
			"nonpublic repository",
			{ head: { sha: head, repo: { full_name: "draftyak/draftyak", private: true } } },
		],
		[
			"moved head",
			{ head: { sha: control, repo: { full_name: "draftyak/draftyak", private: false } } },
		],
		["wrong base", { base: { ref: "main", repo: { full_name: "draftyak/draftyak" } } }],
		["wrong base repository", { base: { ref: "m2", repo: { full_name: "example/fork" } } }],
	] as const)("refuses %s in the fixed endpoint response", (_name, change) => {
		expect(() => checkNativeStorePull({ ...pull(), ...change }, source)).toThrow(NativeStoreError);
	});

	it.each([null, [], "synthetic invalid response"])("refuses malformed metadata %j", (value) => {
		expect(() => checkNativeStorePull(value, source)).toThrow(NativeStoreError);
	});

	it.each([301, 403, 404, 429, 500])("refuses HTTP %i and cancels its body", async (status) => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel: () => {
				cancelled = true;
			},
		});
		await expect(
			admitNativeStore(
				context(),
				readGit,
				async () => new Response(body, { status, headers: { "content-type": "application/json" } }),
			),
		).rejects.toThrow("Native store PR metadata is unavailable");
		expect(cancelled).toBe(true);
	});

	it("refuses an oversized streaming response and cancels before parsing", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start: (controller) => controller.enqueue(new Uint8Array(256 * 1024 + 1)),
			cancel: () => {
				cancelled = true;
			},
		});
		await expect(
			admitNativeStore(
				context(),
				readGit,
				async () => new Response(body, { headers: { "content-type": "application/json" } }),
			),
		).rejects.toThrow("Native store PR metadata is unavailable");
		expect(cancelled).toBe(true);
	});

	it.each([
		[
			"invalid JSON",
			() => new Response("synthetic-not-json", { headers: { "content-type": "application/json" } }),
		],
		["non-JSON response", () => new Response("synthetic ignored body")],
		[
			"oversized length",
			() =>
				new Response("{}", {
					headers: { "content-type": "application/json", "content-length": "999999" },
				}),
		],
		[
			"invalid length",
			() =>
				new Response("{}", {
					headers: { "content-type": "application/json", "content-length": "unknown" },
				}),
		],
	] as const)("does not echo %s or its body", async (_name, response) => {
		await expect(admitNativeStore(context(), readGit, async () => response())).rejects.toThrow(
			"Native store PR metadata is unavailable",
		);
	});

	it("does not echo network or timeout diagnostics", async () => {
		await expect(
			admitNativeStore(context(), readGit, async () => {
				throw new Error("synthetic untrusted diagnostic");
			}),
		).rejects.toThrow(/^Native store PR metadata is unavailable$/);
	});

	it("maps only fixed Actions environment fields", () => {
		const env = {
			GITHUB_EVENT_NAME: "workflow_dispatch",
			GITHUB_REPOSITORY: "draftyak/draftyak",
			GITHUB_ACTOR: "nicksavov",
			GITHUB_TRIGGERING_ACTOR: "nicksavov",
			GITHUB_REF: "refs/heads/m0",
			GITHUB_SHA: control,
			GITHUB_WORKFLOW_SHA: control,
			GITHUB_WORKFLOW_REF: "draftyak/draftyak/.github/workflows/native-store.yml@refs/heads/m0",
			GITHUB_RUN_ID: "999999001",
			GITHUB_RUN_ATTEMPT: "1",
			GITHUB_JOB: "native-store",
			RUNNER_OS: "macOS",
			GITHUB_WORKSPACE: context().workspace,
			RUNNER_TEMP: temporary,
			NATIVE_STORE_PR: "999999",
			NATIVE_STORE_HEAD: head,
		};
		expect(nativeStoreContext(env, "darwin")).toEqual(context());
		expect(checkNativeStoreContext(nativeStoreContext(env, "darwin"))).toEqual(source);
	});
});

describe("native store executed-case result", () => {
	it("accepts the observed JSON reporter shape only for the actual selected case", () => {
		const value = report(context().workspace);
		expect(checkNativeStoreReport(value, path.join(context().workspace, "source"))).toBe(1);
	});

	it.each([
		[
			"unsuccessful run",
			(value: Record<string, unknown>) => {
				value.success = false;
			},
		],
		[
			"empty collection",
			(value: Record<string, unknown>) => {
				value.numTotalTests = 0;
				value.numPassedTests = 0;
				reportSuite(value).assertionResults = [];
			},
		],
		[
			"wrong file",
			(value: Record<string, unknown>) => {
				reportSuite(value).name = `${reportSuite(value).name}.other`;
			},
		],
		[
			"other passed case",
			(value: Record<string, unknown>) => {
				assertion(value).title = "other passed case";
				assertion(value).fullName = "other passed case";
			},
		],
		[
			"filtered suite",
			(value: Record<string, unknown>) => {
				value.testResults = [];
			},
		],
		[
			"routed skip",
			(value: Record<string, unknown>) => {
				assertion(value).status = "pending";
				value.numPendingTests = 1;
				value.numPassedTests = 0;
			},
		],
		[
			"hidden static skip",
			(value: Record<string, unknown>) => {
				assertion(value).status = "skipped";
			},
		],
		[
			"todo",
			(value: Record<string, unknown>) => {
				assertion(value).status = "todo";
				value.numTodoTests = 1;
			},
		],
		[
			"failed case",
			(value: Record<string, unknown>) => {
				assertion(value).status = "failed";
			},
		],
		[
			"extra failed suite",
			(value: Record<string, unknown>) => {
				value.numFailedTestSuites = 1;
			},
		],
		[
			"duplicate target cases",
			(value: Record<string, unknown>) => {
				reportSuite(value).assertionResults = [assertion(value), { ...assertion(value) }];
				value.numTotalTests = 2;
				value.numPassedTests = 2;
			},
		],
		[
			"unreported extra case",
			(value: Record<string, unknown>) => {
				value.numTotalTests = 2;
			},
		],
		[
			"failed assertion details",
			(value: Record<string, unknown>) => {
				assertion(value).failureMessages = ["synthetic failure"];
			},
		],
		[
			"no measured execution",
			(value: Record<string, unknown>) => {
				assertion(value).duration = 0;
			},
		],
	] as const)("refuses %s even if the process reports exit zero", (_name, change) => {
		const value = report(context().workspace);
		change(value);
		expect(() => checkNativeStoreReport(value, path.join(context().workspace, "source"))).toThrow(
			NativeStoreError,
		);
	});
});

describe("native store source and execution wiring", () => {
	it("accepts an actual clean source tree and uses the required source exclusions", () => {
		const { input } = sourceFixture();
		expect(verifyNativeStoreSource(input)).toEqual({ pr: input.pr, head: input.head });
		let checked = false;
		verifyNativeStoreSource(context(), (args, cwd) => {
			if (args[0] === "diff") {
				checked = true;
				expect(args).toEqual([
					"diff",
					"--quiet",
					"HEAD",
					"--",
					".",
					":(exclude)*siwc*",
					":(exclude)*dynamic-agent*",
					":(exclude)*dynamic_agent*",
				]);
			}
			return readGit(args, cwd);
		});
		expect(checked).toBe(true);
	});

	it.each([
		[nativeStoreFile, false],
		[nativeStoreFile, true],
		["apps/hub/vitest.config.ts", false],
		["apps/hub/vitest.config.ts", true],
		["apps/hub/test/store/fixtures/temp-files-child.ts", false],
		["apps/hub/test/store/fixtures/temp-files-child.ts", true],
	] as const)("refuses changed tracked %s (staged=%s) before executing source", (file, staged) => {
		const fixture = sourceFixture();
		fixture.change(file, staged);
		let executed = false;
		expect(() =>
			runNativeStore(fixture.input, {}, undefined, () => {
				executed = true;
				writeFileSync(
					path.join(fixture.input.temporary, "native-store.json"),
					JSON.stringify(report(fixture.input.workspace)),
				);
				return 0;
			}),
		).toThrow(/^Native store source tree differs from the admitted head$/);
		expect(executed).toBe(false);
	});

	it("refuses tracked source content changed during a passing command", () => {
		const fixture = sourceFixture();
		expect(() =>
			runNativeStore(fixture.input, {}, undefined, () => {
				fixture.change("apps/hub/test/store/fixtures/temp-files-child.ts", false);
				writeFileSync(
					path.join(fixture.input.temporary, "native-store.json"),
					JSON.stringify(report(fixture.input.workspace)),
				);
				return 0;
			}),
		).toThrow(/^Native store source tree differs from the admitted head$/);
	});

	it("binds the feature checkout and committed target to the admitted head", () => {
		expect(verifyNativeStoreSource(context(), readGit)).toEqual(source);
		expect(() =>
			verifyNativeStoreSource(context(), (args, cwd) =>
				path.basename(cwd) === "source" && args[0] === "rev-parse" ? control : readGit(args, cwd),
			),
		).toThrow("source checkout does not match");
		expect(() =>
			verifyNativeStoreSource(context(), (args, cwd) =>
				args[0] === "ls-files" ? "another-file.ts" : readGit(args, cwd),
			),
		).toThrow("source checkout does not match");
	});

	it("executes only the fixed heavy target with both reporters, strict skips and no tokens", () => {
		const input = context({ temporary: directory() });
		let command: NativeStoreCommand | undefined;
		expect(
			runNativeStore(
				input,
				{ GH_TOKEN: "synthetic", GITHUB_TOKEN: "synthetic", DRAFTYAK_STRICT_SKIPS: "0" },
				readGit,
				(value) => {
					command = value;
					writeFileSync(
						path.join(input.temporary, "native-store.json"),
						JSON.stringify(report(input.workspace)),
					);
					return 0;
				},
			),
		).toBe(1);
		expect(command?.executable).toBe(process.execPath);
		expect(command?.cwd).toBe(path.join(input.workspace, "source/apps/hub"));
		expect(command?.args).toEqual([
			path.join(input.workspace, "source/node_modules/vitest/vitest.mjs"),
			"run",
			"--mode=heavy",
			"--reporter=default",
			"--reporter=json",
			`--outputFile=${path.join(input.temporary, "native-store.json")}`,
			"test/store/temp-files.heavy.test.ts",
			"--exclude",
			"**/*siwc*/**",
			"--exclude",
			"**/*siwc*",
			"--exclude",
			"**/*dynamic-agent*",
			"--exclude",
			"**/*dynamic_agent*",
		]);
		expect(command?.env.GH_TOKEN).toBeUndefined();
		expect(command?.env.GITHUB_TOKEN).toBeUndefined();
		expect(command?.env.DRAFTYAK_STRICT_SKIPS).toBe("1");
	});

	it.each([1, null])(
		"propagates a failed or interrupted command (%s) despite a passing report",
		(status) => {
			const input = context({ temporary: directory() });
			expect(() =>
				runNativeStore(input, {}, readGit, () => {
					writeFileSync(
						path.join(input.temporary, "native-store.json"),
						JSON.stringify(report(input.workspace)),
					);
					return status;
				}),
			).toThrow("Native store test command failed");
		},
	);

	it("removes a stale report and refuses a zero-exit command that produced no new report", () => {
		const input = context({ temporary: directory() });
		writeFileSync(
			path.join(input.temporary, "native-store.json"),
			JSON.stringify(report(input.workspace)),
		);
		expect(() => runNativeStore(input, {}, readGit, () => 0)).toThrow(
			"execution report is unavailable",
		);
	});

	it.each(["invalid JSON", "oversized"])(
		"refuses a new %s report without echoing its content",
		(kind) => {
			const input = context({ temporary: directory() });
			expect(() =>
				runNativeStore(input, {}, readGit, () => {
					writeFileSync(
						path.join(input.temporary, "native-store.json"),
						kind === "oversized" ? "x".repeat(1024 * 1024 + 1) : "synthetic invalid report",
					);
					return 0;
				}),
			).toThrow(/^Native store execution report is unavailable$/);
		},
	);

	it("refuses a source head changed during an otherwise passing command", () => {
		const input = context({ temporary: directory() });
		let changed = false;
		expect(() =>
			runNativeStore(
				input,
				{},
				(args, cwd) =>
					changed && path.basename(cwd) === "source" && args[0] === "rev-parse"
						? control
						: readGit(args, cwd),
				() => {
					writeFileSync(
						path.join(input.temporary, "native-store.json"),
						JSON.stringify(report(input.workspace)),
					);
					changed = true;
					return 0;
				},
			),
		).toThrow("source checkout does not match");
	});

	it("makes a context refusal an actual CLI failure without echoing supplied input", () => {
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(new URL("./native-store.ts", import.meta.url)), "admit"],
			{
				env: {
					...process.env,
					GITHUB_EVENT_NAME: "push",
					NATIVE_STORE_PR: "synthetic ignored input",
				},
				encoding: "utf8",
				windowsHide: true,
			},
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("requires the owner-only trusted m0 macOS workflow");
		expect(result.stderr).not.toContain("synthetic ignored input");
	});
});

describe("native store minimal execution receipt", () => {
	it("writes only bounded run/source identities and validated counts after a successful command", () => {
		const input = context({ temporary: directory() });
		const receipt = path.join(input.temporary, nativeStoreReceiptFile);
		writeFileSync(receipt, "stale synthetic receipt");
		expect(
			runNativeStore(
				input,
				{ NATIVE_STORE_PASSED: "999", NATIVE_STORE_SOURCE_UNCHANGED: "false" },
				readGit,
				() => {
					expect(existsSync(receipt)).toBe(false);
					const value = report(input.workspace);
					value.untrusted = "synthetic ignored report field";
					writeFileSync(path.join(input.temporary, "native-store.json"), JSON.stringify(value));
					return 0;
				},
			),
		).toBe(1);
		const text = readFileSync(receipt, "utf8");
		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4096);
		expect(JSON.parse(text)).toEqual({
			version: 1,
			repository: "draftyak/draftyak",
			workflowRef: "draftyak/draftyak/.github/workflows/native-store.yml@refs/heads/m0",
			ref: "refs/heads/m0",
			actor: "nicksavov",
			triggeringActor: "nicksavov",
			controlSha: control,
			pr: "999999",
			sourceHead: head,
			runId: "999999001",
			runAttempt: "1",
			job: "native-store",
			runnerOs: "macOS",
			platform: "darwin",
			testFile: nativeStoreFile,
			testCase: nativeStoreCase,
			passed: 1,
			failed: 0,
			skipped: 0,
			pending: 0,
			todo: 0,
			sourceUnchanged: true,
		});
		expect(text).not.toContain(input.workspace);
		expect(text).not.toContain(input.temporary);
		expect(text).not.toContain("synthetic ignored");
		const info = lstatSync(receipt);
		expect(info.isFile() && !info.isSymbolicLink()).toBe(true);
	});

	it.each([
		"failed command",
		"missing report",
		"skipped case",
		"empty suite",
		"mismatched source",
		"duplicate case",
	])("publishes no receipt for %s", (fault) => {
		const input = context({ temporary: directory() });
		const receipt = path.join(input.temporary, nativeStoreReceiptFile);
		writeFileSync(receipt, "stale synthetic receipt");
		expect(() =>
			runNativeStore(input, {}, readGit, () => {
				if (fault === "missing report") return 0;
				const value = report(input.workspace);
				if (fault === "skipped case") assertion(value).status = "skipped";
				if (fault === "empty suite") value.testResults = [];
				if (fault === "mismatched source") reportSuite(value).name = "synthetic unrelated suite";
				if (fault === "duplicate case") {
					reportSuite(value).assertionResults = [assertion(value), { ...assertion(value) }];
					value.numTotalTests = 2;
					value.numPassedTests = 2;
				}
				writeFileSync(path.join(input.temporary, "native-store.json"), JSON.stringify(value));
				return fault === "failed command" ? 1 : 0;
			}),
		).toThrow(NativeStoreError);
		expect(existsSync(receipt)).toBe(false);
	});

	it("refuses receipt-path replacement during source execution instead of overwriting it", () => {
		const input = context({ temporary: directory() });
		const receipt = path.join(input.temporary, nativeStoreReceiptFile);
		expect(() =>
			runNativeStore(input, {}, readGit, () => {
				writeFileSync(receipt, "synthetic replacement");
				writeFileSync(
					path.join(input.temporary, "native-store.json"),
					JSON.stringify(report(input.workspace)),
				);
				return 0;
			}),
		).toThrow(/^Native store receipt is unavailable$/);
		expect(readFileSync(receipt, "utf8")).toBe("synthetic replacement");
	});
});

it("keeps the real manual workflow disjoint, source-bound and within the generic policy", () => {
	const file = ".github/workflows/native-store.yml";
	const text = readFileSync(path.join(root, file), "utf8");
	expect(checkWorkflow(file, text, "1.95.0")).toEqual([]);
	const parsed = parseYaml(text).value as {
		on: Record<string, unknown>;
		jobs: Record<string, { if: string; "runs-on": string; steps: Record<string, unknown>[] }>;
	};
	expect(Object.keys(parsed.on)).toEqual(["workflow_dispatch"]);
	expect(Object.keys(parsed.jobs)).toEqual(["native-store"]);
	const job = parsed.jobs["native-store"];
	expect(job?.["runs-on"]).toBe("macos-15");
	expect(job?.if).toBe(
		`\${{ github.event_name == 'workflow_dispatch' && github.repository == 'draftyak/draftyak' && github.actor == 'nicksavov' && github.triggering_actor == 'nicksavov' && github.ref == 'refs/heads/m0' }}`,
	);
	const steps = job?.steps ?? [];
	const admission = steps.findIndex(
		(step) => step.run === "node tools/ci-checks/src/native-store.ts admit",
	);
	const checkout = steps.findIndex(
		(step) => (step.with as Record<string, unknown> | undefined)?.path === "source",
	);
	const verification = steps.findIndex(
		(step) => step.run === "node tools/ci-checks/src/native-store.ts verify-source",
	);
	const install = steps.findIndex((step) => step.run === "pnpm install --frozen-lockfile");
	expect(admission).toBeGreaterThan(0);
	expect(checkout).toBeGreaterThan(admission);
	expect(verification).toBeGreaterThan(checkout);
	expect(install).toBeGreaterThan(verification);
	expect(steps[0]?.with).toEqual({ ref: `\${{ github.sha }}`, "persist-credentials": false });
	expect(steps[checkout]?.with).toEqual({
		repository: "draftyak/draftyak",
		ref: `\${{ steps.source.outputs.head }}`,
		path: "source",
		"persist-credentials": false,
	});
	expect(steps.at(-2)?.run).toBe("node tools/ci-checks/src/native-store.ts run");
	expect(steps.at(-2)?.id).toBe("native");
	expect(steps.at(-1)).toEqual({
		name: "Upload the verified native receipt",
		if: `\${{ success() && steps.native.outputs.receipt == 'ready' }}`,
		uses: "actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9",
		with: {
			name: `native-store-receipt-\${{ github.run_id }}-\${{ github.run_attempt }}`,
			path: `\${{ runner.temp }}/native-store-receipt.json`,
			"if-no-files-found": "error",
			"retention-days": 1,
		},
	});
	expect(text).not.toMatch(/continue-on-error|github\.token|secrets\./);
});
