import { execFile, spawn, spawnSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { type Job, monthRange, prChecksOnlyFrom, rates, runnerOs, tally } from "./ci-minutes.ts";
import { appendSummary, runCli, setOutputs, UsageError } from "./lib.ts";

// pnpm spikes:run checks gh and this month's billed minutes, pushes HEAD plus spikes/run.json, as a
// throwaway commit, to spikes-run/<branch>-<UTC stamp>, follows the spikes.yml run there, writes
// its evidence into spikes/<id>/evidence/ after showing the diff and always deletes the branch.
// spikes.yml runs this file with --plan (the job matrix) and --check-evidence (what may be
// uploaded).

export const runners: readonly string[] = [
	"ubuntu-24.04",
	"ubuntu-24.04-arm",
	"windows-2025",
	"windows-11-arm",
	"macos-15",
	"macos-15-intel",
];
export const nodeChoices: readonly string[] = ["both", "minimum", "bundled"];
const runFile = "spikes/run.json";
const workflowFile = ".github/workflows/spikes.yml";
const settingKeys = ["timeout", "docker", "java", "android", "tauriLinux", "apt", "rust"];
const maxEvidenceBytes = 1 << 20;
const maxTests = 20;
const valid = {
	spike: /^[a-z0-9][a-z0-9-]*$/,
	apt: /^[a-z0-9][a-z0-9+.-]+$/,
	android: /^[a-z][\w.-]*(?:;[\w.-]+)*$/,
	target: /^[a-z0-9_]+(?:-[a-z0-9_.]+){1,4}$/,
	evidence: /^[A-Za-z0-9][\w.-]*\.json$/,
	// Relative to the spike's folder: never a flag, '..', a space, shell syntax or a glob.
	test: /^test\/[a-z0-9][a-z0-9-]*\.heavy\.test\.ts$/,
};
const usage =
	"usage: pnpm spikes:run --spikes 'kit,s01' --os ubuntu-24.04 [--node both|minimum|bundled] [--tests 'test/a.heavy.test.ts,test/b.heavy.test.ts'] [--dry-run] [--yes]";
const jobQuery = ".jobs[] | {labels, status, conclusion, started_at, completed_at}";

export interface Proc {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type Run = (
	args: readonly string[],
	options?: {
		readonly input?: string;
		readonly cwd?: string;
		readonly env?: Readonly<Record<string, string>>;
	},
) => Proc;

// The files of one commit: spikes.yml's checkout, or HEAD for the local CLI.
export interface Tree {
	files(dir: string): string[];
	read(file: string): string | undefined;
}

export interface Settings {
	readonly timeout: number;
	readonly docker: boolean;
	readonly java: boolean;
	readonly tauriLinux: boolean;
	readonly apt: readonly string[];
	// The owner's route (a): sdkmanager installs these and accepts their licences.
	readonly android?: { readonly packages: readonly string[] };
	readonly rust?: { readonly targets: readonly string[] };
}

// One spikes.yml job; strings, so that the workflow passes them on as they are.
export interface Entry {
	readonly spike: string;
	readonly os: string;
	readonly timeout: number;
	readonly rate: number;
	readonly docker: boolean;
	readonly java: boolean;
	readonly tauriLinux: boolean;
	readonly apt: string;
	readonly androidPackages: string;
	readonly rust: boolean;
	readonly rustTargets: string;
	readonly rustKey: string;
	readonly rustWorkspaces: string;
	// A partial run's test files, space-separated; "" runs the whole heavy tier.
	readonly tests: string;
}

export interface Plan {
	readonly spikes: readonly string[];
	readonly os: readonly string[];
	readonly node: string;
	readonly tests: readonly string[];
	readonly entries: readonly Entry[];
}

export class PlanError extends Error {
	readonly problems: readonly string[];
	constructor(problems: readonly string[]) {
		super(problems.join("\n"));
		this.problems = problems;
	}
}

class Interrupted extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const message = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);
const lastLine = (text: string): string => text.trim().split(/\r?\n/).at(-1) ?? "";

export const split = (value: string): string[] => value.split(/[\s,]+/).filter(Boolean);

function ok(result: Proc, what: string): string {
	if (result.code !== 0) {
		throw new Error(`${what}: ${lastLine(result.stderr) || `exit code ${result.code}`}`);
	}
	return result.stdout;
}

export function gitTree(git: Run, rev: string): Tree {
	return {
		files: (dir) =>
			ok(
				git(["ls-tree", "-r", "-z", "--full-tree", "--name-only", rev, "--", `${dir}/`]),
				"git ls-tree",
			)
				.split("\0")
				.filter(Boolean),
		read: (file) => {
			const result = git(["cat-file", "blob", `${rev}:${file}`]);
			return result.code === 0 ? result.stdout : undefined;
		},
	};
}

function unknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
	problems: string[],
): void {
	for (const key of Object.keys(value).filter((name) => !allowed.includes(name))) {
		problems.push(`${where}: unknown key ${JSON.stringify(key)}`);
	}
}

// A list of distinct strings that pass `test`; [] when the value is absent and not required.
function strings(
	value: unknown,
	test: (item: string) => boolean,
	where: string,
	problems: string[],
	required = false,
	refusal = "is unknown or malformed",
): string[] {
	if (value === undefined && !required) return [];
	if (!Array.isArray(value) || (required && value.length === 0)) {
		problems.push(`${where} must be a ${required ? "non-empty " : ""}list`);
		return [];
	}
	const count = problems.length;
	for (const [index, item] of value.entries()) {
		if (typeof item !== "string" || !test(item)) {
			problems.push(`${where}: ${JSON.stringify(item)} ${refusal}`);
		} else if (value.indexOf(item) !== index) problems.push(`${where} lists ${item} twice`);
	}
	return problems.length === count ? (value as string[]) : [];
}

