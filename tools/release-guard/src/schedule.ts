import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	constants,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
} from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
	directory,
	type FileRecord,
	hash,
	json,
	localPath,
	object,
	read,
	text,
} from "./integrity.ts";
import {
	authenticatedNodeProbe,
	type NodeSource,
	type NodeTestDeps,
	type ProbeOutput,
} from "./trusted-node.ts";

const workspace = path.resolve(import.meta.dirname, "../../..");
const cache = path.join(workspace, "tools/release-guard/.cache");
const vectorsPath = "spec/vectors/schedule/dst.json";
const rustModule = "crates/draftyak-protocol/src/schedule.rs";
const scheduleModule = "packages/protocol/src/schedule.ts";
const snapshotModule = "packages/protocol/src/snapshot.ts";
const outputLimit = 1_048_576;

interface Case {
	readonly id: string;
	readonly error?: string;
}
interface Resolution extends Case {
	readonly wall: string;
	readonly zone: string;
	readonly notBefore?: number;
}
interface Rendering extends Case {
	readonly notBefore: number;
	readonly zone: string;
	readonly localWallTime?: string;
	readonly mismatchedWallTime?: string;
}
interface Snapshot extends Case {
	readonly snapshot: Readonly<Record<string, unknown>>;
	readonly iat: number;
	readonly window?: Readonly<Record<string, unknown>>;
}
interface Vectors {
	readonly resolutions: readonly Resolution[];
	readonly renderings: readonly Rendering[];
	readonly snapshots: readonly Snapshot[];
}
interface Request extends Vectors {
	readonly scheduleModule: string;
	readonly snapshotModule: string;
}
interface Answers {
	readonly resolutions: readonly Record<string, unknown>[];
	readonly renderings: readonly Record<string, unknown>[];
	readonly snapshots: readonly Record<string, unknown>[];
}
interface Versions {
	readonly jiffVersion: string;
	readonly jiffTzdbVersion: string;
	readonly tzdataVersion: string | null;
}
export interface ScheduleOptions {
	/** Trusted reviewed product sources, never candidate-provided executable source. */
	readonly repo: string;
	readonly root: string;
	readonly nativeArtifact?: FileRecord;
	readonly node: FileRecord & { readonly version: string };
	readonly nodeSource: NodeSource;
}
export interface ScheduleReport {
	readonly nativeArtifact?: FileRecord;
	readonly node: FileRecord & { readonly version: string };
	readonly sources: readonly FileRecord[];
	readonly oracle: {
		readonly sha256: string;
		readonly bytes: number;
		readonly lockSha256: string;
		readonly sourceSha256: string;
		readonly scopedInputsSha256: string;
	};
	readonly versions: {
		readonly jiff: string;
		readonly jiffTzdb: string;
		readonly jiffTzdata: string | null;
		readonly node: string;
		readonly nodeTzdata: string;
	};
	readonly counts: {
		readonly resolutions: number;
		readonly renderings: number;
		readonly snapshots: number;
	};
	readonly warnings: readonly string[];
	readonly boundary: string;
}
export interface ScheduleTestDeps {
	// Test seams are functions in memory only. No CLI/manifest field exposes them.
	readonly signature?: NodeTestDeps["signature"];
	readonly compile?: (repo: string, target: string, env: NodeJS.ProcessEnv) => Promise<void>;
	readonly execute?: (
		kind: "native" | "node",
		file: string,
		request: unknown,
		cwd: string,
		env: NodeJS.ProcessEnv,
	) => ProbeOutput;
}

