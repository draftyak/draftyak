import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { isAttribution } from "../../ci-checks/src/pr-meta.ts";
import { rules } from "../rules/index.ts";
import { devkitNames, devkitRule } from "../rules/openai.ts";
import { glue, lineHits, type PatternRule, type Sample } from "../src/rules.ts";
import { type Finding, scanFiles } from "../src/scan.ts";
import { removeTemp, tempDir, write } from "./helpers.ts";

afterAll(removeTemp);

// Every case is written into its own temp dir at runtime; test names carry only rule ids and paths.
function scan(sample: Sample): Finding[] {
	const dir = tempDir();
	write(dir, sample.path, sample.text);
	return scanFiles(dir, [sample.path]).findings;
}

const cases = (samples: readonly Sample[]) =>
	samples.map((sample, index) => ({ ...sample, index: index + 1 }));

describe("the rules", () => {
	it("have unique kebab-case ids, a reason, and positive and negative cases", () => {
		const ids = rules.map((rule) => rule.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const rule of rules) {
			expect(rule.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)+$|^attribution$/);
			expect(rule.reason.length, rule.id).toBeGreaterThan(10);
			expect(rule.bad.length, rule.id).toBeGreaterThan(0);
			expect(rule.good.length, rule.id).toBeGreaterThan(0);
		}
	});

	it("use patterns without the g or y flag", () => {
		const stateful = rules.flatMap((rule) =>
			rule.kind === "mark" ? [] : rule.patterns.filter((pattern) => /[gy]/.test(pattern.flags)),
		);
		expect(stateful).toEqual([]);
	});

	it("have ids, which name these tests, that no rule flags", () => {
		expect(scan({ path: "src/ids.ts", text: rules.map((rule) => rule.id).join("\n") })).toEqual([]);
	});

	it("run before pnpm install: src/ and rules/ import only node: built-ins and relative files", () => {
		// Import statements start a line; the samples' import lines sit inside strings.
		const statement =
			/^(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)|^import\s*\(?\s*["']([^"']+)/gm;
		const imports = ["src", "rules"].flatMap((dir) =>
			readdirSync(path.join(import.meta.dirname, "..", dir)).flatMap((file) =>
				[
					...readFileSync(path.join(import.meta.dirname, "..", dir, file), "utf8").matchAll(
						statement,
					),
				].map((match) => `${dir}/${file}: ${match[1] ?? match[2]}`),
			),
		);
		expect(imports.length).toBeGreaterThan(10);
		expect(imports.filter((line) => !/: (?:node:|\.\.?\/)/.test(line))).toEqual([]);
	});
});

describe.each([...rules])("$id", (rule) => {
	it.each(cases(rule.bad))("flags positive case $index in $path", (sample) => {
		const found = scan(sample).map((finding) => finding.rule);
		expect(found.length).toBeGreaterThan(0);
		expect(new Set(found)).toEqual(new Set([rule.id]));
	});

	it.each(cases(rule.good))("passes negative case $index in $path", (sample) => {
		expect(scan(sample)).toEqual([]);
	});
});

describe("the attribution rule", () => {
	const attribution = rules.find((rule) => rule.id === "attribution") as PatternRule;
	const coAuthored = glue("Co", "-authored-by");
	const generated = glue("Generated", " with");
	const lines = [
		`${coAuthored}: Someone <someone@example.com>`,
		`  ${coAuthored.toUpperCase()}: Some One <one@example.com>  `,
		`${coAuthored}:A <a>`,
		`${coAuthored}: <a@example.com>`,
		`${coAuthored}: a <>`,
		`${coAuthored}: a <b> c`,
		`${coAuthored}: a  <b <c>>`,
		`${coAuthored}: a line without an address`,
		`No ${coAuthored} trailers.`,
		`\`${coAuthored}: Name <email>\` lines are refused.`,
		`${generated} a tool`,
		`\u{1F916} ${generated} [a tool](https://example.com)`,
		`> ${generated} a tool`,
		`  # * ${generated} a tool`,
		`// ${generated} a tool`,
		`; ${generated} a tool`,
		`"${generated}" lines are refused.`,
		`\`${generated}\` lines are refused.`,
		`Lines beginning "${generated}" are refused.`,
		`${generated}out a space`,
	];

	it("refuses exactly the lines pr-meta (M0.3) refuses", () => {
		const ours = lines.map((line) => lineHits(line, [attribution]).length > 0);
		expect(ours).toEqual(lines.map(isAttribution));
		expect(ours.filter(Boolean).length).toBeGreaterThan(4);
	});
});

describe("the SIWC DevKit slot", () => {
	it("becomes a rule once S7 records the package names", () => {
		expect(rules.some((rule) => rule.id === "openai-devkit")).toBe(devkitNames.length > 0);
	});

	it("flags exactly the names it is given", () => {
		const name = glue("@example/", "siwc-devkit");
		const rule = devkitRule([name]);
		expect(rule.bad.map((sample) => lineHits(sample.text, [rule]).length)).toEqual([1]);
		expect(rule.good.flatMap((sample) => lineHits(sample.text, [rule]))).toEqual([]);
		const near = [`import a from "${name}-extra";`, `import b from "@other/${name}";`];
		expect(near.flatMap((line) => lineHits(line, [rule]))).toEqual([]);
	});
});