// A partial run's heavy test files, as the request names them; [] runs them all.
function testList(value: unknown, problems: string[]): string[] {
	if (value === undefined) return [];
	if (Array.isArray(value) && value.length > maxTests) {
		problems.push(`tests: at most ${maxTests} files, not ${value.length}`);
		return [];
	}
	const refusal = "isn't test/<name>.heavy.test.ts, with <name> of a-z, 0-9 and dashes";
	return strings(value, (file) => valid.test.test(file), "tests", problems, true, refusal);
}

// Vitest reads each test file as a filter and runs every heavy file whose path holds it, so each
// one must be a committed heavy file of the spike that holds no other.
function checkTests(tests: readonly string[], dir: string, files: readonly string[]): string[] {
	const folder = `spikes/${dir}/`;
	const heavy = files
		.filter((file) => file.startsWith(folder) && file.endsWith(".heavy.test.ts"))
		.map((file) => file.slice(folder.length));
	return tests.flatMap((test) => {
		if (!heavy.includes(test)) return [`tests: ${folder}${test} isn't a committed file`];
		const also = heavy.filter((file) => file !== test && file.toLowerCase().includes(test));
		return also.length === 0
			? []
			: [`tests: ${test} would also run ${also.map((file) => folder + file).join(", ")}`];
	});
}

function settings(raw: unknown, where: string, os: string, problems: string[]): Settings | null {
	if (!isObject(raw)) {
		problems.push(`${where} must be an object`);
		return null;
	}
	const count = problems.length;
	unknownKeys(raw, settingKeys, where, problems);
	const max = os.startsWith("macos") ? 30 : 60;
	const timeout = Number.isInteger(raw.timeout) ? Number(raw.timeout) : 0;
	if (timeout < 1 || timeout > max) {
		problems.push(`${where}: timeout must be whole minutes from 1 to ${max}`);
	}
	const flag = (key: string): boolean => {
		if (raw[key] !== undefined && typeof raw[key] !== "boolean") {
			problems.push(`${where}: ${key} must be true or false`);
		}
		return raw[key] === true;
	};
	const [docker, java, tauriLinux] = [flag("docker"), flag("java"), flag("tauriLinux")];
	const apt = strings(raw.apt, (name) => valid.apt.test(name), `${where}: apt`, problems);
	if (!os.startsWith("ubuntu") && (docker || tauriLinux || apt.length > 0)) {
		problems.push(`${where}: docker, tauriLinux and apt need an ubuntu runner`);
	}
	let android: Settings["android"];
	if (raw.android !== undefined) {
		const value = isObject(raw.android) ? raw.android : {};
		unknownKeys(value, ["packages"], `${where}: android`, problems);
		const named = (name: string): boolean => valid.android.test(name);
		const packages = strings(value.packages, named, `${where}: android.packages`, problems, true);
		android = { packages };
	}
	let rust: Settings["rust"];
	if (raw.rust !== undefined) {
		const value = isObject(raw.rust) ? raw.rust : { targets: "?" };
		unknownKeys(value, ["targets"], `${where}: rust`, problems);
		const targets = (name: string): boolean => valid.target.test(name);
		rust = { targets: strings(value.targets, targets, `${where}: rust.targets`, problems) };
	}
	if (problems.length > count) return null;
	return { timeout, docker, java, tauriLinux, apt, android, rust };
}