function measured(root: string, file: string): FileRecord {
	const bytes = read(root, file);
	return { path: file, sha256: hash(bytes), bytes: bytes.length };
}
function verifyFile(root: string, row: FileRecord): void {
	const bytes = read(root, row.path);
	if (hash(bytes) !== row.sha256 || bytes.length !== row.bytes)
		throw new Error(`schedule input integrity mismatch: ${row.path}`);
}
function insideWorkspace(value: string): string {
	const absolute = directory(localPath(value));
	const rel = path.relative(directory(workspace), absolute);
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
		throw new Error("schedule sources must stay in this worktree");
	return absolute;
}
function cleanup(root: string): void {
	if (path.dirname(root) !== cache || !path.basename(root).startsWith("schedule-"))
		throw new Error("unsafe schedule probe cleanup path");
	rmSync(root, { recursive: true, force: true });
}
function sourceRows(repo: string): FileRecord[] {
	const files = [
		rustModule,
		"crates/draftyak-protocol/src/snapshot.rs",
		"crates/draftyak-protocol/examples/xcheck/main.rs",
		"crates/draftyak-protocol/examples/xcheck/schedule.rs",
		"crates/draftyak-protocol/examples/xcheck/snapshot.rs",
		"crates/Cargo.toml",
		"crates/Cargo.lock",
		"crates/draftyak-protocol/Cargo.toml",
		scheduleModule,
		snapshotModule,
		"packages/protocol/package.json",
		"pnpm-lock.yaml",
		"rust-toolchain.toml",
		"tools/fetch-node/versions.json",
		vectorsPath,
	];
	const sources = files.sort().map((file) => measured(repo, file));
	const manifest = read(repo, "crates/draftyak-protocol/Cargo.toml").toString("utf8");
	if (
		!/^jiff\s*=\s*\{[^\r\n]*version\s*=\s*"=0\.2\.38"[^\r\n]*default-features\s*=\s*false[^\r\n]*"std"[^\r\n]*"tzdb-bundle-always"/m.test(
			manifest,
		)
	)
		throw new Error("shared protocol must use the reviewed bundled jiff 0.2.38 feature set");
	const lock = read(repo, "crates/Cargo.lock").toString("utf8");
	for (const [name, version] of [
		["jiff", "0.2.38"],
		["jiff-tzdb", "0.1.9"],
	])
		if (
			![...lock.matchAll(/^name = "([^"]+)"\r?\nversion = "([^"]+)"/gm)].some(
				(entry) => entry[1] === name && entry[2] === version,
			)
		)
			throw new Error(`shared lockfile lacks pinned ${name}`);
	if (!/^channel\s*=\s*"1\.95\.0"\s*$/m.test(read(repo, "rust-toolchain.toml").toString("utf8")))
		throw new Error("Rust 1.95.0 source pin required");
	return sources;
}
function cases<T extends Case>(input: unknown): readonly T[] {
	if (!Array.isArray(input) || input.length === 0 || input.length > 512)
		throw new Error("canonical schedule vector count is invalid");
	const ids = new Set<string>();
	for (const raw of input) {
		const row = object(raw);
		const id = text(row.id);
		if (id.length > 180 || ids.has(id)) throw new Error("canonical schedule vector id is invalid");
		ids.add(id);
	}
	return input as readonly T[];
}
function vectors(repo: string): Vectors {
	const document = object(json(repo, vectorsPath));
	if (document.format !== "draftyak.vectors.schedule.v1")
		throw new Error("canonical M1 schedule vectors required");
	return {
		resolutions: cases<Resolution>(document.resolutionCases),
		renderings: cases<Rendering>(document.renderingCases),
		snapshots: cases<Snapshot>(document.snapshots),
	};
}
function queries(input: Vectors): readonly Record<string, unknown>[] {
	return [
		{ cmd: "schedule", notBefore: 0, zone: "UTC" },
		...input.resolutions.map(({ wall, zone }) => ({ cmd: "scheduleResolve", wall, zone })),
		...input.renderings.flatMap(({ notBefore, zone, localWallTime, mismatchedWallTime, error }) => [
			{ cmd: "schedule", notBefore, zone },
			...(!error ? [{ cmd: "schedule", notBefore, zone, localWallTime }] : []),
			...(mismatchedWallTime !== undefined
				? [{ cmd: "schedule", notBefore, zone, localWallTime: mismatchedWallTime }]
				: []),
		]),
		...input.snapshots.map(({ snapshot, iat }) => ({
			cmd: "snapshot",
			snapshotJson: JSON.stringify(snapshot),
			iat,
		})),
	];
}

// Execute the merged M1 implementations; no schedule policy or timezone algorithm lives here.
const temporalCode = `import {readFileSync} from 'node:fs';
const q=JSON.parse(readFileSync(0,'utf8'));
const {renderLocalWallTime,resolveLocalTime}=await import(q.scheduleModule);
const {sendWindow}=await import(q.snapshotModule);
const codes=new Set(['INVALID_INPUT','SCHEDULING_UNAVAILABLE','NONEXISTENT_LOCAL_TIME','AMBIGUOUS_LOCAL_TIME','SNAPSHOT_INVALID','SNAPSHOT_WINDOW_OVERFLOW','SNAPSHOT_UNICODE_VERSION']);
const attempt=fn=>{try{return fn();}catch(error){if(codes.has(error?.code))return {error:error.code};throw Error('shared M1 schedule evaluation failed');}};
const resolutions=q.resolutions.map(row=>attempt(()=>({notBefore:resolveLocalTime(row.wall,row.zone)})));
const renderings=q.renderings.map(row=>attempt(()=>{const localWallTime=renderLocalWallTime(row.notBefore,row.zone);return {localWallTime,matches:localWallTime===row.localWallTime,...(row.mismatchedWallTime===undefined?{}:{mismatched:localWallTime===row.mismatchedWallTime})};}));
const snapshots=q.snapshots.map(row=>attempt(()=>({window:sendWindow(row.snapshot,row.iat)})));
console.log(JSON.stringify({version:process.versions.node,temporal:typeof globalThis.Temporal,disabled:process.execArgv.includes('--disable-sigusr1'),tzVersion:process.versions.tz,resolutions,renderings,snapshots}));`;

async function compile(repo: string, target: string, env: NodeJS.ProcessEnv): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"cargo",
			[
				"build",
				"--release",
				"--locked",
				"--offline",
				"--manifest-path",
				path.join(repo, "crates/Cargo.toml"),
				"--package",
				"draftyak-protocol",
				"--example",
				"xcheck",
				"--target-dir",
				target,
			],
			{
				cwd: path.join(repo, "crates"),
				env,
				shell: false,
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let bytes = 0;
		let exceeded = false;
		let diagnostic = "";
		const limit = (chunk: Buffer): void => {
			bytes += chunk.length;
			diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-8192);
			if (bytes > outputLimit) {
				exceeded = true;
				child.kill();
			}
		};
		child.stdout.on("data", limit);
		child.stderr.on("data", limit);
		const timer = setTimeout(() => {
			exceeded = true;
			child.kill();
		}, 180_000);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 || exceeded)
				reject(
					new Error(
						`offline schedule oracle compilation failed, timed out or exceeded output limit\n${diagnostic}`,
					),
				);
			else resolve();
		});
	});
}
function encoded(kind: "native" | "node", input: unknown): string {
	const body =
		kind === "native"
			? (input as readonly unknown[]).map((row) => JSON.stringify(row)).join("\n") + "\n"
			: JSON.stringify(input);
	if (Buffer.byteLength(body) > outputLimit)
		throw new Error("schedule oracle request exceeds bounds");
	return body;
}
function run(
	kind: "native" | "node",
	file: string,
	input: unknown,
	cwd: string,
	env: NodeJS.ProcessEnv,
): ProbeOutput {
	return spawnSync(
		file,
		kind === "node" ? ["--disable-sigusr1", "--input-type=module", "-e", temporalCode] : [],
		{
			cwd,
			env,
			input: encoded(kind, input),
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: outputLimit,
			shell: false,
			windowsHide: true,
		},
	);
}
function output(reply: ProbeOutput): string {
	if (reply.status !== 0 || reply.error || Buffer.byteLength(reply.stdout) > outputLimit)
		throw new Error("schedule oracle execution failed or exceeded bounds");
	return reply.stdout;
}
function parsed(value: string): Record<string, unknown> {
	try {
		return object(JSON.parse(value));
	} catch {
		throw new Error("schedule oracle output refused");
	}
}
function nativeAnswers(reply: ProbeOutput, input: Vectors): Answers & Versions {
	const stdout = output(reply);
	if (!stdout.endsWith("\n")) throw new Error("shared schedule oracle answer framing differs");
	const lines = stdout.slice(0, -1).split("\n");
	if (lines.length !== queries(input).length)
		throw new Error("shared schedule oracle answer count differs");
	let at = 0;
	let versions: Versions | undefined;
	const take = (versioned = true): Record<string, unknown> => {
		const row = parsed(lines[at++] ?? "");
		if (row.fault !== undefined) throw new Error("shared schedule oracle refused its input");
		if (row.error !== undefined) {
			if (typeof row.error !== "string" || Object.keys(row).length !== 1)
				throw new Error("shared schedule oracle refusal differs");
			return { error: row.error };
		}
		if (versioned) {
			const current = {
				jiffVersion: row.jiffVersion,
				jiffTzdbVersion: row.jiffTzdbVersion,
				tzdataVersion: row.tzdataVersion,
			};
			if (
				current.jiffVersion !== "0.2.38" ||
				current.jiffTzdbVersion !== "0.1.9" ||
				(current.tzdataVersion !== null &&
					(typeof current.tzdataVersion !== "string" ||
						current.tzdataVersion.length === 0 ||
						current.tzdataVersion.length > 64)) ||
				(versions !== undefined && !isDeepStrictEqual(versions, current))
			)
				throw new Error("shared schedule oracle versions differ");
			versions = current as Versions;
		}
		return row;
	};
	if (take().localWallTime !== "1970-01-01T00:00+00:00" || !versions)
		throw new Error("shared schedule oracle metadata probe differs");
	const resolutions = input.resolutions.map(() => {
		const row = take();
		if (row.error) return { error: row.error };
		if (row.kind === "gap") return { error: "NONEXISTENT_LOCAL_TIME" };
		if (row.kind === "fold") return { error: "AMBIGUOUS_LOCAL_TIME" };
		if (
			row.kind !== "unique" ||
			!Number.isSafeInteger(row.reject) ||
			Number(row.reject) < 0 ||
			row.reject !== row.earlier ||
			row.reject !== row.later ||
			row.reject !== row.compatible
		)
			throw new Error("shared schedule oracle resolution differs");
		return { notBefore: row.reject };
	});
	const renderings = input.renderings.map((vector) => {
		const row = take();
		const matched = vector.error ? undefined : take();
		const mismatched = vector.mismatchedWallTime === undefined ? undefined : take();
		if (row.error) return { error: row.error };
		if (
			typeof row.localWallTime !== "string" ||
			row.localWallTime.length !== 22 ||
			typeof matched?.matches !== "boolean" ||
			(mismatched !== undefined && typeof mismatched.matches !== "boolean")
		)
			throw new Error("shared schedule oracle display differs");
		return {
			localWallTime: row.localWallTime,
			matches: matched.matches,
			...(mismatched === undefined ? {} : { mismatched: mismatched.matches }),
		};
	});
	const snapshots = input.snapshots.map(() => {
		const row = take(false);
		return row.error ? { error: row.error } : { window: object(row.window) };
	});
	return { ...versions, resolutions, renderings, snapshots };
}
function compare(native: Answers, temporal: Answers, input: Vectors): void {
	const expected: Answers = {
		resolutions: input.resolutions.map((row) =>
			row.error ? { error: row.error } : { notBefore: row.notBefore },
		),
		renderings: input.renderings.map((row) =>
			row.error
				? { error: row.error }
				: {
						localWallTime: row.localWallTime,
						matches: true,
						...(row.mismatchedWallTime === undefined ? {} : { mismatched: false }),
					},
		),
		snapshots: input.snapshots.map((row) =>
			row.error ? { error: row.error } : { window: row.window },
		),
	};
	for (const key of ["resolutions", "renderings", "snapshots"] as const) {
		if (
			!isDeepStrictEqual(native[key], expected[key]) ||
			!isDeepStrictEqual(temporal[key], expected[key])
		)
			throw new Error(`M1 jiff, Temporal and canonical schedule vectors differ: ${key}`);
	}
}

