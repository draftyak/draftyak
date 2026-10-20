import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";

export type NativeToolName = "cargo" | "rustc" | "cargo-deny";
export interface NativeVersionResult {
	readonly code: number | null;
	readonly stdout: Uint8Array;
	readonly stderr: Uint8Array;
}
export type NativeVersionProbe = (
	file: string,
	args: readonly string[],
) => Promise<NativeVersionResult>;
export interface NativeToolFact {
	readonly name: NativeToolName;
	readonly version: "1.95.0" | "0.20.2";
	readonly host: string | null;
	readonly sha256: string;
	readonly format: "PE32+-x86_64" | "ELF64-x86_64";
	readonly identityBoundary: "official-release-executable" | "trusted-host-toolchain";
}
declare const provenanceBrand: unique symbol;
export interface NativeToolProvenance {
	readonly digest: string;
	readonly tools: readonly NativeToolFact[];
	readonly [provenanceBrand]: true;
}
export class ToolProvenanceError extends Error {
	readonly code = "TOOL_PROVENANCE_REFUSED";
	constructor() {
		super("native tool provenance refused");
		this.name = "ToolProvenanceError";
	}
}

const NAMES: readonly NativeToolName[] = ["cargo", "rustc", "cargo-deny"];
const DENY = Object.freeze({
	win32: "f7292fab58c706638c999e64c4ba82e5128ae628130ba55e3266a768ee431fbf",
	linux: "b329e25933d01c36dd7c47d84ea5716694f9b7caf53a5003d45674703a8ed54a",
});
const HOST = Object.freeze({ win32: "x86_64-pc-windows-msvc", linux: "x86_64-unknown-linux-gnu" });
const LIMIT = 64 * 1024 * 1024;
const HEADER = 1024 * 1024;
const DOMAIN = "draftyak/native-dependency-policy/tools/v1\0";
type Platform = keyof typeof DENY;
interface FileObservation {
	readonly requested: string;
	readonly canonical: string;
	readonly identity: string;
	readonly sha256: string;
	readonly format: NativeToolFact["format"];
}
interface ToolState {
	readonly platform: Platform;
	readonly files: ReadonlyMap<NativeToolName, FileObservation>;
}
const snapshots = new WeakMap<NativeToolProvenance, ToolState>();
const observations = new WeakMap<
	object,
	{ readonly file: FileObservation; readonly platform: Platform }
