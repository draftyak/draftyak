import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HELPERS } from "../lib/bootstrap.ts";
import { INSTALL_STOP_LINE } from "../lib/hooks.ts";
import { capture } from "../lib/spawn.ts";
import { STOP_LINE } from "../reserved-tripwire.ts";
import {
	copyOwn,
	gitEnvOf,
	ownRepo,
	ownWorkspace,
	type TempRepo,
	tempRepo,
	word,
} from "./temp-repo.ts";

// The second checkout of the native workflows, followed step by step in each real workflow's order
// on synthetic checkouts. The trusted checkout runs the real gate and pre-install check, first on
// itself and then with --root on the source checked out at source/. The steps that need the hosted
// service or a macOS runner are fakes that record that they ran: the install runs each source
// manifest's install hooks, as pnpm would, and the native command reads its target file. A failed
// step ends the route as it ends the job, so a refused source never reaches pnpm, a hook or the
// target.
const workflows = [
	".github/workflows/native-store.yml",
	".github/workflows/native-supervisor.yml",
] as const;
const gate = "node tools/verify/gate.ts";
const preinstall = "node tools/verify/preinstall.ts";
const sourceGate = `${gate} --root source`;
const sourceCheck = `${preinstall} --root source`;
const install = "pnpm install --frozen-lockfile";
const native =
	/^node tools\/ci-checks\/src\/native-(?:store|supervisor)\.ts (admit|verify-source|run)$/;
const ENTRY = [
	...new Set([
		"tools/verify/gate.ts",
		"tools/verify/preinstall.ts",
		"tools/verify/lib/bootstrap.ts",
		...HELPERS.gate,
		...HELPERS.preinstall,
	]),
];
const TARGET = "tools/hooked/test/case.heavy.test.ts";
const MARKER = "tools/hooked/marker";
const HOOK_LINE = "pre-install check: 1 install hook script(s) in 1 manifest(s)";

interface Step {
	readonly uses: string | undefined;
	readonly run: string | undefined;
	readonly path: string | undefined;
	readonly directory: string | undefined;
}

// The steps of a workflow's one job whose commands each fit on one line, as these exact contracts'
// do; a block command stops the test rather than being read wrong.
function stepsOf(file: string): Step[] {
	const text = readFileSync(path.join(ownRepo, file), "utf8").replaceAll("\r\n", "\n");
	const marker = "\n    steps:\n";
	const at = text.indexOf(marker);
	if (at < 0 || text.indexOf(marker, at + 1) >= 0) throw new Error(`${file}: not one job's steps`);
	return text
		.slice(at + marker.length)
		.split(/\n(?= {6}- )/)
		.map((chunk) => {
			const key = (name: string, indent: number): string | undefined =>
				new RegExp(`^(?: {${indent - 2}}- | {${indent}})${name}: (.*)$`, "m").exec(chunk)?.[1];
			const run = key("run", 8);
			if (run === "|" || run === ">") throw new Error(`${file}: a block command`);
			return {
				uses: key("uses", 8)?.split("@")[0],
				run,
				path: key("path", 10),
				directory: key("working-directory", 8),
			};
		});
}

const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

function committed(files: Readonly<Record<string, string>>, entry = false): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	if (entry) copyOwn(repo, ENTRY);
	for (const [file, text] of Object.entries(files)) repo.write(file, text);
	repo.commit();
	return repo;
}

const manifest = (name: string, scripts?: Record<string, string>): string =>
	`${JSON.stringify({ name, private: true, type: "module", ...(scripts && { scripts }) })}\n`;
const TRUSTED = { "package.json": manifest("trusted"), "pnpm-workspace.yaml": ownWorkspace };
const SOURCE: Readonly<Record<string, string>> = {
	"package.json": manifest("source"),
	"pnpm-workspace.yaml": ownWorkspace,
	"tools/hooked/package.json": manifest("hooked", { test: "node -e 0" }),
	"tools/hooked/tsconfig.json": '{ "include": ["**/*.ts"] }\n',
	"tools/hooked/hook.mjs":
		'import { writeFileSync } from "node:fs";\nwriteFileSync("marker", "ran");\n',
	[TARGET]: "export {};\n",
};
// The same source with a postinstall hook in its one package.
const HOOKED = {
	...SOURCE,
	"tools/hooked/package.json": manifest("hooked", {
		test: "node -e 0",
		postinstall: "node hook.mjs",
	}),
};

interface Route {
	readonly ran: readonly string[];
	// The output of the last real check that ran.
	readonly lines: readonly string[];
	readonly hooked: boolean;
	readonly target: boolean;
}

