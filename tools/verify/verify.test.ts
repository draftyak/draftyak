import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChildLifecycleEvent } from "./lib/spawn.ts";
import { childLifecycleLine, type Dirs, directInvocationKind, main } from "./verify.ts";

const tmp = mkdtempSync(path.join(tmpdir(), "draftyak-verify-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(dir: string, name: string, source: string): void {
	mkdirSync(path.join(tmp, dir), { recursive: true });
	writeFileSync(path.join(tmp, dir, `${name}.ts`), source);
}

const envCheck =
	"process.exit(process.env.DY_PROBE === '1' && process.env.DO_NOT_TRACK === '1' && process.env.PATH ? 0 : 1)";
const captureCheck = [
	"async (ctx) => {",
	"  const seen = [];",
	"  for (let index = 0; index < 2; index += 1) {",
	'    const result = await ctx.capture(process.execPath, ["-e", "process.stdout.write(\\"CACHEHIT/REPLAYED private-argv private-env private-cwd private-message\\");process.stderr.write(\'private-stderr\')", "private-argv"], {',
	'      env: { DY_PRIVATE_SENTINEL: "private-env" },',
	"      onLifecycle: (event) => seen.push(event),",
	"    });",
	'    if (result.code !== 0 || result.stdout !== "CACHEHIT/REPLAYED private-argv private-env private-cwd private-message" || result.stderr !== "private-stderr" || seen.at(-1)?.type !== "close")',
	'      return { status: "failed", reason: "capture lifecycle changed" };',
	"  }",
	'  const starts = seen.filter((event) => event.type === "start");',
	"  return starts.length === 2 && starts[0].invocationId !== starts[1].invocationId",
	'    ? { status: "passed" } : { status: "failed", reason: "invocation identity repeated" };',
	"}",
].join("\n");
const observerFailureCheck = [
	"async (ctx) => {",
	'  await ctx.capture(process.execPath, ["-e", "process.stdout.write(\'CACHEHIT/REPLAYED\')"], {',
	'    onLifecycle: () => { throw new Error("private-observer-message"); },',
	"  });",
	'  return { status: "passed" };',
	"}",
].join("\n");
const steps: Record<string, [profiles: string[], run: string]> = {
	"observer-failure": [["observer-failure"], observerFailureCheck],
	"capture-child": [["capture"], captureCheck],
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
for (const name of ["ok", "all", "skip", "env", "capture", "observer-failure"]) {
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
		[
			["--profile", "nope"],
			'verify: unknown profile "nope" (known: all, capture, env, observer-failure, ok, skip)',
		],
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

function lifecycleRows(lines: readonly string[]): Record<string, unknown>[] {
	return lines
		.filter((line) => line.startsWith("verify: child "))
		.map((line) => JSON.parse(line.slice("verify: child ".length)));
}

describe("direct child lifecycle reporting", () => {
	it("reports fresh capture events without replaying cached-looking child text or private inputs", async () => {
		const result = await verify(["--profile", "capture"]);
		expect(result.code).toBe(0);
		expect(result.lines.at(-1)).toBe("verify: 1/1 steps passed");
		const rows = lifecycleRows(result.lines);
		const starts = rows.filter((row) => row.event === "start");
		expect(starts).toHaveLength(2);
		expect(new Set(starts.map((row) => row.invocationId)).size).toBe(2);
		for (const start of starts) {
			expect(start.invocationId).toMatch(
				/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
			);
			const events = rows.filter((row) => row.invocationId === start.invocationId);
			expect(events.map((row) => row.event)).toEqual(["start", "spawn", "exit", "close"]);
			for (const row of events) {
				expect(Object.keys(row)).toEqual([
					"version",
					"profile",
					"step",
					"kind",
					"event",
					"invocationId",
					"pid",
					"code",
					"signal",
					"errorCode",
				]);
				expect(row).toMatchObject({
					version: 1,
					profile: "capture",
					step: "capture-child",
					kind: "capture",
					signal: null,
					errorCode: null,
				});
			}
			const spawned = events[1];
			expect(Number.isSafeInteger(spawned?.pid)).toBe(true);
			expect(spawned?.pid).toBeGreaterThan(0);
			expect(events[2]).toMatchObject({ pid: spawned?.pid, code: 0 });
			expect(events[3]).toMatchObject({ pid: spawned?.pid, code: 0 });
		}
		expect(result.lines.join("\n")).not.toMatch(
			/CACHEHIT|REPLAYED|private-argv|private-env|private-cwd|private-message|private-stderr/,
		);
	});

	it("retains close metadata and fails safely after a synchronous caller observer throws", async () => {
		const result = await verify(["--profile", "observer-failure"]);
		expect(result.code).toBe(1);
		expect(result.lines.at(-1)).toBe("verify: 0/1 steps passed");
		const rows = lifecycleRows(result.lines);
		expect(rows.map((row) => row.event)).toEqual(["start", "spawn", "exit", "close"]);
		expect(new Set(rows.map((row) => row.invocationId)).size).toBe(1);
		for (const row of rows)
			expect(row).toMatchObject({
				profile: "observer-failure",
				step: "observer-failure",
				kind: "capture",
			});
		expect(rows.at(-1)).toMatchObject({ code: 0, signal: null, errorCode: null });
		const close = result.lines.findIndex(
			(line) =>
				line.startsWith("verify: child ") &&
				JSON.parse(line.slice("verify: child ".length)).event === "close",
		);
		const failed = result.lines.findIndex(
			(line) => line.includes("failed in") && line.includes("Child lifecycle observer failed"),
		);
		expect(close).toBeGreaterThanOrEqual(0);
		expect(failed).toBeGreaterThan(close);
		expect(result.lines.join("\n")).not.toMatch(/CACHEHIT|REPLAYED|private-observer-message/);
	});

	it("reports the active step and keeps the existing environment inheritance", async () => {
		const result = await verify(["--profile", "env"]);
		expect(result.code).toBe(0);
		expect(lifecycleRows(result.lines)).toHaveLength(4);
		for (const row of lifecycleRows(result.lines))
			expect(row).toMatchObject({ profile: "env", step: "env", kind: "node" });
	});

	it.each<{ args: readonly string[]; expected: string }>([
		{ args: ["run", "test", "--filter=@draftyak/verify"], expected: "test/verify" },
		{ args: ["run", "test", "--filter=!@draftyak/verify"], expected: "test/remaining" },
		{ args: ["run", "test", "--filter=@draftyak/verify", "private-argv"], expected: "turbo" },
		{ args: ["run", "test", "--filter=other"], expected: "turbo" },
	])("labels only the exact direct test partition $expected", ({ args, expected }) => {
		expect(directInvocationKind("turbo", "test", args)).toBe(expected);
		expect(directInvocationKind("turbo", "build", args)).toBe("turbo");
		expect(directInvocationKind("node", "test", args)).toBe("node");
	});

	it("projects raw lifecycle scalars and excludes extra output/error fields", () => {
		const identity = { invocationId: "00000000-0000-4000-8000-000000000001", pid: 1234 };
		const extra = {
			stdout: "CACHEHIT/REPLAYED",
			args: ["private-argv"],
			env: "private-env",
			cwd: "private-cwd",
			message: "private-message",
		};
		const signalled: ChildLifecycleEvent = {
			...identity,
			type: "exit",
			code: null,
			signal: "SIGTERM",
			...extra,
		};
		const events: ChildLifecycleEvent[] = [
			signalled,
			{ ...identity, type: "close", code: 7, signal: null, ...extra },
			{ ...identity, type: "error", errorCode: "ENOENT", ...extra },
		];
		const rows = events.map((event) =>
			JSON.parse(
				childLifecycleLine("windows-tests", "test", "test/verify", event).slice(
					"verify: child ".length,
				),
			),
		);
		expect(rows[0]).toMatchObject({ code: null, signal: "SIGTERM", errorCode: null });
		expect(rows[1]).toMatchObject({ code: 7, signal: null, errorCode: null });
		expect(rows[2]).toMatchObject({ code: null, signal: null, errorCode: "ENOENT" });
		expect(JSON.stringify(rows)).not.toMatch(/CACHEHIT|REPLAYED|private-/);
		expect(
			JSON.parse(
				childLifecycleLine("private-profile\n", "private-step\n", "run", signalled).slice(
					"verify: child ".length,
				),
			),
		).toMatchObject({ profile: "other", step: "other" });
	});
});
