export interface ThreatLedgerProblem {
	line: number;
	rule: string;
	id?: string;
}

/** Document diagnostics only; neither array contains accepted security results. */
export interface ThreatLedgerDiagnostics {
	structure: ThreatLedgerProblem[];
	unresolved: ThreatLedgerProblem[];
}

interface Line {
	text: string;
	number: number;
}

interface Row {
	cells: string[];
	line: number;
}

// Original headings and dispositions from the reviewed pilot obligations ledger.
const headings: readonly string[] = [
	"Injected mail steers drafting",
	"Header spoofing (Reply-To, forged Authentication-Results, plugin-asserted direction)",
	"Agent proposes an exfiltrating send",
	"Agent leaks or mutates mail",
	"Prompt output carries injected text with the user's authority",
	"Elicitation phishing or automated accept",
	"Hostile draft text runs script in an Apps view (incl. Claude mobile's native WebView)",
	"A view injects into the conversation or calls tools (`ui/message`, `ui/update-model-context`, `tools/call`)",
	"Completion leaks mailbox data",
	"Header/body smuggling on resources and prompts",
	"Malicious plugin sends or alters a send",
	"Plugin sandbox escape (JS or Python)",
	"Python plugin escapes Pyodide",
	"Tampered or substituted Python runtime or wheel (Pyodide ignores integrity hashes in Node and can fall back to its CDN)",
	"Memory exhaustion (wasm memory and ArrayBuffers escape `--max-old-space-size`)",
	"Worker escapes the permission model (`new Worker(…, {execArgv: []})` runs unpermissioned)",
	"Plugin opens the hub's inspector or signals it (`process._debugProcess` and `process.kill` are ungated)",
	"Malicious package or rug-pull update",
	"Injected mail steers lookups or exfiltrates through tool arguments",
	"Tool poisoning or rug pull",
	"Hostile or compromised tool results",
	"Tool plugin exfiltrates or beacons",
	"Tool upstream receives or trains on inbox data",
	"Calendar address theft or over-sharing",
	"Hostile HTML",
	"Compromised webview",
	"Replay, edit after approval, double send, crash",
	"Early, late or duplicate scheduled send (timer overflow, wall-clock jump, suspend, DST, hub down)",
	"Stale approval used after the world changed (approver or SMS host revoked, restore, credential loss, quarantine, read-only switch, policy change, Slack channel facts changed, new reply)",
	"Schedule manipulation by agents or inbound mail (setting or extending the time, sending early, cancelling the owner's items, editing a scheduled draft, replying to suppress a send)",
	"**Restore rollback**",
	"**Approver bootstrap abuse**",
	"Canonicalization tricks",
	"Stolen device or key",
	"Stolen OAuth token, consent phishing, push bombing",
	"SSRF; OAuth mix-up; DNS rebinding, CSRF, token in URL (CVE-2026-25253 class)",
	"Device↔hub MITM, intercepted pairing link",
	"Spoofed SMS broadcast or forged inbound text",
	"Forged, replayed, mutated or misdirected send ticket",
	"Another app or the webview tries to make the host send",
	"Hostile host attacks the hub",
	"Lost or stolen phone",
	"Lossy encoding or segment tricks",
	"OTP or code leakage to AI, MCP or tools",
	"Premium-rate or emergency destinations",
	"Public listener exposes private routes",
	"Theft of disk, backups or logs",
	"Vendor-policy breach",
	"Extension module weakens the gate",
	"Test hooks or CI supply chain",
];

const retained = new Set([1, 2, 17, 25, 26, 27, 28, 32, 33, 34, 37, 47, 49, 50]);
const trimmed = new Set([11, 12, 15, 16, 18, 29, 30, 31, 36, 48]);
const threatIds = headings.map((_, index) => `T${String(index + 1).padStart(2, "0")}`);
const invariantHeadings: readonly string[] = [
	"I1 no send without approval",
	"I2 untrusted data stays in data sinks unless flagged",
	"I3 credentials never leave the hub",
	"I4 loosening needs admin step-up, tightening does not",
	"I5 content never reaches tool inputs",
];
const unbound = "UNBOUND in this ledger; retained evidence is required.";
const deferred = "Deferred obligation; no pilot feature-test pass claimed. A01 remains current.";
const absenceBinding =
	"**Binding: UNBOUND.** The following are required observations, not completed";
const absenceOwners: readonly string[] = [
	"M2 hub/challenge/startup owners",
	"M2 plugin admission/supervisor/broker owners",
	"M4 native capability/route/statement callers",
	"M10 release-guard owner and separately assigned module owners",
	"M11.8/.15",
];

