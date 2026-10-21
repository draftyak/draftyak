import { createHash } from "node:crypto";
import path from "node:path";
import { checkMetadata, type MetadataInputs, type MetadataProblem } from "./metadata.ts";
import { parseMetadataYaml } from "./metadata-cli.ts";

export const communityFiles = [
	"README.md",
	"LICENSE",
	"NOTICE",
	"TRADEMARKS.md",
	"PRIVACY.md",
	"STEWARDSHIP.md",
	"SECURITY.md",
	"SUPPORT.md",
	"GOVERNANCE.md",
	"MAINTAINERS.md",
	"ACCESSIBILITY.md",
	"CODE_OF_CONDUCT.md",
	".github/VULNERABILITY_REPORT.yml",
] as const;

export interface CommunityInputs {
	metadata: MetadataInputs;
	documents: Readonly<Record<string, string>>;
	// Direct internal targets only; undefined means no regular file was found.
	targets: Readonly<Record<string, string | undefined>>;
}

export interface CommunityLink {
	file: string;
	target: string;
	fragment: string;
}
const restricted = /siwc|dynamic[-_]agent|(?:^|\/)s07[^/]*|M0\.27/i;
export const permittedCommunityPath = (file: string): boolean =>
	file !== "" &&
	!restricted.test(file) &&
	!file.includes("\\") &&
	!file.startsWith("/") &&
	!file.split("/").includes("..") &&
	!/[?:]/.test(file) &&
	[...file].every((character) => character.charCodeAt(0) >= 32);

// Static community Markdown only: fenced examples and comments are not disclosures.
function prose(source: string, onUnsupportedContainer?: () => void): string {
	let fence = "";
	let quotedFence = false;
	let comment = false;
	return source
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((line) => {
			const fenceLine = line.replace(/^(?: {0,3}>[ \t]?)+/, "");
			if (fence) {
				const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(quotedFence ? fenceLine : line)?.[1];
				if (closing && closing[0] === fence[0] && closing.length >= fence.length) fence = "";
				return "";
			}
			if (!comment) {
				const containerLine = line.replace(/^(?: {0,3}(?:>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+))+/, "");
				if (containerLine !== line && /^ {0,3}(?:`{3,}|~{3,})/.test(containerLine))
					onUnsupportedContainer?.();
				const opening = /^ {0,3}(`{3,}|~{3,})/.exec(fenceLine)?.[1];
				if (opening) {
					fence = opening;
					quotedFence = fenceLine !== line;
					return "";
				}
				if (/^(?: {4}|\t)/.test(line)) return "";
			}
			let visible = "";
			let offset = 0;
			while (offset < line.length) {
				const boundary = line.indexOf(comment ? "-->" : "<!--", offset);
				if (boundary < 0) {
					if (!comment) visible += line.slice(offset);
					break;
				}
				if (!comment) visible += line.slice(offset, boundary);
				offset = boundary + (comment ? 3 : 4);
				comment = !comment;
			}
			return /^(?: {4}|\t)/.test(visible) ? "" : visible;
		})
		.join("\n");
}

export function communityLinks(documents: Readonly<Record<string, string>>): {
	links: CommunityLink[];
	problems: MetadataProblem[];
} {
	const links: CommunityLink[] = [];
	const problems: MetadataProblem[] = [];
	for (const file of communityFiles) {
		if (!file.endsWith(".md")) continue;
		const text = prose(documents[file] ?? "");
		const definitions = new Map<string, string>();
		for (const match of text.matchAll(/^ {0,3}\[([^\]\n]+)\]:\s*(\S+)\s*$/gm)) {
			const key = (match[1] ?? "").toLowerCase();
			if (definitions.has(key)) problems.push({ file, rule: "duplicate link definition" });
			definitions.set(key, match[2] ?? "");
		}
		const add = (raw: string): void => {
			if (/^(?:https?:|mailto:)/i.test(raw)) return;
			try {
				const decoded = decodeURIComponent(raw);
				if (/\s|[\\?]|^[a-z][\w+.-]*:|^\//i.test(decoded)) throw new Error();
				const [relative = "", fragment = ""] = decoded.split("#");
				if (decoded.split("#").length > 2) throw new Error();
				const target = relative
					? path.posix
							.normalize(path.posix.join(path.posix.dirname(file), relative))
							.replace(/\/$/, "")
					: file;
				if (!permittedCommunityPath(target)) throw new Error();
				links.push({ file, target, fragment });
			} catch {
				problems.push({ file, rule: "unsafe or unsupported internal link" });
			}
		};
		let remaining = text.replace(/^ {0,3}\[([^\]\n]+)\]:\s*(\S+)\s*$/gm, "");
		remaining = remaining.replace(/\[[^\]\n]*\]\(([^)\n]*)\)/g, (_, target: string) => {
			add(target);
			return "";
		});
		remaining = remaining.replace(/\[[^\]\n]+\]\[([^\]\n]+)\]/g, (_, key: string) => {
			const target = definitions.get(key.toLowerCase());
			if (target === undefined) problems.push({ file, rule: "missing link definition" });
			else add(target);
			return "";
		});
		remaining = remaining.replace(/\[([^\]\n]+)\](?!\(|\[)/g, (source, key: string) => {
			const target = definitions.get(key.toLowerCase());
			if (target === undefined) return source;
			add(target);
			return "";
		});
		if (/\]\(|\bhref\s*=|\]\[/i.test(remaining))
			problems.push({ file, rule: "malformed or unsupported link syntax" });
	}
	if (links.length > 256)
		problems.push({ file: "README.md", rule: "community link limit exceeded" });
	return { links: links.slice(0, 256), problems };
}

