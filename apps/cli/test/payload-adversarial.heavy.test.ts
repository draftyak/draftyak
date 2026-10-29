import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { isolateKernelFixture } from "./kernel-fixture.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(packageRoot, "../..");
const require = createRequire(import.meta.url);
const roots: string[] = [];
const links: string[] = [];

function node(args: readonly string[], cwd: string, environment: NodeJS.ProcessEnv = {}) {
	const env = { ...process.env, ...environment };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
	if (environment.NODE_PATH !== undefined) env.NODE_PATH = environment.NODE_PATH;
	const result = spawnSync(process.execPath, [...args], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 20_000,
		maxBuffer: 128 * 1024,
		shell: false,
		windowsHide: true,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return result;
}

interface Fixture {
	readonly root: string;
	readonly source: string;
	readonly installed: string;
	readonly cli: string;
	readonly marker: string;
}

function prepare(files: Readonly<Record<string, string>> = {}): Fixture {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-cli-adversarial-"));
	roots.push(root);
	const workspace = path.join(root, "workspace");
	const source = path.join(workspace, "apps/cli");
	const installed = path.join(root, "installed");
	const cli = path.join(installed, "cli");
	const marker = path.join(root, "DYTEST-executed");
	mkdirSync(source, { recursive: true });
	mkdirSync(installed);
	for (const directory of ["src", "scripts"])
		cpSync(path.join(packageRoot, directory), path.join(source, directory), { recursive: true });
	for (const filename of ["package.json", "tsconfig.json", "tsconfig.build.json"])
		cpSync(path.join(packageRoot, filename), path.join(source, filename));
	isolateKernelFixture(source);
	cpSync(
		path.join(repositoryRoot, "tsconfig.base.json"),
		path.join(workspace, "tsconfig.base.json"),
	);
	const tooling = path.join(workspace, "node_modules/typescript");
	mkdirSync(path.dirname(tooling), { recursive: true });
	symlinkSync(path.dirname(require.resolve("typescript/package.json")), tooling, "junction");
	links.push(tooling);
	const bundler = path.join(workspace, "node_modules/rolldown");
	symlinkSync(path.dirname(require.resolve("rolldown/package.json")), bundler, "junction");
	links.push(bundler);
	const nodeTypes = path.join(workspace, "node_modules/@types/node");
	mkdirSync(path.dirname(nodeTypes), { recursive: true });
	symlinkSync(path.dirname(require.resolve("@types/node/package.json")), nodeTypes, "junction");
	links.push(nodeTypes);
	for (const [relative, contents] of Object.entries(files)) {
		const filename = path.join(source, "src", relative);
		mkdirSync(path.dirname(filename), { recursive: true });
		writeFileSync(filename, contents);
	}
	writeFileSync(path.join(installed, "package.json"), '{"type":"commonjs"}\n');
	return { root, source, installed, cli, marker };
}

function build(fixture: Fixture): void {
	const result = node(["scripts/build.ts"], fixture.source);
	expect(result.status, result.stderr).toBe(0);
	cpSync(path.join(fixture.source, "dist"), fixture.cli, { recursive: true });
}

function runner(
	fixture: Fixture,
	program: string,
	args: readonly string[] = [],
	environment: NodeJS.ProcessEnv = {},
) {
	const filename = path.join(fixture.installed, "DYTEST-runner.mjs");
	writeFileSync(filename, program);
	return node([filename, ...args], fixture.installed, environment);
}

function invoke(fixture: Fixture, args: readonly string[]) {
	return runner(
		fixture,
		'import { main } from "./cli/main.mjs"; process.exitCode = await main(process.argv.slice(2));',
		args,
	);
}

function command(name: string, body: string): string {
	return `import type { Command } from "../command-contract.ts";
export const command: Command = { name: ${JSON.stringify(name)}, async run(argv, context) { ${body} } };`;
}

let ordinary: Fixture;
let exits: Fixture | undefined;
let doctorResults: Fixture | undefined;

const outcomes = [
	{ name: "zero", value: "0", expected: 0 },
	{ name: "seven", value: "7", expected: 7 },
	{ name: "maximum", value: "255", expected: 255 },
	{ name: "missing", value: "undefined", expected: 1 },
	{ name: "null-result", value: "null", expected: 1 },
	{ name: "string-result", value: '"7"', expected: 1 },
	{ name: "boolean-result", value: "true", expected: 1 },
	{ name: "fractional", value: "7.5", expected: 1 },
	{ name: "negative", value: "-1", expected: 1 },
	{ name: "over-maximum", value: "256", expected: 1 },
	{ name: "nan-result", value: "NaN", expected: 1 },
	{ name: "infinite", value: "Infinity", expected: 1 },
] as const;

beforeAll(() => {
	ordinary = prepare();
	build(ordinary);
}, 60_000);

function exitFixture(): Fixture {
	if (!exits) {
		exits = prepare(
			Object.fromEntries(
				outcomes.map(({ name, value }) => [
					`commands/${name}.ts`,
					command(name, `return (${value}) as unknown as number;`),
				]),
			),
		);
		build(exits);
	}
	return exits;
}

afterAll(() => {
	for (const link of links) unlinkSync(link);
	for (const root of roots) {
		expect(path.dirname(root)).toBe(path.resolve(tmpdir()));
		expect(path.basename(root).startsWith("draftyak-cli-adversarial-")).toBe(true);
		expect(realpathSync.native(root)).toBe(path.resolve(root));
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
});

it("imports the staged ESM entries without output, process hooks or active native resources", () => {
	expect(JSON.parse(readFileSync(path.join(ordinary.cli, "package.json"), "utf8")).type).toBe(
		"module",
	);
	const result = runner(
		ordinary,
		`await new Promise(resolve => setImmediate(resolve));
// Node lazily wraps the already inherited stdio descriptors.
void process.stdout; void process.stderr;
const events = ["exit", "beforeExit", "SIGINT", "SIGTERM", "SIGHUP"];
const listeners = events.map(event => process.listenerCount(event));
const resources = process.getActiveResourcesInfo().sort();
await import("./cli/main.mjs");
await import("./cli/payload-contract.mjs");
await import("./cli/doctor/loader.js");
await new Promise(resolve => setImmediate(resolve));
if (JSON.stringify(listeners) !== JSON.stringify(events.map(event => process.listenerCount(event)))) process.exitCode = 71;
if (JSON.stringify(resources) !== JSON.stringify(process.getActiveResourcesInfo().sort())) process.exitCode = 72;`,
	);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("");
});

it.each([[], ["help"], ["--help"], ["-h"]].map((argv) => ({ argv })))(
	"runs actual help without using stdout: $argv",
	({ argv }) => {
		const result = invoke(ordinary, argv);
		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("Usage: draftyak <command>\nCommands:\nhelp\n");
	},
);

it.each([["mcp"], ["mcp", "--unknown"], ["not-installed"], ["../help"]].map((argv) => ({ argv })))(
	"refuses an unavailable command with empty stdout: $argv",
	({ argv }) => {
		const result = invoke(ordinary, argv);
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("Command refused.\n");
	},
);

it("keeps a literal native argv snapshot independent of caller mutation and process.argv", () => {
	const argv = ["literal", "", "DYTEST spaces", "$(DYTEST)", ";&|", "*", "--", "--x=a=b", "é", "é"];
	const fixture = prepare({
		"commands/literal.ts": command(
			"literal",
			`await new Promise(resolve => setTimeout(resolve, 10));
return JSON.stringify(argv) === ${JSON.stringify(JSON.stringify(argv))} ? 7 : 73;`,
		),
	});
	build(fixture);
	const result = runner(
		fixture,
		`import { main } from "./cli/main.mjs";
const original = process.argv.slice(2);
const argv = [...original];
const pending = main(argv);
argv.splice(0, argv.length, "mcp");
process.exitCode = await pending;
if (JSON.stringify(original) !== JSON.stringify(process.argv.slice(2))) process.exitCode = 74;`,
		argv,
	);
	expect(result.status, result.stderr).toBe(7);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("");
});

it("loads only its owned relative module closure under CommonJS and poisoned ancestor resolution", () => {
	const fixture = prepare({
		"dytest-helper.ts": "export const result: number = 7;",
		"commands/relative.ts": `import { result } from "../dytest-helper.ts";\n${command("relative", "return result;")}`,
	});
	const poisoned = path.join(fixture.installed, "node_modules/dytest-helper");
	mkdirSync(poisoned, { recursive: true });
	writeFileSync(path.join(poisoned, "package.json"), '{"type":"module","main":"index.js"}\n');
	writeFileSync(
		path.join(poisoned, "index.js"),
		`import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(fixture.marker)}, "DYTEST"); export const result = 7;`,
	);
	build(fixture);
	const result = runner(
		fixture,
		'import { main } from "./cli/main.mjs"; process.exitCode = await main(["relative"]);',
		[],
		{ NODE_PATH: path.dirname(poisoned) },
	);
	expect(result.status, result.stderr).toBe(7);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("");
	expect(existsSync(fixture.marker)).toBe(false);
});

it.each(outcomes)("validates the awaited native handler exit for $name", ({ name, expected }) => {
	const result = invoke(exitFixture(), [name]);
	expect(result.status).toBe(expected);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe(expected === 1 ? "Command refused.\n" : "");
});

it("does not import unrelated commands when rejecting unavailable MCP and unknown invocations", () => {
	const fixture = prepare();
	writeFileSync(
		path.join(fixture.source, "src/commands/inactive.ts"),
		`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(fixture.marker)}, "DYTEST");
${command("inactive", "return 0;")}`,
	);
	build(fixture);
	for (const argv of [["mcp"], ["mcp", "--help"], ["not-installed"]]) {
		const result = invoke(fixture, argv);
		expect(result.status).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("Command refused.\n");
		expect(existsSync(fixture.marker)).toBe(false);
	}
});

it("refuses accessor and Proxy argv records without invoking their caller code", () => {
	const result = runner(
		ordinary,
		`import { main } from "./cli/main.mjs";
let reads = 0;
const accessor = [];
Object.defineProperty(accessor, "0", { get() { reads++; throw new Error("DYTEST-accessor"); } });
const proxy = new Proxy(["help"], { get() { reads++; throw new Error("DYTEST-proxy"); } });
const results = [await main(accessor), await main(proxy)];
if (JSON.stringify(results) !== "[1,1]" || reads !== 0) process.exitCode = 76;`,
	);
	expect(result.status).toBe(0);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("Command refused.\nCommand refused.\n");
});

it("refuses an extra installed command before executing its module body", () => {
	const fixture = prepare();
	build(fixture);
	writeFileSync(
		path.join(fixture.cli, "commands/intruder.js"),
		`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(fixture.marker)}, "DYTEST");
export const command = { name: "intruder", async run() { return 0; } };`,
	);
	const result = invoke(fixture, ["intruder"]);
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("Command refused.\n");
	expect(existsSync(fixture.marker)).toBe(false);
});

it.each([
	{ label: "duplicate logical name", contents: command("help", "return 0;") },
	{
		label: "extra namespace export",
		contents: `${command("malformed", "return 0;")}\nexport const extra: boolean = true;`,
	},
	{
		label: "nonfunction handler",
		contents: 'export const command: unknown = { name: "malformed", run: 7 };',
	},
])("refuses a compiled $label before reporting successful help", ({ contents }) => {
	const fixture = prepare({ "commands/malformed.ts": contents });
	build(fixture);
	const result = invoke(fixture, ["help"]);
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("Command refused.\n");
});

it("refuses descriptor accessors without invoking their getters", () => {
	const fixture = prepare();
	writeFileSync(
		path.join(fixture.source, "src/commands/accessor.ts"),
		`import { writeFileSync } from "node:fs";
export const command: Record<string, unknown> = { run: async () => 0 };
Object.defineProperty(command, "name", { get() {
writeFileSync(${JSON.stringify(fixture.marker)}, "DYTEST"); return "accessor"; } });`,
	);
	build(fixture);
	const result = invoke(fixture, ["accessor"]);
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("Command refused.\n");
	expect(existsSync(fixture.marker)).toBe(false);
});

it("reports an actual empty doctor catalog as unavailable", () => {
	const result = runner(
		ordinary,
		'import { runDoctorChecks } from "./cli/doctor/loader.js"; process.stdout.write(JSON.stringify(await runDoctorChecks("local")));',
	);
	expect(result.status).toBe(0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual({ available: false, checks: [], exitCode: 1 });
});

it("discovers separately compiled checks and awaits deterministic mode-specific results", () => {
	const fixture = prepare({
		"doctor/checks/alpha.ts": `import type { DoctorCheck } from "../contract.ts";
export const check: DoctorCheck = { id: "alpha", modes: ["local", "public"], async run() {
await new Promise(resolve => setTimeout(resolve, 10)); return "ok"; } };`,
		"doctor/checks/beta.ts": `import type { DoctorCheck } from "../contract.ts";
export const check: DoctorCheck = { id: "beta", modes: ["local"], async run() { return "warn"; } };`,
		"doctor/checks/gamma.ts": `import type { DoctorCheck } from "../contract.ts";
export const check: DoctorCheck = { id: "gamma", modes: ["public"], async run() { return "error"; } };`,
	});
	build(fixture);
	const result = runner(
		fixture,
		`import { runDoctorChecks } from "./cli/doctor/loader.js";
process.stdout.write(JSON.stringify([await runDoctorChecks("local"), await runDoctorChecks("public")]));`,
	);
	expect(result.status, result.stderr).toBe(0);
	expect(result.stderr).toBe("");
	expect(JSON.parse(result.stdout)).toEqual([
		{
			available: true,
			checks: [
				{ id: "alpha", status: "ok" },
				{ id: "beta", status: "warn" },
			],
			exitCode: 0,
		},
		{
			available: true,
			checks: [
				{ id: "alpha", status: "ok" },
				{ id: "gamma", status: "error" },
			],
			exitCode: 1,
		},
	]);
});

function doctorResultFixture(): Fixture {
	if (!doctorResults) {
		const results = [
			["alpha-ok", 'return "ok";'],
			["beta-warn", 'return "warn";'],
			["charlie-error", 'return "error";'],
			["delta-string", 'return "DYTEST-private-result";'],
			["echo-object", 'return { status: "ok", detail: "DYTEST-private-object" };'],
			["foxtrot-throw", 'throw new Error("DYTEST-private-exception");'],
			["golf-reject", 'return Promise.reject("DYTEST-private-rejection");'],
			["hotel-undefined", "return undefined;"],
		] as const;
		doctorResults = prepare(
			Object.fromEntries(
				results.map(([id, body]) => [
					`doctor/checks/${id}.ts`,
					`export const check: unknown = { id: ${JSON.stringify(id)}, modes: ["local", "public"], async run() { ${body} } };`,
				]),
			),
		);
		build(doctorResults);
	}
	return doctorResults;
}

it.each(["local", "public"])(
	"projects compiled doctor results to exact IDs and fixed statuses in %s mode",
	(mode) => {
		const result = runner(
			doctorResultFixture(),
			`import { runDoctorChecks } from "./cli/doctor/loader.js";
process.stdout.write(JSON.stringify(await runDoctorChecks(${JSON.stringify(mode)})));`,
		);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			available: true,
			checks: [
				{ id: "alpha-ok", status: "ok" },
				{ id: "beta-warn", status: "warn" },
				{ id: "charlie-error", status: "error" },
				{ id: "delta-string", status: "error" },
				{ id: "echo-object", status: "error" },
				{ id: "foxtrot-throw", status: "error" },
				{ id: "golf-reject", status: "error" },
				{ id: "hotel-undefined", status: "error" },
			],
			exitCode: 1,
		});
		expect(result.stdout).not.toContain("DYTEST-private");
	},
);

it.each([
	{
		label: "duplicate mode",
		descriptor: '{ id: "malformed", modes: ["local", "local"], async run() { return "ok"; } }',
	},
	{
		label: "duplicate logical ID",
		descriptor: '{ id: "alpha", modes: ["local"], async run() { return "ok"; } }',
	},
])("refuses a compiled doctor $label before invoking any check", ({ descriptor }) => {
	const fixture = prepare();
	writeFileSync(
		path.join(fixture.source, "src/doctor/checks/alpha.ts"),
		`import { writeFileSync } from "node:fs";
import type { DoctorCheck } from "../contract.ts";
export const check: DoctorCheck = { id: "alpha", modes: ["local"], async run() {
writeFileSync(${JSON.stringify(fixture.marker)}, "DYTEST"); return "ok"; } };`,
	);
	writeFileSync(
		path.join(fixture.source, "src/doctor/checks/malformed.ts"),
		`export const check: unknown = ${descriptor};`,
	);
	build(fixture);
	const result = runner(
		fixture,
		`import { runDoctorChecks } from "./cli/doctor/loader.js";
try { await runDoctorChecks("local"); process.exitCode = 75; }
catch (error) { process.stderr.write(error.message + "\\n"); process.exitCode = 1; }`,
	);
	expect(result.status).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toBe("Command refused.\n");
	expect(existsSync(fixture.marker)).toBe(false);
});
