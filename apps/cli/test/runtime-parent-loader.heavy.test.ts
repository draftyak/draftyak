import { spawnSync } from "node:child_process";
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
import { isolateKernelFixture } from "./kernel-fixture.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const workspace = path.resolve(packageRoot, "../..");
const temporary = realpathSync(tmpdir());
const require = createRequire(import.meta.url);
const fixtures = new Set<{ root: string; links: string[] }>();

afterEach(() => {
	for (const fixture of fixtures) {
		const root = path.resolve(fixture.root);
		if (
			path.dirname(root) !== temporary ||
			!path.basename(root).startsWith("draftyak-cli-parent-loader-") ||
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

function node(args: readonly string[], cwd: string) {
	const env = { ...process.env };
	delete env.NODE_OPTIONS;
	delete env.NODE_PATH;
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

function fixture(imports: string, body: string) {
	const root = mkdtempSync(path.join(temporary, "draftyak-cli-parent-loader-"));
	const links: string[] = [];
	fixtures.add({ root, links });
	const source = path.join(root, "workspace/apps/cli");
	const installed = path.join(root, "installed");
	const staged = path.join(installed, "cli");
	const marker = path.join(root, "DYTEST-parent-loader");
	mkdirSync(source, { recursive: true });
	mkdirSync(installed);
	for (const name of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"])
		cpSync(path.join(packageRoot, name), path.join(source, name), { recursive: true });
	isolateKernelFixture(source);
	cpSync(
		path.join(workspace, "tsconfig.base.json"),
		path.join(root, "workspace/tsconfig.base.json"),
	);
	for (const name of ["typescript", "@types/node", "rolldown"]) {
		const target = realpathSync(path.dirname(require.resolve(`${name}/package.json`)));
		const link = path.join(source, "node_modules", name);
		mkdirSync(path.dirname(link), { recursive: true });
		symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
		links.push(link);
	}
	writeFileSync(
		path.join(source, "src/commands/dytest.ts"),
		`${imports}\nimport type { Command } from "../command-contract.ts";\nexport const command: Command = { name: "dytest", async run(): Promise<number> { ${body} } };\n`,
	);
	mkdirSync(path.join(source, "src/support"));
	writeFileSync(path.join(source, "src/support/value.ts"), "export const seven: number = 7;\n");
	writeFileSync(path.join(installed, "package.json"), '{"type":"commonjs"}\n');
	const entry = path.join(installed, "entry.cjs");
	writeFileSync(
		entry,
		`void import(${JSON.stringify(pathToFileURL(path.join(staged, "main.mjs")).href)}).then(({main}) => main(["dytest"])).then(code => { process.exitCode = code; }, () => { process.exitCode = 70; });\n`,
	);
	return { root, source, installed, staged, marker, entry };
}

it("rejects a legacy runtime loader reachable from a CommonJS entry", () => {
	const f = fixture(
		"",
		'const runtime = process.mainModule; if (!runtime) return 19; return runtime.require("node:module").createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	);
	const built = node(["scripts/build.ts"], f.source);
	if (built.status === 0) {
		cpSync(path.join(f.source, "dist"), f.staged, { recursive: true });
		const absent = node([f.entry], f.installed);
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
		const present = node([f.entry], f.installed);
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

it("keeps ordinary builtin and relative ESM usable from a CommonJS entry", () => {
	const f = fixture(
		'import { posix } from "node:path"; import { seven } from "../support/value.ts";',
		'return posix.basename("/DYTEST/7") === "7" ? seven : 70;',
	);
	const built = node(["scripts/build.ts"], f.source);
	expect({ status: built.status, stderr: built.stderr }).toEqual({ status: 0, stderr: "" });
	cpSync(path.join(f.source, "dist"), f.staged, { recursive: true });
	const result = node([f.entry], f.installed);
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 7,
		stdout: "",
		stderr: "",
	});
});

it("rejects a template-literal runtime loader lookup", () => {
	const f = fixture(
		"",
		'return globalThis["process"][`getBuiltinModule`]("module").createRequire(import.meta.url)("dytest-owned-ancestor") as number;',
	);
	const built = node(["scripts/build.ts"], f.source);
	if (built.status === 0) {
		cpSync(path.join(f.source, "dist"), f.staged, { recursive: true });
		const absent = node([f.entry], f.installed);
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
		const present = node([f.entry], f.installed);
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
