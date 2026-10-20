import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkLookupImports, isRepositoryRuntimeSource } from "./repository-imports.ts";

const root = new URL("../../../", import.meta.url);
const runtimePath = "apps/hub/src/mcp/transparent-source.mjs";
const keys = "const first='getBuiltinModule', second='createRequire';";
const use =
	"const {[second]:load}=get('module'); const {planLookups,LookupRunner}=load(import.meta.url)('@draftyak/lookup-core');";
const native = (source: string): string =>
	execFileSync(process.execPath, ["--input-type=module", "-e", source], {
		cwd: fileURLToPath(new URL("node_modules/.pnpm/", root)),
		encoding: "utf8",
	});

describe("known-global transparent source wrappers", () => {
	it.each([
		["declaration with an inner parenthesized global", "const {[first]:get}=(globalThis).process;"],
		[
			"declaration with an inner optional global chain",
			"const {[first]:get}=(globalThis?.global).process;",
		],
		[
			"assignment with nested transparent member objects",
			"let get; ({[first]:get}=((globalThis)?.global).process);",
		],
		["nested named-global declaration", "const {global:{process:{[first]:get}}}=((globalThis));"],
		["nested named-global assignment", "let get; ({process:{[first]:get}}=(globalThis).global);"],
		["nested declaration default", "const {holder:{[first]:get}=(globalThis?.process)}={};"],
		["nested assignment default", "let get; ({holder:{[first]:get}=((globalThis).process)}={});"],
		[
			"parameter default",
			"function select({[first]:found}=((globalThis?.global).process)){return found;} const get=select();",
		],
		[
			"computed member with a transparent known-global object",
			"const get=((globalThis?.global).process)[first];",
		],
	] as const)("refuses native loader access through %s", async (_label, binding) => {
		const source = `${keys}${binding}${use}`;
		expect(isRepositoryRuntimeSource(runtimePath)).toBe(true);
		expect(
			native(`${source}process.stdout.write([typeof planLookups,typeof LookupRunner].join(','));`),
		).toBe("function,function");
		await expect(checkLookupImports([{ path: runtimePath, source }])).rejects.toThrow(
			"boundary review",
		);
	});
	it("keeps the direct known-global refusal as an independent control", async () => {
		const source = `${keys}const {[first]:get}=globalThis.process;${use}`;
		expect(
			native(`${source}process.stdout.write([typeof planLookups,typeof LookupRunner].join(','));`),
		).toBe("function,function");
		await expect(checkLookupImports([{ path: runtimePath, source }])).rejects.toThrow(
			"boundary review",
		);
	});
	it.each([
		[
			"wrapped ordinary declaration",
			"const data={value:7};const key='value';const {[key]:item}=((data));",
		],
		[
			"wrapped optional data member",
			"const data={nested:{value:7}};const key='value';const {[key]:item}=(data?.nested);",
		],
		[
			"wrapped ordinary assignment",
			"const data={value:7};const key='value';let item;({[key]:item}=((data)));",
		],
		[
			"wrapped nested default",
			"const data={value:7};const key='value';const {holder:{[key]:item}=((data))}={};",
		],
		[
			"wrapped parameter default",
			"const data={value:7};const key='value';function select({[key]:item}=((data))){return item;}const item=select();",
		],
		["unrelated wrapped call", "const key='value';const {[key]:item}=((()=>({value:7}))());"],
	] as const)(
		"allows harmless %s without arbitrary alias or call inference",
		async (_label, source) => {
			expect(native(`${source}process.stdout.write(String(item));`)).toBe("7");
			await expect(checkLookupImports([{ path: runtimePath, source }])).resolves.toBeUndefined();
		},
	);
	it("does not turn ordinary properties nested under wrapped globals into loader globals", async () => {
		const source =
			"const key='node';const {versions:{[key]:version}}=((process));const {PI:value}=((globalThis)?.Math);";
		expect(
			native(`${source}process.stdout.write(String(typeof version==='string'&&value===Math.PI));`),
		).toBe("true");
		await expect(checkLookupImports([{ path: runtimePath, source }])).resolves.toBeUndefined();
	});
	it("erases wrapper-adjacent types and preserves inert strings and comments", async () => {
		const source =
			"import type {LookupPlan} from '@draftyak/lookup-core';type Shape={getBuiltinModule:unknown};const text='globalThis?.process.getBuiltinModule';/* createRequire */const data={value:7};const key='value';const {[key]:item}=((data as {value:number}));";
		await expect(
			checkLookupImports([{ path: "packages/view/src/wrapped-types.ts", source }]),
		).resolves.toBeUndefined();
	});
});