function anchors(source: string): Set<string> {
	const found = new Set<string>();
	const counts = new Map<string, number>();
	for (const line of prose(source).split("\n")) {
		const title = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?$/.exec(line)?.[1];
		if (!title) continue;
		const slug = title
			.toLowerCase()
			.replace(/[^\p{L}\p{N}_\s-]/gu, "")
			.replace(/\s/g, "-");
		const count = counts.get(slug) ?? 0;
		found.add(count ? `${slug}-${count}` : slug);
		counts.set(slug, count + 1);
	}
	return found;
}

const sections: Readonly<Record<string, readonly RegExp[]>> = {
	"README.md": [/^#{1,6} .*install|^#{1,6} .*quickstart/im, /^#{1,6} .*security/im],
	"TRADEMARKS.md": [/^#{1,6} .*uses/im, /^#{1,6} .*modified/im],
	"PRIVACY.md": [/^#{1,6} .*storage/im, /^#{1,6} .*routing/im, /^#{1,6} .*outbound/im],
	"STEWARDSHIP.md": [/^#{1,6} .*accountability/im],
	"SECURITY.md": [/^#{1,6} .*security model/im, /^#{1,6} .*report/im, /^#{1,6} .*safe harbor/im],
	"SUPPORT.md": [/^#{1,6} .*useful report/im, /^#{1,6} .*limits/im],
	"GOVERNANCE.md": [/^#{1,6} .*decisions/im, /^#{1,6} .*releases/im],
	"MAINTAINERS.md": [/^#{1,6} .*maintainers/im],
	"ACCESSIBILITY.md": [/^#{1,6} .*review/im, /^#{1,6} .*report/im],
	"CODE_OF_CONDUCT.md": [/^#{1,6} .*pledge/im, /^#{1,6} .*report/im],
};

const unsupportedInstaller =
	"\\b(?:MSI|AppImage|Intel Mac|Intel macOS|macOS Intel|APK|Docker|headless npm|PyPI)\\b";
const installerNoun = "(?:installers?|installation|deployment|builds?|support|releases?|targets?)";
const installerItem = `${unsupportedInstaller}(?:\\s+${installerNoun})?`;
const installerGroup = `${installerItem}(?:\\s*(?:,\\s*(?:(?:and|or)\\s+)?|/|\\b(?:and|or)\\b)\\s*${installerItem})*`;
// Qualifiers cover only adjacent named targets or explicit target lists, never other predicates.
const deferredInstallers = new RegExp(
	`(?:postponed|excluded|unsupported)(?:\\s+${installerNoun})?(?:\\s*:\\s*|\\s+)${installerGroup}|${installerGroup}(?:\\s+and\\s+network update checks)?\\s+(?:(?:is|are|remain|remains)\\s+)?(?:postponed|excluded|unsupported|not (?:supported|available|in this release))\\b|(?:no|not|never)\\s+(?:ship|support|offer|install|download)\\s+${installerGroup}`,
	"gi",
);
// Negation binds to the final operation; only the explicit runtime/CDN coordination shares it.
const prohibitedNetworkOperation =
	/\b(?:must not|never|do not) (?:fetch(?: from)?|(?:fetch a runtime from a CDN or )?contact)(?: the)?\s*$/i;

export function checkCommunity(input: CommunityInputs): MetadataProblem[] {
	const problems = checkMetadata(input.metadata);
	const report = (file: string, rule: string): void => {
		problems.push({ file, rule });
	};
	for (const file of communityFiles) {
		const source = input.documents[file];
		if (source === undefined || source.trim() === "") {
			report(file, "required community document is missing or empty");
			continue;
		}
		let unsupportedContainer = false;
		const text = prose(source, () => {
			unsupportedContainer = true;
		});
		if (unsupportedContainer) report(file, "unsupported container-prefixed code fence");
		for (const section of sections[file] ?? [])
			if (!section.test(text)) report(file, "required community section is missing");
		// Check each clause, so a postponed feature elsewhere cannot excuse a current installer claim.
		for (const clause of text.split(/[;.\n]|\b(?:but|whereas|unlike)\b/i)) {
			if (!/install|download|ship|support|release|available|target/i.test(clause)) continue;
			const deferred = [...clause.matchAll(deferredInstallers)];
			for (const unsupported of clause.matchAll(new RegExp(unsupportedInstaller, "gi"))) {
				const qualified = deferred.some(
					(match) =>
						unsupported.index >= match.index &&
						unsupported.index + unsupported[0].length <= match.index + match[0].length,
				);
				const future = /\bfor resumed\b|\bwhen .*resumes\b/i.test(clause);
				const networkPrefix =
					clause
						.slice(0, unsupported.index)
						.split(/\band\b/i)
						.at(-1) ?? "";
				const forbiddenNetwork = prohibitedNetworkOperation.test(networkPrefix);
				if (!qualified && !future && !forbiddenNetwork)
					report(file, "unsupported current installer claim");
			}
		}
	}
	const require = (file: string, pattern: RegExp, rule: string): void => {
		const source = input.documents[file] ?? "";
		if (
			input.documents[file] !== undefined &&
			!pattern.test(file.endsWith(".md") ? prose(source) : source)
		)
			report(file, rule);
	};
	if (
		input.documents.LICENSE !== undefined &&
		createHash("sha256").update(input.documents.LICENSE.replaceAll("\r\n", "\n")).digest("hex") !==
			"cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30"
	)
		report("LICENSE", "Apache-2.0 licence text differs from the approved baseline");
	require("NOTICE", /DraftYak[\s\S]*trademark/i, "project and trademark notice is missing");
	require("PRIVACY.md", /zero telemetry/i, "zero-telemetry disclosure is missing");
	require("SECURITY.md", /same.OS.user|hub.s OS user/i, "same-user security limit is missing");
	require("SECURITY.md", /PIN[\s\S]*exact[\s\S]*(?:window|timing)/i, "exact-content and window approval disclosure is missing");
	require("SUPPORT.md", /awake and running/i, "scheduled-send availability limit is missing");
	require("SUPPORT.md", /missed window[\s\S]*fresh approval/i, "missed-window reapproval disclosure is missing");
	require("ACCESSIBILITY.md", /WCAG 2\.2[\s\S]*(?:Level )?AA/i, "accessibility target is missing");
	require(".github/VULNERABILITY_REPORT.yml", /privat[\s\S]*synthetic[\s\S]*credentials/i, "private safe-reporting guidance is missing");
	if (input.documents[".github/VULNERABILITY_REPORT.yml"] !== undefined) {
		try {
			const value = parseMetadataYaml(
				input.documents[".github/VULNERABILITY_REPORT.yml"] ?? "",
			) as { body?: { id?: string; type?: string; validations?: { required?: boolean } }[] };
			for (const id of ["summary", "version", "environment", "reproduction"]) {
				if (
					!Array.isArray(value?.body) ||
					!value.body.some(
						(field) =>
							field?.id === id &&
							["input", "textarea"].includes(field.type ?? "") &&
							field.validations?.required === true,
					)
				)
					report(
						".github/VULNERABILITY_REPORT.yml",
						"required interactive private-report field is missing",
					);
			}
		} catch {
			report(".github/VULNERABILITY_REPORT.yml", "invalid private-report YAML");
		}
	}
	for (const [pattern, rule] of [
		[/Windows[\s\S]*NSIS/i, "Windows NSIS quickstart is missing"],
		[/(?:Apple.silicon|arm64)[\s\S]*DMG/i, "Apple-silicon DMG quickstart is missing"],
		[/Ubuntu 24\.04[\s\S]*deb/i, "Ubuntu deb quickstart is missing"],
		[/Keychain[\s\S]*prompt/i, "Keychain prompt disclosure is missing"],
		[/Secret Service|GNOME Keyring|KWallet/i, "Linux key-store requirement is missing"],
		[/tray/i, "tray guidance is missing"],
		[/reopen/i, "reopen guidance is missing"],
		[/autostart/i, "autostart guidance is missing"],
		[/PIN[\s\S]*exact[\s\S]*(?:window|timing)/i, "one-screen approval model is missing"],
		[/same.OS.user|hub.s OS user/i, "one-screen same-user limit is missing"],
		[/awake and running/i, "scheduled-send availability limit is missing"],
		[/missed window[\s\S]*fresh approval/i, "missed-window reapproval disclosure is missing"],
		[/signing|signed|unsigned|notariz/i, "signing limitations are missing"],
	] as const)
		require("README.md", pattern, rule);
	const parsed = communityLinks(input.documents);
	problems.push(...parsed.problems);
	for (const link of parsed.links) {
		const target = input.targets[link.target];
		if (target === undefined) report(link.file, "internal link target is missing");
		else if (link.fragment && !anchors(target).has(link.fragment))
			report(link.file, "internal link fragment is missing");
	}
	return problems;
}
