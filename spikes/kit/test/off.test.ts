import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ViteUserConfig } from "vitest/config";
import { reservedOffConfig, reservedSpikeOff } from "../off.ts";
import { kitDir, repoRoot } from "../repo.ts";

describe("reservedSpikeOff", () => {
	it("keeps every folder's tests on, whatever DRAFTYAK_RESERVED_TESTS says", () => {
		const spikes = path.join(repoRoot, "spikes");
		const dirs = [
			undefined,
			"",
			".",
			repoRoot,
			kitDir,
			tmpdir(),
			path.join(tmpdir(), "draftyak-kit-missing"),
			...readdirSync(spikes, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => path.join(spikes, entry.name)),
		];
		const values = ["1", "0", "", "true", "yes", "off", " 1", "1\n"];
		const envs = [
			undefined,
			{},
			{ ...process.env, DRAFTYAK_RESERVED_TESTS: undefined },
			...values.map((value) => ({ DRAFTYAK_RESERVED_TESTS: value })),
			...values.map((value) => ({ ...process.env, DRAFTYAK_RESERVED_TESTS: value })),
		];
		const answers = dirs.flatMap((dir) => envs.map((env) => reservedSpikeOff(dir, env)));
		expect(answers).toHaveLength(dirs.length * envs.length);
		expect(new Set(answers)).toEqual(new Set([false]));
		expect(reservedSpikeOff()).toBe(false);
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
