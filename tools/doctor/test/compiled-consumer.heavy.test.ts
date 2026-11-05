import { spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	isCallExpression,
	isExportDeclaration,
	isImportDeclaration,
	isStringLiteralLikeNode,
	type Node,
	SyntaxKind,
} from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { expect, it } from "vitest";

const workspace = fileURLToPath(new URL("../../../", import.meta.url));
const cli = path.join(workspace, "apps/cli");

function childEnvironment(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { DO_NOT_TRACK: "1", TURBO_TELEMETRY_DISABLED: "1" };
	for (const key of ["SystemRoot", "WINDIR", "PATH", "Path", "TEMP", "TMP"])
		if (process.env[key] !== undefined) env[key] = process.env[key];
	return env;
}

function removeFixture(
	root: string,
	temporary: string,
	identity: { readonly dev: number; readonly ino: number },
): void {
	const current = lstatSync(root);
	if (
		path.dirname(root) !== temporary ||
		!path.basename(root).startsWith("draftyak-doctor-compiled-") ||
		!current.isDirectory() ||
		current.isSymbolicLink() ||
		current.dev !== identity.dev ||
		current.ino !== identity.ino ||
		realpathSync.native(root) !== root
	)
		throw new Error("Invalid compiled doctor cleanup scope");
	rmSync(root, { recursive: true, force: true });
	expect(existsSync(root)).toBe(false);
}

