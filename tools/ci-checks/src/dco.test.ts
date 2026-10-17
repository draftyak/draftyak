import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempRepo } from "../test/temp-repo.ts";
import { commitsBetween, dcoProblems } from "./dco.ts";

const ada = "Ada Lovelace <ada@example.com>";
const bob = "Bob Builder <bob@example.com>";
const author = { sha: "a".repeat(40), name: "Ada Lovelace", email: "ada@example.com" };

describe("dco", () => {
	it.each([
		["the author's sign-off", [ada], []],
		["the author's sign-off in another case", ["ada lovelace <ADA@Example.com>"], []],
		["several sign-offs, one of them the author's", [bob, ada], []],
		["no sign-off", [], ["no Signed-off-by"]],
		["someone else's sign-off", [bob], [`signed off by ${bob}, not the author ${ada}`]],
		["the author's email under another name", ["Ada L <ada@example.com>"], ["not the author"]],
		["several sign-offs, none the author's", [bob, "Eve <eve@example.com>"], ["not the author"]],
	])("%s", (_, signers, expected) => {
		const message = ["fix: x", "", ...signers.map((signer) => `Signed-off-by: ${signer}`)].join(
			"\n",
		);
		const problems = dcoProblems([{ ...author, message }]);
		expect(problems).toHaveLength(expected.length);
		for (const [index, part] of expected.entries()) expect(problems[index]).toContain(part);
	});

	const repo = tempRepo();
	afterAll(() => repo.remove());
	const base = repo.commit("chore: base");
	repo.commit(`feat: a\n\nSigned-off-by: ${ada}`);
	repo.commit("fix: b");
	repo.commit(`docs: c\n\nSigned-off-by: ${bob}`, ada);
	const head = repo.git("rev-parse", "HEAD");

	it("reads base..head from git and names each failing commit", () => {
		const commits = commitsBetween(base, head, repo.dir);
		expect(commits.map((commit) => commit.message.split("\n")[0])).toEqual([
			"docs: c",
			"fix: b",
			"feat: a",
		]);
		expect(dcoProblems(commits)).toEqual([
			expect.stringMatching(/^[0-9a-f]{12} docs: c: signed off by Bob Builder/),
			expect.stringMatching(/^[0-9a-f]{12} fix: b: no Signed-off-by$/),
		]);
	});

	it("takes the SHAs from the environment and exits 1 on a missing sign-off", () => {
		const script = path.join(import.meta.dirname, "dco.ts");
		const run = (env: Record<string, string>) =>
			spawnSync(process.execPath, [script], {
				cwd: repo.dir,
				encoding: "utf8",
				env: { ...process.env, ...env },
			});
		const failed = run({ BASE_SHA: base, HEAD_SHA: head });
		expect(failed.status).toBe(1);
		expect(failed.stdout).toContain("dco: 2 of 3 commits need their author's sign-off");
		expect(run({ BASE_SHA: head, HEAD_SHA: head }).status).toBe(0);
		expect(run({ BASE_SHA: "--output=x", HEAD_SHA: head }).status).toBe(2);
	});
});
