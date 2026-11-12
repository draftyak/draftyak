import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { createRequire, isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { PayloadCatalog } from "../src/catalog.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const repository = path.resolve(packageRoot, "../..");
const temporary = realpathSync.native(tmpdir());
const reportName = "cli-build-inputs.json";
const dependencyName = "@dytest/provenance-input";
const generated = [
	"catalog.js",
	"cli-build-inputs.json",
	"main.mjs",
	"main.d.mts",
	"payload-contract.mjs",
	"payload-contract.d.mts",
	"package.json",
];

interface Component {
	readonly id: string;
	readonly name: string;
	readonly kind: "workspace" | "dependency";
	readonly manifestSha256: string;
	readonly version?: string;
	readonly declaredLicense?: string;
}
interface Source {
	readonly id: string;
	readonly component: string;
	readonly path: string;
	readonly sha256: string;
	readonly size: number;
	readonly imports: readonly (
		| { readonly specifier: string; readonly source: string }
		| { readonly specifier: string; readonly builtin: string }
	)[];
}
interface BuildInputs {
	readonly v: 1;
	readonly scope: "cli-bundler";
	readonly lockfileSha256: string;
	readonly components: readonly Component[];
	readonly sources: readonly Source[];
	readonly chunks: readonly {
		readonly path: string;
		readonly sha256: string;
		readonly size: number;
		readonly sources: readonly string[];
		readonly compilerHelpers: readonly {
			readonly name: "rolldown/runtime.js";
			readonly compilerName: "rolldown";
			readonly compilerVersion: "1.2.14";
			readonly compilerManifestSha256: string;
		}[];
	}[];
	readonly excludedGenerated: readonly string[];
}
interface Fixture {
	readonly root: string;
	readonly dev: number;
	readonly ino: number;
	readonly workspace: string;
	readonly cli: string;
	readonly dependency: string;
	readonly links: string[];
}
const fixtures = new Set<Fixture>();
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function put(root: string, relative: string, contents: string): void {
	const filename = path.join(root, relative);
	mkdirSync(path.dirname(filename), { recursive: true });
	writeFileSync(filename, contents);
}

function link(fixture: Fixture, name: string, target: string): void {
	const filename = path.join(fixture.cli, "node_modules", name);
	mkdirSync(path.dirname(filename), { recursive: true });
	symlinkSync(target, filename, process.platform === "win32" ? "junction" : "dir");
	fixture.links.push(filename);
}

function fixture(): Fixture {
	const root = mkdtempSync(path.join(temporary, "draftyak-cli-provenance-"));
	const identity = lstatSync(root);
	const workspace = path.join(root, "workspace");
	const cli = path.join(workspace, "apps/cli");
	const dependency = path.join(workspace, "packages/provenance-input");
	const result: Fixture = {
		root,
		dev: identity.dev,
		ino: identity.ino,
		workspace,
		cli,
		dependency,
		links: [],
	};
	fixtures.add(result);
	mkdirSync(cli, { recursive: true });
	for (const name of ["src", "scripts", "package.json", "tsconfig.json", "tsconfig.build.json"])
		cpSync(path.join(packageRoot, name), path.join(cli, name), { recursive: true });
	for (const name of ["tsconfig.base.json", "pnpm-lock.yaml"])
		cpSync(path.join(repository, name), path.join(workspace, name));
	put(workspace, "package.json", '{"private":true,"type":"module"}\n');
	put(workspace, "pnpm-workspace.yaml", "packages:\n  - apps/*\n  - packages/*\n");
	const require = createRequire(import.meta.url);
	for (const name of ["typescript", "@types/node", "rolldown"])
		link(result, name, realpathSync.native(path.dirname(require.resolve(`${name}/package.json`))));
	const manifest = JSON.parse(readFileSync(path.join(cli, "package.json"), "utf8"));
	manifest.dependencies = { [dependencyName]: "workspace:*" };
	put(cli, "package.json", `${JSON.stringify(manifest)}\n`);
	put(
		dependency,
		"package.json",
		`${JSON.stringify({
			name: dependencyName,
			version: "1.2.3",
			license: "MIT",
			private: true,
			type: "module",
			exports: { ".": { types: "./dist/index.d.ts", default: "./src/index.ts" } },
		})}\n`,
	);
	put(dependency, "dist/index.d.ts", "export declare const seven: number;\n");
	put(dependency, "src/value.ts", "export const value: number = 7;\n");
	put(
		dependency,
		"src/index.ts",
		`import { posix } from "node:path";
import { value } from "./value.ts";
export const seven: number = posix.basename("/DYTEST/7") === "7" ? value : 70;\n`,
	);
	link(result, dependencyName, dependency);
	put(
		cli,
		"src/commands/provenance.ts",
		`import type { Command } from "../command-contract.ts";
import { seven } from "${dependencyName}";
export const command: Command = {
 name: "provenance", async run(): Promise<number> { return seven; }
};\n`,
	);
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
	expect(result.error === undefined, "owned child spawn").toBe(true);
	expect(result.signal === null, "owned child close").toBe(true);
	return result;
}

function build(f: Fixture): SpawnSyncReturns<string> {
	return node(["scripts/build.ts"], f.cli);
}

function stage(f: Fixture, label: string): string {
	const parent = path.join(f.root, `installed-${label}`);
	mkdirSync(parent);
	put(parent, "package.json", '{"type":"commonjs"}\n');
	const cli = path.join(parent, "cli");
	cpSync(path.join(f.cli, "dist"), cli, { recursive: true });
	return cli;
}

function invoke(cli: string): SpawnSyncReturns<string> {
	const entry = pathToFileURL(path.join(cli, "main.mjs")).href;
	return node(
		[
			"--input-type=module",
			"-e",
			`const { main } = await import(${JSON.stringify(entry)}); process.exitCode = await main(["provenance"]);`,
		],
		path.dirname(cli),
	);
}

function ownedFile(root: string, relative: string): string {
	if (
		path.isAbsolute(relative) ||
		/[\\:\0]/.test(relative) ||
		relative.split("/").some((part) => !part || part === "." || part === "..")
	)
		throw new Error("DYTEST nonrelative provenance path");
	const file = path.resolve(root, relative);
	if (!file.startsWith(`${path.resolve(root)}${path.sep}`))
		throw new Error("DYTEST provenance path escaped");
	return file;
}

let compiled: Fixture;
beforeAll(() => {
	compiled = fixture();
	const result = build(compiled);
	expect(result.status, "real provenance build").toBe(0);
	expect(result.stderr.length, "real provenance build stderr bytes").toBe(0);
});

afterAll(() => {
	for (const f of fixtures) {
		const stat = lstatSync(f.root);
		if (
			path.dirname(f.root) !== temporary ||
			!path.basename(f.root).startsWith("draftyak-cli-provenance-") ||
			stat.isSymbolicLink() ||
			stat.dev !== f.dev ||
			stat.ino !== f.ino ||
			realpathSync.native(f.root) !== path.resolve(f.root)
		)
			throw new Error("DYTEST invalid provenance cleanup scope");
		for (const file of f.links) {
			if (!file.startsWith(`${f.root}${path.sep}`) || !lstatSync(file).isSymbolicLink())
				throw new Error("DYTEST invalid provenance fixture link");
			unlinkSync(file);
		}
		rmSync(f.root, { recursive: true, force: true });
		expect(existsSync(f.root), "owned provenance cleanup").toBe(false);
	}
	fixtures.clear();
});

it("binds real compiled CLI sources, dependency membership, chunks and lock to its payload catalogue", async () => {
	const dist = path.join(compiled.cli, "dist");
	const bytes = readFileSync(path.join(dist, reportName));
	const report: BuildInputs = JSON.parse(bytes.toString("utf8"));
	expect(report.v).toBe(1);
	expect(report.scope).toBe("cli-bundler");
	expect(report.excludedGenerated).toEqual(generated);
	expect(report.lockfileSha256).toBe(
		hash(readFileSync(path.join(compiled.workspace, "pnpm-lock.yaml"))),
	);
	expect(report.lockfileSha256).toBe(hash(readFileSync(path.join(repository, "pnpm-lock.yaml"))));
	expect(report.components.map((item) => item.name).sort()).toEqual(
		["@draftyak/cli", dependencyName].sort(),
	);
	const components = new Map(report.components.map((item) => [item.id, item]));
	const sources = new Map(report.sources.map((item) => [item.id, item]));
	expect(components.size).toBe(report.components.length);
	expect(sources.size).toBe(report.sources.length);
	for (const component of components.values()) {
		expect(component.id).toMatch(/^[a-f0-9]{64}$/);
		expect(component.kind).toBe("workspace");
		const root = component.name === "@draftyak/cli" ? compiled.cli : compiled.dependency;
		expect(component.manifestSha256).toBe(hash(readFileSync(path.join(root, "package.json"))));
		if (component.name === dependencyName) {
			expect(component.version).toBe("1.2.3");
			expect(component.declaredLicense).toBe("MIT");
		}
	}
	for (const source of sources.values()) {
		expect(source.id).toMatch(/^[a-f0-9]{64}$/);
		const component = components.get(source.component);
		if (!component) throw new Error("DYTEST source component missing");
		const root = component.name === "@draftyak/cli" ? compiled.cli : compiled.dependency;
		const actual = readFileSync(ownedFile(root, source.path));
		expect(source.sha256).toBe(hash(actual));
		expect(source.size).toBe(actual.length);
		for (const edge of source.imports) {
			if ("source" in edge) expect(sources.has(edge.source)).toBe(true);
			else expect(isBuiltin(edge.builtin)).toBe(true);
		}
	}
	const dependency = report.components.find((item) => item.name === dependencyName);
	if (!dependency) throw new Error("DYTEST dependency component missing");
	const dependencySources = report.sources.filter((item) => item.component === dependency.id);
	expect(dependencySources.map((item) => item.path).sort()).toEqual([
		"src/index.ts",
		"src/value.ts",
	]);
	expect(
		dependencySources.some((item) =>
			item.imports.some((edge) => "builtin" in edge && edge.specifier === "node:path"),
		),
	).toBe(true);
	const command = report.sources.find(
		(item) =>
			components.get(item.component)?.name === "@draftyak/cli" &&
			item.path === "src/commands/provenance.ts",
	);
	if (!command) throw new Error("DYTEST command source missing");
	expect(
		command.imports.some(
			(edge) =>
				edge.specifier === dependencyName &&
				"source" in edge &&
				dependencySources.some((item) => item.id === edge.source),
		),
	).toBe(true);
	expect(
		report.chunks.some(
			(chunk) => chunk.path === "commands/provenance.js" && chunk.sources.includes(command.id),
		),
	).toBe(true);
	expect(
		report.chunks.some((chunk) =>
			chunk.sources.some((id) => dependencySources.some((item) => item.id === id)),
		),
	).toBe(true);
	const compilerManifest = readFileSync(
		path.join(compiled.cli, "node_modules/rolldown/package.json"),
	);
	const compiler = JSON.parse(compilerManifest.toString("utf8"));
	expect({ name: compiler.name, version: compiler.version }).toEqual({
		name: "rolldown",
		version: "1.2.14",
	});
	for (const chunk of report.chunks) {
		expect(generated.includes(chunk.path)).toBe(false);
		const actual = readFileSync(ownedFile(dist, chunk.path));
		expect(chunk.sha256).toBe(hash(actual));
		expect(chunk.size).toBe(actual.length);
		expect(new Set(chunk.sources).size).toBe(chunk.sources.length);
		for (const id of chunk.sources) expect(sources.has(id)).toBe(true);
		expect(Array.isArray(chunk.compilerHelpers)).toBe(true);
		expect(new Set(chunk.compilerHelpers.map((helper) => helper.name)).size).toBe(
			chunk.compilerHelpers.length,
		);
		for (const helper of chunk.compilerHelpers) {
			// Identity only: the containing chunk hash binds emitted bytes, not a helper source claim.
			expect(helper).toEqual({
				name: "rolldown/runtime.js",
				compilerName: "rolldown",
				compilerVersion: "1.2.14",
				compilerManifestSha256: hash(compilerManifest),
			});
		}
	}
	const serialized = JSON.stringify(report);
	expect(serialized.includes(compiled.root.replaceAll("\\", "\\\\"))).toBe(false);
	expect(serialized.includes(pathToFileURL(compiled.root).href)).toBe(false);
	const namespace = await import(pathToFileURL(path.join(dist, "catalog.js")).href);
	const catalog = namespace.installedCatalog as PayloadCatalog;
	expect(catalog.files.find((file) => file.path === reportName)?.sha256).toBe(hash(bytes));
	const result = invoke(stage(compiled, "positive"));
	expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
		status: 7,
		stdout: "",
		stderr: "",
	});
});

