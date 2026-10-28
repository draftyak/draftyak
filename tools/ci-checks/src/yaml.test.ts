import { describe, expect, it } from "vitest";
import { parseYaml } from "./yaml.ts";

const source = `name: ci # the name
on:
  push:
    branches: [main, 'spikes-run/**']
jobs:
  a:
    steps:
    - uses: owner/repo@abc # v1
      with:
        n: 0
        on: false
        q: "a \\"b\\""
        s: 'it''s # no'
        e:
      run: |
        echo "\${{ env.X }}"

        # script
`;

describe("parseYaml", () => {
	const flowPrefixes = [
		["anchor", "&node"],
		["alias", "*node"],
		["local tag", "!local value"],
		["global tag", "!!str value"],
		["literal block", "|"],
		["literal chomp", "|-"],
		["folded block marker", ">"],
		["folded block", ">-"],
		["directive", "%YAML 1.2"],
		["reserved at sign", "@reserved"],
		["reserved backtick", "`reserved"],
		["explicit key", "? key"],
		["tab-separated key", "?\tkey"],
		["standalone key", "?"],
		["explicit value", ": value"],
		["tab-separated value", ":\tvalue"],
		["standalone value", ":"],
		["sequence entry", "- item"],
		["tab-separated sequence entry", "-\titem"],
		["standalone sequence entry", "-"],
	] as const;

	it.each(flowPrefixes)("refuses unquoted %s in flow sequences", (_, raw) => {
		for (const items of [raw, `${raw}, safe`, `safe, ${raw}, safe`, `safe, ${raw}`]) {
			expect(() => parseYaml(`a: [${items}]`)).toThrow("unsupported flow sequence item");
		}
	});

	it.each(flowPrefixes)("keeps quoted %s as literal flow data", (_, raw) => {
		expect(parseYaml(`a: ['${raw}', ${JSON.stringify(raw)}]`).value).toEqual({ a: [raw, raw] });
	});

	it("preserves ordinary flow scalars and their existing resolution", () => {
		expect(
			parseYaml(
				"a: [ -word, -12, +7, 1.5, -1e2, true, FALSE, null, ~, https://example.invalid/x, word&node, word!tag, word|data, ?word, :word, on, 'true', \"12\" ]",
			).value,
		).toEqual({
			a: [
				"-word",
				-12,
				7,
				1.5,
				"-1e2",
				true,
				false,
				null,
				null,
				"https://example.invalid/x",
				"word&node",
				"word!tag",
				"word|data",
				"?word",
				":word",
				"on",
				"true",
				"12",
			],
		});
	});

	it("preserves empty flow sequences and the existing trailing comma", () => {
		expect(parseYaml("a: []\nb: [one,]").value).toEqual({ a: [], b: ["one"] });
	});

	it.each([
		"a: [[one]]",
		"a: [{b: 1}]",
		"a: [one: two]",
		"a: [one # comment]",
		"a: ['one' two]",
		"a: [one",
		"a: [one,,two]",
	])("preserves flow grammar refusal for %s", (yaml) => {
		expect(() => parseYaml(yaml)).toThrow(SyntaxError);
	});

	it("reads mappings, sequences, flow sequences, scalars and comments", () => {
		const doc = parseYaml(source);
		const step = { n: 0, on: false, q: 'a "b"', s: "it's # no", e: null };
		expect(doc.value).toEqual({
			name: "ci",
			on: { push: { branches: ["main", "spikes-run/**"] } },
			jobs: {
				a: {
					steps: [
						{ uses: "owner/repo@abc", with: step, run: `echo "\${{ env.X }}"\n\n# script\n` },
					],
				},
			},
		});
		expect(parseYaml(source.replaceAll("\n", "\r\n")).value).toEqual(doc.value);
		expect(doc.scalars.find((scalar) => scalar.path.at(-1) === "uses")).toEqual({
			path: ["jobs", "a", "steps", 0, "uses"],
			value: "owner/repo@abc",
			line: 8,
			comment: "v1",
		});
	});

	it.each([
		["an anchor", "a: &x 1"],
		["an alias", "a: *x"],
		["a tag", "a: !!str 1"],
		["a flow mapping", "a: {b: 1}"],
		["a folded scalar", "a: >\n  b"],
		["a multi-line plain scalar", "a: one\n  two"],
		["an unclosed quote", "a: 'one"],
		["': ' in a plain scalar", "a: b: c"],
		["a duplicate key", "a: 1\na: 2"],
		["tab indentation", "a:\n\tb: 1"],
		["uneven indentation", "a:\n  b: 1\n c: 2"],
		["text after a quoted scalar", "a: 'b' c"],
		["a lone CR", "a: 1 #\rb: 2"],
		["a NEL", "a: 1 #\u0085b: 2"],
		["a line separator", "a: 1 # b: 2"],
		["a no-break space before a comment", "a: 1 # b"],
	])("refuses %s", (_, yaml) => {
		expect(() => parseYaml(yaml)).toThrow(SyntaxError);
	});

	const keyForms = [
		["plain", (name: string) => name],
		["double-quoted", (name: string) => `"${name}"`],
		["single-quoted", (name: string) => `'${name}'`],
	] as const;
	// Each document puts the key on the given line.
	const keyPlaces = [
		["with a scalar value", (key: string) => `${key}: write-all`, 1],
		["with a null value", (key: string) => `a: 1\n${key}:`, 2],
		["with a mapping value", (key: string) => `${key}:\n  permissions: write-all`, 1],
		["with a flow sequence value", (key: string) => `${key}: [a, b]`, 1],
		["with a block sequence value", (key: string) => `${key}:\n- a`, 1],
		["with a literal block value", (key: string) => `${key}: |\n  a`, 1],
		["with a space before its colon", (key: string) => `${key} : 1`, 1],
		["nested, with a scalar value", (key: string) => `jobs:\n  a:\n    ${key}: write-all`, 3],
		["nested, with a mapping value", (key: string) => `jobs:\n  ${key}:\n    b: 1`, 2],
		["first in a sequence item", (key: string) => `steps:\n- ${key}: 1`, 2],
		["later in a sequence item", (key: string) => `- a: 1\n  ${key}:\n    b: 1`, 2],
	] as const;

	it.each(
		keyForms.flatMap(([form, quote]) =>
			keyPlaces.map(([place, document, line]) => [form, place, quote, document, line] as const),
		),
	)("refuses a %s __proto__ key %s", (_, __, quote, document, line) => {
		expect(() => parseYaml(document(quote("__proto__")))).toThrow(
			`line ${line}: __proto__ keys are not supported`,
		);
		expect(JSON.stringify(parseYaml(document(quote("constructor"))).value)).toContain(
			'"constructor":',
		);
	});

	it.each(keyForms)(
		"refuses a repeated %s __proto__ key before the duplicate check",
		(_, quote) => {
			const document = (key: string): string => `${key}:\n  a: 1\n${key}:\n  b: 2`;
			expect(() => parseYaml(document(quote("__proto__")))).toThrow(
				"line 1: __proto__ keys are not supported",
			);
			expect(() => parseYaml(document(quote("constructor")))).toThrow(
				"line 3: duplicate key constructor",
			);
		},
	);

	// Each document puts `sep` before a value on the given line and, without a tab there, reads as
	// the given value.
	const tabbed = [
		[
			"an event",
			(sep: string) => `on: ${sep}pull_request_target`,
			1,
			{ on: "pull_request_target" },
		],
		["another event", (sep: string) => `on: ${sep}workflow_run`, 1, { on: "workflow_run" }],
		[
			"a flow sequence",
			(sep: string) => `on: ${sep}[push, workflow_run]`,
			1,
			{ on: ["push", "workflow_run"] },
		],
		[
			"a flow sequence with push",
			(sep: string) => `on: ${sep}[push, pull_request]`,
			1,
			{ on: ["push", "pull_request"] },
		],
		[
			"a block sequence item",
			(sep: string) => `on:\n  - ${sep}pull_request_target`,
			2,
			{ on: ["pull_request_target"] },
		],
		["a mapping in a sequence item", (sep: string) => `- ${sep}a: b`, 1, [{ a: "b" }]],
		["a comment in a sequence item", (sep: string) => `- ${sep}# b`, 1, [null]],
		[
			"a later value in a sequence item",
			(sep: string) => `- a: 1\n  b: ${sep}c`,
			2,
			[{ a: 1, b: "c" }],
		],
		["a quoted scalar", (sep: string) => `a: ${sep}'b'`, 1, { a: "b" }],
		["a literal block", (sep: string) => `a: ${sep}|\n  b`, 1, { a: "b\n" }],
		["a comment", (sep: string) => `a: ${sep}# b`, 1, { a: null }],
		["a value after several spaces", (sep: string) => `a:   ${sep}b`, 1, { a: "b" }],
		["a quoted key's value", (sep: string) => `"a": ${sep}b`, 1, { a: "b" }],
	] as const;

	it.each(tabbed)("refuses a tab before %s", (_, document, line, value) => {
		expect(() => parseYaml(document("\t"))).toThrow(
			`line ${line}: tabs before a value are not supported`,
		);
		expect(parseYaml(document("")).value).toEqual(value);
	});

	it.each([
		[
			"a flow mapping",
			(sep: string) => `on: ${sep}{pull_request_target}`,
			"unsupported YAML syntax",
		],
		[
			"a nested sequence",
			(sep: string) => `- ${sep}- a`,
			"nested compact sequences are not supported",
		],
	] as const)("refuses %s with or without a tab before it", (_, document, refusal) => {
		expect(() => parseYaml(document("\t"))).toThrow(
			"line 1: tabs before a value are not supported",
		);
		expect(() => parseYaml(document(""))).toThrow(`line 1: ${refusal}`);
	});

	// Each document puts `sep` after a key's colon on line 1 and, with a space there, reads as the
	// given value.
	it.each([
		[
			"a key in a sequence item",
			(sep: string) => `- uses:${sep}a/b@c`,
			[{ uses: "a/b@c" }],
			"tabs before a value are not supported",
		],
		[
			"a key and a space in a sequence item",
			(sep: string) => `- run :${sep}echo`,
			[{ run: "echo" }],
			"tabs before a value are not supported",
		],
		["a key in a mapping", (sep: string) => `a:${sep}b`, { a: "b" }, "expected `key: value`"],
	] as const)("refuses a tab after the colon of %s", (_, document, value, refusal) => {
		expect(() => parseYaml(document("\t"))).toThrow(`line 1: ${refusal}`);
		expect(parseYaml(document(" ")).value).toEqual(value);
	});

	// Each document puts `sep` after an indicator on line 1.
	it.each([
		[
			"a key in a plain scalar",
			(sep: string) => `a: b:${sep}c`,
			"plain scalars can't contain ': '",
			"tabs before a value are not supported",
		],
		[
			"a key in a flow sequence item",
			(sep: string) => `a: [b:${sep}c]`,
			"unsupported flow sequence item",
			"unsupported flow sequence item",
		],
		[
			"a key without a value in a flow sequence item",
			(sep: string) => `a: [b:${sep}]`,
			"unsupported flow sequence item",
			"unsupported flow sequence item",
		],
		[
			"a sequence entry as a value",
			(sep: string) => `a: -${sep}b`,
			"unsupported YAML syntax",
			"unsupported YAML syntax",
		],
		[
			"a nested sequence entry",
			(sep: string) => `- -${sep}a`,
			"nested compact sequences are not supported",
			"unsupported YAML syntax",
		],
	] as const)("refuses %s with a space or a tab after it", (_, document, withSpace, withTab) => {
		expect(() => parseYaml(document(" "))).toThrow(`line 1: ${withSpace}`);
		expect(() => parseYaml(document("\t"))).toThrow(`line 1: ${withTab}`);
	});

	it("keeps tabs inside a value, before a comment and between flow items", () => {
		expect(parseYaml("a: b\tc\nd: e\t# f\ng: [\th,\ti\t]\nj: k:l\tm\nn: [o:p\t]").value).toEqual({
			a: "b\tc",
			d: "e",
			g: ["h", "i"],
			j: "k:l\tm",
			n: ["o:p"],
		});
	});
});
