import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PINNED_IMAGE } from "./docker.ts";
import { exec, sleep } from "./exec.ts";
import { gitEnv } from "./repo.ts";

export interface MachineLoad {
	readonly cpuPercent: number;
	readonly cpuCount: number;
	readonly cpuModel: string;
	readonly memoryUsedPercent: number;
	readonly concurrentBuilds: number | null;
}

export interface Fingerprint {
	readonly os: Readonly<Record<"platform" | "arch" | "osName" | "osVersion", string>>;
	readonly node: Readonly<Record<"nodeVersion" | "v8Version", string>>;
	readonly commit: string | null;
	readonly dirty: boolean | null;
	readonly load: MachineLoad;
}

const round1 = (value: number): number => Math.round(value * 10) / 10;

// Busy share of all cores over `ms` (os.loadavg() is always 0 on Windows).
export async function sampleCpu(ms = 1000): Promise<number> {
	const times = () => os.cpus().map(({ times: t }) => [t.idle, t.user + t.nice + t.sys + t.irq]);
	const sum = (rows: number[][], column: number): number =>
		rows.reduce((total, row) => total + (row[column] ?? 0), 0);
	const before = times();
	await sleep(ms);
	const after = times();
	const idle = sum(after, 0) - sum(before, 0);
	const busy = sum(after, 1) - sum(before, 1);
	return idle + busy > 0 ? round1((100 * busy) / (idle + busy)) : 0;
}

// Not turbo: it runs every test task, this one included; the tools it starts are listed here.
const BUILD_TOOLS = new Set(
	"cargo rustc cl link msbuild clang gcc cc1plus ld java gradle tsc esbuild".split(" "),
);

// Running build processes, counted by image name only (no command lines, users or paths).
export async function concurrentBuilds(): Promise<number | null> {
	const windows = process.platform === "win32";
	const listing = await (windows
		? exec("tasklist", ["/fo", "csv", "/nh"], { timeoutMs: 15_000 })
		: exec("ps", ["-A", "-o", "comm="], { timeoutMs: 15_000 })
	).catch(() => null);
	if (listing?.code !== 0) return null;
	const name = (line: string): string =>
		(windows ? (line.split('","')[0] ?? "").slice(1) : path.basename(line.trim()))
			.toLowerCase()
			.replace(/\.exe$/, "");
	return listing.stdout.split(/\r?\n/).filter((line) => BUILD_TOOLS.has(name(line))).length;
}

// OS build, Node, commit, machine load and concurrent builds, recorded with every evidence file.
export async function fingerprint(
	options: { readonly cwd?: string; readonly sampleMs?: number } = {},
): Promise<Fingerprint> {
	const load: MachineLoad = {
		cpuPercent: await sampleCpu(options.sampleMs),
		cpuCount: os.availableParallelism(),
		cpuModel: os.cpus()[0]?.model.trim() ?? "unknown",
		memoryUsedPercent: round1(100 * (1 - os.freemem() / os.totalmem())),
		concurrentBuilds: await concurrentBuilds(),
	};
	const cwd = options.cwd ?? process.cwd();
	const git = (...args: string[]) => exec("git", ["-C", cwd, ...args], { env: gitEnv() });
	const [head, status] = await Promise.all([
		git("rev-parse", "HEAD").catch(() => null),
		git("status", "--porcelain", "--untracked-files=no").catch(() => null),
	]);
	const sha = head?.code === 0 ? head.stdout.trim() : "";
	return {
		os: {
			platform: process.platform,
			arch: process.arch,
			osName: os.version(),
			osVersion: os.release(),
		},
		node: { nodeVersion: process.versions.node, v8Version: process.versions.v8 },
		commit: /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha) ? sha : null,
		dirty: status?.code === 0 ? status.stdout.trim() !== "" : null,
		load,
	};
}

// Values loaded from .env.live: evidence never holds them and redact() replaces them.
const secrets = new Set<string>();

export function registerSecret(value: string): void {
	if (value.length >= 6) secrets.add(value);
}

function isIpv6(candidate: string): boolean {
	const groups = candidate.split(":");
	const shaped = groups.length >= 3 && groups.length <= 8 && groups.every((g) => g.length <= 4);
	const full = candidate.includes("::") || groups.length === 8;
	return shaped && full && groups.some((group) => group !== "");
}