function assertClosedImports(root: string, installed: string): void {
	const files: string[] = [];
	function visit(directory: string): void {
		for (const name of readdirSync(directory)) {
			const file = path.join(directory, name);
			const stat = lstatSync(file);
			expect(stat.isSymbolicLink()).toBe(false);
			if (stat.isDirectory()) visit(file);
			else if (/\.[cm]?js$/.test(name)) files.push(file);
		}
	}
	visit(installed);
	const config = path.join(root, "scan.json");
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: { allowJs: true, noEmit: true, noLib: true, noResolve: true, types: [] },
			files,
		}),
	);
	const api = new API();
	try {
		using snapshot = api.updateSnapshot({ openProjects: [config] });
		const project = snapshot.getProject(config);
		if (!project) throw new Error("Compiled doctor scan did not open");
		for (const file of files) {
			const ast = project.program.getSourceFile(file);
			if (!ast) throw new Error("Compiled doctor module was not parsed");
			expect(project.program.getSyntacticDiagnostics(file)).toHaveLength(0);
			function specifier(value: string): void {
				if (isBuiltin(value)) return;
				expect(value.startsWith("./") || value.startsWith("../")).toBe(true);
				const target = path.resolve(path.dirname(file), value);
				const relative = path.relative(installed, target);
				expect(
					path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`),
				).toBe(false);
				expect(files).toContain(target);
			}
			function inspect(node: Node): void {
				if (
					(isImportDeclaration(node) || isExportDeclaration(node)) &&
					node.moduleSpecifier &&
					isStringLiteralLikeNode(node.moduleSpecifier)
				)
					specifier(node.moduleSpecifier.text);
				if (isCallExpression(node) && node.expression.kind === SyntaxKind.ImportKeyword) {
					const argument = node.arguments[0];
					if (argument && isStringLiteralLikeNode(argument)) specifier(argument.text);
				}
				node.forEachChild(inspect);
			}
			inspect(ast);
		}
	} finally {
		api.close();
	}
}

it("keeps canonical synced-path refusal and Node admission in the installed compiled doctor", () => {
	const temporary = realpathSync.native(os.tmpdir());
	const root = mkdtempSync(path.join(temporary, "draftyak-doctor-compiled-"));
	const identity = lstatSync(root);
	try {
		const compiler = path.join(
			path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
			"bin/tsc",
		);
		const declarations = spawnSync(
			process.execPath,
			[compiler, "-p", "tsconfig.declarations.json"],
			{
				cwd: path.join(workspace, "tools/doctor"),
				env: childEnvironment(),
				encoding: "utf8",
				timeout: 30_000,
				windowsHide: true,
			},
		);
		expect({
			status: declarations.status,
			stdout: declarations.stdout,
			stderr: declarations.stderr,
		}).toEqual({ status: 0, stdout: "", stderr: "" });
		const build = spawnSync(process.execPath, [path.join(cli, "scripts/build.ts")], {
			cwd: cli,
			env: childEnvironment(),
			encoding: "utf8",
			timeout: 60_000,
			windowsHide: true,
		});
		expect({ status: build.status, stdout: build.stdout, stderr: build.stderr }).toEqual({
			status: 0,
			stdout: "CLI payload built.\n",
			stderr: "",
		});
		const installed = path.join(root, "installed/cli");
		mkdirSync(path.dirname(installed));
		writeFileSync(path.join(root, "installed/package.json"), '{"type":"commonjs"}\n');
		cpSync(path.join(cli, "dist"), installed, { recursive: true });
		expect(existsSync(path.join(root, "node_modules"))).toBe(false);
		expect(existsSync(path.join(root, "installed/node_modules"))).toBe(false);
		assertClosedImports(root, installed);
		const command = pathToFileURL(path.join(installed, "commands/doctor.js")).href;
		const execute = (source: string) =>
			spawnSync(process.execPath, ["--disable-sigusr1", "--input-type=module", "-e", source], {
				cwd: path.join(root, "installed"),
				env: childEnvironment(),
				encoding: "utf8",
				timeout: 30_000,
				maxBuffer: 16_384,
				windowsHide: true,
			});
		const unsupported = execute(`
import assert from 'node:assert/strict';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
let diagnosticCalls = 0;
const dataRoot = ${JSON.stringify(path.join(root, "OneDrive"))};
for (const [object, names] of [
 [fs, ['lstatSync', 'realpathSync', 'statSync', 'readdirSync', 'readFileSync', 'openSync']],
 [promises, ['lstat', 'realpath', 'stat', 'readdir', 'readFile', 'open']]
]) for (const name of names) {
 const original = object[name];
 object[name] = function(...args) {
  if (typeof args[0] === 'string' && args[0].startsWith(dataRoot)) {
   diagnosticCalls++; throw new Error('DYTEST data directory touched before admission');
  }
  return Reflect.apply(original, this, args);
 };
 Object.assign(object[name], original);
}
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
 childProcess[name] = () => {
  diagnosticCalls++; throw new Error('DYTEST diagnostic subprocess before admission');
 };
};
syncBuiltinESMExports();
const { command } = await import(${JSON.stringify(command)});
assert.equal(diagnosticCalls, 0);
Object.defineProperty(process, 'version', { value: 'v0.0.0' });
const output = [];
const exit = await command.run(['doctor', '--data-dir', ${JSON.stringify(path.join(root, "OneDrive/absent/data"))}],
 { commands: ['doctor', 'help'], stderr: text => output.push(text) });
assert.equal(exit, 1);
const report = JSON.parse(output.join(''));
assert.equal(report.format, 'draftyak-doctor-v1');
assert.equal(report.checks.length, 1);
assert.equal(report.checks[0].code, 'NODE_UNSUPPORTED');
assert.equal(diagnosticCalls, 0);
console.log('DYTEST inert import and unsupported Node refused');
`);
		expect({
			status: unsupported.status,
			stdout: unsupported.stdout,
			stderr: unsupported.stderr,
		}).toEqual({
			status: 0,
			stdout: "DYTEST inert import and unsupported Node refused\n",
			stderr: "",
		});
		for (const [relative, expectedCode, expectedStatus] of [
			["OneDrive/absent/data", "DATA_DIR_SYNCED", "fail"],
			["OneDriveish/absent/data", "DATA_DIR_ABSENT", "warn"],
		] as const) {
			const requested = path.join(root, relative);
			const result = execute(`
const { command } = await import(${JSON.stringify(command)});
const output = [];
const exit = await command.run(['doctor', '--data-dir', ${JSON.stringify(requested)}],
 { commands: ['doctor', 'help'], stderr: text => output.push(text) });
console.log(JSON.stringify({ exit, report: JSON.parse(output.join('')) }));
`);
			expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" });
			const { exit, report } = JSON.parse(result.stdout);
			expect(report.format).toBe("draftyak-doctor-v1");
			const check = report.checks.find((entry: { id: string }) => entry.id === "data_directory");
			expect(check).toEqual({
				id: "data_directory",
				status: expectedStatus,
				code: expectedCode,
				message:
					expectedCode === "DATA_DIR_SYNCED"
						? "Choose a local unsynced data directory."
						: "Directory is absent; its existing ancestor passed the known path checks.",
			});
			expect(exit).toBe(expectedStatus === "fail" ? 1 : 0);
			expect(result.stdout).not.toContain(requested);
			expect(existsSync(requested)).toBe(false);
		}
	} finally {
		removeFixture(root, temporary, identity);
	}
});
