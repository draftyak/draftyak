import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { type CommunityInputs, checkCommunity } from "../src/community.ts";
import { loadMetadata } from "../src/metadata-cli.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
let baseline: CommunityInputs;
beforeAll(async () => {
	const documents = {
		"README.md":
			"# DraftYak\n## Install and first run\nWindows NSIS; Apple-silicon macOS DMG; Ubuntu 24.04 deb. Keychain may prompt after updates. Linux needs Secret Service. Tray, reopen and autostart behavior need platform checks. Signing limitations remain documented.\n## Security\nPIN approval covers exact content and the send window. The same-OS-user limit applies. Desktop must be awake and running; a missed window requires fresh approval. See [security](SECURITY.md#security-model).",
		LICENSE: await readFile(new URL("../../../LICENSE", import.meta.url), "utf8"),
		NOTICE: "DraftYak is a trademark.",
		"TRADEMARKS.md":
			"# Trademarks\n## Uses permitted\nNominative use.\n## Modified builds\nRebrand.",
		"PRIVACY.md":
			"# Privacy\nCore has zero telemetry.\n## Storage\nEncrypted.\n## Routing\nAccount consent.\n## Outbound destinations\nActual destinations need separate reconciliation.",
		"STEWARDSHIP.md": "# Stewardship\n## Accountability\nReview responsibility remains human.",
		"SECURITY.md":
			"# Security\n## Security model\nPIN approval covers exact content and window. A process running as the hub's OS user is outside the same-OS-user boundary.\n## Report privately\nUse synthetic data.\n## Safe harbor\nReport safely.",
		"SUPPORT.md":
			"# Support\n## A useful report\nUse synthetic data.\n## Limits\nDesktop must be awake and running. A missed window needs fresh approval.",
		"GOVERNANCE.md":
			"# Governance\n## Decisions\nReview required.\n## Releases\nOwner approval required.",
		"MAINTAINERS.md": "# Maintainers\nA single maintainer is valid.",
		"ACCESSIBILITY.md":
			"# Accessibility\nWCAG 2.2 Level AA is the target.\n## What we review\nKeyboard and assistive technologies.\n## Report a barrier\nReport privately.",
		"CODE_OF_CONDUCT.md": "# Conduct\n## Our pledge\nRespect.\n## Reporting\nPrivate reports.",
		".github/VULNERABILITY_REPORT.yml":
			"name: Private report\ndescription: Use synthetic data, never credentials.\nbody:\n" +
			["summary", "version", "environment", "reproduction"]
				.map((id) => `  - id: ${id}\n    type: textarea\n    validations:\n      required: true\n`)
				.join(""),
	};
	baseline = { metadata: await loadMetadata(root), documents, targets: documents };
});
const copy = (): CommunityInputs => structuredClone(baseline);
const rules = (input: CommunityInputs): string[] =>
	checkCommunity(input).map((problem) => problem.rule);

test("synthetic community documents satisfy the structural scope without claiming acceptance", () => {
	expect(checkCommunity(baseline)).toEqual([]);
});

test("the community audit consumes actual metadata validation", () => {
	const input = copy();
	input.metadata.labels = [];
	expect(checkCommunity(input).some((problem) => problem.file === ".github/labels.yml")).toBe(true);
});

test.each(["README.md", "PRIVACY.md", "SECURITY.md", "LICENSE"])(
	"missing %s is a real structural failure",
	(file) => {
		const input = copy();
		delete (input.documents as Record<string, string>)[file];
		expect(checkCommunity(input)).toContainEqual({
			file,
			rule: "required community document is missing or empty",
		});
	},
);

test("comments and fenced text cannot replace a required disclosure", () => {
	for (const suffix of [
		"<!-- zero telemetry -->",
		"<!-- zero telemetry",
		"```text\nzero telemetry\n```",
		"```text\nzero telemetry",
	]) {
		const input = copy();
		(input.documents as Record<string, string>)["PRIVACY.md"] =
			`# Privacy\n## Storage\n## Routing\n## Outbound destinations\n${suffix}`;
		expect(rules(input)).toContain("zero-telemetry disclosure is missing");
	}
});

test("review witness: quoted fences cannot supply the privacy disclosure", () => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		input.documents["PRIVACY.md"]?.replace(
			"Core has zero telemetry.",
			"> ```text\n> zero telemetry\n> ```",
		) ?? "";
	expect(rules(input)).toContain("zero-telemetry disclosure is missing");
});

test("genuine prose after a quoted fence remains visible", () => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		input.documents["PRIVACY.md"]?.replace(
			"Core has zero telemetry.",
			"> ```text\n> example\n> ```\nCore has zero telemetry.",
		) ?? "";
	expect(checkCommunity(input)).toEqual([
		{ file: "PRIVACY.md", rule: "unsupported container-prefixed code fence" },
	]);
});

