import { cliArgs, git, revision, runCli } from "./lib.ts";

export interface Commit {
	readonly sha: string;
	readonly name: string;
	readonly email: string;
	readonly message: string;
}

const signOffLine = /^signed-off-by:[ \t]*(.*?)[ \t]*<([^<>\r\n]*)>[ \t]*\r?$/gim;

export function signOffs(message: string): { name: string; email: string }[] {
	return [...message.matchAll(signOffLine)].map(([, name = "", email = ""]) => ({ name, email }));
}

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// One line per commit without a Signed-off-by from its author.
export function dcoProblems(commits: readonly Commit[]): string[] {
	return commits.flatMap((commit) => {
		const found = signOffs(commit.message);
		const label = `${commit.sha.slice(0, 12)} ${commit.message.split("\n", 1)[0]}`;
		if (found.length === 0) return [`${label}: no Signed-off-by`];
		if (found.some((s) => same(s.name, commit.name) && same(s.email, commit.email))) return [];
		const listed = found.map((s) => `${s.name} <${s.email}>`).join(", ");
		return [`${label}: signed off by ${listed}, not the author ${commit.name} <${commit.email}>`];
	});
}

// The commits in base..head, merges included.
export function commitsBetween(base: string, head: string, cwd?: string): Commit[] {
	return git(["log", "-z", "--format=%H%n%an%n%ae%n%B", `${base}..${head}`], cwd)
		.split("\0")
		.filter((record) => record.trim() !== "")
		.map((record) => {
			const [sha = "", name = "", email = "", ...message] = record.split("\n");
			return { sha, name, email, message: message.join("\n") };
		});
}

function main(argv: readonly string[]): number {
	const args = cliArgs(argv, ["base", "head"]);
	const base = revision(args.base ?? process.env.BASE_SHA, "base (BASE_SHA)");
	const head = revision(args.head ?? process.env.HEAD_SHA, "head (HEAD_SHA)");
	const commits = commitsBetween(base, head);
	const problems = dcoProblems(commits);
	if (problems.length === 0) {
		console.log(`dco: all ${commits.length} commits are signed off by their authors`);
		return 0;
	}
	console.log(`dco: ${problems.length} of ${commits.length} commits need their author's sign-off:`);
	for (const problem of problems) console.log(`  ${problem}`);
	console.log(
		"dco: the human contributor signs off (git commit -s, git rebase --signoff); tools never do",
	);
	return 1;
}

if (import.meta.main) await runCli("dco", () => main(process.argv.slice(2)));
