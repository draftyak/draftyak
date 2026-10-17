import { glue, type PatternRule, type Sample } from "../src/rules.ts";

// The shapes spikes/kit/evidence.ts refuses, with its exemptions, so whatever writeEvidence()
// writes passes: commit SHAs, SHA-256 digests, hashId() values, the name part of digest-pinned
// images, and IPv4-looking values under *Version keys.
const hash = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64}|hmac:[\w-]{22})$/;
const pinnedImage = /^(?:([a-z0-9][\w./-]*(?::[\w.-]+)?)@)?sha256:[0-9a-f]{64}$/;

// The part of an evidence string the rules check; undefined for a hash.
export function evidenceSubject(value: string): string | undefined {
	if (hash.test(value)) return undefined;
	return pinnedImage.exec(value)?.[1] ?? value;
}

function isIpv6(candidate: string): boolean {
	const groups = candidate.split(":");
	const shaped = groups.length >= 3 && groups.length <= 8 && groups.every((g) => g.length <= 4);
	const full = candidate.includes("::") || groups.length === 8;
	return shaped && full && groups.some((group) => group !== "");
}

const file = "spikes/s99-sample/evidence/sample.json";
const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const at = (value: unknown, key = "value"): Sample => ({
	path: file,
	text: json({ recordedAt: "2026-10-17T10:00:00.000Z", data: { [key]: value } }),
});

const digest = "7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587";
// What writeEvidence() writes: a fingerprint, measurements as numbers, hashes and names.
const written: Sample = {
	path: file,
	text: json({
		recordedAt: "2026-10-17T10:00:00.000Z",
		fingerprint: {
			os: { platform: "win32", arch: "x64", osName: "Windows 11 Home", osVersion: "10.0.26200" },
			node: { nodeVersion: "26.12.0", v8Version: "14.6.202.33-node.20" },
			commit: "1234567890abcdef1234567890abcdef12345678",
			dirty: false,
			load: { cpuPercent: 3.5, cpuCount: 24, cpuModel: "AMD Ryzen 9 7900X", concurrentBuilds: 0 },
		},
		data: {
			image: `node:26.12.0-bookworm-slim@sha256:${digest}`,
			digest: `sha256:${digest}`,
			id: "hmac:AbCdEfGhIjKlMnOpQrStUv",
			headers: ["content-type", "x-ratelimit-remaining"],
			host: "api.example.com",
			p50Ms: 812.5,
			bytes: 536870912,
		},
	}),
};

const shape = (
	id: string,
	reason: string,
	patterns: readonly RegExp[],
	bad: readonly Sample[],
	extra: Pick<PatternRule, "accept"> & { good?: readonly Sample[] } = {},
): PatternRule => ({
	id: `evidence-${id}`,
	kind: "evidence",
	reason: `${reason} in evidence, which holds only content-free measurements and names`,
	patterns,
	bad,
	good: [written, ...(extra.good ?? [])],
	...(extra.accept ? { accept: extra.accept } : {}),
});

export const evidence: readonly PatternRule[] = [
	shape(
		"token",
		"a token shape",
		[
			/\b(?:xox[a-z]-|xapp-|sk-|ya29\.|GOCSPX-|AIza|gh[opsur]_|github_pat_|glpat-)[\w.-]{8,}/,
			/\b1\/\/[\w-]{16,}/,
			/(?<![\w-])eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/,
			/\bBearer\s+[\w.~+/-]{8,}=*/,
		],
		[
			at(glue("ey", "JhbGciOiJIUzI1NiJ9.", "eyJzdWIiOiIxIn0.", "c2lnbmF0dXJl")),
			at(glue("Bearer ", "abcdefgh12345678")),
			at(glue("gh", "p_", "abcdefghijKLMNOP")),
		],
	),
	shape(
		"email",
		"an e-mail address",
		[/(?<![\w.%+-])[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i],
		[at(glue("someone", "@", "example", ".com"))],
	),
	shape(
		"phone",
		"a phone number",
		[/\+\d[\d\s().-]{6,}\d|\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/],
		[at(glue("+1 202", " 555 0143")), at(glue("(202) ", "555-0143"))],
	),
	shape(
		"ipv4",
		"an IPv4 address outside a *Version field",
		[/\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/],
		[at(glue("192.0", ".2.10"), "address"), at(glue("1.3", ".0.1"), "version")],
		{
			accept: (_match, key) => !key?.endsWith("Version"),
			good: [at(glue("1.3", ".0.1"), "zlibVersion")],
		},
	),
	shape(
		"ipv6",
		"an IPv6 address",
		[/(?<![\w:])[0-9a-f:]{2,}(?![\w:])/i],
		[at(glue("2001:db8", "::8a2e:370:7334"))],
		{ accept: isIpv6, good: [at("std::fs at 12:34:56")] },
	),
	shape(
		"tailnet",
		"a tailnet name (*.ts.net)",
		[/[\w-]\.ts\.net\b/i],
		[at(glue("box.tail1234", ".ts", ".net"))],
	),
	shape(
		"uuid",
		"a UUID",
		[/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
		[at(glue("3f2c8a1e-9b4d", "-4e6f-8a7b-", "1c2d3e4f5a6b"))],
	),
	shape(
		"digits",
		"a run of 9 or more digits in a string (measurements are numbers)",
		[/\d{9,}/],
		[at("536870912"), at({ [glue("1712345", "678")]: 1 })],
		{ good: [at(536870912)] },
	),
];

// Evidence is UTF-8 JSON that writeEvidence() wrote: anything else in spikes/<id>/evidence/, other
// than a .gitkeep, fails, and so does such a *.json in any other evidence/ folder under spikes/.
export const evidenceFormat: PatternRule = {
	id: "evidence-json",
	kind: "evidence",
	reason: "evidence/ holds only UTF-8 JSON written by writeEvidence()",
	patterns: [],
	bad: [
		{ path: "spikes/s99-sample/evidence/notes.txt", text: "three runs, all green\n" },
		{ path: "spikes/s99-sample/evidence/macos/run.log", text: "ok\n" },
		{ path: file, text: '{ "p50Ms": \n' },
		{ path: "spikes/s99-sample/rust/evidence/run.json", text: '{ "p50Ms": 1 }\u0000\n' },
	],
	good: [
		written,
		{ path: "spikes/s99-sample/evidence/.gitkeep", text: "" },
		{ path: "spikes/s99-sample/src/evidence/index.ts", text: "export const runs = 3;\n" },
	],
};