test("a quote-fence context mismatch cannot pass the audit", () => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		(input.documents["PRIVACY.md"]?.replace("Core has zero telemetry.", "") ?? "") +
		"\n> ```text\n```\nzero telemetry\n```";
	expect(checkCommunity(input)).toEqual([
		{ file: "PRIVACY.md", rule: "unsupported container-prefixed code fence" },
	]);
});

test("list-prefixed code fences refuse with a controlled diagnostic", () => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		(input.documents["PRIVACY.md"]?.replace("Core has zero telemetry.", "") ?? "") +
		"\n- ```text\n  zero telemetry\n  ```";
	expect(checkCommunity(input)).toEqual([
		{ file: "PRIVACY.md", rule: "unsupported container-prefixed code fence" },
	]);
});

test("container markers inside top-level code and comments stay literal", () => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		input.documents["PRIVACY.md"]?.replace(
			"Core has zero telemetry.",
			"```text\n> ```text\n> ```\n- ```text\n- ```\n```\n<!--\n> ```text\n- ```text\n-->\nCore has zero telemetry.",
		) ?? "";
	expect(checkCommunity(input)).toEqual([]);
});

test("indented code alone cannot supply the privacy disclosure", () => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		input.documents["PRIVACY.md"]?.replace("Core has zero telemetry.", "    zero telemetry") ?? "";
	expect(rules(input)).toContain("zero-telemetry disclosure is missing");
});

test("genuine prose after indented code remains visible", () => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		input.documents["PRIVACY.md"]?.replace(
			"Core has zero telemetry.",
			"    example\nCore has zero telemetry.",
		) ?? "";
	expect(checkCommunity(input)).toEqual([]);
});

test.each([">", "-"])("ordinary %s prose still supplies a genuine disclosure", (prefix) => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		input.documents["PRIVACY.md"]?.replace(
			"Core has zero telemetry.",
			`${prefix} Core has zero telemetry.`,
		) ?? "";
	expect(checkCommunity(input)).toEqual([]);
});

test.each([
	{ name: "LF", ending: "\n" },
	{ name: "CRLF", ending: "\r\n" },
	{ name: "CR", ending: "\r" },
])("genuine $name prose preserves required sections and disclosures", ({ ending }) => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		input.documents["PRIVACY.md"]?.replaceAll("\n", ending) ?? "";
	expect(checkCommunity(input)).toEqual([]);
});

test.each([
	{ name: "closed", suffix: "```text\rzero telemetry\r```" },
	{ name: "unclosed", suffix: "```text\rzero telemetry" },
])("CR-only $name fenced examples cannot supply a disclosure", ({ suffix }) => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		`# Privacy\r## Storage\r## Routing\r## Outbound destinations\r${suffix}`;
	expect(rules(input)).toContain("zero-telemetry disclosure is missing");
});

test.each([
	{ name: "trailing text", apparentClose: "```not-a-close" },
	{ name: "literal comment prefix", apparentClose: "<!-- -->```" },
])("$name cannot close a fence and expose its disclosure", ({ apparentClose }) => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		`# Privacy\n## Storage\n## Routing\n## Outbound destinations\n\`\`\`text\n${apparentClose}\nzero telemetry\n\`\`\``;
	expect(rules(input)).toContain("zero-telemetry disclosure is missing");
});

test.each([
	{ name: "plain", opening: "```text", literal: "example", closing: "```" },
	{ name: "trailing whitespace", opening: "```text", literal: "example", closing: "``` \t" },
	{
		name: "literal unclosed comment and longer tilde delimiter",
		opening: "~~~text",
		literal: "<!-- unclosed comment",
		closing: "~~~~ \t",
	},
])("a valid $name closing preserves following prose", ({ opening, literal, closing }) => {
	const input = copy();
	(input.documents as Record<string, string>)["PRIVACY.md"] =
		`# Privacy\n## Storage\n## Routing\n## Outbound destinations\n${opening}\n${literal}\n${closing}\nzero telemetry`;
	expect(checkCommunity(input)).toEqual([]);
});

test("a README security link cannot replace its one-screen approval model", () => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] =
		input.documents["README.md"]?.replace(/PIN approval[^\n]+See \[security\]/, "See [security]") ??
		"";
	expect(rules(input)).toContain("one-screen approval model is missing");
});

test("a renamed section and altered licence fail independently", () => {
	const input = copy();
	(input.documents as Record<string, string>)["SECURITY.md"] =
		input.documents["SECURITY.md"]?.replace("## Safe harbor", "## Other") ?? "";
	(input.documents as Record<string, string>).LICENSE += "\nA different licence.\n";
	expect(rules(input)).toContain("required community section is missing");
	expect(rules(input)).toContain("Apache-2.0 licence text differs from the approved baseline");
});