// spikes/<dir>/ci.json: { "os": { "<runner>": { "timeout": <minutes>, ...setup } } }.
function readCi(tree: Tree, dir: string, problems: string[]): Map<string, Settings> | null {
	const file = `spikes/${dir}/ci.json`;
	const text = tree.read(file);
	if (text === undefined) {
		problems.push(`${file} is missing, so ${dir} can't run on GitHub`);
		return null;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch (error) {
		problems.push(`${file}: ${message(error)}`);
		return null;
	}
	const count = problems.length;
	const ci = isObject(value) ? value : {};
	unknownKeys(ci, ["os"], file, problems);
	if (!isObject(ci.os) || Object.keys(ci.os).length === 0) {
		problems.push(`${file}: "os" must map runners to their settings`);
		return null;
	}
	const found = new Map<string, Settings>();
	for (const [os, raw] of Object.entries(ci.os)) {
		if (!runners.includes(os)) problems.push(`${file}: unknown runner ${JSON.stringify(os)}`);
		const parsed = settings(raw, `${file} os.${os}`, os, problems);
		if (parsed) found.set(os, parsed);
	}
	return problems.length === count ? found : null;
}

// The Cargo workspaces in a spike: each [workspace] manifest's folder, and packages outside them.
function rustWorkspaces(tree: Tree, files: readonly string[], dir: string): string[] {
	const manifests = files.filter(
		(file) => file.startsWith(`spikes/${dir}/`) && path.posix.basename(file) === "Cargo.toml",
	);
	const roots = manifests
		.filter((file) => /^\s*\[workspace\]/m.test(tree.read(file) ?? ""))
		.map((file) => path.posix.dirname(file));
	const inside = (folder: string): boolean =>
		roots.some((root) => folder === root || folder.startsWith(`${root}/`));
	const packages = manifests.map((file) => path.posix.dirname(file)).filter((d) => !inside(d));
	return [...roots, ...packages].sort();
}

function entry(
	spike: string,
	os: string,
	setup: Settings,
	workspaces: readonly string[],
	tests: readonly string[],
): Entry {
	const targets = setup.rust?.targets ?? [];
	return {
		spike,
		os,
		timeout: setup.timeout,
		rate: rates[runnerOs([os])],
		docker: setup.docker,
		java: setup.java,
		tauriLinux: setup.tauriLinux,
		apt: setup.apt.join(" "),
		androidPackages: setup.android?.packages.join(" ") ?? "",
		rust: setup.rust !== undefined,
		rustTargets: targets.join(","),
		rustKey: [spike, ...targets].join("-"),
		rustWorkspaces: setup.rust ? workspaces.join("\n") : "",
		tests: tests.join(" "),
	};
}

function heavyScript(tree: Tree, dir: string): unknown {
	try {
		const manifest: unknown = JSON.parse(tree.read(`spikes/${dir}/package.json`) ?? "");
		return isObject(manifest) && isObject(manifest.scripts) ? manifest.scripts["test:heavy"] : null;
	} catch {
		return null;
	}
}

// A partial run's files follow pnpm's `--`. The kit's runner reads its flags across it and hands
// the files to Vitest as filters; Vitest takes nothing after a `--` as a filter, so runs them all.
const kitRun = "node ../kit/run.ts --heavy";
const runsKit = (dir: string, script: unknown): boolean =>
	script === kitRun || (dir === "kit" && script === "node run.ts --heavy");

// Validates a request ({ spikes, os, node, tests? }) and each spike's ci.json; any problem throws.
export function planRun(request: unknown, tree: Tree): Plan {
	const problems: string[] = [];
	const value = isObject(request) ? request : {};
	unknownKeys(value, ["spikes", "os", "node", "tests"], "the request", problems);
	const ids = strings(value.spikes, (id) => valid.spike.test(id), "spikes", problems, true);
	const labels = strings(value.os, (os) => runners.includes(os), "os", problems, true);
	if (labels.length === 0) problems.push(`os: the runners are ${runners.join(", ")}`);
	const node = typeof value.node === "string" ? value.node : "";
	if (!nodeChoices.includes(node)) problems.push(`node must be ${nodeChoices.join(", ")}`);
	const tests = testList(value.tests, problems);
	if (value.tests !== undefined && ids.length > 1) {
		problems.push(`tests: allowed only with exactly one spike, not ${ids.join(", ")}`);
	}
	const files = tree.files("spikes");
	const folders = files.flatMap((file) => /^spikes\/([^/]+)\/package\.json$/.exec(file)?.[1] ?? []);
	const spikes: string[] = [];
	for (const id of ids) {
		const matches = folders.includes(id) ? [id] : folders.filter((f) => f.startsWith(`${id}-`));
		const [dir = ""] = matches;
		if (matches.length !== 1) {
			const how = matches.length === 0 ? "no spike" : "more than one spike";
			problems.push(`spikes: ${how} matches ${id} (spikes/ has ${folders.join(", ")})`);
		} else if (spikes.includes(dir)) problems.push(`spikes: ${id} names ${dir} again`);
		else spikes.push(dir);
	}
	const entries: Entry[] = [];
	for (const dir of spikes) {
		const script = heavyScript(tree, dir);
		if (!script) {
			problems.push(`spikes/${dir}/package.json has no test:heavy script, which spikes.yml runs`);
		} else if (tests.length > 0 && !runsKit(dir, script)) {
			problems.push(
				`tests: spikes/${dir}/package.json's test:heavy isn't "${kitRun}", which hands the files to Vitest`,
			);
		}
		const ci = readCi(tree, dir, problems);
		if (!ci) continue;
		const workspaces = rustWorkspaces(tree, files, dir);
		for (const os of labels) {
			const setup = ci.get(os);
			if (!setup) {
				problems.push(
					`spikes/${dir}/ci.json doesn't run on ${os} (only ${[...ci.keys()].join(", ")})`,
				);
			} else if (setup.rust && workspaces.length === 0) {
				problems.push(`spikes/${dir}/ci.json: rust on ${os}, but spikes/${dir} has no Cargo.toml`);
			} else entries.push(entry(dir, os, setup, workspaces, tests));
		}
	}
	const [only] = spikes;
	if (only !== undefined && spikes.length === 1) problems.push(...checkTests(tests, only, files));
	if (problems.length > 0) throw new PlanError(problems);
	return { spikes, os: labels, node, tests, entries };
}

// Each job's timeout times its runner's rate, plus a minute for plan.
export function worstCase(plan: Plan): number {
	return plan.entries.reduce((sum, job) => sum + job.timeout * job.rate, 1);
}

function setupOf(job: Entry): string {
	const parts = [
		job.docker && "docker",
		job.java && "JDK 21",
		job.androidPackages && `Android SDK via sdkmanager (${job.androidPackages})`,
		job.tauriLinux && "Tauri packages and xvfb",
		job.apt && `apt: ${job.apt}`,
		job.rust && `Rust 1.95.0${job.rustTargets ? ` + ${job.rustTargets}` : ""}`,
	];
	return parts.filter(Boolean).join("; ") || "none";
}

const onlyTests = (plan: Plan, separator: string): string =>
	plan.tests.length > 0 ? `${separator}only ${plan.tests.join(", ")}` : "";

export function describePlan(plan: Plan): string[] {
	const jobs = plan.entries.length;
	return [
		`spikes-run: ${jobs} job${jobs === 1 ? "" : "s"}, node ${plan.node}, at most ${worstCase(plan)} billed minutes (timeouts x runner rates, plus 1 for plan)${onlyTests(plan, "; ")}`,
		...plan.entries.map(
			(job) =>
				`  ${job.spike} on ${job.os}: up to ${job.timeout} min x ${job.rate}; ${setupOf(job)}`,
		),
	];
}

function planSummary(plan: Plan): string {
	return [
		"### Spikes run",
		"",
		"| Spike | Runner | Timeout | Rate | Setup |",
		"|---|---|---|---|---|",
		...plan.entries.map(
			(job) => `| ${job.spike} | ${job.os} | ${job.timeout} min | ${job.rate} | ${setupOf(job)} |`,
		),
		"",
		`Node: ${plan.node}. At most ${worstCase(plan)} billed minutes (each timeout times its runner's rate, plus 1 for plan); each job's summary has its estimate.`,
		...(plan.tests.length > 0
			? ["", `Only these test files run: ${plan.tests.map((file) => `\`${file}\``).join(", ")}.`]
			: []),
	].join("\n");
}

// spikes.yml's plan step: the request comes from the pushed spikes/run.json, or after the gate
// from workflow_dispatch inputs (RUN_SPIKES, RUN_OS, RUN_NODE, RUN_TESTS).
export function planStep(tree: Tree, env: NodeJS.ProcessEnv, log: (line: string) => void): number {
	const fail = (line: string): number => {
		log(`${env.GITHUB_ACTIONS === "true" ? "::error::" : ""}spikes-run: ${line}`);
		return 1;
	};
	let request: unknown;
	if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
		const [spikes, os] = [split(env.RUN_SPIKES ?? ""), split(env.RUN_OS ?? "")];
		const fields = { spikes, os, node: env.RUN_NODE ?? "" };
		const raw = env.RUN_TESTS ?? "";
		const tests = split(raw);
		// An empty input runs the whole tier; separators alone are refused, as --tests refuses them.
		if (raw !== "" && tests.length === 0) {
			return fail("tests names no test file; leave it empty to run the whole heavy tier");
		}
		request = tests.length > 0 ? { ...fields, tests } : fields;
	} else {
		const text = tree.read(runFile);
		if (text === undefined) return fail(`${runFile} is missing: start runs with pnpm spikes:run`);
		try {
			request = JSON.parse(text);
		} catch (error) {
			return fail(`${runFile}: ${message(error)}`);
		}
	}
	let plan: Plan;
	try {
		plan = planRun(request, tree);
	} catch (error) {
		if (!(error instanceof PlanError)) throw error;
		for (const problem of error.problems) fail(problem);
		return 1;
	}
	setOutputs(
		{ matrix: JSON.stringify({ include: plan.entries }), node: plan.node },
		env.GITHUB_OUTPUT,
	);
	appendSummary(planSummary(plan), env.GITHUB_STEP_SUMMARY);
	for (const line of describePlan(plan)) log(line);
	return 0;
}

// Only .json files directly in spikes/<id>/evidence/, up to 1 MiB each, may be uploaded: never an
// installable build, and no links, which upload-artifact would follow.
export function checkEvidence(root: string): { files: string[]; problems: string[] } {
	const files: string[] = [];
	const problems: string[] = [];
	for (const spike of readdirSync(path.join(root, "spikes"), { withFileTypes: true })) {
		const where = `spikes/${spike.name}`;
		if (spike.isSymbolicLink()) problems.push(`${where} is a link`);
		const dir = path.join(root, where, "evidence");
		const stat = spike.isDirectory() ? lstatSync(dir, { throwIfNoEntry: false }) : undefined;
		if (!stat) continue;
		if (!stat.isDirectory()) {
			problems.push(`${where}/evidence isn't a folder`);
			continue;
		}
		for (const item of readdirSync(dir, { withFileTypes: true })) {
			const file = `${where}/evidence/${item.name}`;
			if (!item.isFile() || !valid.evidence.test(item.name)) {
				problems.push(`${file}: evidence is .json files only`);
				continue;
			}
			const bytes = readFileSync(path.join(dir, item.name));
			if (bytes.length > maxEvidenceBytes) problems.push(`${file}: over 1 MiB`);
			else if (!isJson(bytes)) problems.push(`${file}: not JSON`);
			else files.push(file);
		}
	}
	return { files, problems };
}