it.each(["changed", "missing", "extra"] as const)(
	"refuses %s installed provenance bytes through the actual payload loader",
	(kind) => {
		const cli = stage(compiled, kind);
		const report = path.join(cli, reportName);
		if (kind === "changed") writeFileSync(report, `${readFileSync(report, "utf8")} \n`);
		else if (kind === "missing") unlinkSync(report);
		else writeFileSync(path.join(cli, "cli-build-inputs-extra.json"), "{}\n");
		const result = invoke(cli);
		expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
			status: 1,
			stdout: "",
			stderr: "Command refused.\n",
		});
	},
);

it.each(["lock", "imported-source", "extra-source"] as const)(
	"refuses %s input failure without publishing provenance",
	(kind) => {
		const f = fixture();
		if (kind === "lock") unlinkSync(path.join(f.workspace, "pnpm-lock.yaml"));
		else if (kind === "imported-source") unlinkSync(path.join(f.dependency, "src/value.ts"));
		else put(f.cli, "src/support/DYTEST-unadmitted.txt", "DYTEST unsupported source\n");
		const result = build(f);
		expect(result.status === 0, "real builder refusal").toBe(false);
		expect(existsSync(path.join(f.cli, "dist", reportName))).toBe(false);
		expect(existsSync(path.join(f.cli, "dist/main.mjs"))).toBe(false);
	},
);