test.each([
	"MSI installers are available; Python is postponed.",
	"Download AppImage now.",
	"Intel macOS is supported.",
	"Docker installation is supported.",
	"Download the APK installer.",
	"PyPI installation is available.",
	"MSI is postponed and AppImage installers are available.",
	"MSI installers are available and AppImage is postponed.",
	"Postponed installers: MSI; AppImage installers are available.",
	"Installed plugins must not contact update servers, although users can fetch from PyPI for supported installation.",
])("refuses misleading current installer claim: %s", (claim) => {
	const input = copy();
	(input.documents as Record<string, string>)["SUPPORT.md"] += `\n${claim}`;
	expect(rules(input)).toContain("unsupported current installer claim");
});

test("review witness: an unrelated network prohibition cannot excuse Docker support", () => {
	const input = copy();
	(input.documents as Record<string, string>)["SUPPORT.md"] +=
		"\nDocker installers are supported and must not contact update servers";
	expect(rules(input)).toContain("unsupported current installer claim");
});

test.each([
	"Installed plugins must not contact PyPI at runtime.",
	"Installed plugins must not fetch from PyPI at runtime.",
	"Installed plugins must not fetch a runtime from a CDN or contact PyPI or the Pyodide index at runtime.",
])("prohibited package-host access stays allowed: %s", (statement) => {
	const input = copy();
	(input.documents as Record<string, string>)["SUPPORT.md"] += `\n${statement}`;
	expect(checkCommunity(input)).toEqual([]);
});

test.each([
	"MSI installers are postponed; AppImage is not available in this release; Intel macOS support is postponed.",
	"MSI, AppImage and Intel macOS installers are postponed.",
	"Postponed installers: MSI, AppImage and Intel macOS.",
	"MSI is postponed and AppImage installers are postponed.",
	"Headless npm/Docker deployment and network update checks are postponed.",
])("explicit postponed installer references stay allowed: %s", (claim) => {
	const input = copy();
	(input.documents as Record<string, string>)["SUPPORT.md"] += `\n${claim}`;
	expect(checkCommunity(input)).toEqual([]);
});

test.each([
	"missing.md",
	"SECURITY.md#missing",
	"../outside.md",
	"%2e%2e/outside.md",
	"file:secret",
	"javascript:bad",
	"//external.invalid/x",
	"SECURITY.md?raw=1",
])("refuses broken or unsafe internal link %s", (target) => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] += `\n[link](${target})`;
	expect(checkCommunity(input).some((problem) => problem.file === "README.md")).toBe(true);
});

test("reserved target names refuse before becoming file inputs", () => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] += "\n[link](closed-si" + "wc.md)";
	expect(rules(input)).toContain("unsafe or unsupported internal link");
});

test("reference links, encoded fragments and duplicate ATX anchors resolve", () => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] +=
		"\n[again][SEC]\n[SEC]: SECURITY.md#security%2dmodel-1\n";
	(input.targets as Record<string, string>)["SECURITY.md"] += "\n## Security model\n";
	expect(checkCommunity(input)).toEqual([]);
});

test.each([
	{ name: "valid", target: "SECURITY.md#security-model", missing: false },
	{ name: "missing", target: "missing.md", missing: true },
])("defined $name shortcut links validate their target", ({ target, missing }) => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] += `\n[policy]\n[policy]: ${target}`;
	expect(rules(input)).toEqual(missing ? ["internal link target is missing"] : []);
});

test("unused definitions and full-reference captions are not shortcut uses", () => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] +=
		"\n[caption][good]\n[caption]: missing.md\n[good]: SECURITY.md\n[unused]: missing.md";
	expect(checkCommunity(input)).toEqual([]);
});

test.each(["href", "HREF"])("unsupported HTML %s links refuse", (attribute) => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] +=
		`\n<a ${attribute}="SECURITY.md">policy</a>`;
	expect(rules(input)).toContain("malformed or unsupported link syntax");
});

test("a directory link has no invented fragment and link enumeration is bounded", () => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] += "\n[policies](docs/compliance/)";
	(input.targets as Record<string, string>)["docs/compliance"] = "";
	expect(checkCommunity(input)).toEqual([]);
	(input.documents as Record<string, string>)["README.md"] += "\n[link](SECURITY.md)".repeat(257);
	expect(rules(input)).toContain("community link limit exceeded");
});

test("malformed links and missing reference definitions refuse without content echoes", () => {
	const input = copy();
	(input.documents as Record<string, string>)["README.md"] +=
		"\n[private sentinel](unterminated\n[other][absent]";
	const problems = rules(input);
	expect(problems).toContain("malformed or unsupported link syntax");
	expect(problems).toContain("missing link definition");
	expect(problems.join("\n")).not.toContain("private sentinel");
});

test("malformed YAML and markdown posing as required report inputs refuse", () => {
	for (const source of [
		"name: [",
		baseline.documents[".github/VULNERABILITY_REPORT.yml"]?.replaceAll(
			"type: textarea",
			"type: markdown",
		) ?? "",
	]) {
		const input = copy();
		(input.documents as Record<string, string>)[".github/VULNERABILITY_REPORT.yml"] = source;
		expect(
			checkCommunity(input).some((problem) => problem.file === ".github/VULNERABILITY_REPORT.yml"),
		).toBe(true);
	}
});
