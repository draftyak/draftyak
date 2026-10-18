import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs public component/large-history/deadline and independent raw-work neighbors under plugin flags", () => {
	const run = spawnSync(
		process.execPath,
		[
			"--disallow-code-generation-from-strings",
			"--max-old-space-size=256",
			fileURLToPath(new URL("./acceptance-runner.ts", import.meta.url)),
		],
		{ timeout: 90_000, maxBuffer: 65_536, encoding: "utf8", windowsHide: true },
	);
	expect(run.error).toBeUndefined();
	expect(run.stderr).toBe("");
	expect(run.status).toBe(0);
	const result = JSON.parse(run.stdout) as {
		cases: number;
		results: { id: string; bytes?: number }[];
	};
	expect(result.cases).toBe(8);
	expect(result.results.map((item) => item.id)).toEqual([
		"public-5000-kept",
		"public-5001-refuses",
		"public-large-history",
		"remaining-deadline-independent-of-counts",
		"deadline-interrupts-single-library-call",
		"deadline-interrupts-single-zone-call",
		"raw-call-boundary-100000",
		"raw-call-boundary-100001",
	]);
	expect(result.results[2]?.bytes).toBeGreaterThanOrEqual(29 * 1024 * 1024);
	console.log(run.stdout.trim());
}, 95_000);
