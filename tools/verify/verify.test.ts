import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { type Dirs, main } from "./verify.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "draftyak-verify-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(dir: string, name: string, source: string): void {
	mkdirSync(path.join(tmp, dir), { recursive: true });
	writeFileSync(path.join(tmp, dir, `${name}.ts`), source);
}

const envCheck =
	"process.exit(process.env.DY_PROBE === '1' && process.env.DO_NOT_TRACK === '1' && process.env.PATH ? 0 : 1)";
const steps: Record<string, [profiles: string[], run: string]> = {
	pass: [["ok", "all", "skip"], `async () => ({ status: "passed" })`],
	fail: [["all"], `async () => ({ status: "failed", reason: "broken" })`],
	skip: [["skip"], `async () => ({ status: "skipped", reason: "not here" })`],
	env: [
		["env"],
		`async (ctx) => (await ctx.node(["-e", ${JSON.stringify(envCheck)}], { env: { DY_PROBE: "1" } })) === 0 ? { status: "passed" } : { status: "failed", reason: "env replaced" }`,
	],
};
for (const [name, [profiles, run]] of Object.entries(steps)) {
	const step = `{ name: "${name}", order: 1, profiles: ${JSON.stringify(profiles)}, run: ${run} }`;
	write("steps", name, `export const step = ${step};\n`);
}
for (const name of ["ok", "all", "skip", "env"]) {
	const select = `(steps) => steps.filter((step) => step.profiles.includes("${name}"))`;
	write(
		"profiles",
		name,
		`export const profile = { name: "${name}", description: "", select: ${select} };\n`,
	);
}
write(
	"misnamed",
	"other",
	`export const step = { name: "renamed", order: 1, profiles: [], run: async () => ({ status: "passed" }) };\n`,
);

const dirs: Dirs = { steps: path.join(tmp, "steps"), profiles: path.join(tmp, "profiles") };

async function verify(argv: string[], at: Dirs = dirs): Promise<{ code: number; lines: string[] }> {
	const lines: string[] = [];
	const collect = (...parts: unknown[]): void => {
		lines.push(...parts.join(" ").split("\n"));
	};
	const log = vi.spyOn(console, "log").mockImplementation(collect);
	const error = vi.spyOn(console, "error").mockImplementation(collect);
	try {
		return { code: await main(argv, at), lines };
	} finally {
		log.mockRestore();
		error.mockRestore();
	}
}

describe("verify", () => {
	it.each([
		[["--profile", "ok"], 0, "verify: 1/1 steps passed"],
		[["--profile", "all"], 1, "verify: 1/2 steps passed"],
		[["--profile", "skip"], 0, "verify: 1/1 steps passed, 1 skipped"],
		[["--profile", "env"], 0, "verify: 1/1 steps passed"],
		[["--", "--profile", "ok"], 0, "verify: 1/1 steps passed"],
	])("%j exits %i and ends with %j", async (argv, code, summary) => {
		const result = await verify(argv);
		expect(result.code).toBe(code);
		expect(result.lines.at(-1)).toBe(summary);
	});

	it.each([
		[["--profile", "nope"], 'verify: unknown profile "nope" (known: all, env, ok, skip)'],
		[["--bogus"], "verify: Unknown option '--bogus'"],
		[["--profile", "ok", "extra"], "verify: Unexpected argument 'extra'"],
	])("%j is a usage error (exit 2)", async (argv, error) => {
		const result = await verify(argv);
		expect(result.code).toBe(2);
		expect(result.lines[0]).toContain(error);
	});

	it("refuses a step file whose step has another name (exit 2)", async () => {
		const result = await verify(["--list"], { ...dirs, steps: path.join(tmp, "misnamed") });
		expect(result.code).toBe(2);
		expect(result.lines[0]).toMatch(/other\.ts must export a step named "other"$/);
	});
});
