import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
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
import { afterEach, expect, it } from "vitest";
import { kernelFixtureSource } from "./kernel-fixture.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspaceRoot = path.resolve(packageRoot, "../..");
const temporary = realpathSync.native(os.tmpdir());
const roots = new Map<string, { readonly dev: number; readonly ino: number }>();

afterEach(() => {
	for (const [root, identity] of roots) {
		const current = lstatSync(root);
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-cli-dependencies-") ||
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			current.dev !== identity.dev ||
			current.ino !== identity.ino ||
			realpathSync.native(root) !== root
		)
			throw new Error("Invalid dependency fixture cleanup scope");
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
	roots.clear();
});

function childEnvironment(): NodeJS.ProcessEnv {
	const result: NodeJS.ProcessEnv = { DO_NOT_TRACK: "1", TURBO_TELEMETRY_DISABLED: "1" };
	for (const key of [
		"SystemRoot",
		"WINDIR",
		"COMSPEC",
		"PATHEXT",
		"PATH",
		"Path",
		"TEMP",
		"TMP",
		"USERPROFILE",
		"LOCALAPPDATA",
		"APPDATA",
		"HOME",
		"DRAFTYAK_CACHE_DIR",
		"DRAFTYAK_TEST_NODE_CACHE",
	]) {
		const value = process.env[key];
		if (value !== undefined) result[key] = value;
	}
	return result;
}

interface Fixture {
	readonly root: string;
	readonly workspace: string;
	readonly cli: string;
}

function put(root: string, relative: string, text: string): void {
	const file = path.join(root, relative);
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, text);
}

function linkPackage(root: string, name: string, target: string): void {
	const destination = path.join(root, "node_modules", name);
	mkdirSync(path.dirname(destination), { recursive: true });
	symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
}

