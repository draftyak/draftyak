import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspace = path.resolve(packageRoot, "../..");
const temporary = realpathSync(os.tmpdir());
const owned = new Set<string>();

afterEach(() => {
	for (const root of owned) {
		if (path.dirname(root) !== temporary || !path.basename(root).startsWith("draftyak-cli-build-"))
			throw new Error("Invalid cleanup scope");
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
	owned.clear();
});

function fixture(): { root: string; cli: string } {
	const root = mkdtempSync(path.join(temporary, "draftyak-cli-build-"));
	owned.add(root);
	const cli = path.join(root, "workspace/apps/cli");
	mkdirSync(cli, { recursive: true });
	for (const name of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"])
		cpSync(path.join(packageRoot, name), path.join(cli, name), { recursive: true });
	cpSync(
		path.join(workspace, "tsconfig.base.json"),
		path.join(root, "workspace/tsconfig.base.json"),
	);
	const require = createRequire(import.meta.url);
	for (const name of ["typescript", "@types/node"]) {
		const target = realpathSync(path.dirname(require.resolve(`${name}/package.json`)));
		const link = path.join(cli, "node_modules", name);
		mkdirSync(path.dirname(link), { recursive: true });
		symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
	}
	return { root, cli };
}

function add(cli: string, file: string, code: string): void {
	const filename = path.join(cli, "src", file);
	mkdirSync(path.dirname(filename), { recursive: true });
	writeFileSync(filename, code);
}

function build(cli: string): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [path.join(cli, "scripts/build.ts")], {
		cwd: cli,
		encoding: "utf8",
		timeout: 60_000,
		windowsHide: true,
	});
}

function invoke(entry: string, argv: readonly string[]): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		const { main } = await import(${JSON.stringify(pathToFileURL(entry).href)});
		process.exitCode = await main(${JSON.stringify(argv)});
	`,
		],
		{ encoding: "utf8", timeout: 30_000, windowsHide: true, cwd: path.dirname(entry) },
	);
}

function stage(root: string, cli: string): string {
	const staged = path.join(root, "isolated/cli");
	mkdirSync(path.dirname(staged), { recursive: true });
	writeFileSync(path.join(root, "isolated/package.json"), '{"type":"commonjs"}');
	cpSync(path.join(cli, "dist"), staged, { recursive: true });
	return staged;
}

it("discovers added command/check files in source and actual compiled closure without registration", () => {
	const { root, cli } = fixture();
	add(cli, "support/exit.ts", "export const exit: number = 7;\n");
	add(
		cli,
		"commands/alpha.ts",
		`
		import type { Command } from '../command-contract.ts';
		import { exit } from '../support/exit.ts';
		export const command: Command = { name: 'alpha', async run(): Promise<number> { return exit; } };
	`,
	);
	add(
		cli,
		"doctor/checks/pulse.ts",
		`
		import type { DoctorCheck, DoctorStatus } from '../contract.ts';
		export const check: DoctorCheck = { id: 'pulse', modes: ['local'], async run(): Promise<DoctorStatus> { return 'warn'; } };
	`,
	);
	const source = invoke(path.join(cli, "src/main.ts"), ["alpha"]);
	expect({ status: source.status, stdout: source.stdout, stderr: source.stderr }).toEqual({
		status: 7,
		stdout: "",
		stderr: "",
	});
	const compiled = build(cli);
	expect({ status: compiled.status, stderr: compiled.stderr }).toEqual({ status: 0, stderr: "" });
	const staged = stage(root, cli);
	expect(existsSync(path.join(staged, "support/exit.js"))).toBe(true);
	const result = invoke(path.join(staged, "main.mjs"), ["alpha"]);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 7,
		stdout: "",
		stderr: "",
	});
	const help = invoke(path.join(staged, "main.mjs"), ["help"]);
	expect({ status: help.status, stdout: help.stdout, stderr: help.stderr }).toEqual({
		status: 0,
		stdout: "",
		stderr: "Usage: draftyak <command>\nCommands:\nalpha\nhelp\n",
	});
	const doctor = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
		const { runDoctorChecks } = await import(${JSON.stringify(pathToFileURL(path.join(staged, "doctor/loader.js")).href)});
		console.log(JSON.stringify(await runDoctorChecks('local')));
	`,
		],
		{ encoding: "utf8", timeout: 30_000, windowsHide: true },
	);
	expect(doctor.status).toBe(0);
	expect(doctor.stderr).toBe("");
	expect(JSON.parse(doctor.stdout)).toEqual({
		available: true,
		checks: [{ id: "pulse", status: "warn" }],
		exitCode: 0,
	});
});

it("refuses a changed installed module before invoking it", () => {
	const { root, cli } = fixture();
	expect(build(cli).status).toBe(0);
	const staged = stage(root, cli);
	const filename = path.join(staged, "commands/help.js");
	writeFileSync(filename, `${readFileSync(filename, "utf8")}\n// DYTEST changed bytes\n`);
	const result = invoke(path.join(staged, "main.mjs"), ["help"]);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 1,
		stdout: "",
		stderr: "Command refused.\n",
	});
});

it.each(["commands/UPPER.ts", "commands/nested/hidden.ts", "doctor/checks/UPPER.ts"])(
	"refuses malformed registry filename %s at build time",
	(file) => {
		const { cli } = fixture();
		add(cli, file, "export const value: number = 1;\n");
		expect(build(cli).status).not.toBe(0);
		expect(existsSync(path.join(cli, "dist/main.mjs"))).toBe(false);
	},
);

it.each(["bare", "outside", "computed"] as const)(
	"refuses %s imports outside the owned JS closure",
	(kind) => {
		const { cli } = fixture();
		let dependency = "";
		if (kind === "bare") {
			const ancestor = path.join(cli, "node_modules/dytest-ancestor");
			mkdirSync(ancestor, { recursive: true });
			writeFileSync(
				path.join(ancestor, "package.json"),
				'{"type":"module","exports":"./index.js","types":"./index.d.ts"}',
			);
			writeFileSync(
				path.join(ancestor, "index.js"),
				"throw new Error('DYTEST ancestor executed');",
			);
			writeFileSync(path.join(ancestor, "index.d.ts"), "export {};\n");
			dependency = "import 'dytest-ancestor';";
		} else if (kind === "outside") {
			writeFileSync(path.join(cli, "outside.ts"), "export {};\n");
			dependency = "import '../../outside.ts';";
		} else dependency = "await import(String(process.env.DYTEST_UNUSED));";
		add(
			cli,
			"commands/alpha.ts",
			`${dependency}
		import type { Command } from '../command-contract.ts';
		export const command: Command = { name: 'alpha', async run(): Promise<number> { return 0; } };
	`,
		);
		expect(build(cli).status).not.toBe(0);
		expect(existsSync(path.join(cli, "dist/main.mjs"))).toBe(false);
	},
);
