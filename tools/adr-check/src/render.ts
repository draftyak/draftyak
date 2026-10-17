import path from "node:path";
import { type Adr, backticked, content, decision, field, keptTests, section } from "./adr.ts";

const cell = (text: string): string => text.replaceAll("|", "\\|").trim() || "none";
const title = (adr: Adr): string => adr.title?.text.replace(/^ADR \d{4}: /, "") ?? "";
const link = (adr: Adr, base: string): string =>
	`[${adr.number}](${base}${path.posix.basename(adr.file)})`;

// The Decision's lines after its first, up to a subheading; list items joined with "; ".
export function planChanges(adr: Adr): string {
	const lines = content(section(adr, "Decision")?.body ?? []).slice(1);
	const end = lines.findIndex((line) => !line.code && line.text.startsWith("#"));
	const items: string[] = [];
	for (const { text } of end === -1 ? lines : lines.slice(0, end)) {
		const item = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(text);
		if (item || items.length === 0) items.push((item?.[1] ?? text).trim());
		else items.push(`${items.pop()} ${text.trim()}`);
	}
	items[0] = items[0]?.replace(/^Plan changes:\s*/i, "") ?? "";
	return items.filter((item) => item !== "").join("; ") || "none";
}

function evidence(adr: Adr): string {
	const lines = content(section(adr, "Evidence")?.body ?? []);
	const paths = new Set(lines.flatMap((line) => backticked(line.text)));
	const files = [...paths].filter((token) => /^\S*\/\S*$/.test(token));
	if (files.length > 0) return files.map((file) => `\`${file}\``).join(", ");
	return lines[0]?.text.replace(/^\s*[-*+]\s+/, "") ?? "";
}

function kept(adr: Adr): string {
	const tests = keptTests(adr).map((test) => {
		const destination = test.get("Destination")?.text.replace(/\.$/, "");
		const paths = test.get("Path")?.text ?? "";
		return destination ? `${paths} → ${destination}` : paths;
	});
	return tests.join("; ");
}

function outcome(adr: Adr): string {
	const notes = [field(adr, "Status") ?? ""];
	if (field(adr, "Owner decision") === "yes") notes.push("owner decision");
	return `${decision(adr) ?? ""} (${notes.join(", ")})`;
}

const table = (head: readonly string[], rows: readonly string[][]): string[] => [
	`| ${head.join(" | ")} |`,
	`|${"---|".repeat(head.length)}`,
	...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
];

// m0-gate.md §1, which lives in docs/roadmap/.
export function renderReport(adrs: readonly Adr[]): string {
	const head = ["Spike", "ADR", "Decision", "Evidence", "Kept test → destination", "Plan changes"];
	const rows = adrs.map((adr) => [
		field(adr, "Spike") ?? "",
		`${link(adr, "../adr/")} ${title(adr)}`,
		outcome(adr),
		evidence(adr),
		kept(adr),
		planChanges(adr),
	]);
	return table(head, rows).join("\n");
}

export function renderIndex(adrs: readonly Adr[]): string {
	const head = ["ADR", "Title", "Status", "Decision", "Date", "Spike", "Owner decision"];
	const rows = adrs.map((adr) => [
		link(adr, ""),
		title(adr),
		...["Status", "Decision", "Date", "Spike", "Owner decision"].map((name) =>
			name === "Decision" ? (decision(adr) ?? "") : (field(adr, name) ?? ""),
		),
	]);
	const intro =
		"Written by `pnpm adr --index`: edit the ADRs, not this file. New ADRs start from [template.md](template.md) and keep their number for good.";
	return ["# Architecture decision records", "", intro, "", ...table(head, rows), ""].join("\n");
}