function fixture(): Fixture {
	const root = mkdtempSync(path.join(temporary, "draftyak-cli-dependencies-"));
	const identity = lstatSync(root);
	roots.set(root, { dev: identity.dev, ino: identity.ino });
	const workspace = path.join(root, "workspace");
	const cli = path.join(workspace, "apps/cli");
	mkdirSync(cli, { recursive: true });
	for (const name of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"])
		cpSync(path.join(packageRoot, name), path.join(cli, name), {
			recursive: true,
			filter: kernelFixtureSource,
		});
	cpSync(
		path.join(workspaceRoot, "tsconfig.base.json"),
		path.join(workspace, "tsconfig.base.json"),
	);
	put(workspace, "package.json", '{"private":true,"type":"module"}\n');
	put(workspace, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
	const require = createRequire(import.meta.url);
	for (const name of ["typescript", "@types/node", "rolldown"])
		linkPackage(
			cli,
			name,
			realpathSync.native(path.dirname(require.resolve(`${name}/package.json`))),
		);
	return { root, workspace, cli };
}

function dependencies(root: string, names: readonly string[]): void {
	const file = path.join(root, "package.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	manifest.dependencies = Object.fromEntries(names.map((name) => [name, "workspace:*"]));
	writeFileSync(file, `${JSON.stringify(manifest)}\n`);
}

function workspacePackage(f: Fixture, name: string, source: string, declaration: string): string {
	const root = path.join(f.workspace, "packages", name.slice(name.lastIndexOf("/") + 1));
	put(
		root,
		"package.json",
		JSON.stringify({
			name,
			private: true,
			type: "module",
			exports: { ".": { types: "./dist/index.d.ts", default: "./src/index.ts" } },
		}),
	);
	put(root, "src/index.ts", source);
	put(root, "dist/index.d.ts", declaration);
	linkPackage(f.cli, name, root);
	return root;
}

function command(f: Fixture, body: string, imports = ""): void {
	put(
		f.cli,
		"src/commands/dependency.ts",
		`
import type { Command } from '../command-contract.ts';
${imports}
export const command: Command = {
 name: 'dependency',
 async run(argv, context): Promise<number> { ${body} }
};\n`,
	);
}

function build(f: Fixture): SpawnSyncReturns<string> {
	return spawnSync(process.execPath, [path.join(f.cli, "scripts/build.ts")], {
		cwd: f.cli,
		env: childEnvironment(),
		encoding: "utf8",
		timeout: 60_000,
		windowsHide: true,
	});
}

function built(f: Fixture): string {
	const result = build(f);
	expect({ status: result.status, stderr: result.stderr }).toEqual({
		status: 0,
		stderr: "",
	});
	const staged = path.join(f.root, "isolated/cli");
	put(f.root, "isolated/package.json", '{"type":"commonjs"}\n');
	cpSync(path.join(f.cli, "dist"), staged, { recursive: true });
	// Runtime resolution cannot fall back to the original workspace or its dependency links.
	const retired = path.join(f.root, "retired-workspace");
	if (path.dirname(f.workspace) !== f.root || path.dirname(retired) !== f.root)
		throw new Error("Invalid dependency fixture move scope");
	renameSync(f.workspace, retired);
	expect(existsSync(f.workspace)).toBe(false);
	expect(existsSync(path.join(f.root, "isolated/node_modules"))).toBe(false);
	return staged;
}

function invoke(staged: string, args: readonly string[]): SpawnSyncReturns<string> {
	return spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
const { main } = await import(${JSON.stringify(pathToFileURL(path.join(staged, "main.mjs")).href)});
process.exitCode = await main(${JSON.stringify(args)});
`,
		],
		{
			cwd: path.dirname(staged),
			env: childEnvironment(),
			encoding: "utf8",
			timeout: 30_000,
			windowsHide: true,
		},
	);
}

function assertClosedImports(f: Fixture, staged: string): void {
	const files: string[] = [];
	function visit(directory: string): void {
		for (const name of readdirSync(directory)) {
			const file = path.join(directory, name);
			if (lstatSync(file).isDirectory()) visit(file);
			else if (/\.[cm]?js$/.test(name)) files.push(file);
		}
	}
	visit(staged);
	const config = path.join(f.root, "import-scan/tsconfig.json");
	put(
		f.root,
		"import-scan/tsconfig.json",
		JSON.stringify({
			compilerOptions: { allowJs: true, noEmit: true, noLib: true, noResolve: true, types: [] },
			files,
		}),
	);
	const api = new API();
	try {
		using snapshot = api.updateSnapshot({ openProjects: [config] });
		const project = snapshot.getProject(config);
		if (!project) throw new Error("Compiled dependency scan did not open");
		for (const file of files) {
			const ast = project.program.getSourceFile(file);
			if (!ast) throw new Error("Compiled dependency module was not parsed");
			expect(project.program.getSyntacticDiagnostics(file)).toHaveLength(0);
			function specifier(value: string): void {
				if (isBuiltin(value)) return;
				expect(value.startsWith("./") || value.startsWith("../")).toBe(true);
				const target = path.resolve(path.dirname(file), value);
				const relative = path.relative(staged, target);
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

function expectRefused(f: Fixture): void {
	const result = build(f);
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("CLI build refused.");
	expect(result.stdout + result.stderr).not.toMatch(/error TS\d+:/);
	expect(existsSync(path.join(f.cli, "dist/main.mjs"))).toBe(false);
}

it("runs a declared workspace dependency and its relative source from the sealed compiled CLI", () => {
	const f = fixture();
	const name = "@draftyak/build-fixture";
	const dependency = workspacePackage(
		f,
		name,
		'export { value } from "./value.ts";\n',
		"export declare const value: string;\n",
	);
	put(dependency, "src/value.ts", 'export const value: string = "DYTEST bundled value";\n');
	dependencies(f.cli, [name]);
	command(
		f,
		'return value === "DYTEST bundled value" ? 7 : 8;',
		`import { value } from '${name}';`,
	);
	const staged = built(f);
	assertClosedImports(f, staged);
	const result = invoke(staged, ["dependency"]);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 7,
		stdout: "",
		stderr: "",
	});
});

it("includes each declared transitive workspace dependency in the compiled closure", () => {
	const f = fixture();
	const direct = "@draftyak/build-fixture",
		transitive = "@draftyak/build-transitive";
	const first = workspacePackage(
		f,
		direct,
		`export { value } from '${transitive}';\n`,
		"export declare const value: string;\n",
	);
	const second = workspacePackage(
		f,
		transitive,
		'export const value: string = "DYTEST transitive";\n',
		"export declare const value: string;\n",
	);
	dependencies(f.cli, [direct]);
	dependencies(first, [transitive]);
	linkPackage(first, transitive, second);
	command(f, 'return value === "DYTEST transitive" ? 9 : 8;', `import { value } from '${direct}';`);
	const staged = built(f);
	assertClosedImports(f, staged);
	const result = invoke(staged, ["dependency"]);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 9,
		stdout: "",
		stderr: "",
	});
});

it("refuses a resolvable workspace import absent from CLI runtime dependencies", () => {
	const f = fixture();
	workspacePackage(
		f,
		"@draftyak/build-fixture",
		"export const value: number = 7;\n",
		"export declare const value: number;\n",
	);
	command(f, "return value;", 'import { value } from "@draftyak/build-fixture";');
	expectRefused(f);
});

it("refuses a dependency's resolvable undeclared transitive workspace import", () => {
	const f = fixture();
	const direct = "@draftyak/build-fixture",
		transitive = "@draftyak/build-transitive";
	const first = workspacePackage(
		f,
		direct,
		`export { value } from '${transitive}';\n`,
		"export declare const value: number;\n",
	);
	const second = workspacePackage(
		f,
		transitive,
		"export const value: number = 7;\n",
		"export declare const value: number;\n",
	);
	dependencies(f.cli, [direct]);
	linkPackage(first, transitive, second);
	command(f, "return value;", `import { value } from '${direct}';`);
	expectRefused(f);
});

it("refuses a workspace dependency's relative import escaping its package", () => {
	const f = fixture();
	workspacePackage(
		f,
		"@draftyak/build-fixture",
		'export { value } from "../../outside.ts";\n',
		"export declare const value: number;\n",
	);
	put(f.workspace, "packages/outside.ts", "export const value: number = 7;\n");
	dependencies(f.cli, ["@draftyak/build-fixture"]);
	command(f, "return value;", 'import { value } from "@draftyak/build-fixture";');
	expectRefused(f);
});

function externalFixture(): {
	readonly fixture: Fixture;
	readonly owner: string;
	readonly external: string;
} {
	const f = fixture();
	const direct = "@draftyak/build-fixture";
	const owner = workspacePackage(
		f,
		direct,
		'export { value } from "zod";\n',
		"export declare const value: string;\n",
	);
	const ownerManifest = JSON.parse(readFileSync(path.join(owner, "package.json"), "utf8"));
	ownerManifest.dependencies = { zod: "4.6.7" };
	put(owner, "package.json", JSON.stringify(ownerManifest));
	const external = path.join(f.workspace, "node_modules/.pnpm/zod@4.6.7/node_modules/zod");
	put(
		external,
		"package.json",
		JSON.stringify({
			name: "zod",
			version: "4.6.7",
			type: "module",
			exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
		}),
	);
	put(external, "index.js", 'export const value = "DYTEST synthetic external";\n');
	put(external, "index.d.ts", "export declare const value: string;\n");
	linkPackage(owner, "zod", external);
	cpSync(path.join(workspaceRoot, "pnpm-lock.yaml"), path.join(f.workspace, "pnpm-lock.yaml"));
	dependencies(f.cli, [direct]);
	command(
		f,
		'return value === "DYTEST synthetic external" ? 11 : 8;',
		`import { value } from '${direct}';`,
	);
	return { fixture: f, owner, external };
}

it("bundles an exact locked external runtime dependency declared by a workspace package", () => {
	const { fixture: f } = externalFixture();
	const staged = built(f);
	assertClosedImports(f, staged);
	const result = invoke(staged, ["dependency"]);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 11,
		stdout: "",
		stderr: "",
	});
});

it("builds and runs a typed workspace facade with the real pinned Zod dependency", () => {
	const { fixture: f, owner, external } = externalFixture();
	const require = createRequire(path.join(workspaceRoot, "packages/protocol/package.json"));
	const installed = realpathSync.native(path.dirname(require.resolve("zod/package.json")));
	const metadata = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
	expect({ name: metadata.name, version: metadata.version }).toEqual({
		name: "zod",
		version: "4.6.7",
	});
	cpSync(installed, external, { recursive: true });
	put(
		owner,
		"src/index.ts",
		'import { z } from "zod"; export function validated(value: unknown): string { return z.string().parse(value); }\n',
	);
	put(
		owner,
		"tsconfig.json",
		JSON.stringify({
			extends: "../../tsconfig.base.json",
			compilerOptions: {
				noEmit: false,
				noEmitOnError: true,
				emitDeclarationOnly: true,
				rootDir: "src",
				outDir: "dist",
				types: [],
			},
			include: ["src/**/*.ts"],
		}),
	);
	const compiler = path.join(
		path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
		"bin/tsc",
	);
	const typed = spawnSync(process.execPath, [compiler, "-p", "tsconfig.json"], {
		cwd: owner,
		env: childEnvironment(),
		encoding: "utf8",
		timeout: 60_000,
		windowsHide: true,
	});
	expect({ status: typed.status, stdout: typed.stdout, stderr: typed.stderr }).toEqual({
		status: 0,
		stdout: "",
		stderr: "",
	});
	expect(readFileSync(path.join(owner, "dist/index.d.ts"), "utf8")).toContain(
		"validated(value: unknown): string",
	);
	command(
		f,
		'let rejected = false; try { validated(7); } catch { rejected = true; } return validated("DYTEST real Zod") === "DYTEST real Zod" && rejected ? 13 : 8;',
		'import { validated } from "@draftyak/build-fixture";',
	);
	const staged = built(f);
	assertClosedImports(f, staged);
	const result = invoke(staged, ["dependency"]);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 13,
		stdout: "",
		stderr: "",
	});
});

it.each(["undeclared", "mismatched name", "mismatched version"] as const)(
	"refuses a resolvable %s external runtime dependency before compilation",
	(failure) => {
		const { fixture: f, owner, external } = externalFixture();
		if (failure === "undeclared") dependencies(owner, []);
		else {
			const manifest = JSON.parse(readFileSync(path.join(external, "package.json"), "utf8"));
			if (failure === "mismatched name") manifest.name = "dytest-unexpected-package";
			else manifest.version = "4.6.8";
			put(external, "package.json", JSON.stringify(manifest));
		}
		expectRefused(f);
	},
);

it("preserves Node classification before lazy diagnostic module evaluation", () => {
	const f = fixture();
	const name = "@draftyak/build-fixture";
	const dependency = workspacePackage(
		f,
		name,
		`
export function classifyNode(value: unknown): 'full' | 'unsupported' {
 return value === ${JSON.stringify(process.version)} ? 'full' : 'unsupported';
}
export async function diagnostics(): Promise<unknown> {
 return (await import('./diagnostics.ts')).report;
}\n`,
		`
export declare function classifyNode(value: unknown): 'full' | 'unsupported';
export declare function diagnostics(): Promise<unknown>;\n`,
	);
	put(
		dependency,
		"src/diagnostics.ts",
		`
const marker: { readonly report: never } = {
 get report(): never { throw new Error('DYTEST diagnostic getter evaluated'); }
};
export const report: never = marker.report;\n`,
	);
	dependencies(f.cli, [name]);
	command(
		f,
		`
 if (classifyNode(argv[1]) !== 'full') {
  context.stderr('DYTEST NODE_UNSUPPORTED\\n'); return 12;
 }
 try { await diagnostics(); return 0; }
 catch (error) {
  if (!(error instanceof Error) || error.message !== 'DYTEST diagnostic getter evaluated') throw error;
  context.stderr('DYTEST DIAGNOSTIC_EVALUATED\\n'); return 23;
 }`,
		`import { classifyNode, diagnostics } from '${name}';`,
	);
	const staged = built(f);
	assertClosedImports(f, staged);
	for (const [version, status, stderr] of [
		["v0.0.0", 12, "DYTEST NODE_UNSUPPORTED\n"],
		[process.version, 23, "DYTEST DIAGNOSTIC_EVALUATED\n"],
	] as const) {
		const result = invoke(staged, ["dependency", version]);
		expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
			status,
			stdout: "",
			stderr,
		});
	}
});

it("refuses a changed dependency chunk before evaluating its module body", () => {
	const f = fixture();
	const name = "@draftyak/build-fixture";
	workspacePackage(
		f,
		name,
		`
export const shared: { readonly value: string } = {
 get value(): string { return 'DYTEST shared dependency'; }
};\n`,
		"export declare const shared: { readonly value: string };\n",
	);
	dependencies(f.cli, [name]);
	command(
		f,
		"return shared.value === 'DYTEST shared dependency' ? 7 : 8;",
		`import { shared } from '${name}';`,
	);
	put(
		f.cli,
		"src/commands/dependency-peer.ts",
		`
import type { Command } from '../command-contract.ts';
import { shared } from '${name}';
export const command: Command = {
 name: 'dependency-peer',
 async run(): Promise<number> { return shared.value === 'DYTEST shared dependency' ? 9 : 8; }
};\n`,
	);
	const staged = built(f);
	const chunks = readdirSync(path.join(staged, "chunks"))
		.map((name) => path.join(staged, "chunks", name))
		.filter((file) => readFileSync(file, "utf8").includes("DYTEST shared dependency"));
	expect(chunks).toHaveLength(1);
	const chunk = chunks[0];
	if (!chunk) throw new Error("Shared dependency chunk was not produced");
	writeFileSync(
		chunk,
		`globalThis['DYTEST_DEPENDENCY_EVALUATED'] = true;\n${readFileSync(chunk, "utf8")}`,
	);
	const result = spawnSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
globalThis['DYTEST_DEPENDENCY_EVALUATED'] = false;
const { main } = await import(${JSON.stringify(pathToFileURL(path.join(staged, "main.mjs")).href)});
const exit = await main(['dependency']);
console.log(JSON.stringify({ exit, dependencyEvaluated: globalThis['DYTEST_DEPENDENCY_EVALUATED'] }));
process.exitCode = exit;
`,
		],
		{
			cwd: path.dirname(staged),
			env: childEnvironment(),
			encoding: "utf8",
			timeout: 30_000,
			windowsHide: true,
		},
	);
	expect({
		status: result.status,
		stderr: result.stderr,
		report: JSON.parse(result.stdout),
	}).toEqual({
		status: 1,
		stderr: "Command refused.\n",
		report: { exit: 1, dependencyEvaluated: false },
	});
});

