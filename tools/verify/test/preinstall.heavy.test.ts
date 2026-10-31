import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { withoutReservedTests } from "../../../reserved-tests.ts";
import { HELPERS } from "../lib/bootstrap.ts";
import { capture, type Invocation } from "../lib/spawn.ts";
import { resolvePnpm, telemetryOff } from "../lib/tools.ts";
import { copyOwn, gitEnvOf, type TempRepo, tempRepo } from "./temp-repo.ts";

// The checked local install route, `node tools/verify/gate.ts && node tools/verify/preinstall.ts
// && pnpm install --frozen-lockfile`, with real pnpm, offline, in a synthetic workspace without
// dependencies. A workspace package's postinstall would leave a marker: the route stops before the
// install and leaves none, while the same install without the checks runs the hook.
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const { packageManager } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
	packageManager: string;
};
const ENTRY = [
	...new Set([
		"tools/verify/gate.ts",
		"tools/verify/preinstall.ts",
		"tools/verify/lib/bootstrap.ts",
		...HELPERS.gate,
		...HELPERS.preinstall,
	]),
];
const MARKER = "tools/hooked/marker";

const repos: TempRepo[] = [];
afterEach(() => {
	for (const repo of repos.splice(0)) repo.remove();
});

function workspace(hook: boolean): TempRepo {
	const repo = tempRepo();
	repos.push(repo);
	copyOwn(repo, [...ENTRY, "pnpm-workspace.yaml"]);
	repo.write(
		"package.json",
		`${JSON.stringify({ name: "route-probe", private: true, type: "module", packageManager })}\n`,
	);
	const scripts = hook
		? { test: "node -e 0", postinstall: "node hook.mjs" }
		: { test: "node -e 0" };
	repo.write("tools/hooked/package.json", `${JSON.stringify({ name: "hooked", scripts })}\n`);
	repo.write(
		"tools/hooked/hook.mjs",
		'import { writeFileSync } from "node:fs";\nwriteFileSync("marker", "ran");\n',
	);
	repo.write(".gitignore", "node_modules/\nmarker\n");
	repo.commit();
	return repo;
}

// This process's env without the flag or an outer turbo's or pnpm's task variables.
const env = (repo: TempRepo): NodeJS.ProcessEnv => {
	const kept = Object.entries({ ...process.env, ...withoutReservedTests(process.env) }).filter(
		([name]) => !/^(?:TURBO_|npm_|PNPM_SCRIPT|VITEST)/i.test(name),
	);
	return { ...Object.fromEntries(kept), ...gitEnvOf(repo), ...telemetryOff };
};

async function step(repo: TempRepo, invocation: Invocation) {
	const result = await capture(invocation, { cwd: repo.dir, env: env(repo) });
	return { code: result.code, output: `${result.stdout}\n${result.stderr}` };
}

const pnpm = resolvePnpm(process.env);
const withArgs = (...args: string[]): Invocation => ({
	command: pnpm.command,
	args: [...pnpm.args, ...args],
});
const node = (rel: string): Invocation => ({
	command: process.execPath,
	args: [path.join("tools", "verify", rel)],
});

// The route as bash and cmd run it: each command only after the one before it passed.
async function route(repo: TempRepo, install: Invocation) {
	const ran: string[] = [];
	for (const [name, invocation] of [
		["gate", node("gate.ts")],
		["pre-install check", node("preinstall.ts")],
		["install", install],
	] as const) {
		const { code, output } = await step(repo, invocation);
		ran.push(`${name} ${code}`);
		if (code !== 0) return { ran, output };
	}
	return { ran, output: "" };
}

describe("the checked local install route", () => {
	it("stops before an install that would run a workspace package's postinstall", async () => {
		const repo = workspace(true);
		const lock = await step(
			repo,
			withArgs("install", "--lockfile-only", "--ignore-scripts", "--offline"),
		);
		expect(lock.code, lock.output).toBe(0);
		const install = withArgs("install", "--frozen-lockfile", "--offline");
		const stopped = await route(repo, install);
		expect(stopped.ran).toEqual(["gate 0", "pre-install check 1"]);
		expect(stopped.output).toContain(
			"pre-install check: 1 install hook script(s) in 1 manifest(s)",
		);
		expect(existsSync(path.join(repo.dir, MARKER))).toBe(false);
		expect(existsSync(path.join(repo.dir, "node_modules"))).toBe(false);

		// Mutation: the same install without the checks runs the hook.
		const unchecked = await step(repo, install);
		expect(unchecked.code, unchecked.output).toBe(0);
		expect(existsSync(path.join(repo.dir, MARKER))).toBe(true);
	}, 240_000);

	it("installs a workspace with no hook", async () => {
		const repo = workspace(false);
		const lock = await step(
			repo,
			withArgs("install", "--lockfile-only", "--ignore-scripts", "--offline"),
		);
		expect(lock.code, lock.output).toBe(0);
		const passed = await route(repo, withArgs("install", "--frozen-lockfile", "--offline"));
		expect(passed.ran).toEqual(["gate 0", "pre-install check 0", "install 0"]);
		expect(existsSync(path.join(repo.dir, "node_modules"))).toBe(true);
		expect(existsSync(path.join(repo.dir, MARKER))).toBe(false);
	}, 240_000);
});
