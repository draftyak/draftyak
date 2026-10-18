import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { cacheDir } from "../../../spikes/kit/repo.ts";
import { fromExitCode, type Profile, type Step, stepsFor } from "../lib/registry.ts";
import {
	dockerState,
	type Exec,
	fetchNodeArgs,
	inspectImage,
	label,
	nodeTargets,
	pinnedImages,
	tools,
	workspacePackages,
} from "../prefetch.ts";

export interface Check {
	readonly name: string;
	readonly state: "ok" | "missing" | "warn" | "n/a";
	readonly detail: string;
	readonly minutes?: number;
}

async function toolCheck(name: "uv" | "gpgv", exec: Exec, env: NodeJS.ProcessEnv): Promise<Check> {
	const file = tools[name](env);
	const where =
		name === "uv" ? "the WinGet folder or DRAFTYAK_UV" : "Git's usr/bin or DRAFTYAK_GPG";
	if (file === undefined)
		return { name, state: "missing", detail: `not found on PATH, in ${where}` };
	const { code, stdout } = await exec.capture(file, ["--version"]);
	const version = /\d+\.\d+\.\d+/.exec(stdout)?.[0];
	if (code !== 0 || version === undefined) {
		return { name, state: "missing", detail: `${file} --version failed (exit code ${code})` };
	}
	const pinned = name !== "uv" || version === "0.13.1";
	const detail = `${version} at ${file}${pinned ? "" : "; ADR 0001 pins 0.13.1"}`;
	return { name, state: pinned ? "ok" : "warn", detail };
}

// Where the packages that use Playwright 1.64 install and launch its browsers (each spike's
// prefetch.ts applies the same rule): PLAYWRIGHT_BROWSERS_PATH ("0": inside playwright-core), else
// <DRAFTYAK_CACHE_DIR>/playwright, never the user profile. A relative value is refused, since each
// tool would resolve it against its own working folder. One <name with _>-<revision>/
// INSTALLATION_COMPLETE per browser.
export function browsersDir(core: string, env: NodeJS.ProcessEnv): string {
	const configured = env.PLAYWRIGHT_BROWSERS_PATH;
	if (configured === "0") return path.join(core, ".local-browsers");
	if (configured && !path.isAbsolute(configured)) {
		throw new Error(`PLAYWRIGHT_BROWSERS_PATH must be absolute or 0, not ${configured}`);
	}
	return configured ? path.resolve(configured) : path.join(cacheDir(env), "playwright");
}

function missingBrowsers(
	dir: string,
	browsers: readonly { name: string; revision: string }[],
): string[] {
	return browsers
		.filter(({ name }) => ["chromium", "chromium-headless-shell", "webkit"].includes(name))
		.map(({ name, revision }) => `${name.replaceAll("-", "_")}-${revision}`)
		.filter((entry) => !existsSync(path.join(dir, entry, "INSTALLATION_COMPLETE")));
}

function browserCheck(root: string, env: NodeJS.ProcessEnv): Check {
	const name = "browsers";
	const uses = (deps: object | undefined): boolean => !!deps && "@playwright/test" in deps;
	const users = workspacePackages(root).filter(
		({ manifest }) => uses(manifest.dependencies) || uses(manifest.devDependencies),
	);
	if (users.length === 0) return { name, state: "n/a", detail: "no package uses Playwright yet" };
	const absent = users.flatMap(({ dir, manifest }) => {
		let core: string;
		try {
			const from = (file: string, id: string): string => createRequire(file).resolve(id);
			const runner = from(path.join(root, dir, "package.json"), "@playwright/test/package.json");
			core = path.dirname(
				from(from(runner, "playwright/package.json"), "playwright-core/package.json"),
			);
		} catch {
			return [`${manifest.name}: Playwright isn't installed (pnpm install)`];
		}
		const { browsers } = JSON.parse(readFileSync(path.join(core, "browsers.json"), "utf8"));
		const missing = missingBrowsers(browsersDir(core, env), browsers);
		return missing.length === 0 ? [] : [`${manifest.name}: ${missing.join(", ")}`];
	});
	if (absent.length === 0) return { name, state: "ok", detail: `installed for ${users.length}` };
	const detail = `${absent.join("; ")}; pnpm m0:prefetch installs them (about 3 min)`;
	return { name, state: "missing", detail };
}

// Node binaries through fetch-node's offline lookup and pinned images in Docker; cold ones download
// during the run unless pnpm m0:prefetch fetched them first.
async function cacheCheck(root: string, exec: Exec, docker: string | undefined): Promise<Check> {
	const targets = nodeTargets(root);
	const cold: string[] = [];
	for (const target of targets ?? []) {
		const args = fetchNodeArgs(root, target, "--offline", "--print-path");
		if ((await exec.capture(process.execPath, args)).code !== 0) cold.push(`Node ${label(target)}`);
	}
	const images = docker === undefined ? [] : await pinnedImages(root, exec);
	for (const image of images) {
		if ((await inspectImage(exec, docker ?? "docker", image)).code !== 0) cold.push(image);
	}
	if (cold.length > 0) {
		const detail = `not cached: ${cold.join(", ")}; pnpm m0:prefetch fetches them`;
		return { name: "caches", state: "warn", detail, minutes: 2 * cold.length };
	}
	const nodes = targets
		? `${targets.length} Node binaries`
		: "Node binaries once fetch-node lands (M0.5)";
	const detail = `${nodes}; ${docker ? `${images.length} pinned images` : "images need Docker"}`;
	return { name: "caches", state: targets || images.length > 0 ? "ok" : "n/a", detail };
}