function problem(line: number, rule: string, value = ""): ThreatLedgerProblem {
	const invariant = invariantHeadings.indexOf(value);
	const id =
		threatIds.includes(value) || value === "A01"
			? value
			: invariant === -1
				? undefined
				: `I${invariant + 1}`;
	return id ? { line, rule, id } : { line, rule };
}

function hasUnsupportedControl(text: string): boolean {
	for (const character of text) {
		const code = character.charCodeAt(0);
		if (code <= 8 || (code >= 11 && code <= 31) || code === 127) return true;
	}
	return false;
}

/** A bounded Markdown view: fences/comments/code stay literal; raw HTML is refused. */
function visibleLines(source: string, problems: ThreatLedgerProblem[]): Line[] {
	const lines: Line[] = [];
	let fence: { marker: string; length: number } | undefined;
	let comment = false;
	for (const [index, text] of source
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n")
		.entries()) {
		const number = index + 1;
		const blank = () => lines.push({ text: "", number });
		if (fence) {
			const close = /^ {0,3}(`+|~+)[ \t]*$/.exec(text);
			if (close?.[1]?.[0] === fence.marker && close[1].length >= fence.length) fence = undefined;
			blank();
			continue;
		}
		if (comment) {
			const end = text.indexOf("-->");
			if (end !== -1) {
				comment = false;
				if (text.slice(end + 3).trim()) problems.push({ line: number, rule: "markdown-comment" });
			}
			blank();
			continue;
		}
		if (/^(?: {4}|\t)/.test(text)) {
			blank();
			continue;
		}
		// List-contained fences are outside this grammar; their tables cannot qualify.
		if (/^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+(?:`{3,}|~{3,})/.test(text)) {
			problems.push({ line: number, rule: "markdown-container-fence" });
			blank();
			continue;
		}
		const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
		if (open?.[1]) {
			if (open[1][0] === "`" && open[2]?.includes("`"))
				problems.push({ line: number, rule: "markdown-fence" });
			fence = { marker: open[1][0] ?? "", length: open[1].length };
			blank();
			continue;
		}
		if (/^ {0,3}<!--/.test(text)) {
			const end = text.indexOf("-->");
			comment = end === -1;
			if (end !== -1 && text.slice(end + 3).trim())
				problems.push({ line: number, rule: "markdown-comment" });
			blank();
			continue;
		}
		if (/<(?:[A-Za-z/!?]|$)/.test(text) || hasUnsupportedControl(text)) {
			problems.push({ line: number, rule: "markdown-unsupported" });
			blank();
			continue;
		}
		lines.push({ text, number });
	}
	if (fence || comment) problems.push({ line: lines.length, rule: "markdown-unclosed" });
	return lines;
}

