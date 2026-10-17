import { runCli } from "./lib.ts";

export const titleTypes: readonly string[] =
	"feat fix docs style refactor perf test build ci chore revert spike".split(" ");

const title = new RegExp(`^(?:${titleTypes.join("|")})(?:\\([\\w./-]+\\))?!?: \\S`);
const itemBranch = /^m(\d+[a-z]?)-\d{2}[a-z]?-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const milestoneBranch = /^m\d+[a-z]?$/;

// Attribution by trailer syntax only, so prose that names the rule passes. "Generated with" may
// follow symbols such as an emoji or a list marker, but not a quote or a backtick.
const coAuthoredBy = /^\s*co-authored-by:\s*.+\s<.+>\s*$/i;
const generatedWith = /^(?:(?!`)[\s\p{S}\p{M}\p{Cf}*_>#~-])*Generated with\b/u;

export function isAttribution(line: string): boolean {
	return coAuthoredBy.test(line) || generatedWith.test(line);
}

export interface PullRequest {
	readonly title: string;
	readonly body: string;
	readonly head: string;
	readonly base: string;
}

export function prProblems(pr: PullRequest): string[] {
	const problems: string[] = [];
	if (!title.test(pr.title)) {
		problems.push(
			`title ${JSON.stringify(pr.title)} is not "<type>[(scope)][!]: <description>" with a type from ${titleTypes.join(", ")}`,
		);
	}
	const item = itemBranch.exec(pr.head);
	const allowed = item
		? pr.base === `m${item[1]}`
		: milestoneBranch.test(pr.head) && pr.base === "main";
	if (!allowed) {
		problems.push(
			`${pr.head} into ${pr.base}: item branches mN-<nn>-<slug> go into mN, and mN into main`,
		);
	}
	for (const line of pr.body.split(/\r\n|\r|\n/)) {
		if (isAttribution(line)) problems.push(`the body has an attribution line: ${line.trim()}`);
	}
	return problems;
}

// Title, body and branches come only from the environment, never from the command line.
function main(): number {
	const env = process.env;
	const pr = {
		title: env.PR_TITLE ?? "",
		body: env.PR_BODY ?? "",
		head: env.PR_HEAD_REF ?? "",
		base: env.PR_BASE_REF ?? "",
	};
	if (!pr.title || !pr.head || !pr.base) {
		throw new Error("set PR_TITLE, PR_HEAD_REF and PR_BASE_REF");
	}
	const problems = prProblems(pr);
	for (const problem of problems) console.log(`pr-meta: ${problem}`);
	if (problems.length > 0) return 1;
	console.log(`pr-meta: title, branches (${pr.head} into ${pr.base}) and body ok`);
	return 0;
}

if (import.meta.main) await runCli("pr-meta", main);
