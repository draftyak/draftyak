import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadSteps, type StepContext } from "../lib/registry.ts";
import { type Captured, capture } from "../lib/spawn.ts";
import {
	bounded,
	type Exec,
	imageRefs,
	label,
	type NodeTarget,
	nodeTargets,
	prefetch,
} from "../prefetch.ts";
import { checkPrerequisites, profile } from "../profiles/m0.ts";

const here = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(tmpdir(), "draftyak-m0-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const exe = process.platform === "win32" ? ".exe" : "";
const node = path.basename(process.execPath);

function write(file: string, text = ""): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}

let roots = 0;
function fakeRoot(files: Record<string, string> = {}): string {
	const root = path.join(tmp, `root-${++roots}`);
	const all = {
		".node-version": process.versions.node,
		"pnpm-workspace.yaml": "packages:\n  - spikes/*\n  - tools/*\n\nengineStrict: true\n",
		...files,
	};
	for (const [file, text] of Object.entries(all)) write(path.join(root, file), text);
	return root;
}

// Records run() calls with absolute paths shortened. capture() answers by command name, looking
// through bounded() to the docker command it wraps.
type Answer = (name: string, args: readonly string[]) => Partial<Captured>;
function fakeExec(answer: Answer = () => ({})): { exec: Exec; calls: string[] } {
	const calls: string[] = [];
	const short = (arg: string): string => (path.isAbsolute(arg) ? path.basename(arg) : arg);
	const exec: Exec = {
		run: async (command, args, options) => {
			calls.push([command, ...args].map(short).concat(`@${options?.cwd}`).join(" "));
			return 0;
		},
		capture: async (command, args) => {
			const wrapped = args[1] === "-e" && args[0] === "--input-type=module";
			const name = path.parse(wrapped ? (args[4] ?? "") : command).name;
			const inner = wrapped ? args.slice(5) : args;
			return { code: name === "git" ? 0 : 1, stdout: "", stderr: "", ...answer(name, inner) };
		},
	};
	return { exec, calls };
}

