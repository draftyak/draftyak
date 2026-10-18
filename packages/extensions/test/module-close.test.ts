import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

const moduleUrl = new URL("../src/module.ts", import.meta.url).href;

it.each(["before", "after", "preopen"] as const)(
	"refuses a failed directory close %s while keeping independent admissions usable",
	(mode) => {
		const child = spawnSync(
			process.execPath,
			[
				"--disable-sigusr1",
				path.resolve(import.meta.dirname, "fixtures/module-close.mjs"),
				moduleUrl,
				mode,
			],
			{ encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 16_384 },
		);
		expect(child.status, child.stderr).toBe(0);
		expect(JSON.parse(child.stdout)).toEqual({
			refused: true,
			opensAfterFault: mode === "preopen" ? 3 : 2,
			faultCloses: 1,
		});
	},
);