function section(lines: Line[], heading: string, problems: ThreatLedgerProblem[]): Line[] {
	const starts = lines.filter((line) => line.text.trim() === heading);
	if (starts.length !== 1) problems.push({ line: starts[0]?.number ?? 1, rule: "section" });
	const start = starts[0];
	if (!start) return [];
	const index = lines.indexOf(start) + 1;
	const end = lines.findIndex((line, offset) => offset >= index && /^ {0,3}## /.test(line.text));
	return lines.slice(index, end === -1 ? undefined : end);
}

function cells(text: string): string[] | undefined {
	if (!/^ {0,3}\|/.test(text) || !text.trimEnd().endsWith("|")) return undefined;
	// Escaped delimiters are outside this declared subset, including a terminal \|.
	if (text.includes("\\|")) return undefined;
	return text
		.trim()
		.slice(1, -1)
		.split("|")
		.map((cell) => cell.trim());
}

function table(lines: Line[], header: readonly string[], problems: ThreatLedgerProblem[]): Row[] {
	for (const line of lines) {
		if (/^ {0,3}\|/.test(line.text) && line.text.includes("\\|"))
			problems.push({ line: line.number, rule: "table-escaped-delimiter" });
	}
	const starts = lines.filter((line) => {
		const parsed = cells(line.text);
		return (
			parsed?.length === header.length && parsed.every((cell, index) => cell === header[index])
		);
	});
	if (starts.length !== 1)
		problems.push({ line: starts[0]?.number ?? lines[0]?.number ?? 1, rule: "table-header" });
	const start = starts[0];
	if (!start) return [];
	const index = lines.indexOf(start);
	const separator = cells(lines[index + 1]?.text ?? "");
	if (separator?.length !== header.length || !separator.every((cell) => /^:?-{3,}:?$/.test(cell)))
		problems.push({ line: start.number + 1, rule: "table-separator" });
	const rows: Row[] = [];
	for (const line of lines.slice(index + 2)) {
		if (!/^ {0,3}\|/.test(line.text)) break;
		const parsed = cells(line.text);
		if (!parsed) {
			problems.push({ line: line.number, rule: "table-row" });
			continue;
		}
		if (parsed.length !== header.length) problems.push({ line: line.number, rule: "field-count" });
		if (parsed.some((cell) => !cell)) problems.push({ line: line.number, rule: "empty-field" });
		rows.push({ cells: parsed, line: line.number });
	}
	return rows;
}

function identities(
	rows: Row[],
	expected: readonly string[],
	problems: ThreatLedgerProblem[],
): void {
	if (rows.length !== expected.length)
		problems.push({ line: rows[0]?.line ?? 1, rule: "identity-count" });
	const seen = new Set<string>();
	for (const [index, row] of rows.entries()) {
		const id = row.cells[0] ?? "";
		if (seen.has(id)) problems.push(problem(row.line, "identity-duplicate", id));
		seen.add(id);
		if (id !== expected[index]) problems.push(problem(row.line, "identity-order", id));
	}
}

/** Checks only the current document grammar. It cannot accept evidence or qualify a candidate. */
export function checkThreatLedger(source: string): ThreatLedgerDiagnostics {
	const structure: ThreatLedgerProblem[] = [];
	const unresolved: ThreatLedgerProblem[] = [];
	const lines = visibleLines(source, structure);
	const threatSection = section(
		lines,
		"## Original threat identities and pilot obligations",
		structure,
	);
	const threats = table(
		threatSection,
		[
			"ID",
			"Original threat heading",
			"Pilot disposition",
			"Item and implementation/evidence owner",
			"Required retained property or preserved later obligation",
			"Binding",
		],
		structure,
	);
	identities(threats, threatIds, structure);
	const rowLines = new Set(threats.map((row) => row.line));
	for (const line of threatSection) {
		if (/^ {0,3}\|\s*T\d/.test(line.text) && !rowLines.has(line.number))
			structure.push({ line: line.number, rule: "threat-row-outside-table" });
	}
	for (const row of threats) {
		const [id = "", heading = "", disposition = "", , , binding = ""] = row.cells;
		const number = /^T\d{2}$/.test(id) ? Number(id.slice(1)) : 0;
		if (heading !== headings[number - 1]) structure.push(problem(row.line, "threat-heading", id));
		const expected = retained.has(number)
			? "Retained"
			: trimmed.has(number)
				? "Trimmed"
				: "Postponed";
		if (!["Retained", "Trimmed", "Postponed"].includes(disposition))
			structure.push(problem(row.line, "disposition-unsupported", id));
		else if (disposition !== expected) structure.push(problem(row.line, "disposition-changed", id));
		const isDeferred = expected === "Postponed";
		if (binding !== (isDeferred ? deferred : unbound))
			structure.push(problem(row.line, "binding-unsupported", id));
		if (!isDeferred || binding !== deferred)
			unresolved.push(
				problem(row.line, binding === unbound ? "evidence-unbound" : "binding-unqualified", id),
			);
	}

	const invariantSection = section(lines, "## Invariants and retained suite ownership", structure);
	const invariants = table(
		invariantSection,
		["Requirement", "Pilot disposition / owner", "Acceptance or gap"],
		structure,
	);
	identities(
		invariants.filter((row) => /^I\d/.test(row.cells[0] ?? "")),
		invariantHeadings,
		structure,
	);

	const absence = section(lines, "## A01 — Postponed surfaces remain absent or refused", structure);
	const bindingLines = absence.filter((line) => line.text.startsWith("**Binding:"));
	const absenceIsUnbound = bindingLines.length === 1 && bindingLines[0]?.text === absenceBinding;
	if (!absenceIsUnbound)
		structure.push({
			line: bindingLines[0]?.number ?? absence[0]?.number ?? 1,
			rule: "absence-binding",
		});
	unresolved.push({
		line: bindingLines[0]?.number ?? absence[0]?.number ?? 1,
		rule: absenceIsUnbound ? "evidence-unbound" : "binding-unqualified",
		id: "A01",
	});
	const owners = table(absence, ["Implementing owner", "Required current evidence"], structure);
	identities(owners, absenceOwners, structure);
	return { structure, unresolved };
}