>();
const refuse = (): never => {
	throw new ToolProvenanceError();
};
function platform(value: string, arch: string): Platform {
	if (arch !== "x64" || (value !== "win32" && value !== "linux")) return refuse();
	return value;
}
function absolute(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4096 ||
		!path.isAbsolute(value) ||
		value.startsWith("\\\\") ||
		value.startsWith("//")
	)
		return refuse();
	for (const char of value)
		if (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) return refuse();
	if (/\.(?:cmd|bat|ps1|sh)$/i.test(value)) return refuse();
	return path.resolve(value);
}
function identity(stat: BigIntStats, host: Platform): string {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		stat.size < 64n ||
		stat.size > BigInt(LIMIT)
	)
		return refuse();
	if (host === "linux" && (stat.mode & 0o111n) === 0n) return refuse();
	return JSON.stringify([
		String(stat.dev),
		String(stat.ino),
		String(stat.size),
		String(stat.mtimeNs),
		String(stat.ctimeNs),
		String(stat.mode),
	]);
}
function nativeFormat(bytes: Uint8Array, host: Platform): NativeToolFact["format"] {
	const b = Buffer.from(bytes);
	if (host === "win32") {
		if (b.length < 64 || b[0] !== 0x4d || b[1] !== 0x5a) return refuse();
		const pe = b.readUInt32LE(60);
		if (
			pe < 64 ||
			pe > HEADER - 136 ||
			pe + 136 > b.length ||
			b.readUInt32LE(pe) !== 0x4550 ||
			b.readUInt16LE(pe + 4) !== 0x8664 ||
			b.readUInt16LE(pe + 20) < 112 ||
			b.readUInt16LE(pe + 24) !== 0x20b
		)
			return refuse();
		const flags = b.readUInt16LE(pe + 22);
		if ((flags & 2) === 0 || (flags & 0x2000) !== 0) return refuse();
		return "PE32+-x86_64";
	}
	if (
		b.length < 64 ||
		b.subarray(0, 4).toString("hex") !== "7f454c46" ||
		b[4] !== 2 ||
		b[5] !== 1 ||
		b[6] !== 1 ||
		![0, 3].includes(b[7] ?? -1) ||
		![2, 3].includes(b.readUInt16LE(16)) ||
		b.readUInt16LE(18) !== 62 ||
		b.readUInt32LE(20) !== 1 ||
		b.readUInt16LE(52) !== 64
	)
		return refuse();
	return "ELF64-x86_64";
}
function denyHash(host: Platform, sha256: string): void {
	if (sha256 !== DENY[host]) refuse();
}
async function observe(requestedPath: string, host: Platform): Promise<FileObservation> {
	const requested = absolute(requestedPath);
	if (host === "win32" && !requested.toLowerCase().endsWith(".exe")) return refuse();
	const canonical = absolute(await fs.realpath(requested));
	if (host === "win32" && !canonical.toLowerCase().endsWith(".exe")) return refuse();
	const initial = await fs.lstat(canonical, { bigint: true });
	const id = identity(initial, host);
	const file = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		if (identity(await file.stat({ bigint: true }), host) !== id) return refuse();
		const hash = createHash("sha256");
		const header = Buffer.alloc(Math.min(HEADER, Number(initial.size)));
		const buffer = Buffer.alloc(65_536);
		let total = 0;
		while (true) {
			const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, LIMIT + 1 - total));
			if (bytesRead === 0) break;
			if (total + bytesRead > LIMIT) return refuse();
			if (total < header.length)
				buffer.copy(header, total, 0, Math.min(bytesRead, header.length - total));
			hash.update(buffer.subarray(0, bytesRead));
			total += bytesRead;
		}
		if (
			BigInt(total) !== initial.size ||
			identity(await file.stat({ bigint: true }), host) !== id ||
			identity(await fs.lstat(canonical, { bigint: true }), host) !== id ||
			(await fs.realpath(requested)) !== canonical
		)
			return refuse();
		return {
			requested,
			canonical,
			identity: id,
			sha256: hash.digest("hex"),
			format: nativeFormat(header, host),
		};
	} finally {
		await file.close();
	}
}
async function unchanged(before: FileObservation, host: Platform): Promise<void> {
	const now = await observe(before.requested, host);
	if (
		now.canonical !== before.canonical ||
		now.identity !== before.identity ||
		now.sha256 !== before.sha256 ||
		now.format !== before.format
	)
		return refuse();
}
async function executionPath(file: FileObservation, host: Platform): Promise<string> {
	await unchanged(file, host);
	// A native rustup proxy dispatches by invocation basename, not its realpath target name.
	return file.requested;
}
async function exists(filename: string): Promise<boolean> {
	try {
		await fs.lstat(filename);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}
async function resolveTool(
	name: NativeToolName,
	repository: string,
	host: Platform,
	env: NodeJS.ProcessEnv,
): Promise<string> {
	if (!NAMES.includes(name)) return refuse();
	if (name === "cargo-deny" && env.DRAFTYAK_CARGO_DENY) {
		const configured = env.DRAFTYAK_CARGO_DENY;
		return absolute(
			path.isAbsolute(configured) ? configured : path.resolve(repository, configured),
		);
	}
	if (env.PATH !== undefined && env.Path !== undefined && env.PATH !== env.Path) return refuse();
	const entries = (env.PATH ?? env.Path ?? "").split(path.delimiter);
	if (entries.length > 256) return refuse();
	for (const entry of entries) {
		if (!entry) continue;
		const directory = absolute(entry);
		const candidate = path.join(directory, `${name}${host === "win32" ? ".exe" : ""}`);
		if (await exists(candidate)) return candidate;
		for (const suffix of [".cmd", ".bat", ".ps1", ".sh"])
			if (await exists(path.join(directory, name + suffix))) return refuse();
	}
	return refuse();
}
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;
function boundedBytes(value: unknown, cap: number): Uint8Array {
	if (!types.isUint8Array(value) || types.isProxy(value) || !byteLength) return refuse();
	const size = byteLength.call(value) as number;
	if (size > cap) return refuse();
	const copy = new Uint8Array(size);
	Uint8Array.prototype.set.call(copy, value);
	return copy;
}
function version(
	name: NativeToolName,
	result: NativeVersionResult,
	host: Platform,
): { version: NativeToolFact["version"]; host: string | null } {
	if (!NAMES.includes(name)) return refuse();
	if (result.code !== 0 || boundedBytes(result.stderr, 0).length !== 0) return refuse();
	const bytes = boundedBytes(result.stdout, 8192);
	if (bytes.some((byte) => byte > 127 || (byte < 32 && byte !== 10 && byte !== 13)))
		return refuse();
	const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	if (name === "cargo-deny") {
		if (!["cargo-deny 0.20.2", "cargo-deny 0.20.2\n", "cargo-deny 0.20.2\r\n"].includes(text))
			return refuse();
		return { version: "0.20.2", host: null };
	}
	const lines = text.replaceAll("\r\n", "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const banner = new RegExp(
		`^${name} 1\\.95\\.0 \\(([a-f0-9]{9,40}) (\\d{4}-\\d{2}-\\d{2})\\)$`,
	).exec(lines.shift() ?? "");
	if (!banner) return refuse();
	const fields = new Map<string, string>();
	for (const line of lines) {
		const colon = line.indexOf(": ");
		if (colon < 1 || fields.has(line.slice(0, colon))) return refuse();
		fields.set(line.slice(0, colon), line.slice(colon + 2));
	}
	const commit = fields.get("commit-hash");
	if (
		fields.get("release") !== "1.95.0" ||
		fields.get("host") !== HOST[host] ||
		!commit ||
		!/^[a-f0-9]{40}$/.test(commit) ||
		!commit.startsWith(banner[1] ?? "") ||
		fields.get("commit-date") !== banner[2]
	)
		return refuse();
	return { version: "1.95.0", host: HOST[host] };
}
async function guarded<T>(action: () => Promise<T>): Promise<T> {
	try {
		return await action();
	} catch {
		return refuse();
	}
}
function state(snapshot: NativeToolProvenance): ToolState {
	const value = snapshots.get(snapshot);
	if (!value) return refuse();
	return value;
}

/** Fixed production policy; the callback only executes the supplied version command. */
export async function captureNativeToolProvenance(
	repositoryRoot: string,
	probe: NativeVersionProbe,
): Promise<NativeToolProvenance> {
	return guarded(async () => {
		const host = platform(process.platform, process.arch);
		const repository = absolute(repositoryRoot);
		const environment = { ...process.env };
		const files = new Map<NativeToolName, FileObservation>();
		for (const name of NAMES)
			files.set(name, await observe(await resolveTool(name, repository, host, environment), host));
		const deny = files.get("cargo-deny");
		if (!deny) return refuse();
		denyHash(host, deny.sha256);
		const facts: NativeToolFact[] = [];
		for (const name of NAMES) {
			const file = files.get(name);
			if (!file) return refuse();
			const invocation = await executionPath(file, host);
			const args = Object.freeze(
				name === "cargo-deny" ? ["--version"] : ["--version", "--verbose"],
			);
			const release = version(name, await probe(invocation, args), host);
			await unchanged(file, host);
			facts.push(
				Object.freeze({
					name,
					...release,
					sha256: file.sha256,
					format: file.format,
					identityBoundary:
						name === "cargo-deny" ? "official-release-executable" : "trusted-host-toolchain",
				}),
			);
		}
		for (const file of files.values()) await unchanged(file, host);
		const tuple = [
			"tools",
			1,
			facts.map((f) => [f.name, f.version, f.host, f.sha256, f.format, f.identityBoundary]),
		];
		const result = Object.freeze({
			digest: createHash("sha256").update(DOMAIN).update(JSON.stringify(tuple)).digest("hex"),
			tools: Object.freeze(facts),
		}) as NativeToolProvenance;
		snapshots.set(result, { platform: host, files });
		return result;
	});
}

/** Recheck immediately before spawning; the caller also checks again after completion. */
export async function nativeToolPath(
	snapshot: NativeToolProvenance,
	name: NativeToolName,
): Promise<string> {
	return guarded(async () => {
		const value = state(snapshot);
		const file = value.files.get(name);
		if (!file) return refuse();
		return executionPath(file, value.platform);
	});
}
export async function assertNativeToolsUnchanged(snapshot: NativeToolProvenance): Promise<void> {
	return guarded(async () => {
		const value = state(snapshot);
		for (const file of value.files.values()) await unchanged(file, value.platform);
	});
}

/** Pure validation and synthetic file checks; cannot mint production provenance. */
export const toolProvenanceTestInterface: {
	format: (bytes: Uint8Array, platformName: string, arch: string) => NativeToolFact["format"];
	denyHash: (platformName: string, arch: string, hash: string) => void;
	version: (
		name: NativeToolName,
		result: NativeVersionResult,
		platformName: string,
		arch: string,
	) => { version: NativeToolFact["version"]; host: string | null };
	resolve: (
		name: NativeToolName,
		repository: string,
		platformName: string,
		arch: string,
		environment: NodeJS.ProcessEnv,
	) => Promise<string>;
	observe: (
		filename: string,
		platformName: string,
		arch: string,
	) => Promise<{ readonly sha256: string; readonly format: NativeToolFact["format"] }>;
	unchanged: (observation: object) => Promise<void>;
	invocationPath: (observation: object) => Promise<string>;
} = Object.freeze({
	format: (bytes, platformName, arch) => nativeFormat(bytes, platform(platformName, arch)),
	denyHash: (platformName, arch, hash) => denyHash(platform(platformName, arch), hash),
	version: (name, result, platformName, arch) =>
		version(name, result, platform(platformName, arch)),
	resolve: (name, repository, platformName, arch, environment) =>
		guarded(() =>
			resolveTool(name, absolute(repository), platform(platformName, arch), environment),
		),
	observe: (filename, platformName, arch) =>
		guarded(async () => {
			const host = platform(platformName, arch);
			const file = await observe(filename, host);
			const result = Object.freeze({ sha256: file.sha256, format: file.format });
			observations.set(result, { file, platform: host });
			return result;
		}),
	unchanged: (observation) =>
		guarded(async () => {
			const value = observations.get(observation);
			if (!value) return refuse();
			await unchanged(value.file, value.platform);
		}),
	invocationPath: (observation) =>
		guarded(async () => {
			const value = observations.get(observation);
			if (!value) return refuse();
			return executionPath(value.file, value.platform);
		}),
});
