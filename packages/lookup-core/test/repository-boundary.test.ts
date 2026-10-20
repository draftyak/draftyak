import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as calendar from "../src/public-calendar.ts";
import {
	checkLookupImports,
	isRepositoryRuntimeSource,
	type RuntimeSource,
} from "./repository-imports.ts";
import { runtimeClosure } from "./runtime-imports.ts";

const root = new URL("../../../", import.meta.url);
const sources = (): RuntimeSource[] =>
	execFileSync(
		"git",
		[
			"-c",
			"gc.auto=0",
			"-c",
			"maintenance.auto=false",
			"ls-files",
			"-z",
			"--",
			".",
			":(exclude)*siwc*",
			":(exclude)*dynamic-agent*",
			":(exclude)*dynamic_agent*",
			":(exclude)*s07*",
		],
		{ cwd: fileURLToPath(root), encoding: "utf8" },
	)
		.split("\0")
		.filter(isRepositoryRuntimeSource)
		.map((name) => ({ path: name, source: readFileSync(new URL(name, root), "utf8") }));

describe("protected package repository imports", () => {
	it.each([
		[
			"literal",
			"const {'getBuiltinModule': get} = process; const {'createRequire': load} = get('module');",
		],
		[
			"template",
			"const {[`getBuiltinModule`]: get} = process; const {[`createRequire`]: load} = get('module');",
		],
		[
			"concatenation",
			"const {['get' + 'BuiltinModule']: get} = process; const {['create' + 'Require']: load} = get('module');",
		],
		[
			"variable",
			"const first = 'getBuiltinModule', second = 'createRequire'; const {[first]: get} = process; const {[second]: load} = get('module');",
		],
		[
			"assignment",
			"let get, load; ({'getBuiltinModule': get} = process); ({'createRequire': load} = get('module'));",
		],
		[
			"transparent parenthesized process",
			"const first='getBuiltinModule', second='createRequire'; const {[first]: get}=(process); const {[second]: load}=get('module');",
		],
		[
			"transparent optional process",
			"const first='getBuiltinModule', second='createRequire'; const {[first]: get}=globalThis?.process; const {[second]: load}=get('module');",
		],
		[
			"transparent optional computed process",
			"const first='getBuiltinModule', second='createRequire'; const {[first]: get}=globalThis?.['process']; const {[second]: load}=get('module');",
		],
		[
			"transparent optional global process chain",
			"const first='getBuiltinModule', second='createRequire'; const {[first]: get}=globalThis?.global?.process; const {[second]: load}=get('module');",
		],
	] as const)(
		"refuses native Node binding-pattern loader access through %s",
		async (_label, prefix) => {
			const source = `${prefix} const {planLookups, LookupRunner} = load(import.meta.url)('@draftyak/lookup-core');`;
			const path = "apps/hub/src/mcp/binding.mjs";
			expect(isRepositoryRuntimeSource(path)).toBe(true);
			const output = execFileSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					`${source} process.stdout.write([typeof planLookups, typeof LookupRunner].join(','));`,
				],
				{ cwd: fileURLToPath(new URL("node_modules/.pnpm/", root)), encoding: "utf8" },
			);
			expect(output).toBe("function,function");
			await expect(checkLookupImports([{ path, source }])).rejects.toThrow("boundary review");
		},
	);
	it.each([
		"const {'require': load} = capability;",
		"const {[`createRequire`]: load} = capability;",
		"const {['get' + 'BuiltinModule']: get} = capability;",
		String.raw`const {'get\u0042uiltinModule': get} = capability;`,
		"const {'mainModule': current} = capability;",
		"const {'module': current} = capability;",
		"const {'getBuiltinModule': get = fallback} = process;",
		"let get; ({[`getBuiltinModule`]: get = fallback} = process);",
		"const {nested: {'createRequire': load}} = capability;",
		"function loadFrom({'createRequire': load} = capability) {}",
	])("refuses explicit binding-pattern loader keys: %s", async (source) => {
		await expect(
			checkLookupImports([{ path: "packages/view/binding.mjs", source }]),
		).rejects.toThrow("boundary review");
	});
	it.each([
		"const {[key]: get} = process;",
		"let get; ({[key]: get} = process);",
		"const {[key]: get = fallback} = globalThis;",
		"let get; ({[key]: get = fallback} = global);",
		"const {[key]: get} = globalThis[`process`];",
		"const {process: {[key]: get}} = globalThis;",
		"let get; ({process: {[key]: get}} = globalThis);",
		"const {['global' + 'This']: {process: {[key]: get}}} = globalThis;",
		"const {process: {[key]: get} = fallback} = globalThis;",
		"let get; ({process: {[key]: get} = fallback} = globalThis);",
		"function fromGlobal({[key]: get} = process) {}",
		"const {nested: {[key]: get} = process} = data;",
	])("refuses unresolved loader-global binding keys: %s", async (source) => {
		await expect(
			checkLookupImports([{ path: "packages/view/binding.mjs", source }]),
		).rejects.toThrow("boundary review");
	});
	it("keeps inert loader data and ordinary destructuring without global alias inference", async () => {
		await expect(
			checkLookupImports([
				{
					path: "packages/view/data.mjs",
					source:
						"const data = {'getBuiltinModule': 1, 'createRequire': 2}; const text = 'getBuiltinModule'; /* createRequire */",
				},
				{
					path: "packages/view/bindings.mjs",
					source:
						"const {[key]: value, nested: {[other]: item}} = data; let assigned; ({value: assigned} = data); function f({value = 3} = {}) { return value; }",
				},
				{
					path: "packages/view/globals.mjs",
					source:
						"const {env: {[key]: value}, versions: {node: version}} = process; const {Math: math} = globalThis;",
				},
				{
					path: "packages/view/types.ts",
					source:
						"type Data = {'getBuiltinModule': unknown}; import type { createRequire } from 'node:module'; export const safe = 1;",
				},
			]),
		).resolves.toBeUndefined();
	});
	it.each([
		"const load = require; load('@draftyak/lookup-core');",
		String.raw`r\u0065quire('@draftyak/lookup-core');`,
		"(0, require)('@draftyak/lookup-core');",
		"module['require']('@draftyak/lookup-core');",
		"globalThis['require']('@draftyak/lookup-core');",
		"const loader = process.mainModule; loader.require('@draftyak/lookup-core');",
		"process['getBuiltinModule']('module')['createRequire'](import.meta.url)('@draftyak/lookup-core');",
		"process.getBuiltinModule('module').createRequire(import.meta.url)('@draftyak/lookup-core');",
		"capability[`createRequire`](import.meta.url)('@draftyak/lookup-core');",
		"capability['create' + 'Require'](import.meta.url)('@draftyak/lookup-core');",
		"import * as loader from 'node:module'; const load = loader.createRequire; load(import.meta.url)('@draftyak/lookup-core');",
		"import * as loader from 'node:module'; const load = loader[key];",
		String.raw`import * as loader from 'node\u003amodule'; const load = loader[key];`,
		"const loader = await import('module');",
		"export * from 'node:module';",
	])(
		"refuses unsupported loader references without evaluating their arguments: %s",
		async (source) => {
			await expect(
				checkLookupImports([{ path: "apps/hub/src/mcp/external.mjs", source }]),
			).rejects.toThrow("boundary review");
		},
	);
	it.each(["cjs", "cts", "CJS", "CTS"])(
		"refuses unaudited CommonJS .%s format by default",
		async (ext) => {
			const path = `packages/view/external.${ext}`;
			expect(isRepositoryRuntimeSource(path)).toBe(true);
			await expect(checkLookupImports([{ path, source: "const value = 1;" }])).rejects.toThrow(
				"CommonJS source",
			);
		},
	);
	it("keeps harmless ESM loader text, unrelated imports and erased types usable", async () => {
		await expect(
			checkLookupImports([
				{
					path: "packages/view/source.ts",
					source:
						"import type { createRequire } from 'node:module'; type Loader = typeof import('node:module'); import { readFileSync } from 'node:fs'; const text = `require('module')`; /* module.createRequire */ export { text, readFileSync };",
				},
				{ path: "packages/view/values.js", source: "const value = 1;" },
				{
					path: "packages/view/properties.mjs",
					source:
						"const values = data[index]; const version = process[`versions`]['node']; const os = process['plat' + 'form']; const math = globalThis[`Math`]; const setting = process.env[key];",
				},
				{ path: "apps/hub/src/tools/adapter.mjs", source: "import '@DRAFTYAK/LOOKUP-CORE';" },
				{
					path: "tools/calendar-goldens/probe.mjs",
					source: "import '@DRAFTYAK/LOOKUP-CORE/calendar';",
				},
			]),
		).resolves.toBeUndefined();
	});
	it.each([
		"process[loaderName]('module');",
		"globalThis[loaderName]('@draftyak/lookup-core');",
		"global[loaderName]('@draftyak/lookup-core');",
		"globalThis.process[loaderName]('module');",
		"globalThis[`process`][loaderName]('module');",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript fixture for a computed loader key.
		"process[`get${part}Module`]('module');",
	])("refuses unresolved computed process/global loader access: %s", async (source) => {
		await expect(
			checkLookupImports([{ path: "apps/hub/src/mcp/external.mjs", source }]),
		).rejects.toThrow("boundary review");
	});
	it("refuses an escaped loader after JSX transformation", async () => {
		await expect(
			checkLookupImports([
				{
					path: "apps/desktop/src/view.tsx",
					source: String.raw`const load = r\u0065quire; export const view = <div/>;`,
				},
			]),
		).rejects.toThrow("Runtime loader");
	});
	it("refuses TypeScript runtime import-equals without evaluating its target", async () => {
		await expect(
			checkLookupImports([
				{
					path: "packages/view/source.ts",
					source: "import core = require('@draftyak/lookup-core');",
				},
			]),
		).rejects.toThrow();
	});
	it("fails closed when a runtime module cannot be parsed", async () => {
		await expect(
			checkLookupImports([{ path: "packages/view/source.mjs", source: "export const = ;" }]),
		).rejects.toThrow();
	});
	it.each([
		"#lookups",
		"../../node_modules/@draftyak/lookup-core/src/index.ts",
		"file:///repo/node_modules/@draftyak/lookup-core/dist/index.mjs",
		"file:///repo/node_modules/@DRAFTYAK/LOOKUP-CORE/dist/index.mjs",
		String.raw`@draftyak/lookup\u002dcore`,
	])("refuses package-import aliases and linked protected identities: %s", async (specifier) => {
		await expect(
			checkLookupImports([
				{ path: "apps/hub/src/mcp/external.mjs", source: `import '${specifier}';` },
			]),
		).rejects.toThrow();
	});
	it.each([
		["packages/view/external.cjs", "const core = require('@draftyak/lookup-core');"],
		["packages/view/external.cts", "const core = require('@draftyak/lookup-core');"],
		["packages/view/external.js", "const core = require('@draftyak/lookup-core');"],
		[
			"apps/hub/src/mcp/external.mjs",
			"import { createRequire } from 'node:module'; const core = createRequire(import.meta.url)('@draftyak/lookup-core');",
		],
	] as const)("refuses the reported non-ESM loader from %s", async (path, source) => {
		expect(isRepositoryRuntimeSource(path)).toBe(true);
		await expect(checkLookupImports([{ path, source }])).rejects.toThrow();
	});
	it.each([
		"@DRAFTYAK/LOOKUP-CORE",
		"@draftyak/Lookup-Core",
		"@DRAFTYAK/lookup-core/calendar",
		"@draftyak/LOOKUP-CORE/runner",
	])("refuses case-varied protected package identities: %s", async (specifier) => {
		await expect(
			checkLookupImports([
				{ path: "apps/hub/src/mcp/external.mjs", source: `import '${specifier}';` },
			]),
		).rejects.toThrow();
	});
	it.each([
		[
			"packages/view/external.cjs",
			"const { planLookups, LookupRunner } = require('@draftyak/lookup-core');",
			"commonjs",
		],
		[
			"apps/hub/src/mcp/external.mjs",
			"import { createRequire as load } from 'node:module'; const { planLookups, LookupRunner } = load(import.meta.url)('@draftyak/lookup-core');",
			"module",
		],
		[
			"apps/hub/src/mcp/template.mjs",
			"const { planLookups, LookupRunner } = process[`getBuiltinModule`]('module')[`createRequire`](import.meta.url)('@draftyak/lookup-core');",
			"module",
		],
		[
			"apps/hub/src/mcp/concatenation.mjs",
			"const { planLookups, LookupRunner } = process['get' + 'BuiltinModule']('module')['create' + 'Require'](import.meta.url)('@draftyak/lookup-core');",
			"module",
		],
	] as const)("rejects a loader that native Node resolves from %s", async (path, source, mode) => {
		// Use pnpm's existing workspace link and ordinary Node resolution, without resolver hooks.
		const result = execFileSync(
			process.execPath,
			[
				`--input-type=${mode}`,
				"-e",
				`${source} process.stdout.write([typeof planLookups, typeof LookupRunner].join(','));`,
			],
			{ cwd: fileURLToPath(new URL("node_modules/.pnpm/", root)), encoding: "utf8" },
		);
		expect(result).toBe("function,function");
		await expect(checkLookupImports([{ path, source }])).rejects.toThrow();
	});
	it("rejects the case-varied ESM identity that native Windows Node resolves", {
		tags: ["requires:windows"],
	}, async () => {
		const source = "import { planLookups, LookupRunner } from '@DRAFTYAK/LOOKUP-CORE';";
		const result = execFileSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`${source} process.stdout.write([typeof planLookups, typeof LookupRunner].join(','));`,
			],
			{ cwd: fileURLToPath(new URL("node_modules/.pnpm/", root)), encoding: "utf8" },
		);
		expect(result).toBe("function,function");
		await expect(
			checkLookupImports([{ path: "apps/hub/src/mcp/external.mjs", source }]),
		).rejects.toThrow();
	});
	it.each([
		"plugins/example/src/siwc/index.ts",
		"packages/example/src/auth-dynamic-agent.ts",
		"packages/example/src/auth-dynamic_agent.ts",
		"apps/hub/src/s07/index.ts",
		"apps/hub/src/SIWC/index.ts",
	])("leaves separately maintained source boundaries closed: %s", (name) => {
		expect(isRepositoryRuntimeSource(name)).toBe(false);
	});
	it("checks the actual tracked production inventory without evaluating modules", async () => {
		expect(isRepositoryRuntimeSource("packages/protocol/scripts/vectors.ts")).toBe(false);
		expect(isRepositoryRuntimeSource("packages/protocol/scripts/export-spec.ts")).toBe(false);
		expect(isRepositoryRuntimeSource("packages/protocol/src/scripts/runtime.ts")).toBe(true);
		const inventory = sources();
		expect(inventory.length).toBeGreaterThan(20);
		await expect(checkLookupImports(inventory)).resolves.toBeUndefined();
	});
	it("allows the protected native hub tools entry", async () => {
		await expect(
			checkLookupImports([
				{
					path: "apps/hub/src/tools/planner-adapter.ts",
					source: "import { planLookups, LookupRunner } from '@draftyak/lookup-core';",
				},
			]),
		).resolves.toBeUndefined();
	});
	it("allows internal modules and erased external type imports", async () => {
		await expect(
			checkLookupImports([
				{ path: "packages/lookup-core/src/planner.ts", source: "import './metadata.ts';" },
				{
					path: "packages/view/src/types.ts",
					source: "import type { LookupPlan } from '@draftyak/lookup-core';",
				},
			]),
		).resolves.toBeUndefined();
	});
	it("allows the test-only golden harness to consume only the calendar entry", async () => {
		await expect(
			checkLookupImports([
				{
					path: "tools/calendar-goldens/test/calendar-goldens.test.ts",
					source: "import { renderFreeSlots } from '@draftyak/lookup-core/calendar';",
				},
			]),
		).resolves.toBeUndefined();
	});
	it.each([
		["apps/hub/src/mcp/handlers.ts", "import { LookupRunner } from '@draftyak/lookup-core';"],
		["packages/providers/src/model.ts", "import { planLookups } from '@draftyak/lookup-core';"],
		["plugins/example/src/index.ts", "import '@draftyak/lookup-core';"],
		[
			"tools/calendar-goldens/test/calendar-goldens.test.ts",
			"import { planLookups } from '@draftyak/lookup-core';",
		],
		["apps/desktop/src/index.ts", "export { LookupRunner } from '@draftyak/lookup-core';"],
		["apps/hub/src/tools/adapter.ts", "import '@draftyak/lookup-core/runner';"],
		["apps/hub/src/tools/adapter.ts", "import '../../../../packages/lookup-core/src/runner.ts';"],
		[
			"tools/calendar-goldens/test/calendar-goldens.test.ts",
			"import '../../../packages/lookup-core/src/planner.ts';",
		],
		["apps/hub/src/mcp/handlers.ts", "void import('@draftyak/lookup-core');"],
		["packages/providers/src/model.ts", "void import(target);"],
	] as const)("refuses an unrelated, dynamic or deep import from %s", async (path, source) => {
		await expect(checkLookupImports([{ path, source }])).rejects.toThrow();
	});
	it.each(["jsx", "tsx"])(
		"includes ordinary .%s UI modules without evaluating JSX",
		async (ext) => {
			const path = `apps/desktop/src/view.${ext}`;
			expect(isRepositoryRuntimeSource(path)).toBe(true);
			const types = ext === "tsx" ? "import type { LookupPlan } from '@draftyak/lookup-core';" : "";
			await expect(
				checkLookupImports([
					{ path, source: `${types}export const view = <div>{globalThis.neverEvaluated()}</div>;` },
				]),
			).resolves.toBeUndefined();
		},
	);
	it.each([
		["jsx", "import { LookupRunner } from '@draftyak/lookup-core';"],
		["tsx", "import { LookupRunner } from '@draftyak/lookup-core';"],
		["jsx", "void import('@draftyak/lookup-core');"],
		["tsx", "void import('@draftyak/lookup-core');"],
		["jsx", "import '../../../packages/lookup-core/src/runner.ts';"],
		["tsx", "import '../../../packages/lookup-core/src/runner.ts';"],
	] as const)(
		"refuses static, dynamic and deep lookup imports after .%s transform: %s",
		async (ext, edge) => {
			const path = `apps/desktop/src/view.${ext}`;
			expect(isRepositoryRuntimeSource(path)).toBe(true);
			await expect(
				checkLookupImports([{ path, source: `${edge}export const view = <div/>;` }]),
			).rejects.toThrow();
		},
	);
	it.each([
		"../../packages/%6cookup-core/src/runner.ts",
		"FILE:///repo/packages/%6cookup-core/src/runner.ts",
		"file:///repo/packages/lookup-core%2fsrc/runner.ts",
	])("refuses encoded local/file module paths: %s", async (specifier) => {
		await expect(
			checkLookupImports([{ path: "packages/view/index.ts", source: `import '${specifier}';` }]),
		).rejects.toThrow("Encoded local import");
	});
	it("refuses case-varied Windows local lookup paths", async () => {
		await expect(
			checkLookupImports([
				{
					path: "packages/view/index.ts",
					source: "import 'file:///C:/repo/packages/Lookup-Core/src/runner.ts';",
				},
			]),
		).rejects.toThrow("Lookup relative or absolute internal import");
	});
	it("keeps the public calendar runtime closure free of planner and runner", async () => {
		expect(Object.keys(calendar).sort()).toEqual([
			"calendarWindow",
			"renderFreeSlots",
			"workingIntervals",
		]);
		const sourceRoot = new URL("../src/", import.meta.url);
		const visited = await runtimeClosure(
			sourceRoot,
			[new URL("public-calendar.ts", sourceRoot)],
			(file) => readFileSync(file, "utf8"),
		);
		for (const name of ["planner", "binder", "runner", "metadata"])
			expect(visited).not.toContain(new URL(`${name}.ts`, sourceRoot).href);
	});
	it("declares only protected root and narrow public calendar package exports", () => {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		expect(Object.keys(manifest.exports).sort()).toEqual([".", "./calendar"]);
		expect(Object.keys(manifest.publishConfig.exports).sort()).toEqual([".", "./calendar"]);
	});
	it("keeps the injected host call in the runner while the native transport adapter remains pending", () => {
		const inventory = sources().filter((file) => file.path.startsWith("packages/lookup-core/src/"));
		const calls = inventory.filter((file) => file.source.includes("this.#host.call("));
		expect(calls.map((file) => file.path)).toEqual(["packages/lookup-core/src/runner.ts"]);
		// This records today's injected seam; actual tools/call transport ownership needs its native adapter.
		expect(calls[0]?.source.match(/this\.#host\.call\(/g)).toHaveLength(1);
	});
});
