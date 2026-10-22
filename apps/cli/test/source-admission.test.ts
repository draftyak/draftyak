import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SourceFile } from "typescript/unstable/ast";
import { API, type Snapshot } from "typescript/unstable/sync";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertSourceAdmission } from "../scripts/source-admission.ts";

interface Case {
	readonly label: string;
	readonly text: string;
}

const fields = ["getBuiltinModule", "mainModule", "process"] as const;
const denied: Case[] = fields.flatMap((field) => [
	{ label: `quoted ${field} binding key`, text: `const { "${field}": picked } = data;` },
	{ label: `computed string ${field} binding key`, text: `const { ["${field}"]: picked } = data;` },
	{
		label: `computed plain template ${field} binding key`,
		text: `const { [\`${field}\`]: picked } = data;`,
	},
]);

const wrappers = [
	{ label: "parenthesized", wrap: (value: string) => `(${value})` },
	{ label: "as", wrap: (value: string) => `${value} as const` },
	{ label: "satisfies", wrap: (value: string) => `${value} satisfies string` },
	{ label: "type assertion", wrap: (value: string) => `<string>${value}` },
	{ label: "non-null", wrap: (value: string) => `${value}!` },
] as const;
const wrappedDenied = wrappers.map(({ label, wrap }) => ({
	label: `${label} literal binding key`,
	text: `const { [${wrap('"mainModule"')}]: picked } = data;`,
}));
const existing = ["getBuiltinModule", "mainModule"].flatMap((field) => [
	{ label: `identifier property ${field}`, text: `const { ${field}: picked } = data;` },
	{ label: `shorthand ${field}`, text: `const { ${field} } = data;` },
]);
const nested = fields.map((field) => ({
	label: `nested ${field}`,
	text: `const { outer: { ["${field}"]: picked } } = data;`,
}));
const elements = fields.flatMap((field) => [
	{ label: `string element ${field}`, text: `const picked = data["${field}"];` },
	{ label: `template element ${field}`, text: `const picked = data[\`${field}\`];` },
]);
const allowed: Case[] = [
	{
		label: "unrelated string values",
		text: 'const a = "getBuiltinModule"; const b = "mainModule"; const c = "process";',
	},
	{
		label: "ordinary metadata values",
		text: 'const metadata = { note: "mainModule", detail: "getBuiltinModule" };',
	},
	{ label: "ordinary identifier key", text: "const { regular: picked } = data;" },
	{ label: "ordinary computed string key", text: 'const { ["regular"]: picked } = data;' },
	{ label: "ordinary computed template key", text: "const { [`regular`]: picked } = data;" },
	{ label: "nonmatching literal key", text: 'const { "mainModuleDescription": picked } = data;' },
	...wrappers.map(({ label, wrap }) => ({
		label: `${label} ordinary key`,
		text: `const { [${wrap('"regular"')}]: picked } = data;`,
	})),
];
const dependencies: Case = {
	label: "ordinary ESM declarations",
	text: 'import value from "node:path"; import { other } from "./other.ts"; export { item } from "../item.ts";',
};

const asts = new Map<string, SourceFile>();
const tempRoot = realpathSync(tmpdir());
let directory: string | undefined;
let api: API | undefined;
let snapshot: Snapshot | undefined;

beforeAll(() => {
	directory = mkdtempSync(path.join(tempRoot, "draftyak-source-admission-"));
	const cases = [
		...denied,
		...wrappedDenied,
		...existing,
		...nested,
		...elements,
		...allowed,
		dependencies,
	];
	const files = cases.map((_, index) => `case-${index}.ts`);
	for (const [index, entry] of cases.entries())
		writeFileSync(path.join(directory, files[index] ?? ""), entry.text);
	const config = path.join(directory, "tsconfig.json");
	writeFileSync(
		config,
		JSON.stringify({
			compilerOptions: {
				target: "ESNext",
				module: "ESNext",
				noEmit: true,
				noLib: true,
				noResolve: true,
				types: [],
			},
			files,
		}),
	);
	api = new API();
	snapshot = api.updateSnapshot({ openProjects: [config] });
	const project = snapshot.getProject(config);
	if (!project) throw new Error("Synthetic source project was not opened");
	for (const [index, entry] of cases.entries()) {
		const filename = path.join(directory, files[index] ?? "");
		expect(project.program.getSyntacticDiagnostics(filename)).toHaveLength(0);
		const ast = project.program.getSourceFile(filename);
		if (!ast) throw new Error("Synthetic source was not parsed");
		asts.set(entry.label, ast);
	}
});

afterAll(() => {
	try {
		snapshot?.dispose();
	} finally {
		try {
			api?.close();
		} finally {
			if (directory) {
				const target = realpathSync(directory);
				expect(path.dirname(target)).toBe(tempRoot);
				expect(path.basename(target).startsWith("draftyak-source-admission-")).toBe(true);
				rmSync(target, { recursive: true, force: true });
				expect(existsSync(target)).toBe(false);
			}
		}
	}
});

function astFor(entry: Case): SourceFile {
	const ast = asts.get(entry.label);
	if (!ast) throw new Error("Synthetic AST is unavailable");
	return ast;
}

it.each([...denied, ...wrappedDenied])("refuses $label", (entry) => {
	expect(() => assertSourceAdmission(astFor(entry))).toThrow(new Error("CLI build refused."));
});

it.each(["getBuiltinModule", "mainModule"])("retains identifier refusal for %s", (field) => {
	for (const entry of existing.filter((item) => item.label.endsWith(field)))
		expect(() => assertSourceAdmission(astFor(entry))).toThrow(new Error("CLI build refused."));
});

it("visits nested generic bindings", () => {
	for (const entry of nested)
		expect(() => assertSourceAdmission(astFor(entry))).toThrow(new Error("CLI build refused."));
});

it("keeps binding refusal under the module-loader syntax exception", () => {
	for (const entry of denied)
		expect(() => assertSourceAdmission(astFor(entry), true)).toThrow(
			new Error("CLI build refused."),
		);
});

it("refuses reserved literal keys in generic element syntax", () => {
	for (const entry of elements)
		expect(() => assertSourceAdmission(astFor(entry))).toThrow(new Error("CLI build refused."));
});

it.each(allowed)("admits $label", (entry) => {
	expect(assertSourceAdmission(astFor(entry))).toEqual([]);
});

it("collects literal ESM dependencies without loading them", () => {
	expect(assertSourceAdmission(astFor(dependencies))).toEqual([
		"node:path",
		"./other.ts",
		"../item.ts",
	]);
});