type Rule = readonly [string, RegExp, ((match: string) => boolean)?];
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const userName = (): string => {
	try {
		return os.userInfo().username;
	} catch {
		return "";
	}
};

// This machine's home folder, user name (as a path segment) and host name, read at runtime.
function hostRules(): Rule[] {
	const found: Rule[] = [];
	const ends = "(?![\\w.-])";
	const home = literal(os.homedir()).replace(/\\\\|\//g, "[\\\\/]");
	if (home.length > 8) found.push(["home", new RegExp(`${home}${ends}`, "gi")]);
	const user = userName();
	if (user.length > 1) {
		found.push(["user", new RegExp(`(?<![^\\\\/])${literal(user)}${ends}`, "gi")]);
	}
	const host = os.hostname();
	if (host.length > 2 && host.toLowerCase() !== "localhost") {
		found.push(["host", new RegExp(`\\b${literal(host)}\\b`, "gi")]);
	}
	return found;
}

// The shapes vendor-guard refuses under spikes/**/evidence/**. Global patterns: never call .test().
const rules: readonly Rule[] = [
	[
		"token",
		/\b(?:xox[a-z]-|xapp-|sk-|ya29\.|GOCSPX-|AIza|gh[opsur]_|github_pat_|glpat-)[\w.-]{8,}|\b1\/\/[\w-]{16,}|\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*|\bBearer\s+[\w.~+/-]{8,}=*/g,
	],
	["email", /(?<![\w.%+-])[\w.%+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi],
	["tailnet", /\b[\w-]+(?:\.[\w-]+)*\.ts\.net\b/gi],
	["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi],
	["ipv6", /(?<![\w:])[0-9a-f:]{2,}(?![\w:])/gi, isIpv6],
	["ipv4", /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g],
	["phone", /\+\d[\d\s().-]{6,}\d|\(\d{3}\)\s?\d{3}[\s.-]\d{4}|\b\d{3}[\s.-]\d{3}[\s.-]\d{4}\b/g],
	["digits", /\d{9,}/g],
	...hostRules(),
];

// Commit SHAs, SHA-256 digests and hashId() values may hold digit runs; they are never content.
// Pinned images (name[:tag]@sha256:<digest>) are checked without their digest.
const HASH = /^(?:[0-9a-f]{40}|[0-9a-f]{64}|sha256:[0-9a-f]{64}|hmac:[\w-]{22})$/;
const withoutDigest = (text: string): string => PINNED_IMAGE.exec(text)?.[1] ?? text;
// Longer strings skip the patterns: evidence refuses them anyway, and redact() replaces them.
const REDACT_MAX = 4_096;

// Version strings look like IPv4 addresses, so `*Version` keys skip that rule, as in vendor-guard.
const active = (key: string | undefined) =>
	rules.filter(([name]) => name !== "ipv4" || !key?.endsWith("Version"));

function contentRules(text: string, key?: string): string[] {
	const found = [...secrets].some((secret) => text.includes(secret)) ? ["secret"] : [];
	if (HASH.test(text)) return found;
	const subject = withoutDigest(text);
	for (const [name, pattern, accept] of active(key)) {
		if ([...subject.matchAll(pattern)].some(([match]) => accept?.(match) ?? true)) found.push(name);
	}
	return found;
}

function redactText(text: string, key?: string): string {
	if (text.length > REDACT_MAX) return "[redacted:long]";
	let out = text;
	for (const secret of secrets) out = out.replaceAll(secret, "[redacted:secret]");
	if (HASH.test(out)) return out;
	const subject = withoutDigest(out);
	let kept = subject;
	for (const [name, pattern, accept] of active(key)) {
		kept = kept.replace(pattern, (match) =>
			(accept?.(match) ?? true) ? `[redacted:${name}]` : match,
		);
	}
	return kept + out.slice(subject.length);
}

function transform(value: unknown, key?: string): unknown {
	if (typeof value === "string") return redactText(value, key);
	if (Array.isArray(value)) return value.map((item) => transform(item, key));
	const proto = value && typeof value === "object" ? Object.getPrototypeOf(value) : undefined;
	if (proto !== Object.prototype && proto !== null) return value;
	const entries = Object.entries(value as object);
	return Object.fromEntries(
		entries.map(([name, item]) => [redactText(name), transform(item, name)]),
	);
}

// Replaces secrets, tokens, addresses and identifiers in strings, arrays and plain objects.
export function redact<T>(value: T): T {
	return transform(value) as T;
}

// Header names, plus values only for *ratelimit*, retry-after and content-type.
export function redactHeaders(
	headers: Headers | Readonly<Record<string, string | readonly string[] | number | undefined>>,
): { readonly names: readonly string[]; readonly values: Readonly<Record<string, string>> } {
	const entries =
		headers instanceof Headers
			? [...headers]
			: Object.entries(headers).flatMap(([name, value]) =>
					value === undefined ? [] : [[name.toLowerCase(), [value].flat().join(", ")] as const],
				);
	const kept = entries.filter(([name]) => /ratelimit|^retry-after$|^content-type$/.test(name));
	const values = Object.fromEntries(kept.map(([name, value]) => [name, redactText(value)]));
	return { names: [...new Set(entries.map(([name]) => name))].toSorted(), values };
}

// A URL as its host plus the SHA-256 of the document fetched from it (Conventions → Evidence).
// Paths and queries hold vendor ids, so they are never hashed on their own.
export function redactUrl(
	url: string | URL,
	document: string | Uint8Array,
): { readonly host: string; readonly sha256: string } {
	const sha256 = createHash("sha256").update(document).digest("hex");
	return { host: redactText(new URL(url).host), sha256 };
}

// The key lives in memory for one session and is never written, so the ids can't be reversed.
export function newSessionKey(): Uint8Array {
	return randomBytes(32);
}

export function hashId(sessionKey: Uint8Array, id: string): string {
	if (sessionKey.byteLength < 32) throw new Error("hashId needs a 32-byte newSessionKey()");
	return `hmac:${createHmac("sha256", sessionKey).update(id).digest("base64url").slice(0, 22)}`;
}

// Throws unless every string, keys included, is content-free; names JSON paths, never values.
export function assertContentFree(value: unknown, label = "evidence", maxLength = 256): void {
	const problems: string[] = [];
	const json = JSON.stringify(value, (key, item: unknown) => {
		if (typeof item === "number" && !Number.isFinite(item)) problems.push(`${key} (not finite)`);
		return item;
	});
	const check = (text: string, key?: string): string[] =>
		text.length > maxLength ? [`longer than ${maxLength}`] : contentRules(text, key);
	const visit = (node: unknown, at: string, key?: string): void => {
		if (typeof node === "string") {
			const found = check(node, key);
			if (found.length > 0) problems.push(`${at} (${found.join(", ")})`);
		} else if (node !== null && typeof node === "object") {
			for (const [name, item] of Object.entries(node)) {
				const found = Array.isArray(node) ? [] : check(name);
				if (found.length > 0) problems.push(`${at}.<key> (${found.join(", ")})`);
				const step = Array.isArray(node) ? `[${name}]` : `.${found.length > 0 ? "<key>" : name}`;
				visit(item, `${at}${step}`, Array.isArray(node) ? key : name);
			}
		}
	};
	visit(json === undefined ? undefined : JSON.parse(json), "$");
	if (problems.length > 0) {
		throw new Error(`${label}: content-shaped values at ${problems.join("; ")}`);
	}
}

// Writes <spike>/evidence/<name>.json as { recordedAt, fingerprint, data } in 2-space JSON.
export async function writeEvidence(
	file: string | URL,
	data: Readonly<Record<string, unknown>>,
	options: { readonly fingerprint?: Fingerprint } = {},
): Promise<string> {
	const target = typeof file === "string" ? path.resolve(file) : fileURLToPath(file);
	if (path.basename(path.dirname(target)) !== "evidence" || path.extname(target) !== ".json") {
		throw new Error(`evidence is written as .json into an evidence/ folder, not ${target}`);
	}
	mkdirSync(path.dirname(target), { recursive: true });
	const print = options.fingerprint ?? (await fingerprint({ cwd: path.dirname(target) }));
	const document = { recordedAt: new Date().toISOString(), fingerprint: print, data };
	assertContentFree(document, target);
	const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`);
		renameSync(temp, target);
	} finally {
		rmSync(temp, { force: true });
	}
	return target;
}