it("bundles an explicit workspace JSON export without a runtime source or package lookup", () => {
	const f = fixture();
	const ownerName = "@draftyak/build-fixture",
		policyName = "@draftyak/build-policy";
	const owner = workspacePackage(
		f,
		ownerName,
		`
import policy from '${policyName}/versions.json' with { type: 'json' };
export const value: string = policy.minimum;\n`,
		"export declare const value: string;\n",
	);
	const policy = workspacePackage(f, policyName, "export {};\n", "export {};\n");
	const manifest = JSON.parse(readFileSync(path.join(policy, "package.json"), "utf8"));
	manifest.exports = { "./versions.json": "./versions.json" };
	put(policy, "package.json", JSON.stringify(manifest));
	put(
		policy,
		"versions.json",
		JSON.stringify({ minimum: "DYTEST floor", bundled: "DYTEST bundled" }),
	);
	dependencies(owner, [policyName]);
	linkPackage(owner, policyName, policy);
	dependencies(f.cli, [ownerName]);
	command(f, "return value === 'DYTEST floor' ? 15 : 8;", `import { value } from '${ownerName}';`);
	const staged = built(f);
	assertClosedImports(f, staged);
	const result = invoke(staged, ["dependency"]);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 15,
		stdout: "",
		stderr: "",
	});
});
