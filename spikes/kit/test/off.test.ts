import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ViteUserConfig } from "vitest/config";
import { withoutReservedTests } from "../../../reserved-tests.ts";
import { reservedOffConfig, reservedSpikeOff } from "../off.ts";
import { kitDir, repoRoot } from "../repo.ts";

// The reserved words are built here, so this file never spells one, and assertions compare
// booleans and counts only.
const word = ["si", "wc"].join("");
const agent = ["dynamic", "agent"];
const reservedName = new RegExp(`${word}|${agent.join("[-_]")}`, "i");
const flag = "DRAFTYAK_RESERVED_TESTS";

describe("reservedSpikeOff", () => {
	const spikes = path.join(repoRoot, "spikes");
	const spikeDirs = readdirSync(spikes, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => path.join(spikes, entry.name));
	const ordinary = [
		undefined,
		"",
		".",
		repoRoot,
		kitDir,
		tmpdir(),
		path.join(tmpdir(), "draftyak-kit-missing"),
		...spikeDirs.filter((dir) => !reservedName.test(path.basename(dir))),
	];
	// Nothing on disk: only the path below the repository root, or a path outside it, counts.
	const temp = path.join(tmpdir(), "draftyak-kit-off");
	const synthetic = path.join(temp, `x-${word}`);
	const reserved = [
		synthetic,
		path.join(temp, `${word.toUpperCase()}-spike`, "src"),
		path.join(temp, agent.join("-")),
		path.join(temp, "a", agent.map((part) => part.toUpperCase()).join("_"), "b"),
		path.join(spikes, `zz-${word}`),
		...spikeDirs.filter((dir) => reservedName.test(path.basename(dir))),
	];
	const unset = [
		{},
		{ [flag]: undefined },
		{ ...process.env, ...withoutReservedTests(process.env) },
	];
	const optIn = [
		{ [flag]: "1" },
		{ ...process.env, ...withoutReservedTests(process.env), [flag]: "1" },
	];
	const answers = (dirs: readonly (string | undefined)[], envs: readonly NodeJS.ProcessEnv[]) =>
		new Set(dirs.flatMap((dir) => envs.map((env) => reservedSpikeOff(dir, env))));

	it("keeps an ordinary folder's tests on, with the flag unset or 1", () => {
		expect(ordinary.length).toBeGreaterThan(8);
		expect(answers(ordinary, [...unset, ...optIn])).toEqual(new Set([false]));
		expect(reservedSpikeOff()).toBe(false);
	});

	it("turns a reserved folder's tests off unless the flag is 1", () => {
		expect(reserved.length).toBeGreaterThan(5);
		expect(answers(reserved, unset)).toEqual(new Set([true]));
		expect(answers(reserved, optIn)).toEqual(new Set([false]));
	});

	it("reads the flag in any case on Windows, as a child process gets it", () => {
		const lower = { [flag.toLowerCase()]: "1" };
		expect(reservedSpikeOff(synthetic, lower)).toBe(process.platform !== "win32");
	});

	it.each(["", "0", "true", "yes", " 1", "1\n"])(
		"refuses the flag value %j for an ordinary folder and a reserved one alike",
		(value) => {
			const refusal = `${flag} must be unset (off) or exactly 1 (on), not ${JSON.stringify(value)}`;
			for (const dir of [repoRoot, synthetic]) {
				expect(() => reservedSpikeOff(dir, { [flag]: value })).toThrow(refusal);
			}
		},
	);

	it("names neither a long value nor one holding a reserved word when it refuses", () => {
		const message = (value: string): string => {
			try {
				reservedSpikeOff(repoRoot, { [flag]: value });
				return "accepted";
			} catch (error) {
				return error instanceof Error ? error.message : "refused";
			}
		};
		const named = message(`x-${word}`);
		expect([reservedName.test(named), named.endsWith("not a 6-character value")]).toEqual([
			false,
			true,
		]);
		expect(message("1".repeat(40))).toContain("not a 40-character value");
	});
});

describe("reservedOffConfig", () => {
	it("is a Vitest config with no test files that passes, after one notice line on stderr", () => {
		const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const config: ViteUserConfig = reservedOffConfig();
			expect(config).toStrictEqual({
				envDir: false,
				test: { include: [], passWithNoTests: true },
			});
			expect(write.mock.calls).toEqual([
				[
					"tests below this folder are reserved and off by default; DRAFTYAK_RESERVED_TESTS=1 runs them\n",
				],
			]);
		} finally {
			write.mockRestore();
		}
	});
});