function isJson(bytes: Buffer): boolean {
	try {
		JSON.parse(bytes.toString("utf8"));
		return true;
	} catch {
		return false;
	}
}

export function checkEvidenceStep(
	root: string,
	env: NodeJS.ProcessEnv,
	log: (line: string) => void,
): number {
	const { files, problems } = checkEvidence(root);
	const mark = env.GITHUB_ACTIONS === "true" ? "::error::" : "";
	for (const problem of problems) log(`${mark}spikes-run: ${problem}`);
	log(`spikes-run: ${files.length} evidence file(s)${files.map((file) => `\n  ${file}`).join("")}`);
	const list = files.map((file) => `- ${file}`).join("\n") || "none";
	appendSummary(`### Evidence\n\n${list}`, env.GITHUB_STEP_SUMMARY);
	return problems.length > 0 ? 1 : 0;
}

export interface Cli {
	readonly mode: "run" | "plan" | "check-evidence";
	readonly spikes: readonly string[];
	readonly os: readonly string[];
	readonly node: string;
	// Heavy test files of the one spike to run instead of all of them.
	readonly tests: readonly string[];
	readonly dryRun: boolean;
	// The owner's OK to run although this month's billed minutes reach prChecksOnlyFrom.
	readonly yes: boolean;
}

const cliOptions = {
	spikes: { type: "string" },
	os: { type: "string" },
	node: { type: "string" },
	tests: { type: "string" },
	"dry-run": { type: "boolean" },
	yes: { type: "boolean" },
	plan: { type: "boolean" },
	"check-evidence": { type: "boolean" },
} as const;

function tokens(argv: readonly string[]) {
	try {
		const args = argv[0] === "--" ? argv.slice(1) : [...argv];
		return parseArgs({ args, options: cliOptions, allowPositionals: true, tokens: true });
	} catch (error) {
		throw new UsageError(`${message(error)}\n${usage}`);
	}
}

