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
const keyForms = [
	{ label: "quoted", key: (value: string) => `"${value}"` },
	{ label: "computed string", key: (value: string) => `["${value}"]` },
	{ label: "computed template", key: (value: string) => `[\`${value}\`]` },
] as const;
const denied: Case[] = fields.flatMap((field) =>
	keyForms.map(({ label, key }) => ({
		label: `${label} ${field} assignment key`,
		text: `({ ${key(field)}: picked } = data);`,
	})),
);
const escapedFields = ["\\u0067etBuiltinModule", "\\u006dainModule", "\\u0070rocess"];
const escaped = escapedFields.flatMap((field, index) =>
	keyForms.map(({ label, key }) => ({
		label: `${label} escaped ${fields[index]} assignment key`,
		text: `({ ${key(field)}: picked } = data);`,
	})),
);
const wrappers = [
	{ label: "parenthesized", wrap: (value: string) => `(${value})` },
	{ label: "as", wrap: (value: string) => `${value} as const` },
	{ label: "satisfies", wrap: (value: string) => `${value} satisfies string` },
	{ label: "type assertion", wrap: (value: string) => `<string>${value}` },
	{ label: "non-null", wrap: (value: string) => `${value}!` },
] as const;
const wrapped = wrappers.map(({ label, wrap }) => ({
	label: `${label} literal assignment key`,
	text: `({ [${wrap('"mainModule"')}]: picked } = data);`,
}));
const wrappedTargets = wrappers.map(({ label, wrap }) => ({
	label: `${label} whole assignment target`,
	text: `(${wrap('({ ["mainModule"]: picked })')}) = data;`,
}));
const nested: Case[] = [
	{
		label: "nested object target",
		text: '({ outer: { "mainModule": picked } } = data);',
	},
	{
		label: "nested array target",
		text: '([{ ["mainModule"]: picked }] = data);',
	},
	{
		label: "object default target left",
		text: '({ outer: { "mainModule": picked } = fallback } = data);',
	},
	{
		label: "array default target left",
		text: '([{ "mainModule": picked } = fallback] = data);',
	},
	{
		label: "array rest target",
		text: '([...{ ["mainModule"]: picked }] = data);',
	},
	{
		label: "for-of assignment initializer",
		text: 'for ({ ["mainModule"]: picked } of entries) {}',
	},
	{
		label: "for-in assignment initializer",
		text: "for ({ [`mainModule`]: picked } in entries) {}",
	},
	{
		label: "independently rooted assignment in default data",
		text: '({ outer: picked = (({ "mainModule": another } = data)) } = data);',
	},
	{
		label: "independently rooted assignment in iterable data",
		text: 'for (picked of [({ "mainModule": another } = data)]) {}',
	},
];
const ordinaryData = fields.flatMap((field) => [
	{
		label: `ordinary ${field} object construction`,
		text: `const value = { "${field}": 0 };`,
	},
	{
		label: `ordinary ${field} assignment right`,
		text: `picked = { ["${field}"]: 0 };`,
	},
	{
		label: `ordinary ${field} default right`,
		text: `({ outer: picked = { [\`${field}\`]: 0 } } = data);`,
	},
]);
const allowed: Case[] = [
	...ordinaryData,
	{
		label: "shorthand default object data",
		text: '({ outer = { "mainModule": 0 } } = data);',
	},
	{ label: "call argument object data", text: 'consume({ ["mainModule"]: 0 });' },
	{
		label: "for-of iterable object data",
		text: 'for (picked of [{ "mainModule": 0 }]) {}',
	},
	{
		label: "for-in iterable object data",
		text: "for (picked in { [`mainModule`]: 0 }) {}",
	},
	{
		label: "array default object data",
		text: '([picked = { "mainModule": 0 }] = data);',
	},
	{
		label: "nested object construction",
		text: 'picked = { outer: [{ "mainModule": 0 }] };',
	},
	{ label: "ordinary target", text: '({ ["regular"]: picked } = data);' },
	{
		label: "nested ordinary target",
		text: '({ outer: [{ "regular": picked }] } = data);',
	},
	{
		label: "ordinary rest target",
		text: "([...{ [`regular`]: picked }] = data);",
	},
	{
		label: "ordinary for-of target",
		text: 'for ({ "regular": picked } of entries) {}',
	},
	{
		label: "ordinary for-in target",
		text: 'for ({ ["regular"]: picked } in entries) {}',
	},
	...wrappers.map(({ label, wrap }) => ({
		label: `${label} ordinary assignment key`,
		text: `({ [${wrap('"regular"')}]: picked } = data);`,
	})),
	...wrappers.map(({ label, wrap }) => ({
		label: `${label} whole ordinary assignment target`,
		text: `(${wrap('({ ["regular"]: picked })')}) = data;`,
	})),
];
const dependencies = {
	label: "literal ESM dependencies",
	text: 'import { join } from "node:path"; export { value } from "./owned.js";',
};
const cases = [
	...denied,
	...escaped,
	...wrapped,
	...wrappedTargets,
	...nested,
	...allowed,
	dependencies,
];
const asts = new Map<string, SourceFile>();
const tempRoot = realpathSync(tmpdir());
let directory: string | undefined;
let api: API | undefined;
let snapshot: Snapshot | undefined;

