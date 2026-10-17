import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { capture } from "../lib/spawn.ts";
import { resolveTurbo, telemetryOff } from "../lib/tools.ts";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const { packageManager } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
	packageManager: string;
};

// The probe fails unless the declared variables arrive and an undeclared one is filtered out.
const probe = `
const seen = {
	strict: process.env.DRAFTYAK_STRICT_SKIPS ?? "missing",
	dnt: process.env.DO_NOT_TRACK ?? "missing",
	undeclared: process.env.DY_TURBO_ENV_UNDECLARED ?? "absent",
};
console.log("probe: " + JSON.stringify(seen));
process.exit(seen.strict === "1" && seen.dnt === "1" && seen.undeclared === "absent" ? 0 : 1);
`;

function write(dir: string, file: string, text: string): void {
	mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
	writeFileSync(path.join(dir, file), text);
}

describe("turbo env", () => {
	it("passes DRAFTYAK_* and DO_NOT_TRACK to a test:heavy task, and nothing undeclared", async () => {
		const dir = mkdtempSync(path.join(tmpdir(), "draftyak-turbo-env-"));
		try {
			// A one-package workspace under the repo's own turbo.json.
			write(dir, "turbo.json", readFileSync(path.join(root, "turbo.json"), "utf8"));
			const workspace = { name: "turbo-env-probe", private: true, packageManager };
			write(dir, "package.json", JSON.stringify(workspace));
			write(dir, "pnpm-workspace.yaml", "packages:\n  - probe\nverifyDepsBeforeRun: false\n");
			const scripts = { "test:heavy": "node probe.mjs" };
			write(dir, "probe/package.json", JSON.stringify({ name: "probe", private: true, scripts }));
			write(dir, "probe/probe.mjs", probe);

			// Drop the outer turbo's TURBO_* task variables; keep the rest of this process's env.
			const env = Object.fromEntries(
				Object.entries(process.env).filter(([name]) => !name.startsWith("TURBO_")),
			);
			Object.assign(env, telemetryOff, {
				DRAFTYAK_STRICT_SKIPS: "1",
				DY_TURBO_ENV_UNDECLARED: "1",
			});
			const turbo = {
				command: resolveTurbo(root),
				args: ["run", "test:heavy", "--log-prefix=none"],
			};
			const result = await capture(turbo, { cwd: dir, env });
			const output = `${result.stdout}\n${result.stderr}`;
			expect(output).toContain('probe: {"strict":"1","dnt":"1","undeclared":"absent"}');
			expect(result.code, output).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 120_000);
});
