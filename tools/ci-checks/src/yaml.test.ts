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
});
