import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { capture, SpawnRefusedError } from "./spawn.ts";
import { resolveBiome, resolvePnpm, resolveTurbo, telemetryOff } from "./tools.ts";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const binaries: [string, (root: string) => string][] = [
	["turbo", resolveTurbo],
	["@biomejs/biome", resolveBiome],
];

describe("tool resolution", () => {
	const dir = mkdtempSync(path.join(tmpdir(), "draftyak-verify-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	it.each(binaries)(
		"runs %s as the native executable from its platform package",
		async (_, resolve) => {
			const binary = resolve(root);
			expect(path.isAbsolute(binary)).toBe(true);
			if (process.platform === "win32") expect(binary).toMatch(/\.exe$/i);
			const result = await capture(
				{ command: binary, args: ["--version"] },
				{ env: { ...process.env, ...telemetryOff } },
			);
			expect(result.code).toBe(0);
			expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
		},
	);

	it.each(binaries)("asks for pnpm install when %s is missing", (name, resolve) => {
		expect(() => resolve(dir)).toThrow(new RegExp(`^${name}: .+; run pnpm install$`));
	});

	it("runs pnpm as process.execPath plus npm_execpath", () => {
		const script = path.join(dir, "pnpm", "bin", "pnpm.mjs");
		expect(resolvePnpm({ npm_execpath: script })).toEqual({
			command: process.execPath,
			args: [script],
		});
	});

	it("refuses a .cmd npm_execpath", () => {
		expect(() => resolvePnpm({ npm_execpath: path.join(dir, "pnpm.cmd") })).toThrow(
			SpawnRefusedError,
		);
	});

	it("falls back to the pnpm package beside a pnpm shim on PATH", () => {
		const bin = path.join(dir, "global");
		const scripts = path.join(bin, "node_modules", "pnpm", "bin");
		mkdirSync(scripts, { recursive: true });
		for (const file of ["pnpm.cjs", "pnpm.mjs"]) writeFileSync(path.join(scripts, file), "");
		writeFileSync(path.join(bin, "pnpm.cmd"), "");
		expect(resolvePnpm({ PATH: bin })).toEqual({
			command: process.execPath,
			args: [path.join(scripts, "pnpm.mjs")],
		});
	});
});
