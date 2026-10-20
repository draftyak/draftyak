import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { tempRepo } from "../test/temp-repo.ts";
import { identitiesBetween, identityProblems, isFork, isGate } from "./commit-identity.ts";
import { UsageError } from "./lib.ts";

const owner = "Nick Savov <nicksavov@protonmail.com>";
const identity = (authorEmail: string, committerEmail: string) => ({
	sha: "a".repeat(40),
	subject: "fix: x",
	author: "Ada",
	authorEmail,
	committer: "Bob",
	committerEmail,
});

describe("commit-identity", () => {
	it.each([
		[
			"the owner as author and committer",
			"nicksavov@protonmail.com",
			"nicksavov@protonmail.com",
			[],
		],
		[
			"the owner's email in another case",
			"NickSavov@ProtonMail.com",
			"nicksavov@protonmail.com",
			[],
		],
		[
			"the owner's GitHub noreply address, which commits a rebase merge",
			"nicksavov@protonmail.com",
			"nicksavov@users.noreply.github.com",
			[],
		],
		[
			"an allowed committer email in another case",
			"nicksavov@protonmail.com",
			"NickSavov@Users.NoReply.GitHub.com",
			[],
		],
		[
			"GitHub's own address, for commits GitHub makes itself",
			"nicksavov@users.noreply.github.com",
			"noreply@github.com",
			[],
		],
		[
			"another author email",
			"nick@example.com",
			"nicksavov@protonmail.com",
			["author Ada <nick@example.com>"],
		],
		[
			"another committer email",
			"nicksavov@protonmail.com",
			"bot@example.com",
			["committer Bob <bot@example.com>"],
		],
		[
			"both other emails",
			"ada@example.com",
			"bob@example.com",
			["author Ada <ada@example.com>, committer Bob <bob@example.com>"],
		],
		[
			"the owner's email with a Kelvin sign for its k",
			"nicKsavov@protonmail.com",
			"nicksavov@protonmail.com",
			["author Ada <nicKsavov@protonmail.com>"],
		],
		[
			"the owner's email with a trailing no-break space",
			"nicksavov@protonmail.com",
			"nicksavov@protonmail.com ",
			["committer Bob <nicksavov@protonmail.com >"],
		],
	])("%s", (_, authorEmail, committerEmail, expected) => {
		const problems = identityProblems([identity(authorEmail, committerEmail)]);
		expect(problems).toHaveLength(expected.length);
		for (const [index, part] of expected.entries()) expect(problems[index]).toContain(part);
	});

	it("checks only committer emails on a gate PR", () => {
		expect(
			identityProblems([identity("ada@example.com", "nicksavov@users.noreply.github.com")], true),
		).toEqual([]);
		expect(identityProblems([identity("ada@example.com", "bob@example.com")], true)).toEqual([
			`${"a".repeat(12)} fix: x: committer Bob <bob@example.com>`,
		]);
	});

	it.each([
		["this repository", "draftyak/draftyak", "draftyak/draftyak", false],
		["this repository in another case", "DraftYak/DraftYak", "draftyak/draftyak", false],
		["a fork", "someone/draftyak", "draftyak/draftyak", true],
		["a deleted fork", "", "draftyak/draftyak", true],
		["a local run without BASE_REPO", undefined, undefined, false],
	])("treats %s as a fork: %s", (_, headRepo, baseRepo, fork) => {
		expect(isFork(headRepo, baseRepo)).toBe(fork);
	});

	it("refuses an unset HEAD_REPO beside BASE_REPO", () => {
		expect(() => isFork(undefined, "draftyak/draftyak")).toThrow(UsageError);
	});

	it.each([
		["m0", "main", true],
		["m7b", "main", true],
		["m0", "m1", false],
		["m0-03c-commit-identity", "main", false],
		["main", "main", false],
		[undefined, undefined, false],
	])("treats %s into %s as a gate PR: %s", (headRef, baseRef, gate) => {
		expect(isGate(headRef, baseRef)).toBe(gate);
	});

	const repo = tempRepo();
	afterAll(() => repo.remove());
	const commitAs = (committer: string, email: string, subject: string, author = owner) =>
		repo.git(
			"-c",
			`user.name=${committer}`,
			"-c",
			`user.email=${email}`,
			"commit",
			"-q",
			"--allow-empty",
			"-m",
			subject,
			`--author=${author}`,
		);
	const base = repo.commit("chore: base", owner);
	repo.commit("feat: a", owner);
	repo.commit("fix: b", "Nick Savov <nick@example.com>");
	commitAs("Build Bot", "bot@example.com", "docs: c");
	repo.git("checkout", "-q", "-b", "side", base);
	repo.commit("feat: side", "Side Author <side@example.com>");
	repo.git("checkout", "-q", "main");
	repo.git(
		"-c",
		"user.name=Merger",
		"-c",
		"user.email=merger@example.com",
		"merge",
		"-q",
		"--no-ff",
		"-m",
		"merge side",
		"side",
	);
	commitAs("Nick Savov", "NickSavov@Users.NoReply.GitHub.com", "chore: d");
	const head = repo.git("rev-parse", "HEAD");
	commitAs(
		"Nick Savov",
		"nicksavov@users.noreply.github.com",
		"feat: contributed",
		"Ada Contributor <ada@example.com>",
	);
	const contributed = repo.git("rev-parse", "HEAD");

	it("reads base..head from git, merges and both parents included, and names each commit with another email", () => {
		const commits = identitiesBetween(base, head, repo.dir);
		expect(commits.map((commit) => commit.subject).sort()).toEqual([
			"chore: d",
			"docs: c",
			"feat: a",
			"feat: side",
			"fix: b",
			"merge side",
		]);
		const problems = identityProblems(commits);
		for (const problem of problems) expect(problem).toMatch(/^[0-9a-f]{12} /);
		expect(problems.map((problem) => problem.slice(13)).sort()).toEqual([
			"docs: c: committer Build Bot <bot@example.com>",
			"feat: side: author Side Author <side@example.com>, committer Side Author <side@example.com>",
			"fix: b: author Nick Savov <nick@example.com>, committer Nick Savov <nick@example.com>",
			"merge side: author Merger <merger@example.com>, committer Merger <merger@example.com>",
		]);
	});

	it("takes the SHAs, repositories and refs from the environment, skips forks and exits 2 on bad input", () => {
		const script = path.join(import.meta.dirname, "commit-identity.ts");
		const run = (env: Record<string, string | undefined>) =>
			spawnSync(process.execPath, [script], {
				cwd: repo.dir,
				encoding: "utf8",
				env: { ...process.env, HEAD_REF: undefined, BASE_REF: undefined, ...env },
			});
		const own = {
			BASE_SHA: base,
			HEAD_SHA: head,
			BASE_REPO: "draftyak/draftyak",
			HEAD_REPO: "draftyak/draftyak",
		};
		const failed = run(own);
		expect(failed.status).toBe(1);
		expect(failed.stdout).toContain("commit-identity: 4 of 6 commits");
		const fork = run({ ...own, HEAD_REPO: "someone/draftyak" });
		expect(fork.status).toBe(0);
		expect(fork.stdout).toContain("skipped, the PR comes from someone/draftyak");
		expect(run({ ...own, BASE_SHA: head }).status).toBe(0);
		expect(run({ ...own, BASE_SHA: "--output=x" }).status).toBe(2);
		expect(run({ ...own, HEAD_REPO: undefined }).status).toBe(2);
		const outsideAuthor = { ...own, BASE_SHA: head, HEAD_SHA: contributed };
		expect(run(outsideAuthor).status).toBe(1);
		const gate = run({ ...outsideAuthor, HEAD_REF: "m0", BASE_REF: "main" });
		expect(gate.status).toBe(0);
		expect(gate.stdout).toContain("all 1 commits use an allowed committer email (a gate PR");
	});
});
