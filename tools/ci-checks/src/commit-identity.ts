import { cliArgs, git, revision, runCli, UsageError } from "./lib.ts";

// Commits on this repository's own branches carry only these emails: the owner's; the owner's
// GitHub noreply address, which GitHub gives the commits of a rebase merge; and GitHub's own, for
// commits GitHub makes itself (web edits). The local pre-push check allows the same list. Fork PRs
// keep their contributors' identities, so once one merges, a milestone branch holds outside authors.
export const allowedEmails: ReadonlySet<string> = new Set([
	"nicksavov@protonmail.com",
	"nicksavov@users.noreply.github.com",
	"noreply@github.com",
]);

export interface CommitIdentity {
	readonly sha: string;
	readonly subject: string;
	readonly author: string;
	readonly authorEmail: string;
	readonly committer: string;
	readonly committerEmail: string;
}

// An exact match after folding ASCII letters only, so lookalike letters and spaces never pass.
const allowed = (email: string): boolean =>
	allowedEmails.has(email.replace(/[A-Z]/g, (letter) => letter.toLowerCase()));

// One line per commit whose author or committer email is not allowed. committersOnly is for gate
// PRs, whose authors may be outside contributors whose fork PRs merged.
export function identityProblems(
	commits: readonly CommitIdentity[],
	committersOnly = false,
): string[] {
	return commits.flatMap((commit) => {
		const wrong = [
			committersOnly || allowed(commit.authorEmail)
				? ""
				: `author ${commit.author} <${commit.authorEmail}>`,
			allowed(commit.committerEmail)
				? ""
				: `committer ${commit.committer} <${commit.committerEmail}>`,
		].filter(Boolean);
		if (wrong.length === 0) return [];
		return [`${commit.sha.slice(0, 12)} ${commit.subject}: ${wrong.join(", ")}`];
	});
}

// The commits in base..head, merges included.
export function identitiesBetween(base: string, head: string, cwd?: string): CommitIdentity[] {
	return git(["log", "-z", "--format=%H%n%an%n%ae%n%cn%n%ce%n%s", `${base}..${head}`], cwd)
		.split("\0")
		.filter((record) => record.trim() !== "")
		.map((record) => {
			const [sha = "", author = "", authorEmail = "", committer = "", committerEmail = ""] =
				record.split("\n");
			const subject = record.split("\n").slice(5).join(" ");
			return { sha, subject, author, authorEmail, committer, committerEmail };
		});
}

// A PR from a fork, or from a deleted fork (an empty HEAD_REPO), when BASE_REPO is set. An unset
// HEAD_REPO beside BASE_REPO is a broken workflow step, not a fork.
export function isFork(headRepo: string | undefined, baseRepo: string | undefined): boolean {
	if (!baseRepo) return false;
	if (headRepo === undefined) throw new UsageError("HEAD_REPO must be set when BASE_REPO is");
	return headRepo.toLowerCase() !== baseRepo.toLowerCase();
}

// A milestone's gate PR: mN into main, as pr-meta names it.
export function isGate(headRef: string | undefined, baseRef: string | undefined): boolean {
	return baseRef === "main" && /^m\d+[a-z]?$/.test(headRef ?? "");
}

function main(argv: readonly string[]): number {
	const env = process.env;
	if (isFork(env.HEAD_REPO, env.BASE_REPO)) {
		console.log(
			`commit-identity: skipped, the PR comes from ${env.HEAD_REPO || "a deleted fork"}; dco covers outside contributors`,
		);
		return 0;
	}
	const args = cliArgs(argv, ["base", "head"]);
	const base = revision(args.base ?? env.BASE_SHA, "base (BASE_SHA)");
	const head = revision(args.head ?? env.HEAD_SHA, "head (HEAD_SHA)");
	const gate = isGate(env.HEAD_REF, env.BASE_REF);
	const commits = identitiesBetween(base, head);
	const problems = identityProblems(commits, gate);
	const checked = gate
		? "committer email (a gate PR: authors may be outside contributors)"
		: "email";
	if (problems.length === 0) {
		console.log(`commit-identity: all ${commits.length} commits use an allowed ${checked}`);
		return 0;
	}
	console.log(
		`commit-identity: ${problems.length} of ${commits.length} commits use ${gate ? "a" : "an"} ${checked} that this repository's branches don't allow:`,
	);
	for (const problem of problems) console.log(`  ${problem}`);
	console.log(`commit-identity: allowed: ${[...allowedEmails].join(", ")}`);
	return 1;
}

if (import.meta.main) await runCli("commit-identity", () => main(process.argv.slice(2)));