// A probe that throws becomes its own row, so the table and the estimate always print.
async function guarded(
	name: string,
	state: Check["state"],
	probe: () => Check | Promise<Check>,
): Promise<Check> {
	try {
		return await probe();
	} catch (error) {
		return { name, state, detail: error instanceof Error ? error.message : String(error) };
	}
}

export async function checkPrerequisites(
	root: string,
	exec: Exec,
	env: NodeJS.ProcessEnv,
): Promise<Check[]> {
	const pinned = readFileSync(path.join(root, ".node-version"), "utf8").trim();
	const running = process.versions.node;
	let docker: string | undefined;
	return [
		running === pinned
			? { name: "node", state: "ok", detail: `${running}, as .node-version pins` }
			: { name: "node", state: "warn", detail: `${running} runs; .node-version pins ${pinned}` },
		await guarded("docker", "missing", async () => {
			const found = await dockerState(root, exec, env);
			docker = found.docker;
			return { name: "docker", state: docker ? "ok" : "missing", detail: found.detail };
		}),
		await guarded("uv", "missing", () => toolCheck("uv", exec, env)),
		await guarded("gpgv", "missing", () => toolCheck("gpgv", exec, env)),
		await guarded("browsers", "missing", () => browserCheck(root, env)),
		await guarded("caches", "warn", () => cacheCheck(root, exec, docker)),
	];
}

// The heavy step runs one suite at a time, so the minutes add up.
function estimate(root: string, checks: readonly Check[]): string {
	const downloads = checks.reduce((sum, check) => sum + (check.minutes ?? 0), 0);
	const heavy = workspacePackages(root).filter(({ manifest }) => manifest.scripts?.["test:heavy"]);
	const count = (folder: string): number =>
		heavy.filter(({ dir }) => dir.startsWith(`${folder}/`)).length;
	const spikeSuites = count("spikes");
	const toolSuites = count("tools");
	const parts = [
		"3 for the checks",
		`3 per spike with heavy tests (${spikeSuites})`,
		`1 per tool with heavy tests (${toolSuites})`,
	];
	if (downloads > 0) parts.push(`${downloads} of first-run downloads`);
	return `about ${3 + 3 * spikeSuites + toolSuites + downloads} min (${parts.join(", ")})`;
}

const progress = { ready: false };

const prerequisites: Step = {
	name: "prerequisites",
	order: 0,
	profiles: [],
	async run(ctx) {
		progress.ready = false;
		const checks = await checkPrerequisites(ctx.root, ctx, ctx.env);
		const width = Math.max(...checks.map((check) => check.name.length));
		console.log("verify:m0: prerequisites");
		for (const { state, name, detail } of checks) {
			console.log(`  ${state.padEnd(7)}  ${name.padEnd(width)}  ${detail}`);
		}
		console.log(`verify:m0: expected duration ${estimate(ctx.root, checks)}`);
		const missing = checks.filter((check) => check.state === "missing").map((check) => check.name);
		progress.ready = missing.length === 0;
		if (progress.ready) return { status: "passed" };
		console.log("verify:m0: the other steps are skipped; fix the missing prerequisites and rerun");
		return { status: "failed", reason: `missing ${missing.join(", ")}` };
	},
};

const heavy: Step = {
	name: "test:heavy",
	order: 45,
	profiles: [],
	async run(ctx) {
		// turbo refuses a path filter whose folder doesn't exist (no spikes/ before M0.6a lands).
		const filters = ["spikes", "tools"]
			.filter((dir) => existsSync(path.join(ctx.root, dir)))
			.map((dir) => `--filter=./${dir}/*`);
		const args = [
			"run",
			"test:heavy",
			...filters,
			// One suite at a time: benchmarks and budgets hold the kit's lock and need an idle machine.
			"--concurrency=1",
			"--continue=dependencies-successful",
		];
		return fromExitCode(await ctx.turbo(args, { env: { DRAFTYAK_STRICT_SKIPS: "1" } }));
	},
};

const gated = (step: Step): Step => ({
	...step,
	run: (ctx) =>
		progress.ready
			? step.run(ctx)
			: Promise.resolve({ status: "skipped", reason: "prerequisites missing" }),
});

export const profile: Profile = {
	name: "m0",
	description:
		"pnpm verify:m0: prerequisites and estimate, the default steps, heavy tests with strict skips, pnpm adr",
	select(steps) {
		const chosen = [...new Set([...stepsFor("default", steps), ...stepsFor("m0", steps), heavy])];
		const ordered = chosen.toSorted((a, b) => a.order - b.order || a.name.localeCompare(b.name));
		return [prerequisites, ...ordered.map(gated)];
	},
};
