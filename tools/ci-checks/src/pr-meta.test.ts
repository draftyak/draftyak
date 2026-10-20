import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAttribution, prProblems } from "./pr-meta.ts";

// Built at runtime, so no file in the repo holds an attribution line.
const coAuthored = ["Co", "authored", "by"].join("-");
const generated = ["Generated", "with"].join(" ");
const ok = { title: "ci: add the CI skeleton", body: "", head: "m0-03-ci-skeleton", base: "m0" };

describe("pr-meta", () => {
	it("accepts Conventional Commit titles with the allowed types only", () => {
		const good = [
			"feat: x",
			"fix(dco)!: x",
			"docs(roadmap): x",
			"spike(s01): x",
			"revert: x",
			"ci(m0.3): x",
		];
		const bad = ["Feat: x", "feature: x", "fix:x", "fix: ", "fix(): x", "fix x", "WIP: x"];
		expect(good.flatMap((title) => prProblems({ ...ok, title }))).toEqual([]);
		for (const title of bad) {
			expect(prProblems({ ...ok, title }), title).toEqual([expect.stringContaining("is not")]);
		}
	});

	it("accepts item branches into their milestone, and milestones into main", () => {
		const good = [
			["m0-03-ci-skeleton", "m0"],
			["m0-06a-spike-kit", "m0"],
			["m1b-02-transport", "m1b"],
			["m0", "main"],
		];
		const bad = [
			["m0-03-ci-skeleton", "main"],
			["m0-03-ci-skeleton", "m1"],
			["m0-3-ci", "m0"],
			["m0-03-CI", "m0"],
			["feature/x", "m0"],
			["m0", "m1"],
			["main", "m0"],
		];
		expect(good.flatMap(([head = "", base = ""]) => prProblems({ ...ok, head, base }))).toEqual([]);
		for (const [head = "", base = ""] of bad) {
			expect(prProblems({ ...ok, head, base }), `${head} into ${base}`).toEqual([
				expect.stringContaining("go into mN"),
			]);
		}
	});

	it.each([
		["m1-99-plugin-stdio", "m1"],
		["m1-100-plugin-stdio", "m1"],
		["m2-142-device-auth", "m2"],
		["m10-1000-boundary", "m10"],
		["m1b-100a-transport", "m1b"],
		["m11-1234567890-release", "m11"],
	])("accepts two or more item-number digits in %s into %s", (head, base) => {
		expect(prProblems({ ...ok, head, base })).toEqual([]);
	});

	it.each([
		["m1-1-plugin-stdio", "m1"],
		["m1-9a-plugin-stdio", "m1"],
		["m1--plugin-stdio", "m1"],
		["m1-+100-plugin-stdio", "m1"],
		["m1-1_00-plugin-stdio", "m1"],
		["m1-0x64-plugin-stdio", "m1"],
		["m1-100ab-plugin-stdio", "m1"],
		["m1-100A-plugin-stdio", "m1"],
		["prefix-m1-100-plugin-stdio", "m1"],
		["refs/heads/m1-100-plugin-stdio", "m1"],
		[" m1-100-plugin-stdio", "m1"],
		["m1/100-plugin-stdio", "m1"],
		["M1-100-plugin-stdio", "m1"],
		["m-100-plugin-stdio", "m1"],
		["m1bb-100-plugin-stdio", "m1bb"],
		["mx-100-plugin-stdio", "mx"],
		["m1-100-", "m1"],
		["m1-100--plugin-stdio", "m1"],
		["m1-100-plugin-stdio-", "m1"],
		["m1-100-plugin--stdio", "m1"],
		["m1-100-Plugin-stdio", "m1"],
		["m1-100-plugin_stdio", "m1"],
		["m1-100-plugin.stdio", "m1"],
		["m1-100-plugin-stdio/extra", "m1"],
		["m1-100-plugin-stdio ", "m1"],
		["m1-100-plugin-stdio", "m2"],
		["m1-100-plugin-stdio", "main"],
	])("keeps the item-branch boundary for %s into %s", (head, base) => {
		expect(prProblems({ ...ok, head, base })).toEqual([expect.stringContaining("go into mN")]);
	});

	it.each([
		`${coAuthored}: Someone <someone@example.com>`,
		`  ${coAuthored.toUpperCase()}: Some One <one@example.com>`,
		`${generated} a tool`,
		`\u{1F916} ${generated} [a tool](https://example.com)`,
		`> ${generated} a tool`,
	])("refuses the attribution line %j", (line) => {
		expect(isAttribution(line)).toBe(true);
		expect(prProblems({ ...ok, body: `Summary\r\n\r\n${line}\r\n` })).toEqual([
			expect.stringContaining("attribution"),
		]);
	});

	it.each([
		`No ${coAuthored} trailers.`,
		`\`${coAuthored}: Name <email>\` lines are refused.`,
		`${coAuthored}: a line without an address`,
		`Lines beginning "${generated}" are refused.`,
		`"${generated}" lines are refused.`,
		`\`${generated}\` lines are refused.`,
	])("passes the prose %j", (line) => {
		expect(prProblems({ ...ok, body: line })).toEqual([]);
	});

	it("reads only the environment and exits 0, 1 or 2", () => {
		const script = path.join(import.meta.dirname, "pr-meta.ts");
		const pr = { PR_TITLE: ok.title, PR_BODY: "", PR_HEAD_REF: ok.head, PR_BASE_REF: ok.base };
		const status = (env: Record<string, string>): number | null =>
			spawnSync(process.execPath, [script, "--title", "fix: ignored"], {
				env: { ...process.env, ...pr, ...env },
			}).status;
		expect(status({})).toBe(0);
		expect(status({ PR_HEAD_REF: "m1-100-plugin-stdio", PR_BASE_REF: "m1" })).toBe(0);
		expect(status({ PR_HEAD_REF: "m2-142-device-auth", PR_BASE_REF: "m2" })).toBe(0);
		expect(status({ PR_HEAD_REF: "m1-1-plugin-stdio", PR_BASE_REF: "m1" })).toBe(1);
		expect(status({ PR_TITLE: "Update stuff" })).toBe(1);
		expect(status({ PR_BODY: `x\n${coAuthored}: A <a@example.com>` })).toBe(1);
		expect(status({ PR_BASE_REF: "" })).toBe(2);
	});
});