async function quietly<T>(work: () => Promise<T>): Promise<{ result: T; output: string }> {
	const lines: string[] = [];
	const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error")];
	for (const spy of spies) spy.mockImplementation((...parts) => lines.push(parts.join(" ")));
	try {
		return { result: await work(), output: lines.join("\n") };
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
}

const never = async (): Promise<number> => 1;
const context = (root: string, env: NodeJS.ProcessEnv, exec: Exec): StepContext => ({
	root,
	env,
	profile: "m0",
	node: never,
	pnpm: never,
	turbo: never,
	biome: never,
	...exec,
});

// docker, uvx and gpgv as empty files in a fresh folder, for find() to pick up from PATH.
function fakeBin(name: string): string {
	const bin = path.join(tmp, name);
	for (const tool of ["docker", "uvx", "gpgv"]) write(path.join(bin, `${tool}${exe}`));
	return bin;
}

const versions: Record<string, string> = {
	docker: "29.4.0",
	uvx: "uvx 0.13.1 (62f)",
	gpgv: "2.4.9",
};

describe("verify:m0", () => {
	it("checks prerequisites first, then the default steps, heavy tests after build, then adr", async () => {
		const steps = profile.select(await loadSteps(path.join(here, "steps")));
		const known = ["prerequisites", "lint", "typecheck", "test", "build", "test:heavy", "adr"];
		expect(steps.map((step) => step.name).filter((name) => known.includes(name))).toEqual(known);
		expect(steps[0]?.name).toBe("prerequisites");
	});

	it("names each missing tool, prints the expected duration and skips every later step", async () => {
		const steps = profile.select(await loadSteps(path.join(here, "steps")));
		const ctx = context(fakeRoot(), {}, fakeExec().exec);
		const { result, output } = await quietly(async () => {
			const outcomes = [];
			for (const step of steps) outcomes.push(await step.run(ctx));
			return outcomes;
		});
		expect(result[0]).toEqual({ status: "failed", reason: "missing docker, uv, gpgv" });
		expect(new Set(result.slice(1).map((outcome) => outcome.status))).toEqual(new Set(["skipped"]));
		expect(output).toMatch(/missing +docker +docker not found: install Docker Desktop/);
		expect(output).toMatch(/missing +uv +not found on PATH, in the WinGet folder or DRAFTYAK_UV/);
		expect(output).toMatch(/missing +gpgv +not found on PATH, in Git's usr\/bin or DRAFTYAK_GPG/);
		expect(output).toMatch(/n\/a +caches +Node binaries once fetch-node lands \(M0\.5\)/);
		expect(output).toContain("verify:m0: expected duration about 3 min");
	});

	it("passes when Docker answers and uv and gpgv are found, then runs heavy suites one at a time", async () => {
		const { exec } = fakeExec((name) => ({ code: 0, stdout: versions[name] ?? "" }));
		const heavy = JSON.stringify({ scripts: { "test:heavy": "vitest run --mode heavy" } });
		const root = fakeRoot({
			"spikes/s01-sqlite3mc/package.json": heavy,
			"spikes/s02-plugin-sandbox/package.json": "{}",
			"tools/verify/package.json": heavy,
		});
		const turbo: unknown[] = [];
		const ctx: StepContext = {
			...context(root, { PATH: fakeBin("bin-ok") }, exec),
			turbo: async (args, options) => {
				turbo.push({ args, options });
				return 0;
			},
		};
		const [prerequisites, heavyStep] = profile.select([]);
		const { result, output } = await quietly(async () => prerequisites?.run(ctx));
		expect(result).toEqual({ status: "passed" });
		expect(output).toMatch(/ok +docker +Docker 29\.4\.0\n +ok +uv +0\.13\.1 at /);
		expect(output).toContain(
			"expected duration about 7 min (3 for the checks, 3 per spike with heavy tests (1), 1 per tool with heavy tests (1))",
		);
		expect(await heavyStep?.run(ctx)).toEqual({ status: "passed" });
		const filters = "--filter=./spikes/* --filter=./tools/*";
		const args = `run test:heavy ${filters} --concurrency=1 --continue=dependencies-successful`;
		const options = { env: { DRAFTYAK_STRICT_SKIPS: "1" } };
		expect(turbo).toEqual([{ args: args.split(" "), options }]);
	});

	it("turns a probe that throws into its own row, and takes only files from overrides", async () => {
		const { exec } = fakeExec((name) => {
			if (name === "uvx" || name === "git") throw new Error(`spawn ${name} ENOENT`);
			return { code: 0, stdout: versions[name] ?? "" };
		});
		const bin = fakeBin("bin-throws");
		rmSync(path.join(bin, `gpgv${exe}`));
		const env = { PATH: bin, DRAFTYAK_GPG: tmp };
		const checks = await quietly(() => checkPrerequisites(fakeRoot(), exec, env));
		expect(checks.result.filter((check) => check.state !== "ok")).toEqual([
			{ name: "uv", state: "missing", detail: "spawn uvx ENOENT" },
			{
				name: "gpgv",
				state: "missing",
				detail: "not found on PATH, in Git's usr/bin or DRAFTYAK_GPG",
			},
			{ name: "browsers", state: "n/a", detail: "no package uses Playwright yet" },
			{ name: "caches", state: "warn", detail: "spawn git ENOENT" },
		]);
	});

	it("reports a Docker daemon that doesn't answer within 20 s as missing", async () => {
		const { exec } = fakeExec((name, args) =>
			name === "docker" && args[0] === "info" ? { code: 124 } : { code: 0 },
		);
		const env = { PATH: fakeBin("bin-hung") };
		const checks = await quietly(() => checkPrerequisites(fakeRoot(), exec, env));
		expect(checks.result.find((check) => check.name === "docker")).toEqual({
			name: "docker",
			state: "missing",
			detail: "docker info didn't answer within 20 s",
		});
	});

	it("kills a bounded command that hangs and exits 124", async () => {
		const [command, args] = bounded(200, process.execPath, ["-e", "setTimeout(() => {}, 60_000)"]);
		const started = performance.now();
		expect((await capture({ command, args })).code).toBe(124);
		expect(performance.now() - started).toBeLessThan(10_000);
	});

	it("requires the Playwright browsers of each package that uses Playwright", async () => {
		const spike = "spikes/s03-mcp-sdk";
		const modules = `${spike}/node_modules`;
		const name = "@draftyak/spike-s03-mcp-sdk";
		const manifest = { name, devDependencies: { "@playwright/test": "1.64.1" } };
		const files: Record<string, string> = { [`${spike}/package.json`]: JSON.stringify(manifest) };
		for (const pkg of ["@playwright/test", "playwright", "playwright-core"]) {
			files[`${modules}/${pkg}/package.json`] = JSON.stringify({ name: pkg });
		}
		const revisions = { chromium: "1248", "chromium-headless-shell": "1248", webkit: "2370" };
		const browsers = Object.entries({ ...revisions, firefox: "1555" }).map(([key, revision]) => ({
			name: key,
			revision,
		}));
		files[`${modules}/playwright-core/browsers.json`] = JSON.stringify({ browsers });
		const root = fakeRoot(files);
		const registry = path.join(tmp, "ms-playwright");
		const check = async () => {
			const env = { PLAYWRIGHT_BROWSERS_PATH: registry };
			const checks = await quietly(() => checkPrerequisites(root, fakeExec().exec, env));
			return checks.result.find((c) => c.name === "browsers");
		};
		const absent = ["chromium-1248", "chromium_headless_shell-1248", "webkit-2370"];
		const detail = `${name}: ${absent.join(", ")}; pnpm m0:prefetch installs them (about 3 min)`;
		expect(await check()).toMatchObject({ state: "missing", detail });
		for (const dir of absent) write(path.join(registry, dir, "INSTALLATION_COMPLETE"));
		expect(await check()).toMatchObject({ state: "ok" });
	});
});

describe("m0:prefetch", () => {
	it("skips, with a note, whatever isn't in the tree yet", async () => {
		const { exec, calls } = fakeExec();
		const { result, output } = await quietly(() => prefetch(fakeRoot(), exec, {}));
		expect({ result, calls }).toEqual({ result: 0, calls: [] });
		expect(output).toContain("skipped: tools/fetch-node isn't in the tree yet (M0.5)");
		expect(output).toContain("skipped: no digest-pinned image in tools/ or spikes/ yet");
		expect(output).toContain("skipped: no spike has a prefetch.ts yet");
	});

	it("fetches both Nodes for the host and Linux, then runs each spike's prefetch.ts", async () => {
		const root = fakeRoot({
			"tools/fetch-node/fetch-node.mjs": "",
			"tools/fetch-node/versions.json": JSON.stringify({ minimum: "26.5.1", bundled: "26.12.0" }),
			"spikes/s99-probe/prefetch.ts": "",
		});
		const onWindows = nodeTargets(root, { platform: "win32", arch: "x64" })?.map(label);
		expect(onWindows).toEqual([
			"26.5.1 win-x64",
			"26.5.1 linux-x64",
			"26.12.0 win-x64",
			"26.12.0 linux-x64",
		]);
		const { exec, calls } = fakeExec();
		expect((await quietly(() => prefetch(root, exec, {}))).result).toBe(0);
		const fetch = (t: NodeTarget) =>
			`--version ${t.version} --platform ${t.platform} --arch ${t.arch}`;
		const fetches = (nodeTargets(root) ?? []).map(
			(t) => `${node} fetch-node.mjs ${fetch(t)} @${root}`,
		);
		const spike = `${node} prefetch.ts @${path.join(root, "spikes", "s99-probe")}`;
		expect(calls).toEqual([...fetches, spike]);
	});

	it("pulls the digest-pinned images Docker doesn't have yet", async () => {
		const digest = `sha256:${"0123456789abcdef".repeat(4)}`;
		const present = `debian:bookworm-slim@${digest}`;
		const absent = `docker.io/library/node:26-alpine@${digest}`;
		const source = `FROM ${absent} AS build\nconst image = "${present}"; const loose = "node:26";`;
		expect(imageRefs(source)).toEqual([absent, present]);
		const bin = path.join(tmp, "docker-bin");
		write(path.join(bin, `docker${exe}`));
		const { exec, calls } = fakeExec((name, args) =>
			name === "git"
				? { stdout: "tools/x/images.ts\0" }
				: { code: args[0] === "info" || args.includes(present) ? 0 : 1, stdout: "29.4.0" },
		);
		const root = fakeRoot({ "tools/x/images.ts": source });
		const { result, output } = await quietly(() => prefetch(root, exec, { PATH: bin }));
		const pull = `docker${exe} pull ${absent} @${root}`;
		expect({ result, calls }).toEqual({ result: 0, calls: [pull] });
		expect(output).toContain(`present: ${present}`);
	});

	it("refuses an unknown argument on stderr", async () => {
		const args = [path.join(here, "prefetch.ts"), "--", "--bogus"];
		const { code, stderr } = await capture({ command: process.execPath, args });
		expect(code).toBe(2);
		expect(stderr).toMatch(/^m0:prefetch: unknown argument --bogus\nusage: pnpm m0:prefetch /);
	});

	it("loads before pnpm install: prefetch.ts imports only node: built-ins and relative files", () => {
		const source = readFileSync(path.join(here, "prefetch.ts"), "utf8");
		const imports = source.matchAll(/\b(?:from|import)\s*\(?\s*["']([^"']+)/g);
		const bare = [...imports].map((m) => m[1] ?? "").filter((id) => !/^(?:node:|\.\.?\/)/.test(id));
		expect(bare).toEqual([]);
	});
});
