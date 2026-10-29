import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { exec } from "../exec.ts";
import { freePorts } from "../ports.ts";
import { kitDir } from "../repo.ts";
import { parseRunArgs, resolveTsc, resolveVitest } from "../run.ts";

describe("run.ts", () => {
	const run = (cwd: string, ...args: string[]) =>
		exec(process.execPath, [path.join(kitDir, "run.ts"), ...args], { cwd });

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
