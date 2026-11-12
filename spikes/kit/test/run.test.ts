import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { OFF_NOTICE, reservedWord, withoutReservedTests } from "../../../reserved-tests.ts";
import { GATE_ROOT_ENV, START_STOP_LINE } from "../../../tools/verify/lib/bootstrap.ts";
import { shortAlias, word } from "../../../tools/verify/test/temp-repo.ts";
import { exec } from "../exec.ts";
import { freePorts } from "../ports.ts";
import { gitEnv, kitDir, repoRoot } from "../repo.ts";
import { aliasedCwd, CWD_REFUSED } from "../run.ts";
import { parseRunArgs, resolveTsc, resolveVitest } from "../runner.ts";

const win = process.platform === "win32";

// Runs of this checkout's own kit start as a gated launcher's would: the input gate has run.
const gated = { ...process.env, [GATE_ROOT_ENV]: realpathSync.native(repoRoot) };

describe("run.ts and runner.ts", () => {
	const run = (cwd: string, ...args: string[]) =>
		exec(process.execPath, [path.join(kitDir, "run.ts"), ...args], { cwd, env: gated });

	it("maps tier flags to vitest --mode, the same with or without pnpm's `--`", () => {
		expect(parseRunArgs([]).args).toEqual(["run"]);
		expect(parseRunArgs(["--device"]).args).toEqual(["run", "--mode", "device"]);
		const heavy = { tier: "heavy", strict: false, args: ["run", "--mode", "heavy", "-t", "x"] };
		expect(parseRunArgs(["--heavy", "--", "-t", "x"])).toEqual(heavy);
		expect(parseRunArgs(["--heavy", "-t", "x"])).toEqual(heavy);
		const strict = { tier: "heavy", strict: true, args: ["run", "--mode", "heavy"] };
		expect(parseRunArgs(["--heavy", "--", "--strict"])).toEqual(strict);
		expect(parseRunArgs(["--heavy", "--strict"])).toEqual(strict);
		expect(parseRunArgs(["--", "--heavy"])).toEqual({ ...strict, strict: false });
		expect(parseRunArgs(["--live", "--strict"])).toMatchObject({ tier: "live", strict: true });
	});

	it("refuses two tiers, a hand-written --mode, or a folder without a Vitest config", async () => {
		expect(() => parseRunArgs(["--heavy", "--live"])).toThrow("one tier at a time");
		expect(() => parseRunArgs(["--", "--mode=live"])).toThrow("not --mode");
		const bare = mkdtempSync(path.join(tmpdir(), "draftyak-kit-bare-"));
		try {
			const result = await exec(process.execPath, [path.join(kitDir, "run.ts"), "--live"], {
				cwd: bare,
				env: gated,
			});
			expect([result.code, result.stderr]).toEqual([
				2,
				expect.stringContaining("no vitest.config.ts"),
			]);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("runs vitest.mjs with process.execPath, never a .cmd shim", () => {
		const vitest = resolveVitest();
		expect(path.basename(vitest)).toBe("vitest.mjs");
		expect(existsSync(vitest)).toBe(true);
	});

	it("maps --typecheck to tsc -b, the same with or without pnpm's `--`", () => {
		const typecheck = { tier: "unit", strict: false, args: ["-b"], typecheck: true };
		expect(parseRunArgs(["--typecheck"])).toStrictEqual(typecheck);
		expect(parseRunArgs(["--", "--typecheck"])).toStrictEqual(typecheck);
		expect(parseRunArgs(["--typecheck", "--"])).toStrictEqual(typecheck);
		// Vitest plans keep their exact shape.
		expect(parseRunArgs(["--heavy", "-t", "x"])).toStrictEqual({
			tier: "heavy",
			strict: false,
			args: ["run", "--mode", "heavy", "-t", "x"],
		});
	});

	it("refuses --typecheck with a tier, --strict or Vitest args, or without a tsconfig.json", async () => {
		const combined = [
			["--typecheck", "--heavy"],
			["--live", "--typecheck"],
			["--device", "--", "--typecheck"],
			["--typecheck", "--strict"],
			["--strict", "--typecheck"],
			["--typecheck", "-t", "x"],
			["--typecheck", "--", "--reporter=dot"],
			["-t", "x", "--typecheck"],
		];
		for (const argv of combined) {
			expect(() => parseRunArgs(argv), argv.join(" ")).toThrow("--typecheck runs tsc -b alone");
		}
		const bare = mkdtempSync(path.join(tmpdir(), "draftyak-kit-bare-"));
		try {
			const [refused, missing] = await Promise.all([
				run(kitDir, "--typecheck", "--strict"),
				run(bare, "--typecheck"),
			]);
			expect(refused.code).toBe(2);
			expect(refused.stderr).toContain("\nusage: node ../kit/run.ts [--heavy | --live | --device]");
			expect(refused.stderr).toContain("\n       node ../kit/run.ts --typecheck ");
			expect([missing.code, missing.stderr]).toEqual([
				2,
				expect.stringContaining("no tsconfig.json"),
			]);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("runs typescript's tsc bin with process.execPath, the package's own install first", () => {
		const tsc = resolveTsc();
		expect(path.basename(tsc)).toBe("tsc");
		expect(existsSync(tsc)).toBe(true);
		const own = mkdtempSync(path.join(tmpdir(), "draftyak-kit-tsc-"));
		try {
			const typescript = path.join(own, "node_modules", "typescript");
			mkdirSync(typescript, { recursive: true });
			const manifest = JSON.stringify({ name: "typescript", bin: { tsc: "./bin/tsc" } });
			writeFileSync(path.join(typescript, "package.json"), manifest);
			expect(resolveTsc(own)).toBe(path.join(typescript, "bin", "tsc"));
		} finally {
			rmSync(own, { recursive: true, force: true });
		}
	});

	it("passes a clean package's tsc -b and fails one with a type error", async () => {
		const root = mkdtempSync(path.join(tmpdir(), "draftyak-kit-typecheck-"));
		const check = (name: string, source: string) => {
			const dir = path.join(root, name);
			mkdirSync(dir);
			const options = { strict: true, noEmit: true, types: [] };
			writeFileSync(
				path.join(dir, "tsconfig.json"),
				JSON.stringify({ compilerOptions: options, files: ["index.ts"] }),
			);
			writeFileSync(path.join(dir, "index.ts"), source);
			return run(dir, "--typecheck");
		};
		try {
			const [clean, broken] = await Promise.all([
				check("clean", "export const answer: number = 42;\n"),
				check("broken", 'export const answer: number = "42";\n'),
			]);
			expect(clean.code, clean.stdout + clean.stderr).toBe(0);
			expect(broken.stdout).toContain("TS2322");
			expect(broken.code).not.toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

// run.ts decides, with only node: built-ins, its start checks, the off notice (off.ts) and the
// stop line loaded, whether the folder's scripts may run at all. These runs use a copy of it in a git
// checkout of its own whose runner.ts throws on load, so a run that gets past those checks says so.
// Each starts as under a gated launcher, so the input gate (routes.test.ts) isn't run here.
describe("run.ts before the rest of the kit loads", () => {
	const RUNNER_LOADED = "the runner of this copy loaded";
	const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "draftyak-kit-entry-")));
	afterAll(() => rmSync(base, { recursive: true, force: true, maxRetries: 5 }));
	// A child without the flag, whatever this run has.
	const childEnv = { ...process.env, ...withoutReservedTests(process.env) };
	let copies = 0;

	// The text a mutation replaces must be in run.ts exactly once.
	function mutated(source: string, from: string, to: string): string {
		const parts = source.split(from);
		if (parts.length !== 2) throw new Error(`run.ts must hold ${JSON.stringify(from)} once`);
		return parts.join(to);
	}

	function checkout(change: (source: string) => string = (source) => source) {
		const repo = path.join(base, `copy-${++copies}`);
		const put = (rel: string, text: string): void => {
			mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
			writeFileSync(path.join(repo, rel), text);
		};
		const copy = (rel: string): void => put(rel, readFileSync(path.join(repoRoot, rel), "utf8"));
		put("package.json", JSON.stringify({ private: true, type: "module" }));
		copy("reserved-tests.ts");
		copy("tools/verify/lib/bootstrap.ts");
		for (const file of ["off.ts", "repo.ts", "exec.ts"]) copy(`spikes/kit/${file}`);
		put("spikes/kit/run.ts", change(readFileSync(path.join(kitDir, "run.ts"), "utf8")));
		put("spikes/kit/runner.ts", `throw new Error(${JSON.stringify(RUNNER_LOADED)});\n`);
		// The start checks need git to list the kit's helpers; untracked files count.
		const init = spawnSync("git", ["init", "-q"], { cwd: repo, env: gitEnv(), windowsHide: true });
		if (init.status !== 0) throw new Error("git init failed in the kit's copy");
		const env = { ...childEnv, [GATE_ROOT_ENV]: repo };
		const folder = (rel: string): string => {
			const dir = path.join(repo, rel);
			mkdirSync(dir, { recursive: true });
			return dir;
		};
		const start = async (cwd: string, script = path.join(repo, "spikes", "kit", "run.ts")) => {
			const result = await exec(process.execPath, [script], { cwd, env, timeoutMs: 60_000 });
			const lines = result.stderr.split(/\r?\n/).filter(Boolean);
			return {
				code: result.code,
				off: result.stdout.includes(OFF_NOTICE),
				runner: result.stderr.includes(RUNNER_LOADED),
				// The tripwire line and the stop line, once each, and nothing else: no path.
				refused: JSON.stringify(lines) === JSON.stringify([CWD_REFUSED, START_STOP_LINE]),
			};
		};
		return { repo, folder, start };
	}

	const ran = { code: 2, off: false, runner: true, refused: false };
	const off = { code: 0, off: true, runner: false, refused: false };
	const refused = { code: 2, off: false, runner: false, refused: true };
	// Reserved folder names: the word comes after eight letters, so an 8.3 alias drops it.
	const reservedName = (): string => `aaaaaaaa-${word()}`;
	// A folder's 8.3 alias; on Windows a volume without short names fails the case, never skips it.
	const alias = (dir: string): string => {
		const short = shortAlias(dir);
		if (short === null) throw new Error("this volume makes no 8.3 names; the case can't run");
		return short;
	};

	it("stops a reserved folder's run at the off notice, before any other kit module loads", async () => {
		const { folder, start } = checkout();
		expect(await start(folder(`spikes/${reservedName()}`))).toEqual(off);
		expect(await start(folder(`spikes/x-${word("_")}/src`))).toEqual(off);
	});

	it("reaches the runner from an ordinary folder", async () => {
		const { repo, folder, start } = checkout();
		expect(await start(folder("spikes/plain"))).toEqual(ran);
		expect(await start(repo)).toEqual(ran);
	});

	it("refuses a working folder reached through an ordinary-named junction, whatever is behind it", async () => {
		const { repo, folder, start } = checkout();
		const behind = [folder(`spikes/${reservedName()}`), folder("spikes/plain")];
		for (const [index, target] of behind.entries()) {
			const link = path.join(repo, "spikes", `link-${index}`);
			symlinkSync(target, link, "junction");
			expect(await start(link)).toEqual(refused);
		}
	});

	it.runIf(win)(
		"refuses a working folder reached through an 8.3 alias of a reserved folder inside the checkout",
		async () => {
			const { repo, folder, start } = checkout();
			const reserved = folder(`spikes/${reservedName()}`);
			// The long names down to spikes, then the alias of the reserved folder.
			const cwd = path.join(repo, "spikes", path.basename(alias(reserved)));
			expect(reservedWord.test(path.basename(cwd))).toBe(false);
			expect(aliasedCwd(repo, cwd)).toBe(true);
			expect(await start(cwd)).toEqual(refused);
		},
	);

	it.runIf(win)("doesn't refuse an 8.3 alias above the checkout's root", async () => {
		const { repo, folder, start } = checkout();
		const plain = folder("spikes/plain");
		const reserved = folder(`spikes/x-${word()}`);
		const [shortPlain, shortRepo, shortReserved] = [alias(plain), alias(repo), alias(reserved)];
		// Started through the long path: the folder's own path isn't below that root.
		expect(await start(shortPlain)).toEqual(ran);
		// Started through the alias too, so the root and the folder share it.
		const script = path.join(shortRepo, "spikes", "kit", "run.ts");
		expect(await start(shortPlain, script)).toEqual(ran);
		// A reserved folder still stops at the off notice, judged by its real path.
		expect(await start(shortReserved)).toEqual(off);
		expect(await start(shortReserved, script)).toEqual(off);
	});

	it("judges the working folder by the same path below the real root", () => {
		const { repo, folder } = checkout();
		const plain = folder("spikes/plain");
		const link = path.join(repo, "spikes", "link");
		symlinkSync(plain, link, "junction");
		expect(aliasedCwd(repo, repo)).toBe(false);
		expect(aliasedCwd(repo, plain)).toBe(false);
		expect(aliasedCwd(repo, path.join(plain, "."))).toBe(false);
		expect(aliasedCwd(repo, tmpdir())).toBe(false);
		expect(aliasedCwd(repo, link)).toBe(true);
		// A folder that can't be resolved.
		expect(aliasedCwd(repo, path.join(repo, "spikes", "missing"))).toBe(true);
		if (win) expect(aliasedCwd(repo, path.join(repo, "SPIKES", "Plain"))).toBe(false);
	});

	// Mutation cases: each check removed from a copy, the run it stopped reaches the runner.
	it("reaches the runner from a reserved folder when the off check is removed", async () => {
		const { folder, start } = checkout((source) =>
			mutated(source, "if (reservedSpikeOff(deps.cwd, env)) {", "if (false) {"),
		);
		expect(await start(folder(`spikes/${reservedName()}`))).toEqual(ran);
	});

	it("reaches the runner through a junction to a reserved folder when the alias check is removed", async () => {
		const { repo, folder, start } = checkout((source) =>
			mutated(source, "if (aliasedCwd(deps.root, deps.cwd)) {", "if (false) {"),
		);
		const link = path.join(repo, "spikes", "link");
		symlinkSync(folder(`spikes/${reservedName()}`), link, "junction");
		expect(await start(link)).toEqual(ran);
	});
});

describe("ports.ts", () => {
	it("hands out distinct bindable ports, never the reserved ones", async () => {
		const ports = await freePorts(6);
		expect(new Set(ports).size).toBe(6);
		expect(ports.filter((port) => [1455, 9229, 47613, 47614, 47615].includes(port))).toEqual([]);
		const server = createServer();
		await new Promise<void>((resolve) => server.listen(ports[0], "127.0.0.1", resolve));
		await new Promise((resolve) => server.close(resolve));
	});
});