// Follows `steps` on a fresh trusted checkout, with `origin` as the admitted source, and stops at
// the first step that fails. `plant` changes the source right after its checkout.
async function follow(
	steps: readonly Step[],
	origin: TempRepo,
	plant: (source: string) => void = () => {},
): Promise<Route> {
	const trusted = committed(TRUSTED, true);
	const env = gitEnvOf(trusted);
	const source = path.join(trusted.dir, "source");
	const ran: string[] = [];
	let lines: string[] = [];
	let target = false;
	const check = async (name: string, command: string): Promise<boolean> => {
		const [script = "", ...args] = command.split(" ").slice(1);
		const result = await capture(
			{ command: process.execPath, args: [path.join(trusted.dir, script), ...args] },
			{ cwd: trusted.dir, env },
		);
		ran.push(`${name} ${result.code}`);
		lines = result.stdout.split(/\r?\n/).filter(Boolean);
		return result.code === 0;
	};
	// As an install would: each manifest's install hooks, in its own folder.
	const hooks = (): void => {
		const folders = [
			".",
			...readdirSync(path.join(source, "tools")).map((name) => `tools/${name}`),
		];
		for (const folder of folders) {
			const file = path.join(source, folder, "package.json");
			if (!existsSync(file)) continue;
			const { scripts = {} } = JSON.parse(readFileSync(file, "utf8")) as {
				scripts?: Record<string, string>;
			};
			for (const hook of ["preinstall", "install", "postinstall"]) {
				const [node, ...args] = scripts[hook]?.split(" ") ?? [];
				if (node === undefined) continue;
				expect(node).toBe("node");
				const result = spawnSync(process.execPath, args, {
					cwd: path.join(source, folder),
					windowsHide: true,
				});
				expect(result.status, hook).toBe(0);
			}
		}
	};
	for (const step of steps) {
		if (step.uses === "actions/checkout" && step.path === undefined) ran.push("checkout");
		else if (step.uses === "actions/checkout" && step.path === "source") {
			const cloned = spawnSync("git", ["clone", "-q", "--no-hardlinks", origin.dir, source], {
				env,
				encoding: "utf8",
				windowsHide: true,
			});
			expect(cloned.status, cloned.stderr).toBe(0);
			plant(source);
			ran.push("source checkout");
		} else if (step.uses === "actions/setup-node") ran.push("setup-node");
		else if (step.uses === "pnpm/action-setup") ran.push("pnpm");
		else if (step.uses === "actions/upload-artifact") ran.push("upload");
		else if (step.run === gate) {
			if (!(await check("gate", step.run))) break;
		} else if (step.run === sourceGate) {
			if (!(await check("source gate", step.run))) break;
		} else if (step.run === sourceCheck) {
			if (!(await check("source check", step.run))) break;
		} else if (step.run === install && step.directory === "source") {
			hooks();
			ran.push("install");
		} else {
			const command = native.exec(step.run ?? "")?.[1];
			if (command === undefined) throw new Error(`no fake for the step ${JSON.stringify(step)}`);
			if (command === "run") {
				// The supervisor's command installs in the source itself; the store's runs after its
				// install step.
				if (!steps.some((other) => other.run === install)) hooks();
				readFileSync(path.join(source, TARGET), "utf8");
				target = true;
			}
			ran.push(command);
		}
	}
	return { ran, lines, hooked: existsSync(path.join(source, MARKER)), target };
}

// Count lines only: no path and no reserved word.
const neutral = (lines: readonly string[]): boolean =>
	lines.every((line) => !/[\\/]/.test(line) && !line.toLowerCase().includes(word()));

describe.each(workflows)("the admitted source route of %s", (file) => {
	const steps = stepsOf(file);
	const start = ["checkout", "setup-node", "gate 0", "admit", "source checkout", "verify-source"];
	const ownInstall = steps.some((step) => step.run === install);

	it("reaches the target on a clean source, after the trusted gate and both source checks", async () => {
		const route = await follow(steps, committed(SOURCE));
		expect(route.ran).toEqual([
			...start,
			"source gate 0",
			"source check 0",
			"pnpm",
			...(ownInstall ? ["install"] : []),
			"run",
			"upload",
		]);
		expect([route.hooked, route.target]).toEqual([false, true]);
	});

	it("stops at the source's pre-install check, before pnpm, any install hook or the target", async () => {
		const route = await follow(steps, committed(HOOKED));
		expect(route.ran).toEqual([...start, "source gate 0", "source check 1"]);
		expect(route.lines).toEqual([HOOK_LINE, INSTALL_STOP_LINE]);
		expect([route.hooked, route.target]).toEqual([false, false]);
	});

	it.each([
		[
			"a reserved-named path outside the allowed roots",
			() => committed({ ...HOOKED, [`tools/hooked/${word()}-notes.md`]: "notes\n" }),
			() => {},
		],
		[
			"a file tsc would read that git's listing leaves out",
			() => committed(HOOKED),
			(source: string) => {
				mkdirSync(path.join(source, ".git", "info"), { recursive: true });
				appendFileSync(path.join(source, ".git", "info", "exclude"), "tools/hooked/stray.ts\n");
				writeFileSync(path.join(source, "tools", "hooked", "stray.ts"), "export {};\n");
			},
		],
	])(
		"stops at the source gate on %s, before the pre-install check reads a manifest",
		async (_, origin, plant) => {
			const route = await follow(steps, origin(), plant);
			expect(route.ran).toEqual([...start, "source gate 1"]);
			expect(route.lines.at(-1)).toBe(STOP_LINE);
			expect(route.lines.every((line) => line.startsWith("reserved tripwire: "))).toBe(true);
			expect(neutral(route.lines)).toBe(true);
			expect([route.hooked, route.target]).toEqual([false, false]);
		},
	);

	// Mutation: the same workflow without the two source checks runs the hook and reads the target.
	it("runs the source's hook and reads the target once the two source checks are left out", async () => {
		const unchecked = steps.filter((step) => step.run !== sourceGate && step.run !== sourceCheck);
		expect(steps.length - unchecked.length).toBe(2);
		const route = await follow(unchecked, committed(HOOKED));
		expect(route.ran).toEqual([
			...start,
			"pnpm",
			...(ownInstall ? ["install"] : []),
			"run",
			"upload",
		]);
		expect([route.hooked, route.target]).toEqual([true, true]);
	});
});