beforeAll(() => {
	directory = mkdtempSync(path.join(tempRoot, "draftyak-source-assignment-"));
	const filenames = cases.map(({ text }, index) => {
		const filename = path.join(directory as string, `case-${index}.ts`);
		writeFileSync(filename, text);
		return filename;
	});
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
			files: filenames,
		}),
	);
	api = new API();
	snapshot = api.updateSnapshot({ openProjects: [config] });
	const project = snapshot.getProject(config);
	if (!project) throw new Error("AST fixture unavailable.");
	const invalid: { label: string; count: number }[] = [];
	for (const [index, filename] of filenames.entries()) {
		const ast = project.program.getSourceFile(filename);
		const fixture = cases[index];
		if (!ast || !fixture) throw new Error("AST fixture unavailable.");
		const diagnostics = project.program.getSyntacticDiagnostics(filename);
		if (diagnostics.length) invalid.push({ label: fixture.label, count: diagnostics.length });
		asts.set(fixture.label, ast);
	}
	expect(invalid).toEqual([]);
});

afterAll(() => {
	try {
		snapshot?.dispose();
	} finally {
		try {
			api?.close();
		} finally {
			if (directory) {
				const resolved = realpathSync(directory);
				expect(path.dirname(resolved)).toBe(tempRoot);
				expect(path.basename(resolved).startsWith("draftyak-source-assignment-")).toBe(true);
				rmSync(resolved, { recursive: true });
				expect(existsSync(resolved)).toBe(false);
			}
		}
	}
});

for (const { label } of [...denied, ...escaped, ...wrapped, ...wrappedTargets, ...nested]) {
	it(`refuses ${label}`, () => {
		expect(() => assertSourceAdmission(asts.get(label) as SourceFile)).toThrow(
			new Error("CLI build refused."),
		);
	});
}

for (const { label } of allowed) {
	it(`accepts ${label}`, () => {
		const ast = asts.get(label) as SourceFile;
		expect(() => assertSourceAdmission(ast)).not.toThrow();
		expect(assertSourceAdmission(ast)).toEqual([]);
	});
}

it("collects genuine literal ESM dependencies without loading them", () => {
	const ast = asts.get(dependencies.label) as SourceFile;
	expect(() => assertSourceAdmission(ast)).not.toThrow();
	const result = assertSourceAdmission(ast);
	expect(result).toEqual(["node:path", "./owned.js"]);
	expect(Object.isFrozen(result)).toBe(true);
});