// Lists split on commas and spaces; PowerShell passes an unquoted kit,s01 as two arguments, so a
// bare argument continues the list before it. A leading `--` (pnpm from bash or cmd) is ignored.
export function parseCli(argv: readonly string[]): Cli {
	const parsed = tokens(argv);
	const lists: Record<string, string[]> = { spikes: [], os: [], tests: [] };
	let list: string[] | undefined;
	for (const token of parsed.tokens) {
		if (token.kind === "option") list = lists[token.name];
		const value =
			token.kind === "positional" ? token.value : token.kind === "option" && token.value;
		if (token.kind === "positional" && !list) throw new UsageError(`unexpected ${value}\n${usage}`);
		if (list && typeof value === "string") list.push(...split(value));
	}
	const { values } = parsed;
	const mode = values.plan ? "plan" : values["check-evidence"] ? "check-evidence" : "run";
	const [spikes = [], os = [], tests = []] = [lists.spikes, lists.os, lists.tests];
	if (mode === "run" && (spikes.length === 0 || os.length === 0)) {
		throw new UsageError(`--spikes and --os are required\n${usage}`);
	}
	// An empty --tests (an unset variable, say) would otherwise run the whole heavy tier.
	if (values.tests !== undefined && tests.length === 0) {
		throw new UsageError(`--tests names no test file\n${usage}`);
	}
	const [dryRun, yes] = [values["dry-run"] === true, values.yes === true];
	return { mode, spikes, os, node: values.node ?? "both", tests, dryRun, yes };
}

export function stamp(date: Date): string {
	return date
		.toISOString()
		.replace(/[-:]/g, "")
		.replace(/\.\d+Z$/, "Z");
}

export function refPart(branch: string): string {
	const clean = branch
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/\.{2,}/g, ".")
		.replace(/^[.-]+|[.-]+$/g, "");
	return clean.slice(0, 80) || "head";
}

export function githubRepo(url: string): string {
	const match = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url.trim());
	if (!match) throw new Error(`origin (${url.trim()}) isn't a GitHub repository`);
	return `${match[1]}/${match[2]}`;
}

export const artifactName = (job: Entry): string => `evidence_${job.spike}_${job.os}`;

// HEAD's tree plus spikes/run.json, built in a temporary index: the item branch, the index and the
// working tree stay as they are.
export function throwawayCommit(git: Run, head: string, runJson: string, title: string): string {
	const scratch = mkdtempSync(path.join(tmpdir(), "draftyak-spikes-run-index-"));
	try {
		const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
		const blob = ok(git(["hash-object", "-w", "--stdin"], { input: runJson }), "git hash-object");
		ok(git(["read-tree", head], { env }), "git read-tree");
		const info = `100644,${blob.trim()},${runFile}`;
		ok(git(["update-index", "--add", "--cacheinfo", info], { env }), "git update-index");
		const tree = ok(git(["write-tree"], { env }), "git write-tree").trim();
		return ok(git(["commit-tree", tree, "-p", head, "-m", title]), "git commit-tree").trim();
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

export interface Signals {
	on(handler: (signal: string) => void): () => void;
}

export interface Deps {
	readonly root: string;
	readonly git: Run;
	readonly gh: Run;
	// gh without blocking, so that this month's jobs are listed several runs at a time.
	readonly ghAsync: (args: readonly string[]) => Promise<Proc>;
	// gh with the terminal attached (gh run watch); resolves to its exit code.
	readonly watch: (args: readonly string[]) => Promise<number>;
	readonly signals: Signals;
	readonly now: () => Date;
	readonly wait: (ms: number) => Promise<void>;
	readonly log: (line: string) => void;
}

interface Incoming {
	readonly target: string;
	readonly os: string;
	readonly bytes: Buffer;
}

// An artifact holds <spike>/evidence/<name>.json (upload-artifact keeps the path after spikes/*).
function readArtifact(dir: string, job: Entry, problems: string[]): Incoming[] {
	const found: Incoming[] = [];
	const walk = (folder: string): void => {
		for (const item of readdirSync(folder, { withFileTypes: true })) {
			const full = path.join(folder, item.name);
			const rel = path.relative(dir, full).split(path.sep).join("/");
			if (item.isDirectory()) {
				walk(full);
				continue;
			}
			const [spike, evidence, name = "", ...deeper] = rel.split("/");
			const expected = spike === job.spike && evidence === "evidence" && deeper.length === 0;
			const bytes = item.isFile() && expected && valid.evidence.test(name) && readFileSync(full);
			if (!bytes || bytes.length > maxEvidenceBytes || !isJson(bytes)) {
				problems.push(`${artifactName(job)}: unexpected ${rel}`);
			} else found.push({ target: `spikes/${rel}`, os: job.os, bytes });
		}
	};
	if (existsSync(dir)) walk(dir);
	return found;
}

// Jobs that wrote different files under one name keep each as <name>.<runner>.json.
export function resolveConflicts(incoming: readonly Incoming[]): Map<string, Buffer> {
	const files = new Map<string, Buffer>();
	for (const [target, versions] of Map.groupBy(incoming, (file) => file.target)) {
		const [first] = versions;
		if (first && versions.every((version) => version.bytes.equals(first.bytes))) {
			files.set(target, first.bytes);
		} else {
			for (const version of versions) {
				files.set(target.replace(/\.json$/, `.${version.os}.json`), version.bytes);
			}
		}
	}
	return files;
}

function put(file: string, bytes: Buffer): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, bytes);
}

// Shows what changes, keeps uncommitted local versions under .cache/spikes-run/<run>/replaced/,
// then writes the evidence into spikes/<id>/evidence/.
function applyEvidence(
	files: Map<string, Buffer>,
	deps: Deps,
	runId: string,
	scratch: string,
): void {
	const { root, git, log } = deps;
	const status = git(["status", "--porcelain", "-z", "--untracked-files=all", "--", "spikes"]);
	const uncommitted = new Set(
		ok(status, "git status")
			.split("\0")
			.map((line) => line.slice(3)),
	);
	const [before, after] = ["working-tree", `run-${runId}`];
	const changed: string[] = [];
	for (const target of [...files.keys()].sort()) {
		const file = path.join(root, target);
		const current = existsSync(file) ? readFileSync(file) : undefined;
		const bytes = files.get(target) ?? Buffer.alloc(0);
		const state = !current ? "new" : current.equals(bytes) ? "unchanged" : "changed";
		log(`  ${state.padEnd(9)} ${target}`);
		if (state === "unchanged") continue;
		changed.push(target);
		if (current) put(path.join(scratch, before, target), current);
		put(path.join(scratch, after, target), bytes);
	}
	if (changed.length === 0) return;
	mkdirSync(path.join(scratch, before), { recursive: true });
	const diff = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "diff", "--no-index"];
	const options = ["--no-color", "--no-prefix", "--patch-with-stat", "--", before, after];
	const shown = git([...diff, ...options], { cwd: scratch });
	log(shown.code > 1 ? `spikes-run: no diff (${lastLine(shown.stderr)})` : shown.stdout.trimEnd());
	const kept = path.join(".cache", "spikes-run", runId, "replaced");
	for (const target of changed) {
		const file = path.join(root, target);
		if (uncommitted.has(target) && existsSync(file)) {
			put(path.join(root, kept, target), readFileSync(file));
			log(`spikes-run: kept your uncommitted ${target} in ${kept.split(path.sep).join("/")}/`);
		}
		put(file, files.get(target) ?? Buffer.alloc(0));
	}
	log(
		`spikes-run: wrote ${changed.length} evidence file(s); review them with git status and git diff`,
	);
}

