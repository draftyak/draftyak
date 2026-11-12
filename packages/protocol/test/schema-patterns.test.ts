import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { exportSpec, jsonSchemaOf } from "../scripts/export-spec.ts";
import { aiProviderV1, ModelId } from "../src/ai-provider-v1.ts";
import { exportedSchema, extensionDeclaration, extensionSchema } from "../src/extension.ts";
import { jcsSha256 } from "../src/hash.ts";
import { guardExportedPatterns } from "../src/schema-patterns.ts";
import { canonicalToolsV1, toolExtensionDeclaration, toolV1Schema } from "../src/tool-v1.ts";
import { ENGINE_DEPENDENT, patternBody, patterns } from "./vectors.ts";

const accepts = (schema: unknown, value: unknown): boolean =>
	new Validator(structuredClone(schema) as Schema, "2020-12", false).validate(value).valid;
const strictEnd = "(?![\\s\\S])";

describe("portable exported pattern guards", () => {
	it("guards positive anchored patterns in the actual exported documents and canonical entries", async () => {
		let checked = 0;
		const visit = (value: unknown): void => {
			if (value === null || typeof value !== "object") return;
			if (Array.isArray(value)) {
				for (const child of value) visit(child);
				return;
			}
			const node = value as Record<string, unknown>;
			if (typeof node.pattern === "string") {
				const original = node.pattern.endsWith(strictEnd)
					? node.pattern.slice(0, -strictEnd.length)
					: node.pattern;
				if (original.startsWith("^") && /(?:^|[^\\])(?:\\\\)*\$$/.test(original)) {
					checked++;
					expect(node.pattern).toBe(`${original}${strictEnd}`);
				}
			}
			for (const [key, child] of Object.entries(node)) {
				if (!["const", "enum", "default", "examples", "not", "if", "then", "else"].includes(key))
					visit(child);
			}
		};
		for (const { text } of await exportSpec()) visit(JSON.parse(text));
		for (const { entry } of Object.values(canonicalToolsV1)) {
			visit(entry.inputSchema);
			visit(entry.outputSchema);
		}
		expect(checked).toBeGreaterThan(100);
	});
	it("preserves non-string values through both public conversion paths", () => {
		for (const schema of [
			z.number().meta({ pattern: "^abc$" }),
			z.any().meta({ pattern: "^abc$" }),
			z.union([z.string(), z.null()]).meta({ pattern: "^abc$" }),
		]) {
			const original = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
			const generated = jsonSchemaOf(schema);
			const runtime = exportedSchema("schemas/example-v1.schema.json", schema);
			for (const value of [42, null, true, [], {}, "abc", "other"]) {
				expect(accepts(generated, value)).toBe(accepts(original, value));
				expect(accepts(runtime, value)).toBe(accepts(original, value));
			}
			expect(runtime).toEqual({
				...generated,
				$id: "https://draftyak.com/spec/schemas/example-v1.schema.json",
			});
			expect(generated).toMatchObject({ pattern: `^abc$${strictEnd}` });
			expect(accepts(generated, "abc\n")).toBe(false);
		}
	});
	it("preserves explicitly consumed interior and terminal line feeds through both public exporters", () => {
		const cases = [
			[/^a\nb$/, "a\nb"],
			[/^a[\n]b$/, "a\nb"],
			[/^a[\s\S]b$/, "a\nb"],
			[/^a\n$/, "a\n"],
			[/^a[\n]$/, "a\n"],
			[/^a[^\r]$/, "a\n"],
			[/^a\n?$/, "a\n"],
			[/^a(?:\r\n|\n)$/, "a\r\n"],
			[/^a[\s\S]*$/, "a\n\n"],
		] as const;
		for (const [pattern, valid] of cases) {
			const schema = z.string().regex(pattern);
			const generated = jsonSchemaOf(schema);
			const runtime = exportedSchema("schemas/example-v1.schema.json", schema);
			for (const value of [valid, `${valid}\n`, "a", "other", null, 42]) {
				const native = schema.safeParse(value).success;
				expect(accepts(generated, value), `${pattern}: ${JSON.stringify(value)}`).toBe(native);
				expect(accepts(runtime, value), `${pattern}: ${JSON.stringify(value)}`).toBe(native);
			}
			expect(accepts(generated, valid)).toBe(true);
			expect(accepts(generated, `${valid}\n`)).toBe(schema.safeParse(`${valid}\n`).success);
			expect(generated).toMatchObject({ pattern: `${pattern.source}${strictEnd}` });
		}
	});
	it("preserves native alternation, internal assertions, literal dollars and name tokens", () => {
		const cases = [
			[/^a$|^[\s\S]+b$/, `^a$${strictEnd}|^[\\s\\S]+b$${strictEnd}`],
			[/^a$\n$/, `^a$${strictEnd}\\n$${strictEnd}`],
			[/^(?:a$)*\n$/, `^(?:a$${strictEnd})*\\n$${strictEnd}`],
			[/^a(?:$)|b$/, `^a(?:$${strictEnd})|b$${strictEnd}`],
			[/^a|b$/, `^a|b$${strictEnd}`],
			[/^[a$]+$/, `^[a$]+$${strictEnd}`],
			[/^[a\]$]+$/, `^[a\\]$]+$${strictEnd}`],
			[/^\[$/, `^\\[$${strictEnd}`],
			[/^\\$/, `^\\\\$${strictEnd}`],
			// biome-ignore lint/correctness/noEmptyCharacterClassInRegex: ECMA empty-class token boundary control.
			[/^[]$/, `^[]$${strictEnd}`],
			// biome-ignore lint/correctness/noEmptyCharacterClassInRegex: ECMA negated empty-class token boundary control.
			[/^[^]$/, `^[^]$${strictEnd}`],
			[/^(?<$>a)$/, `^(?<$>a)$${strictEnd}`],
			[/^(?<$>a)\k<$>$/, `^(?<$>a)\\k<$>$${strictEnd}`],
			[/^(?<x$>a)$/, `^(?<x$>a)$${strictEnd}`],
			[/^a(?<=$)$/, `^a(?<=$${strictEnd})$${strictEnd}`],
			[/^a(?<!$)$/, `^a(?<!$${strictEnd})$${strictEnd}`],
		] as const;
		for (const [pattern, expected] of cases) {
			const schema = z.string().regex(pattern);
			const generated = jsonSchemaOf(schema);
			const runtime = exportedSchema("schemas/example-v1.schema.json", schema);
			expect(generated.pattern).toBe(expected);
			for (const value of [
				"",
				"a",
				"aa",
				"b",
				"ab",
				"aZ",
				"a\n",
				"a\nb",
				"a\nb\n",
				"\n",
				"\n\n",
				"$",
				"a$",
				"]",
				"[",
				"\\",
				null,
				42,
			]) {
				const native = schema.safeParse(value).success;
				expect(accepts(generated, value), `${pattern}: ${JSON.stringify(value)}`).toBe(native);
				expect(accepts(runtime, value), `${pattern}: ${JSON.stringify(value)}`).toBe(native);
			}
			expect(guardExportedPatterns(generated)).toEqual(generated);
		}
	});
	it("does not mistake an optional preexisting lookahead for an unconditional strict end", () => {
		// Quantified lookahead is valid native ECMA without u; some JSON validators require u.
		const original = /^a$(?![\s\S])?|^b$/;
		const schema = z.string().regex(original);
		const expected = `^a$${strictEnd}(?![\\s\\S])?|^b$${strictEnd}`;
		for (const exported of [
			jsonSchemaOf(schema),
			exportedSchema("schemas/example-v1.schema.json", schema),
		]) {
			expect(exported.pattern).toBe(expected);
			for (const value of ["a", "b", "a\n", "b\n", "other"]) {
				expect(new RegExp(exported.pattern as string).test(value)).toBe(original.test(value));
			}
			expect(guardExportedPatterns(exported)).toEqual(exported);
		}
	});
	it("preserves inline multiline scopes and restores inherited mode through both public exporters", () => {
		const cases = [
			["^(?m:a$\\n)b$", `^(?m:a$\\n)b$${strictEnd}`, ["a\nb"]],
			["^(?m:a$\\n(?-m:b$)\\n?)$", `^(?m:a$\\n(?-m:b$${strictEnd})\\n?)$${strictEnd}`, ["a\nb"]],
			["^(?m:(?-m:a$)|b$\\n)c$", `^(?m:(?-m:a$${strictEnd})|b$\\n)c$${strictEnd}`, ["b\nc"]],
			["^(?m:(?i:a$\\n))b$", `^(?m:(?i:a$\\n))b$${strictEnd}`, ["a\nb", "A\nb"]],
			["^(?m:(?s:a.$\\n))b$", `^(?m:(?s:a.$\\n))b$${strictEnd}`, ["aX\nb", "a\n\nb"]],
			["^(?im-s:a$\\n)b$", `^(?im-s:a$\\n)b$${strictEnd}`, ["a\nb", "A\nb"]],
			["^(?m:(?-m:(?m:a$\\n)))b$", `^(?m:(?-m:(?m:a$\\n)))b$${strictEnd}`, ["a\nb"]],
			["^(?m:(a$\\n))b$", `^(?m:(a$\\n))b$${strictEnd}`, ["a\nb"]],
			["^(?m:(?<line>a$\\n))b$", `^(?m:(?<line>a$\\n))b$${strictEnd}`, ["a\nb"]],
			["^(?m:\\(a$\\n\\))b$", `^(?m:\\(a$\\n\\))b$${strictEnd}`, ["(a\n)b"]],
			["^(?m:[()]a$\\n)b$", `^(?m:[()]a$\\n)b$${strictEnd}`, ["(a\nb", ")a\nb"]],
			["^(?m:a$\\n)(?s:b$\\n?)$", `^(?m:a$\\n)(?s:b$${strictEnd}\\n?)$${strictEnd}`, ["a\nb"]],
			[
				"^(?m:(?s-m:a$\\n?)|b$\\n)c$",
				`^(?m:(?s-m:a$${strictEnd}\\n?)|b$\\n)c$${strictEnd}`,
				["b\nc"],
			],
		] as const;
		for (const [source, expected, valid] of cases) {
			const schema = z.string().regex(new RegExp(source));
			for (const exported of [
				jsonSchemaOf(schema),
				exportedSchema("schemas/example-v1.schema.json", schema),
			]) {
				for (const value of [...valid, ...valid.map((value) => `${value}\n`), "other", null, 42]) {
					expect(accepts(exported, value), `${source}: ${JSON.stringify(value)}`).toBe(
						schema.safeParse(value).success,
					);
				}
				for (const value of valid) {
					expect(accepts(exported, value)).toBe(true);
					expect(accepts(exported, `${value}\n`)).toBe(false);
				}
				expect(exported.pattern).toBe(expected);
				expect(guardExportedPatterns(exported)).toEqual(exported);
			}
		}
	});
	it("distinguishes legacy identity escapes from named backreferences, including forward references", () => {
		// Identity \\k is valid without u, but some JSON validators require u.
		for (const [source, valid] of [
			["^\\k<(?m:a$\\n>b$\\n)c$", "k<a\n>b\nc"],
			["^\\k<$>(?<$>a)$", "a"],
			["^(?<$>a)\\k<$>$", "aa"],
		] as const) {
			const original = new RegExp(source);
			expect(original.test(valid)).toBe(true);
			const schema = z.string().regex(original);
			for (const exported of [
				guardExportedPatterns({ pattern: source }),
				jsonSchemaOf(schema),
				exportedSchema("schemas/example-v1.schema.json", schema),
			]) {
				for (const value of [valid, `${valid}\n`, "other"]) {
					expect(new RegExp(exported.pattern as string).test(value)).toBe(original.test(value));
				}
				expect(guardExportedPatterns(exported)).toEqual(exported);
			}
		}
	});
	it("exempts only the fixed end guard from existing portability inspections", () => {
		expect(patternBody(`^a$${strictEnd}`)).toBe("^a$");
		expect(patterns(jsonSchemaOf(z.string().regex(/^a$/)))).toEqual(["^a$"]);
		for (const pattern of ["^\\s+$", "^\\S+$", "^\\w+$", "^a$(?![\\S\\s])"]) {
			const inspected = patterns(jsonSchemaOf(z.string().regex(new RegExp(pattern))));
			expect(inspected[0]).toMatch(ENGINE_DEPENDENT);
			expect(inspected).toEqual([pattern]);
		}
		for (const pattern of ["^a(?=b)$", "^a(?!b)$", "^a(?<=b)$", "^a(?<!b)$"]) {
			const inspected = patterns(jsonSchemaOf(z.string().regex(new RegExp(pattern))));
			expect(inspected[0]).toMatch(/\(\?<?[=!]/);
			expect(inspected).toEqual([pattern]);
		}
		for (const quantifier of ["?", "*", "+", "{0,1}", "??", "*?", "+?", "{0,1}?"]) {
			const pattern = `^a$${strictEnd}${quantifier}`;
			const inspected = patterns(jsonSchemaOf(z.string().regex(new RegExp(pattern))));
			expect(inspected[0]).toMatch(/\(\?<?[=!]/);
			expect(patternBody(pattern)).toBe(pattern);
			expect(inspected).toEqual([pattern]);
		}
	});
	it("preserves negated and conditional references to patterns that consume a line feed", () => {
		for (const predicate of [
			{ not: { $ref: "#/$defs/line" } },
			// biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is data.
			{ if: { $ref: "#/$defs/line" }, then: false, else: true },
		]) {
			const schema = z.any().meta({
				$defs: { line: { type: "string", pattern: "^a\\nb$" } },
				...predicate,
			});
			for (const exported of [
				jsonSchemaOf(schema),
				exportedSchema("schemas/example-v1.schema.json", schema),
			]) {
				expect(accepts(exported, "a\nb")).toBe(false);
				expect(accepts(exported, "ordinary")).toBe(true);
				expect(accepts(exported, 42)).toBe(true);
			}
		}
	});
	it("guards both conversion paths identically and binds the runtime extension digest", () => {
		const schema = z.strictObject({ value: ModelId });
		const generated = jsonSchemaOf(schema);
		const runtime = exportedSchema("schemas/example-v1.schema.json", schema);
		expect(runtime).toEqual({
			...generated,
			$id: "https://draftyak.com/spec/schemas/example-v1.schema.json",
		});
		const pattern = `${z.toJSONSchema(ModelId).pattern}${strictEnd}`;
		expect(generated).toMatchObject({ properties: { value: { pattern } } });
		expect(runtime).toMatchObject({ properties: { value: { pattern } } });
		expect(extensionDeclaration(aiProviderV1).schemaDigest).toBe(
			jcsSha256(exportedSchema(aiProviderV1.path, extensionSchema(aiProviderV1))),
		);
	});

	it("guards literal canonical schemas before their entries and declaration are frozen", () => {
		const input = canonicalToolsV1["calendar.freebusy"].entry.inputSchema;
		expect(input).toMatchObject({
			properties: { tz: { pattern: expect.stringContaining(strictEnd) } },
		});
		expect(toolV1Schema.$defs.CalendarFreebusyArguments).toEqual(input);
		expect(toolV1Schema.$defs.CalendarFreebusyEntry).toEqual({
			const: canonicalToolsV1["calendar.freebusy"].entry,
		});
		expect(toolExtensionDeclaration.schemaDigest).toBe(jcsSha256(toolV1Schema));
	});

	it("is nonmutating and idempotent while preserving existing negation and conjunction", () => {
		const original = {
			type: "string",
			pattern: "^[a-z]+$",
			not: { const: "denied" },
			allOf: [{ minLength: 2 }, { not: { const: "blocked" } }],
		};
		const snapshot = structuredClone(original);
		const guarded = guardExportedPatterns(original);
		expect(original).toEqual(snapshot);
		expect(guarded.not).toEqual(original.not);
		expect(guarded.allOf).toEqual(original.allOf);
		expect(guarded.pattern).toBe(`${original.pattern}${strictEnd}`);
		expect(guardExportedPatterns(guarded)).toEqual(guarded);
		for (const value of ["ok", "denied", "blocked", "x", "ok\n", 1]) {
			expect(accepts(guarded, value), JSON.stringify(value)).toBe(accepts(original, value));
		}
	});

	it("preserves untyped, mixed-type and non-string pattern semantics", () => {
		for (const schema of [
			{ pattern: "^abc$" },
			{ type: ["string", "null"], pattern: "^abc$" },
			{ type: ["string", "number"], pattern: "^abc$" },
			...["number", "null", "boolean", "array", "object"].map((type) => ({
				type,
				pattern: "^abc$",
			})),
		]) {
			const snapshot = structuredClone(schema);
			const guarded = guardExportedPatterns(schema);
			for (const value of [null, 42, true, [], {}, "abc", "other"]) {
				expect(accepts(guarded, value), JSON.stringify({ schema, value })).toBe(
					accepts(schema, value),
				);
			}
			expect(accepts(guarded, "abc\n")).toBe(false);
			expect(schema).toEqual(snapshot);
			expect(guardExportedPatterns(guarded)).toEqual(guarded);
		}
	});

	it("retains the semantics of preexisting legacy and string-only newline predicates", () => {
		for (const not of [{ pattern: "\\n" }, { type: "string", pattern: "\\n" }]) {
			for (const schema of [
				{ pattern: "^abc$", not },
				{ pattern: "^abc$", allOf: [{ not }] },
			]) {
				const guarded = guardExportedPatterns(schema);
				expect(guarded).toEqual({ ...schema, pattern: `${schema.pattern}${strictEnd}` });
				expect(guardExportedPatterns(guarded)).toEqual(guarded);
				for (const value of [null, 42, true, [], {}, "abc", "abc\n", "other"]) {
					expect(accepts(guarded, value)).toBe(accepts(schema, value));
				}
			}
		}
		const annotated = { pattern: "^abc$", not: { pattern: "\\n", description: "retained" } };
		const guarded = guardExportedPatterns(annotated);
		expect(guarded.not).toBe(annotated.not);
		expect(guarded).toEqual({ ...annotated, pattern: `${annotated.pattern}${strictEnd}` });
	});

	it("leaves instance data, references, boolean schemas and predicates intact", () => {
		const literal = { pattern: "^data$", properties: { pattern: "^still-data$" } };
		const original = {
			$ref: "#/$defs/item",
			$defs: { item: { type: "string", pattern: "^ok$" } },
			const: literal,
			enum: [literal],
			default: literal,
			examples: [literal],
			not: { pattern: "^denied$" },
			if: { pattern: "^condition$" },
			// biome-ignore lint/suspicious/noThenProperty: JSON Schema's conditional keyword is data.
			then: false,
			else: true,
		};
		const guarded = guardExportedPatterns(original);
		expect(guarded.$ref).toBe(original.$ref);
		expect(guarded.$defs.item).toMatchObject({ pattern: `^ok$${strictEnd}` });
		for (const key of [
			"const",
			"enum",
			"default",
			"examples",
			"not",
			"if",
			"then",
			"else",
		] as const) {
			expect(guarded[key]).toBe(original[key]);
		}
		expect(guardExportedPatterns(true)).toBe(true);
		expect(guardExportedPatterns(false)).toBe(false);
		for (const not of [false, true, { pattern: "^denied$" }]) {
			const schema = { type: "string", pattern: "^[a-z]+$", not };
			for (const value of ["ok", "denied", "ok\n", 1]) {
				expect(accepts(guardExportedPatterns(schema), value)).toBe(accepts(schema, value));
			}
		}
	});

	it("preserves composition cardinality, contains and boolean child semantics", () => {
		const cases = [
			{ oneOf: [{ type: "string", pattern: "^ok$" }, { const: "ok" }] },
			{ oneOf: [{ pattern: "^ok$" }, { type: "null" }] },
			{ anyOf: [false, { type: "string", pattern: "^ok$" }] },
			{ type: "array", prefixItems: [true, false], items: { pattern: "^ok$" } },
			{ type: "array", contains: { type: "string", pattern: "^ok$" }, minContains: 1 },
			{ type: "object", properties: { value: false }, additionalProperties: true },
		];
		for (const schema of cases) {
			for (const value of [
				"ok",
				"ok\n",
				"other",
				null,
				1,
				[],
				[1],
				["ok"],
				["ok\n"],
				{},
				{ value: 1 },
			]) {
				expect(accepts(guardExportedPatterns(schema), value)).toBe(accepts(schema, value));
			}
		}
	});

	it("does not reinterpret unanchored patterns or an escaped final dollar", () => {
		for (const pattern of ["plain", "^prefix", "suffix$", "^cost\\$"]) {
			expect(guardExportedPatterns({ pattern })).toEqual({ pattern });
		}
	});
});