/** Compare the two merged M1 implementations over their canonical vectors. */
export async function inspectScheduleEquivalence(
	options: ScheduleOptions,
	deps: ScheduleTestDeps = {},
): Promise<ScheduleReport> {
	const repo = insideWorkspace(options.repo);
	const root = directory(localPath(options.root));
	if (options.nativeArtifact) verifyFile(root, options.nativeArtifact);
	const sources = sourceRows(repo);
	const input = vectors(repo);
	if (object(json(repo, "tools/fetch-node/versions.json")).bundled !== options.node.version)
		throw new Error("schedule comparison requires the product's bundled Node pin");
	mkdirSync(cache, { recursive: true, mode: 0o700 });
	directory(cache);
	const temporary = mkdtempSync(path.join(cache, "schedule-"));
	try {
		const target = path.join(temporary, "target");
		mkdirSync(target, { mode: 0o700 });
		const env: NodeJS.ProcessEnv = {
			CARGO_NET_OFFLINE: "true",
			CARGO_BUILD_JOBS: "1",
			CARGO_TERM_COLOR: "never",
			RUSTUP_AUTO_INSTALL: "0",
			RUSTUP_TOOLCHAIN: "1.95.0",
		};
		for (const name of [
			"SystemRoot",
			"SystemDrive",
			"WINDIR",
			"ProgramFiles",
			"ProgramFiles(x86)",
			"ProgramW6432",
			"ProgramData",
			"LOCALAPPDATA",
			"APPDATA",
			"USERPROFILE",
			"HOME",
			"CARGO_HOME",
			"RUSTUP_HOME",
			"TEMP",
			"TMP",
		]) {
			const value = process.env[name];
			if (!value) continue;
			if (name === "SystemDrive" && /^[A-Za-z]:$/.test(value)) localPath(`${value}/`);
			else localPath(value);
			env[name] = value;
		}
		env.PATH = (process.env.PATH ?? process.env.Path ?? "")
			.split(path.delimiter)
			.filter(Boolean)
			.map((entry) => localPath(entry))
			.join(path.delimiter);
		await (deps.compile ?? compile)(repo, target, env);
		for (const row of sources) verifyFile(repo, row);
		const binary = `xcheck${process.platform === "win32" ? ".exe" : ""}`;
		const compiled = path.join(directory(path.join(target, "release/examples")), binary);
		const stat = lstatSync(compiled);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.size < 1 || stat.size > 268_435_456)
			throw new Error("compiler output must be a bounded regular executable");
		copyFileSync(compiled, path.join(temporary, binary), constants.COPYFILE_EXCL);
		chmodSync(path.join(temporary, binary), 0o700);
		const built = read(temporary, binary);
		const nativeHash = hash(built);
		let report: ScheduleReport | undefined;
		await authenticatedNodeProbe(root, options.node, options.nodeSource, {
			signature: deps.signature,
			probe: (nodeFile, _args, nodeCwd, childEnv) => {
				if (hash(read(temporary, binary)) !== nativeHash)
					throw new Error("compiled schedule oracle changed");
				const execute = deps.execute ?? run;
				const commands = queries(input);
				encoded("native", commands);
				const native = nativeAnswers(
					execute("native", path.join(temporary, binary), commands, temporary, childEnv),
					input,
				);
				if (hash(read(temporary, binary)) !== nativeHash)
					throw new Error("compiled schedule oracle changed");
				const request: Request = {
					...input,
					scheduleModule: pathToFileURL(path.join(repo, scheduleModule)).href,
					snapshotModule: pathToFileURL(path.join(repo, snapshotModule)).href,
				};
				encoded("node", request);
				const temporal = parsed(output(execute("node", nodeFile, request, nodeCwd, childEnv)));
				compare(native, temporal as unknown as Answers, input);
				const nodeTzdata = text(temporal.tzVersion);
				report = {
					nativeArtifact: options.nativeArtifact,
					node: options.node,
					sources,
					oracle: {
						sha256: nativeHash,
						bytes: built.length,
						lockSha256: measured(repo, "crates/Cargo.lock").sha256,
						sourceSha256: measured(repo, rustModule).sha256,
						scopedInputsSha256: hash(Buffer.from(JSON.stringify(sources))),
					},
					versions: {
						jiff: native.jiffVersion,
						jiffTzdb: native.jiffTzdbVersion,
						jiffTzdata: native.tzdataVersion,
						node: text(temporal.version),
						nodeTzdata,
					},
					counts: {
						resolutions: input.resolutions.length,
						renderings: input.renderings.length,
						snapshots: input.snapshots.length,
					},
					warnings:
						native.tzdataVersion === nodeTzdata
							? []
							: ["Node and jiff tzdata versions differ; all canonical schedule answers agree"],
					boundary:
						"M1 scheduling/rendering/window equivalence only. M4 approval-window validation and installed-artifact acceptance remain separate.",
				};
				return {
					status: 0,
					stdout: JSON.stringify({
						version: temporal.version,
						temporal: temporal.temporal,
						disabled: temporal.disabled,
					}),
					stderr: "",
				};
			},
		});
		if (!report) throw new Error("schedule comparison did not execute");
		for (const row of sources) verifyFile(repo, row);
		if (options.nativeArtifact) verifyFile(root, options.nativeArtifact);
		return report;
	} finally {
		cleanup(temporary);
	}
}
