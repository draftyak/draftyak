import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Node } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";
import { expect, it } from "vitest";
import { assertNativeAppModuleLoader } from "./native-app-module-loader.ts";

function withSource(source: string, check: (ast: Node) => void): void {
	const root = mkdtempSync(path.join(tmpdir(), "draftyak-app-loader-source-"));
	const script = path.join(root, "case.js"),
		config = path.join(root, "scan.json");
	let api: API | undefined;
	try {
		writeFileSync(script, source);
		writeFileSync(
			config,
			JSON.stringify({
				compilerOptions: {
					allowJs: true,
					noEmit: true,
					noResolve: true,
					noLib: true,
					types: [],
					typeRoots: [],
				},
				files: [script],
			}),
		);
		api = new API();
		using snapshot = api.updateSnapshot({ openProjects: [config] });
		const project = snapshot.getProject(config);
		if (!project) throw new Error("DYTEST source project unavailable");
		const ast = project.program.getSourceFile(script);
		if (!ast || project.program.getSyntacticDiagnostics(script).length !== 0)
			throw new Error("DYTEST source syntax refused");
		check(ast);
	} finally {
		try {
			api?.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
}

const arrow = `(verified) => \`data:text/javascript;base64,\${verified.entry.toString("base64")}\``;
const load =
	"function loadModule(verified, clock) { reverifyModule(verified); return settleWithin(() => import(moduleUrl(verified)), MODULE_TIMEOUT_MS, clock); }";
const initialized = `const moduleUrl = ${arrow};\n${load}`;
const assigned = `var moduleUrl;\nfunction initLoader() { moduleUrl = ${arrow}; }\n${load}`;

it("accepts the original initialized verified data-loader binding", () => {
	withSource(initialized, (ast) => expect(() => assertNativeAppModuleLoader(ast)).not.toThrow());
});
it("accepts exactly one hoisted verified data-loader initializer assignment", () => {
	withSource(assigned, (ast) => expect(() => assertNativeAppModuleLoader(ast)).not.toThrow());
});

const refused = [
	{ name: "alias escape", source: assigned + "\nconst alias = moduleUrl;" },
	{ name: "second assignment", source: assigned + `\nmoduleUrl = ${arrow};` },
	{ name: "compound assignment", source: assigned.replace("moduleUrl =", "moduleUrl +=") },
	{
		name: "embedded assignment escape",
		source: assigned.replace(`moduleUrl = ${arrow};`, `const alias = (moduleUrl = ${arrow});`),
	},
	{
		name: "unverified arrow",
		source: assigned.replace("data:text/javascript;base64,", "data:application/javascript;base64,"),
	},
	{
		name: "unverified call input",
		source: assigned.replace("moduleUrl(verified)", "moduleUrl(unverified)"),
	},
	{
		name: "missing revalidation",
		source: assigned.replace("reverifyModule(verified)", "otherCheck(verified)"),
	},
	{
		name: "additional dynamic import",
		source: assigned + "\nconst extra = () => import(otherUrl);",
	},
	{ name: "extra initialized-form read", source: initialized + "\nconsume(moduleUrl);" },
	{
		name: "shadowed helper binding",
		source: assigned + "\nfunction other(moduleUrl) { return 0; }",
	},
] as const;
it.each(refused)("refuses $name", ({ source }) => {
	withSource(source, (ast) =>
		expect(() => assertNativeAppModuleLoader(ast)).toThrow(/^DYTEST import shape /),
	);
});
