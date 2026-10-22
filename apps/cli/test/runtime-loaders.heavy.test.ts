import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
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
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspace = path.resolve(packageRoot, "../..");
const temporary = realpathSync(tmpdir());
const require = createRequire(import.meta.url);

interface Fixture {
	readonly root: string;
	readonly source: string;
	readonly installed: string;
	readonly staged: string;
	readonly marker: string;
	readonly links: string[];
}

const fixtures = new Set<Fixture>();

afterEach(() => {
	for (const fixture of fixtures) {
		const root = path.resolve(fixture.root);
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-cli-runtime-loaders-") ||
			lstatSync(root).isSymbolicLink() ||
			realpathSync.native(root) !== root
		)
			throw new Error("Invalid cleanup scope");
		for (const link of fixture.links) {
			if (!path.resolve(link).startsWith(`${root}${path.sep}`) || !lstatSync(link).isSymbolicLink())
				throw new Error("Invalid tooling link");
			unlinkSync(link);
		}
		rmSync(root, { recursive: true, force: true });
		expect(existsSync(root)).toBe(false);
	}
	fixtures.clear();
});

function fixture(files: Readonly<Record<string, string>>): Fixture {
	const root = mkdtempSync(path.join(temporary, "draftyak-cli-runtime-loaders-"));
	const source = path.join(root, "workspace/apps/cli");
	const installed = path.join(root, "installed");
	const result: Fixture = {
		root,
		source,
		installed,
		staged: path.join(installed, "cli"),
		marker: path.join(root, "DYTEST-ancestor-executed"),
		links: [],
	};
	fixtures.add(result);
	mkdirSync(source, { recursive: true });
	mkdirSync(installed);
	for (const name of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"])
		cpSync(path.join(packageRoot, name), path.join(source, name), { recursive: true });
	cpSync(
		path.join(workspace, "tsconfig.base.json"),
		path.join(root, "workspace/tsconfig.base.json"),
	);
	for (const name of ["typescript", "@types/node"]) {
		const target = realpathSync(path.dirname(require.resolve(`${name}/package.json`)));
		const link = path.join(source, "node_modules", name);
		mkdirSync(path.dirname(link), { recursive: true });
		symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
		result.links.push(link);
	}
	for (const [relative, contents] of Object.entries(files)) {
		const filename = path.join(source, "src", relative);
		mkdirSync(path.dirname(filename), { recursive: true });
		writeFileSync(filename, contents);
	}
	writeFileSync(path.join(installed, "package.json"), '{"type":"commonjs"}\n');
	return result;
}

function node(args: readonly string[], cwd: string): SpawnSyncReturns<string> {
	const env = { ...process.env };
	delete env.NODE_PATH;
	delete env.NODE_OPTIONS;
	const result = spawnSync(process.execPath, [...args], {
		cwd,
		env,
		encoding: "utf8",
		timeout: 60_000,
		maxBuffer: 256 * 1024,
		shell: false,
		windowsHide: true,
	});
	expect(result.error).toBeUndefined();
	expect(result.signal).toBeNull();
	return result;
}

function build(fixture: Fixture): SpawnSyncReturns<string> {
	return node(["scripts/build.ts"], fixture.source);
}

function stage(fixture: Fixture): void {
	cpSync(path.join(fixture.source, "dist"), fixture.staged, { recursive: true });
}

function invoke(fixture: Fixture): SpawnSyncReturns<string> {
	const entry = pathToFileURL(path.join(fixture.staged, "main.mjs")).href;
	return node(
		[
			"--input-type=module",
			"-e",
			`const { main } = await import(${JSON.stringify(entry)}); process.exitCode = await main(["dytest"]);`,
		],
		fixture.installed,
	);
}

function command(imports: string, body: string): string {
	return `${imports}
import type { Command } from "../command-contract.ts";
export const command: Command = { name: "dytest", async run(): Promise<number> { ${body} } };\n`;
}

const ancestorCases = [
	{
		name: "direct node:module import",
		imports: 'import { createRequire } from "node:module";',
		body: 'return createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "renamed node:module import",
		imports: 'import { createRequire as ownedRequire } from "node:module";',
		body: 'return ownedRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "namespace node:module import",
		imports: 'import * as runtime from "node:module";',
		body: 'return runtime.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "bare module import",
		imports: 'import { createRequire } from "module";',
		body: 'return createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "literal dynamic node:module import",
		imports: "",
		body: 'const { createRequire } = await import("node:module"); return createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "relative re-export of node:module",
		imports: 'import { runtimeRequire } from "../support/runtime.ts";',
		body: 'return runtimeRequire(import.meta.url)("dytest-owned-ancestor") as number;',
		helper: 'export { createRequire as runtimeRequire } from "node:module";\n',
	},
	{
		name: "direct process.getBuiltinModule bare lookup",
		imports: "",
		body: 'return process.getBuiltinModule("module")!.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "direct process.getBuiltinModule prefixed lookup",
		imports: "",
		body: 'return process.getBuiltinModule("node:module")!.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "extracted process.getBuiltinModule lookup alias",
		imports: "",
		body: 'const lookup = process.getBuiltinModule; return lookup("module")!.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "literal element process.getBuiltinModule lookup",
		imports: "",
		body: 'return process["getBuiltinModule"]("module")!.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "destructured process.getBuiltinModule lookup alias",
		imports: "",
		body: 'const { getBuiltinModule: lookup } = process; return lookup("node:module")!.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "computed-key process.getBuiltinModule lookup",
		imports: "",
		body: 'const key = "getBuiltinModule" as const; return process[key]("module")!.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "imported process alias getBuiltinModule lookup",
		imports: 'import proc from "node:process";',
		body: 'const key = "getBuiltinModule" as const; return proc[key]("module")!.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
	{
		name: "literal global-root lookup",
		imports: "",
		body: 'return globalThis["process"]["getBuiltinModule"]("module")!.createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	},
] as const;

it.each(ancestorCases)("rejects $name before creating a staged payload", (testCase) => {
	const files: Record<string, string> = {
		"commands/dytest.ts": command(testCase.imports, testCase.body),
	};
	if ("helper" in testCase) files["support/runtime.ts"] = testCase.helper;
	const f = fixture(files);
	const built = build(f);
	if (built.status === 0) {
		stage(f);
		const absent = invoke(f);
		expect({ status: absent.status, stdout: absent.stdout, stderr: absent.stderr }).toEqual({
			status: 1,
			stdout: "",
			stderr: "Command refused.\n",
		});
		expect(existsSync(f.marker)).toBe(false);
		const ancestor = path.join(f.installed, "node_modules/dytest-owned-ancestor");
		expect(path.relative(f.staged, ancestor).startsWith(`..${path.sep}`)).toBe(true);
		mkdirSync(ancestor, { recursive: true });
		writeFileSync(
			path.join(ancestor, "package.json"),
			'{"name":"dytest-owned-ancestor","version":"0.0.0","type":"commonjs","main":"index.cjs"}\n',
		);
		writeFileSync(
			path.join(ancestor, "index.cjs"),
			`require("node:fs").writeFileSync(${JSON.stringify(f.marker)}, "DYTEST"); module.exports = 7;\n`,
		);
		const present = invoke(f);
		expect({ status: present.status, stdout: present.stdout, stderr: present.stderr }).toEqual({
			status: 7,
			stdout: "",
			stderr: "",
		});
		expect(readFileSync(f.marker, "utf8")).toBe("DYTEST");
	}
	expect(built.status).not.toBe(0);
	expect(built.stdout).toBe("");
	expect(built.stderr).toContain("CLI build refused.");
	expect(existsSync(path.join(f.source, "dist/main.mjs"))).toBe(false);
});

it.each([
	{
		name: "relative runtime-loader target",
		body: 'return (createRequire(import.meta.url)("../support/value.js") as { seven: number }).seven;',
	},
	{
		name: "builtin runtime-loader target",
		body: 'return createRequire(import.meta.url)("node:path").posix.basename("/DYTEST/7") === "7" ? 7 : 70;',
	},
])("rejects unsupported $name too", ({ body }) => {
	const f = fixture({
		"commands/dytest.ts": command('import { createRequire } from "node:module";', body),
		"support/value.ts": "export const seven: number = 7;\n",
	});
	const built = build(f);
	if (built.status === 0) {
		stage(f);
		const result = invoke(f);
		expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
			status: 7,
			stdout: "",
			stderr: "",
		});
	}
	expect(built.status).not.toBe(0);
	expect(built.stdout).toBe("");
	expect(built.stderr).toContain("CLI build refused.");
	expect(existsSync(path.join(f.source, "dist/main.mjs"))).toBe(false);
});

it.each([
	{
		name: "ordinary relative ESM",
		imports: 'import { seven } from "../support/value.ts";',
		body: "return seven;",
	},
	{
		name: "node:path ESM builtin",
		imports: 'import { posix } from "node:path";',
		body: 'return posix.basename("/DYTEST/7") === "7" ? 7 : 70;',
	},
	{
		name: "bare path ESM builtin",
		imports: 'import { posix } from "path";',
		body: 'return posix.basename("/DYTEST/7") === "7" ? 7 : 70;',
	},
])("keeps $name available in the compiled closure", ({ imports, body }) => {
	const f = fixture({
		"commands/dytest.ts": command(imports, body),
		"support/value.ts": "export const seven: number = 7;\n",
	});
	const built = build(f);
	expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: "" });
	stage(f);
	const result = invoke(f);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 7,
		stdout: "",
		stderr: "",
	});
});
