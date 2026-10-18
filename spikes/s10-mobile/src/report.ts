import { appendFileSync } from "node:fs";
import { type Crate, type CrateBuild, crateOrder } from "./cargo.ts";

// spikes-run doesn't use turbo, so GITHUB_STEP_SUMMARY reaches the tests; nothing is uploaded.
export function appendSummary(markdown: string, env: NodeJS.ProcessEnv = process.env): void {
	if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown.trimEnd()}\n\n`);
}

const escapePipes = (text: string): string => text.replaceAll("|", "\\|");

function cell(crate: Crate | undefined): string {
	if (crate === undefined) return "-";
	if (crate.status === "ok") return `ok ${crate.version}`;
	return crate.status === "fail" ? `**fail**: ${escapePipes(crate.reason ?? "")}` : crate.status;
}

// Build ok/fail per crate per target and provider: one column per build, one row per crate.
export function crateTableMarkdown(title: string, builds: readonly CrateBuild[]): string {
	const names = crateOrder.filter((name) =>
		builds.some((b) => b.crates.some((c) => c.name === name)),
	);
	const head = builds.map((build) => `${build.target} ${build.provider}`);
	const totals = builds.map((build) => `${build.ok ? "ok" : "**fail**"} (${build.seconds} s)`);
	const rows = names.map((name) => {
		const cells = builds.map((build) => cell(build.crates.find((crate) => crate.name === name)));
		return `| ${name} | ${cells.join(" | ")} |`;
	});
	const strays = builds
		.filter((build) => build.strays.length > 0)
		.map((build) => `- ${build.target} ${build.provider} also compiled ${build.strays.join(", ")}`);
	// "No extra tools" (ADR 0012) shows as the CC builder, with NASM missing on Windows x64.
	const aws = builds.filter((build) => build.provider === "aws-lc-rs");
	const verdict = aws.map((build) => {
		const notes = build.notes.length > 0 ? ` (aws-lc-sys: ${build.notes.join("; ")})` : "";
		return `${build.target}: ${build.ok ? "builds" : "fails"}${notes}`;
	});
	return [
		`### ${title}`,
		"",
		`| Crate | ${head.join(" | ")} |`,
		`|---|${head.map(() => "---").join("|")}|`,
		`| **build** | ${totals.join(" | ")} |`,
		...rows,
		"",
		`aws-lc-rs: ${verdict.join("; ") || "not built"}`,
		...strays,
	].join("\n");
}