// Downloads each job's artifact, refuses anything but its spike's evidence, then applies it.
function collectEvidence(deps: Deps, repo: string, runId: string, plan: Plan): boolean {
	const { gh, log } = deps;
	const query = ".artifacts[] | select(.expired | not) | .name";
	const listed = gh([
		"api",
		"--paginate",
		`repos/${repo}/actions/runs/${runId}/artifacts`,
		"--jq",
		query,
	]);
	const names = new Set(split(ok(listed, "gh api artifacts")));
	const scratch = mkdtempSync(path.join(tmpdir(), "draftyak-spikes-run-"));
	try {
		const problems: string[] = [];
		const incoming: Incoming[] = [];
		for (const job of plan.entries) {
			const name = artifactName(job);
			if (!names.has(name)) {
				log(`spikes-run: no evidence from ${job.spike} on ${job.os}`);
				continue;
			}
			const dir = path.join(scratch, "artifacts", name);
			ok(gh(["run", "download", runId, "--repo", repo, "--name", name, "--dir", dir]), name);
			incoming.push(...readArtifact(dir, job, problems));
		}
		for (const problem of problems) log(`spikes-run: ${problem}`);
		if (problems.length > 0) {
			log(
				`spikes-run: nothing written; the run keeps its artifacts for 7 days (gh run download ${runId})`,
			);
			return false;
		}
		if (incoming.length > 0) applyEvidence(resolveConflicts(incoming), deps, runId, scratch);
		return true;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

const jsonLines = <T>(text: string): T[] =>
	text
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as T);

function billedMinutes(gh: Run, repo: string, runId: string): string {
	const endpoint = `repos/${repo}/actions/runs/${runId}/jobs?per_page=100&filter=latest`;
	const result = gh(["api", "--paginate", endpoint, "--jq", jobQuery]);
	if (result.code !== 0) return `spikes-run: billed minutes unknown (${lastLine(result.stderr)})`;
	const { minutes, billed } = tally(jsonLines<Job>(result.stdout));
	return `spikes-run: ${billed} billed minutes (linux ${minutes.linux}, windows ${minutes.windows} x2, macos ${minutes.macos} x10); pnpm ci:minutes has the month`;
}

// This month's billed minutes, counted as pnpm ci:minutes counts them (M0.3), eight runs at a time.
async function billedThisMonth(deps: Deps, repo: string): Promise<number> {
	const created = monthRange(deps.now().toISOString().slice(0, 7));
	const runs = `repos/${repo}/actions/runs?per_page=100&created=${created}`;
	const listed = await deps.ghAsync(["api", "--paginate", runs, "--jq", ".workflow_runs[].id"]);
	const ids = split(ok(listed, "gh api runs"));
	const jobs: Job[] = [];
	const worker = async (): Promise<void> => {
		for (let id = ids.pop(); id !== undefined; id = ids.pop()) {
			const endpoint = `repos/${repo}/actions/runs/${id}/jobs?per_page=100&filter=all`;
			const result = await deps.ghAsync(["api", "--paginate", endpoint, "--jq", jobQuery]);
			jobs.push(...jsonLines<Job>(ok(result, "gh api jobs")));
		}
	};
	await Promise.all(Array.from({ length: 8 }, worker));
	return tally(jobs).billed;
}

// At prChecksOnlyFrom billed minutes a month, spikes runs wait for the next month or the owner's OK
// (--yes); this run's worst case counts as spent.
async function withinBudget(deps: Deps, repo: string, plan: Plan, yes: boolean): Promise<boolean> {
	deps.log("spikes-run: counting this month's billed minutes, as pnpm ci:minutes does");
	let used: number;
	try {
		used = await billedThisMonth(deps, repo);
	} catch (error) {
		if (!yes) throw new Error(`${message(error)}; with the owner's OK, --yes skips this check`);
		deps.log(`spikes-run: --yes: this month's billed minutes are unknown (${message(error)})`);
		return true;
	}
	const total = used + worstCase(plan);
	deps.log(`spikes-run: ${used} billed minutes this month; at most ${total} after this run`);
	if (total < prChecksOnlyFrom) return true;
	const limit = `that reaches ${prChecksOnlyFrom}, where spikes runs wait for next month or the owner's OK`;
	deps.log(
		`spikes-run: ${limit}${yes ? "; going ahead with it (--yes)" : "; with that OK, add --yes"}`,
	);
	return yes;
}

// Before anything is pushed: gh must be installed, signed in and able to read the repository.
function checkGh(gh: Run, repo: string): void {
	let result: Proc;
	try {
		result = gh(["api", `repos/${repo}`, "--jq", ".full_name"]);
	} catch (error) {
		throw new Error(`gh isn't available (${message(error)}): install it and run gh auth login`);
	}
	if (result.code !== 0) {
		const why = lastLine(result.stderr) || `exit code ${result.code}`;
		throw new Error(`gh can't read ${repo} (${why}): run gh auth login with access to it`);
	}
}

// What the pushed run leaves out: uncommitted and untracked files, except evidence.
function warnUncommitted(git: Run, log: (line: string) => void): void {
	const args = ["status", "--porcelain", "--untracked-files=normal", "--", "."];
	const status = git([...args, ":(exclude)spikes/*/evidence/*"]);
	const changes = ok(status, "git status").split("\n").filter(Boolean);
	if (changes.length === 0) return;
	const listed = changes.slice(0, 5).map((line) => `\n  ${line}`);
	const more = changes.length > 5 ? `\n  and ${changes.length - 5} more` : "";
	log(
		`spikes-run: the run tests HEAD, without these uncommitted changes:${listed.join("")}${more}`,
	);
}

function lookupRun(gh: Run, repo: string, commit: string): string | undefined {
	const args = ["run", "list", "--repo", repo, "--commit", commit, "--event", "push"];
	const listed = ok(gh([...args, "--json", "databaseId,headSha", "--limit", "20"]), "gh run list");
	const runs = JSON.parse(listed) as { databaseId: number; headSha: string }[];
	const run = runs.find((candidate) => candidate.headSha === commit);
	return run ? String(run.databaseId) : undefined;
}

function viewRun(gh: Run, repo: string, runId: string): Record<string, string> {
	const view = gh(["run", "view", runId, "--repo", repo, "--json", "status,conclusion,url"]);
	return JSON.parse(ok(view, "gh run view")) as Record<string, string>;
}

// Calls `probe` until it returns a value, at most `tries` times, `ms` apart; a gh failure is
// retried, but ten in a row end the wait.
async function poll<T>(
	deps: Deps,
	checkpoint: () => Promise<void>,
	[ms, tries]: readonly [number, number],
	probe: () => T | undefined,
	timedOut: string,
): Promise<T> {
	let failures = 0;
	for (let attempt = 1; ; attempt++) {
		await checkpoint();
		try {
			const found = probe();
			if (found !== undefined) return found;
			failures = 0;
		} catch (error) {
			failures++;
			if (failures === 10 || attempt === tries) throw error;
		}
		if (attempt === tries) throw new Error(timedOut);
		await deps.wait(ms);
	}
}

function deleteBranch(git: Run, ref: string, log: (line: string) => void): boolean {
	const result = git(["push", "--no-follow-tags", "origin", "--delete", `refs/heads/${ref}`]);
	if (result.code === 0 || /remote ref does not exist/.test(result.stderr)) {
		log(`spikes-run: deleted ${ref}`);
		return true;
	}
	log(`spikes-run: couldn't delete ${ref} (${lastLine(result.stderr)})`);
	log(`spikes-run: delete it with: git push origin --delete ${ref}`);
	return false;
}

// The local CLI: validate, check gh and the month's minutes, push the throwaway commit, follow the
// run, collect the evidence, and delete the branch whatever happens. A run that nobody follows any
// more, after a signal or an error, is cancelled.
export async function runOnGitHub(cli: Cli, deps: Deps): Promise<number> {
	const { git, gh, log } = deps;
	const tree = gitTree(git, "HEAD");
	const fields = { spikes: cli.spikes, os: cli.os, node: cli.node };
	let plan: Plan;
	try {
		plan = planRun(cli.tests.length > 0 ? { ...fields, tests: cli.tests } : fields, tree);
	} catch (error) {
		if (!(error instanceof PlanError)) throw error;
		for (const problem of error.problems) log(`spikes-run: ${problem}`);
		return 1;
	}
	for (const line of describePlan(plan)) log(line);
	if (tree.read(workflowFile) === undefined) {
		throw new Error(`HEAD has no ${workflowFile}: rebase onto m0 first`);
	}
	const head = ok(git(["rev-parse", "--verify", "HEAD^{commit}"]), "git rev-parse").trim();
	const branch = ok(git(["rev-parse", "--abbrev-ref", "HEAD"]), "git rev-parse").trim();
	const name = branch === "HEAD" ? `detached-${head.slice(0, 8)}` : branch;
	const ref = `spikes-run/${refPart(name)}-${stamp(deps.now())}`;
	// "tests" only for a partial run, so a full run's spikes/run.json stays as it always was.
	const request = { spikes: plan.spikes, os: plan.os, node: plan.node };
	const runFields = plan.tests.length > 0 ? { ...request, tests: plan.tests } : request;
	const runJson = `${JSON.stringify(runFields, null, 2)}\n`;
	if (cli.dryRun) {
		log(`spikes-run: dry run; would push HEAD plus this ${runFile} to ${ref}:\n${runJson}`);
		return 0;
	}
	const url = git(["config", "--get", "remote.origin.url"]);
	if (url.code !== 0) throw new Error("this repository has no origin remote");
	const repo = githubRepo(url.stdout);
	checkGh(gh, repo);
	if (!(await withinBudget(deps, repo, plan, cli.yes))) return 1;
	warnUncommitted(git, log);
	const title = `ci(spikes-run): ${plan.spikes.join(", ")} on ${plan.os.join(", ")}, node ${plan.node}${onlyTests(plan, ", ")}`;
	const commit = throwawayCommit(git, head, runJson, title);

	let signal: string | undefined;
	const stop = deps.signals.on((received) => {
		if (signal) return;
		signal = received;
		log(`spikes-run: ${received}: cancelling the run and deleting ${ref}`);
	});
	const checkpoint = async (): Promise<void> => {
		await new Promise((resolve) => setImmediate(resolve));
		if (signal) throw new Interrupted(signal);
	};
	let pushed = false;
	let runId: string | undefined;
	let completed = false;
	let outcome: number | Error;
	try {
		const push = git(["push", "--no-follow-tags", "origin", `${commit}:refs/heads/${ref}`]);
		// A push stopped halfway can still have created the branch.
		const listed = (): boolean =>
			git(["ls-remote", "--exit-code", "origin", `refs/heads/${ref}`]).code === 0;
		pushed = push.code === 0 || listed();
		ok(push, "git push");
		log(`spikes-run: pushed ${commit.slice(0, 12)} (HEAD plus ${runFile}) to ${ref}`);
		const found = () => lookupRun(gh, repo, commit);
		const id = await poll(
			deps,
			checkpoint,
			[3_000, 40],
			found,
			"no spikes.yml run within 2 minutes",
		);
		runId = id;
		log(`spikes-run: following run ${id}; Ctrl+C cancels it`);
		const watch = ["run", "watch", id, "--repo", repo, "--exit-status", "--compact"];
		await deps.watch([...watch, "--interval", "10"]);
		// gh run watch can stop early (a fine-grained token, the network): then poll until it ends.
		const minutes = Math.max(...plan.entries.map((job) => job.timeout)) + 30;
		let noted = false;
		const ended = (): Record<string, string> | undefined => {
			const view = viewRun(gh, repo, id);
			if (view.status === "completed") return view;
			if (!noted) log(`spikes-run: run ${id} is ${view.status}; checking it every 15 s`);
			noted = true;
			return undefined;
		};
		const late = `run ${id} hasn't finished within ${minutes} minutes`;
		const run = await poll(deps, checkpoint, [15_000, minutes * 4], ended, late);
		completed = true;
		log(`spikes-run: run ${id}: ${run.conclusion} (${run.url})`);
		if (plan.tests.length > 0) {
			log(
				`spikes-run: it ran ${onlyTests(plan, "")}; the spike's other evidence files stay as they are`,
			);
		}
		log(billedMinutes(gh, repo, id));
		pushed = !deleteBranch(git, ref, log);
		const written = collectEvidence(deps, repo, id, plan);
		outcome = run.conclusion === "success" && written && !pushed ? 0 : 1;
	} catch (error) {
		outcome = error instanceof Error ? error : new Error(String(error));
	}
	try {
		// A Ctrl+C that stopped a git or gh call reaches the handler once the event loop runs again.
		await sleep(100);
		if (signal && outcome instanceof Error) outcome = new Interrupted(signal);
		if (pushed && !completed) await stopRun(deps, repo, commit, runId);
		if (outcome instanceof Interrupted) outcome = 130;
		if (pushed && !deleteBranch(git, ref, log) && outcome === 0) outcome = 1;
	} finally {
		stop();
	}
	if (outcome instanceof Error) throw outcome;
	return outcome;
}

// Cleanup after a signal or an error: cancel the run if it can be found, else say how to find it.
// Best effort, so the branch is deleted whatever happens here.
async function stopRun(deps: Deps, repo: string, commit: string, runId?: string): Promise<void> {
	let id = runId;
	for (let attempt = 1; id === undefined && attempt <= 4; attempt++) {
		if (attempt > 1) await deps.wait(3_000);
		try {
			id = lookupRun(deps.gh, repo, commit);
		} catch {}
	}
	let cancelled = false;
	try {
		cancelled = id !== undefined && deps.gh(["run", "cancel", id, "--repo", repo]).code === 0;
	} catch {}
	if (cancelled) return deps.log(`spikes-run: cancelled run ${id}`);
	const which = id === undefined ? `for ${commit.slice(0, 12)}` : id;
	deps.log(`spikes-run: couldn't cancel the spikes.yml run ${which}; it may still be running`);
	deps.log(
		`spikes-run: find it with gh run list --repo ${repo} --commit ${commit}, then gh run cancel <id> --repo ${repo}`,
	);
}

const repoVariables = /^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|PREFIX)$/i;

