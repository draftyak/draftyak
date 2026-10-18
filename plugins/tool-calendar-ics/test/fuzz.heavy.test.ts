import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("fuzzes bytes and valid-corpus structure under plugin flags with a process deadline", () => {
	const run = spawnSync(
		process.execPath,
		[
			"--disallow-code-generation-from-strings",
			"--max-old-space-size=256",
			fileURLToPath(new URL("./fuzz-runner.ts", import.meta.url)),
		],
		{ timeout: 60_000, maxBuffer: 32_768, encoding: "utf8", windowsHide: true },
	);
	expect(run.error).toBeUndefined();
	expect(run.stderr).toBe("");
	expect(run.status).toBe(0);
	expect(JSON.parse(run.stdout)).toEqual({
		bytes: 150,
		malformed: 150,
		structural: 150,
		positiveCorpus: 3,
		denseRefusals: 2,
	});
	console.log(run.stdout.trim());
}, 65_000);