const processEnv = (): NodeJS.ProcessEnv =>
	Object.fromEntries(Object.entries(process.env).filter(([name]) => !repoVariables.test(name)));

// Native executables without a shell; git's repository variables from hooks or `rebase -x` dropped.
function processRun(command: string, root: string): Run {
	const env = processEnv();
	return (args, options = {}) => {
		const result = spawnSync(command, [...args], {
			cwd: options.cwd ?? root,
			input: options.input,
			env: { ...env, ...options.env },
			encoding: "utf8",
			maxBuffer: 256 * 1024 * 1024,
			windowsHide: true,
		});
		if (result.error) throw result.error;
		return { code: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
	};
}

function processRunAsync(command: string, root: string): Deps["ghAsync"] {
	const options = { cwd: root, env: processEnv(), maxBuffer: 256 * 1024 * 1024, windowsHide: true };
	return (args) =>
		new Promise((resolve, reject) => {
			execFile(command, [...args], options, (error, stdout, stderr) => {
				if (error && typeof error.code !== "number") reject(error);
				else resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
			});
		});
}

const processSignals: Signals = {
	on(handler) {
		const names = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
		for (const name of names) process.on(name, handler);
		return () => {
			for (const name of names) process.off(name, handler);
		};
	},
};

if (import.meta.main) {
	const root = path.resolve(import.meta.dirname, "..", "..", "..");
	await runCli("spikes-run", () => {
		const cli = parseCli(process.argv.slice(2));
		const git = processRun("git", root);
		if (cli.mode === "plan") return planStep(gitTree(git, "HEAD"), process.env, console.log);
		if (cli.mode === "check-evidence") return checkEvidenceStep(root, process.env, console.log);
		const watch = (args: readonly string[]): Promise<number> =>
			new Promise((resolve, reject) => {
				spawn("gh", [...args], { cwd: root, stdio: "inherit" })
					.once("error", reject)
					.once("close", (code) => resolve(code ?? 1));
			});
		return runOnGitHub(cli, {
			root,
			git,
			gh: processRun("gh", root),
			ghAsync: processRunAsync("gh", root),
			watch,
			signals: processSignals,
			now: () => new Date(),
			wait: (ms) => sleep(ms),
			log: console.log,
		});
	});
}
