import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	constants,
	copyFileSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	directory,
	type FileRecord,
	hash,
	inventory,
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
const oracle = path.resolve(import.meta.dirname, "../native-oracle");
const modulePath = "apps/app/src-tauri/src/schedule.rs";
const vectorsPath = "spec/vectors/snapshot/snapshots.json";
const zones = ["America/New_York", "Europe/London", "Australia/Lord_Howe"];
const lateness = [900, 3600, 14400, 86400];
const fromMs = Date.UTC(2026, 0, 1);
const toMs = Date.UTC(2028, 0, 1);

interface Transition {
	readonly zone: string;
	readonly epochMs: number;
	readonly offsetBefore: string;
	readonly offsetAfter: string;
}
interface Wall {
	readonly zone: string;
	readonly wall: string;
}
interface Instant {
	readonly zone: string;
	readonly epochMs: number;
}
interface Schedule {
	readonly kind: "now" | "at";
	readonly notBefore?: number;
	readonly zone?: string;
	readonly localWallTime?: string;
	readonly latenessSec?: number;
	readonly holdIfNewInbound?: boolean;
}
interface Request {
	readonly zones?: readonly string[];
	readonly fromMs?: number;
	readonly toMs?: number;
	readonly walls?: readonly Wall[];
	readonly instants?: readonly Instant[];
	readonly schedules?: readonly Schedule[];
}
interface Answers {
	readonly transitions: readonly Transition[];
	readonly walls: readonly Record<string, unknown>[];
	readonly instants: readonly Record<string, unknown>[];
	readonly schedules: readonly Record<string, unknown>[];
}

export interface ScheduleOptions {
	/** Trusted reviewed product sources, never candidate-provided executable source. */
	readonly repo: string;
	readonly root: string;
	readonly nativeArtifact: FileRecord;
	readonly node: FileRecord & { readonly version: string };
	readonly nodeSource: NodeSource;
}
export interface ScheduleReport {
	readonly nativeArtifact: FileRecord;
	readonly node: FileRecord & { readonly version: string };
	readonly sources: readonly FileRecord[];
	readonly oracle: {
		readonly sha256: string;
		readonly bytes: number;
		readonly lockSha256: string;
		readonly sourceSha256: string;
		readonly protocolSha256: string;
	};
	readonly versions: {
		readonly jiff: string;
		readonly jiffTzdb: string;
		readonly jiffTzdata: string;
		readonly node: string;
		readonly nodeTzdata: string;
	};
	readonly counts: {
		readonly transitions: number;
		readonly walls: number;
		readonly instants: number;
		readonly schedules: number;
	};
	readonly warnings: readonly string[];
	readonly boundary: string;
}
export interface ScheduleTestDeps {
	// Test seams are functions in memory only. No CLI/manifest field exposes them.
	readonly signature?: NodeTestDeps["signature"];
	readonly compile?: (project: string, target: string, env: NodeJS.ProcessEnv) => Promise<void>;
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
function verifyFile(root: string, row: FileRecord): Buffer {
	const bytes = read(root, row.path);
	if (hash(bytes) !== row.sha256 || bytes.length !== row.bytes)
		throw new Error(`schedule input integrity mismatch: ${row.path}`);
	return bytes;
}
function insideWorkspace(value: string): string {
	const absolute = directory(localPath(value));
	const rel = path.relative(directory(workspace), absolute);
	if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel))
		throw new Error("schedule sources must stay in this worktree");
	return absolute;
}
function put(root: string, file: string, bytes: Uint8Array | string): void {
	const target = path.join(root, file);
	mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
	directory(path.dirname(target));
	writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
}
function cleanup(root: string): void {
	if (path.dirname(root) !== cache || !path.basename(root).startsWith("schedule-"))
		throw new Error("unsafe schedule probe cleanup path");
	rmSync(root, { recursive: true, force: true });
}
function sourceRows(repo: string): FileRecord[] {
	const files = [
		modulePath,
		"apps/app/src-tauri/Cargo.toml",
		"crates/Cargo.lock",
		"crates/draftyak-protocol/Cargo.toml",
		"rust-toolchain.toml",
		"tools/fetch-node/versions.json",
		vectorsPath,
	];
	for (const row of inventory(path.join(repo, "crates/draftyak-protocol/src")))
		files.push(`crates/draftyak-protocol/src/${row.path}`);
	const sources = files.sort().map((file) => measured(repo, file));
	const nativeManifest = read(repo, "apps/app/src-tauri/Cargo.toml").toString("utf8");
	if (
		!/^jiff\s*=\s*\{[^\r\n]*version\s*=\s*"=0\.2\.38"[^\r\n]*default-features\s*=\s*false[^\r\n]*"std"[^\r\n]*"tzdb-bundle-always"/m.test(
			nativeManifest,
		)
	)
		throw new Error("native app must use the reviewed bundled jiff 0.2.38 feature set");
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
			throw new Error(`native lockfile lacks pinned ${name}`);
	if (!/^channel\s*=\s*"1\.95\.0"\s*$/m.test(read(repo, "rust-toolchain.toml").toString("utf8")))
		throw new Error("Rust 1.95.0 source pin required");
	return sources;
}
function sourceDigest(rows: readonly FileRecord[]): string {
	return hash(Buffer.from(JSON.stringify(rows)));
}
function lockedPackages(lock: string): Set<string> {
	return new Set(
		lock
			.split("[[package]]")
			.slice(1)
			.map((block) => {
				const field = (name: string): string =>
					new RegExp(`^${name} = "([^"\\r\\n]+)"$`, "m").exec(block)?.[1] ?? "";
				return JSON.stringify([
					field("name"),
					field("version"),
					field("source"),
					field("checksum"),
				]);
			}),
	);
}
function schedulesFromVectors(repo: string): Schedule[] {
	const vectors = object(json(repo, vectorsPath));
	if (
		vectors.format !== "draftyak.vectors.snapshot.v1" ||
		!Array.isArray(vectors.cases) ||
		vectors.cases.length > 512
	)
		throw new Error("bounded M1 snapshot vectors required");
	const result: Schedule[] = [];
	for (const raw of vectors.cases) {
		const row = object(raw);
		// Snapshot parse-error vectors do not contain a valid Schedule wire value.
		if (row.error !== undefined || row.valid === false) continue;
		const schedule = object(object(row.snapshot).schedule);
		if (schedule.kind === "now") result.push({ kind: "now" });
		else if (schedule.kind === "at") {
			if (
				!Number.isSafeInteger(schedule.notBefore) ||
				Number(schedule.notBefore) < 0 ||
				typeof schedule.zone !== "string" ||
				schedule.zone.length > 80 ||
				typeof schedule.localWallTime !== "string" ||
				!/^\d{4}-\d\d-\d\dT\d\d:\d\d[+-]\d\d:\d\d$/.test(schedule.localWallTime) ||
				!lateness.includes(Number(schedule.latenessSec)) ||
				typeof schedule.holdIfNewInbound !== "boolean"
			)
				throw new Error("invalid M1 schedule case");
			result.push({
				kind: "at",
				notBefore: Number(schedule.notBefore),
				zone: schedule.zone,
				localWallTime: schedule.localWallTime,
				latenessSec: Number(schedule.latenessSec),
				holdIfNewInbound: schedule.holdIfNewInbound,
			});
		} else throw new Error("unknown M1 schedule kind");
	}
	if (!result.some((row) => row.kind === "at"))
		throw new Error("M1 vectors contain no scheduled case");
	return result;
}

const temporalCode = `import {readFileSync} from 'node:fs';
const q=JSON.parse(readFileSync(0,'utf8')); const T=globalThis.Temporal;
if(typeof T==='undefined') throw Error('Temporal unavailable');
const transitions=[];
for(const zone of q.zones??[]) { let z=T.Instant.fromEpochMilliseconds(q.fromMs).toZonedDateTimeISO(zone); for(let n=z.getTimeZoneTransition('next');n&&n.epochMilliseconds<q.toMs;n=n.getTimeZoneTransition('next')) {transitions.push({zone,epochMs:n.epochMilliseconds,offsetBefore:n.subtract({nanoseconds:1}).offset,offsetAfter:n.offset});if(transitions.length>32)throw Error('transition bound');} }
const render=(zone,epochMs)=>{const z=T.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(zone);return {zone,epochMs,localWallTime:z.toString({smallestUnit:'minute',timeZoneName:'never'}),offset:z.offset};};
const walls=(q.walls??[]).map(({zone,wall})=>{const p=T.PlainDateTime.from(wall,{overflow:'reject'});const a=m=>p.toZonedDateTime(zone,{disambiguation:m});const earlier=a('earlier'),later=a('later');let reject=null;try{reject=a('reject').epochMilliseconds;}catch{}return {zone,wall,kind:earlier.epochMilliseconds===later.epochMilliseconds?'unique':earlier.toPlainDateTime().equals(p)?'fold':'gap',compatible:a('compatible').epochMilliseconds,earlier:earlier.epochMilliseconds,later:later.epochMilliseconds,reject};});
const schedules=(q.schedules??[]).map(s=>{let accepted=s.kind==='now'; if(s.kind==='at'){try{accepted=s.notBefore%60000===0&&render(s.zone,s.notBefore).localWallTime===s.localWallTime&&[900,3600,14400,86400].includes(s.latenessSec)&&Number.isSafeInteger(s.notBefore+s.latenessSec*1000);}catch{accepted=false;}}return {accepted,canApprove:accepted,warning:!accepted};});
console.log(JSON.stringify({version:process.versions.node,temporal:typeof T,disabled:process.execArgv.includes('--disable-sigusr1'),tzVersion:process.versions.tz,transitions,walls,instants:(q.instants??[]).map(({zone,epochMs})=>render(zone,epochMs)),schedules}));`;

async function compile(project: string, target: string, env: NodeJS.ProcessEnv): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			"cargo",
			[
				"build",
				"--release",
				"--locked",
				"--offline",
				"--manifest-path",
				path.join(project, "Cargo.toml"),
				"--target-dir",
				target,
			],
			{ cwd: project, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
		);
		let bytes = 0;
		let exceeded = false;
		let diagnostic = "";
		const limit = (chunk: Buffer): void => {
			bytes += chunk.length;
			diagnostic = `${diagnostic}${chunk.toString("utf8")}`.slice(-8192);
			if (bytes > 1_048_576) {
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
function run(
	kind: "native" | "node",
	file: string,
	request: Request,
	cwd: string,
	env: NodeJS.ProcessEnv,
): ProbeOutput {
	return spawnSync(
		file,
		kind === "node" ? ["--disable-sigusr1", "--input-type=module", "-e", temporalCode] : [],
		{
			cwd,
			env,
			input: JSON.stringify(request),
			encoding: "utf8",
			timeout: 15_000,
			maxBuffer: 1_048_576,
			shell: false,
			windowsHide: true,
		},
	);
}
function parsed(reply: ProbeOutput): Record<string, unknown> {
	if (reply.status !== 0 || reply.error || Buffer.byteLength(reply.stdout) > 1_048_576)
		throw new Error("schedule oracle execution failed or exceeded bounds");
	return object(JSON.parse(reply.stdout));
}
function answers(row: Record<string, unknown>, request: Request): Answers {
	const lengths = {
		transitions: undefined,
		walls: request.walls?.length ?? 0,
		instants: request.instants?.length ?? 0,
		schedules: request.schedules?.length ?? 0,
	};
	for (const [key, size] of Object.entries(lengths)) {
		const rows = row[key];
		if (!Array.isArray(rows) || rows.length > 512 || (size !== undefined && rows.length !== size))
			throw new Error(`schedule oracle ${key} count differs`);
	}
	return row as unknown as Answers;
}
function offset(value: string): number {
	const match = /^([+-])(\d\d):(\d\d)$/.exec(value);
	if (!match) throw new Error("unsupported transition offset");
	return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
}
function transitionCases(rows: readonly Transition[]): { walls: Wall[]; instants: Instant[] } {
	const walls: Wall[] = [],
		instants: Instant[] = [];
	for (const row of rows) {
		if (
			!zones.includes(row.zone) ||
			!Number.isSafeInteger(row.epochMs) ||
			row.epochMs < fromMs ||
			row.epochMs >= toMs
		)
			throw new Error("invalid schedule transition");
		const before = offset(row.offsetBefore),
			after = offset(row.offsetAfter);
		const first = row.epochMs + Math.min(before, after) * 60_000;
		const span = Math.abs(after - before) * 60_000;
		if (![30, 60].includes(span / 60_000)) throw new Error("unexpected schedule transition size");
		for (const ms of [first - 60_000, first, first + span / 2, first + span - 60_000, first + span])
			walls.push({ zone: row.zone, wall: new Date(ms).toISOString().slice(0, 16) });
		walls.push({
			zone: row.zone,
			wall: `${new Date(first - 86_400_000).toISOString().slice(0, 10)}T12:00`,
		});
		const start = row.epochMs - 30 * 60_000;
		for (const epochMs of [
			start,
			row.epochMs - 60_000,
			row.epochMs,
			row.epochMs + 60_000,
			...lateness.map((seconds) => start + seconds * 1000),
		])
			instants.push({ zone: row.zone, epochMs });
	}
	return { walls, instants };
}
function compare(native: Answers, temporal: Answers): void {
	for (const key of ["transitions", "walls", "instants"] as const)
		if (!isDeepStrictEqual(native[key], temporal[key]))
			throw new Error(`bundled jiff and Temporal differ: ${key}`);
	for (const [index, nativeResult] of native.schedules.entries()) {
		const temporalResult = temporal.schedules[index];
		for (const field of ["accepted", "canApprove", "warning"])
			if (nativeResult[field] !== temporalResult?.[field])
				throw new Error(`native schedule validation differs from Temporal: case ${index}`);
		if (
			typeof nativeResult.text !== "string" ||
			nativeResult.text.length > 16_384 ||
			nativeResult.text.length === 0
		)
			throw new Error("native schedule display is absent or unbounded");
	}
}

/** Compile the actual native scheduling module, then compare it with authenticated bundled Node. */
export async function inspectScheduleEquivalence(
	options: ScheduleOptions,
	deps: ScheduleTestDeps = {},
): Promise<ScheduleReport> {
	const repo = insideWorkspace(options.repo),
		root = directory(localPath(options.root));
	verifyFile(root, options.nativeArtifact);
	const sources = sourceRows(repo),
		snapshots = schedulesFromVectors(repo);
	if (object(json(repo, "tools/fetch-node/versions.json")).bundled !== options.node.version)
		throw new Error("schedule comparison requires the product's bundled Node pin");
	const protocolRows = sources.filter((row) => row.path.startsWith("crates/draftyak-protocol/"));
	const protocolSha = sourceDigest(protocolRows);
	const sourceSha = measured(repo, modulePath).sha256;
	const lockSha = measured(oracle, "Cargo.lock").sha256;
	const oracleRows = ["Cargo.toml.template", "Cargo.lock", "src/main.rs"].map((file) =>
		measured(oracle, file),
	);
	const oracleSha = sourceDigest(oracleRows);
	const productPackages = lockedPackages(read(repo, "crates/Cargo.lock").toString("utf8"));
	for (const row of lockedPackages(read(oracle, "Cargo.lock").toString("utf8")))
		if (!row.startsWith('["draftyak-schedule-oracle",') && !productPackages.has(row))
			throw new Error("schedule oracle dependency pin differs from the native product lockfile");
	const native = read(repo, modulePath).toString("utf8");
	if (
		!native.includes("TimeZoneDatabase::bundled()") ||
		!native.includes("pub(crate) fn validate") ||
		!native.includes("pub(crate) fn view")
	)
		throw new Error("actual reviewed native schedule module required");
	mkdirSync(cache, { recursive: true, mode: 0o700 });
	directory(cache);
	const temporary = mkdtempSync(path.join(cache, "schedule-"));
	try {
		const project = path.join(temporary, "project"),
			target = path.join(temporary, "target");
		mkdirSync(target, { mode: 0o700 });
		directory(target);
		for (const row of oracleRows)
			put(
				project,
				row.path === "Cargo.toml.template" ? "Cargo.toml" : row.path,
				read(oracle, row.path),
			);
		put(project, "src/schedule.rs", read(repo, modulePath));
		for (const row of protocolRows)
			put(
				project,
				row.path.replace("crates/draftyak-protocol/", "protocol/"),
				read(repo, row.path),
			);
		const env: NodeJS.ProcessEnv = {
			CARGO_NET_OFFLINE: "true",
			CARGO_BUILD_JOBS: "1",
			CARGO_TERM_COLOR: "never",
			RUSTUP_AUTO_INSTALL: "0",
			RUSTUP_TOOLCHAIN: "1.95.0",
			DRAFTYAK_SCHEDULE_SOURCE_SHA256: sourceSha,
			DRAFTYAK_SCHEDULE_PROTOCOL_SHA256: protocolSha,
			DRAFTYAK_SCHEDULE_LOCK_SHA256: lockSha,
			DRAFTYAK_SCHEDULE_ORACLE_SHA256: oracleSha,
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
			if (value) {
				if (name === "SystemDrive" && /^[A-Za-z]:$/.test(value)) localPath(`${value}/`);
				else localPath(value);
				env[name] = value;
			}
		}
		env.PATH = (process.env.PATH ?? process.env.Path ?? "")
			.split(path.delimiter)
			.filter(Boolean)
			.map((entry) => localPath(entry))
			.join(path.delimiter);
		await (deps.compile ?? compile)(project, target, env);
		for (const row of sources) verifyFile(repo, row);
		const binary = `draftyak-schedule-oracle${process.platform === "win32" ? ".exe" : ""}`;
		const builtDirectory = directory(path.join(target, "release"));
		const compiled = path.join(builtDirectory, binary);
		const compiledStat = lstatSync(compiled);
		if (compiledStat.isSymbolicLink() || !compiledStat.isFile() || compiledStat.size > 268_435_456)
			throw new Error("compiler output must be a bounded regular executable");
		// Cargo normally hard-links its own private release output to release/deps.
		// Copy that trusted compiler output, then require a single-link probe copy.
		copyFileSync(compiled, path.join(temporary, binary), constants.COPYFILE_EXCL);
		chmodSync(path.join(temporary, binary), 0o700);
		const built = read(temporary, binary);
		const nativeHash = hash(built),
			nativeSize = built.length;
		const execute = deps.execute ?? run;
		const ask = (
			kind: "native" | "node",
			file: string,
			request: Request,
			cwd: string,
			childEnv: NodeJS.ProcessEnv,
		): Record<string, unknown> => {
			if (kind === "native" && hash(read(temporary, binary)) !== nativeHash)
				throw new Error("compiled schedule oracle changed");
			const reply = parsed(execute(kind, file, request, cwd, childEnv));
			if (
				kind === "native" &&
				(reply.schemaVersion !== 1 ||
					reply.database !== "bundled" ||
					reply.jiffVersion !== "0.2.38" ||
					reply.jiffTzdbVersion !== "0.1.9" ||
					reply.sourceSha256 !== sourceSha ||
					reply.protocolSha256 !== protocolSha ||
					reply.lockSha256 !== lockSha ||
					reply.oracleSha256 !== oracleSha)
			)
				throw new Error("compiled schedule oracle provenance differs");
			return reply;
		};
		let report: ScheduleReport | undefined;
		await authenticatedNodeProbe(root, options.node, options.nodeSource, {
			signature: deps.signature,
			probe: (nodeFile, _args, nodeCwd, childEnv) => {
				const transitionsRequest = { zones, fromMs, toMs };
				const jiffFirst = ask(
					"native",
					path.join(temporary, binary),
					transitionsRequest,
					temporary,
					childEnv,
				);
				const nodeFirst = ask("node", nodeFile, transitionsRequest, nodeCwd, childEnv);
				const jiffTransitions = answers(jiffFirst, transitionsRequest).transitions;
				const nodeTransitions = answers(nodeFirst, transitionsRequest).transitions;
				if (jiffTransitions.length !== 12 || nodeTransitions.length !== 12)
					throw new Error(
						"schedule transition coverage differs from the required three-zone/two-year suite",
					);
				const union = [
					...new Map(
						[...jiffTransitions, ...nodeTransitions].map((row) => [
							`${row.zone}|${row.epochMs}|${row.offsetBefore}|${row.offsetAfter}`,
							row,
						]),
					).values(),
				];
				const { walls, instants } = transitionCases(union);
				if (walls.length > 256 || instants.length > 256)
					throw new Error("schedule comparison exceeds bounds");
				const schedules: Schedule[] = [...snapshots];
				const jiffResolution = ask(
					"native",
					path.join(temporary, binary),
					{ walls, instants },
					temporary,
					childEnv,
				);
				const nativeInstants = answers(jiffResolution, { walls, instants }).instants;
				for (const item of nativeInstants) {
					for (const latenessSec of lateness)
						schedules.push({
							kind: "at",
							notBefore: Number(item.epochMs),
							zone: text(item.zone),
							localWallTime: text(item.localWallTime),
							latenessSec,
							holdIfNewInbound: true,
						});
				}
				if (schedules.length > 512) throw new Error("too many native schedule cases");
				const request = { walls, instants, schedules };
				const jiffReply = ask("native", path.join(temporary, binary), request, temporary, childEnv);
				const temporalReply = ask("node", nodeFile, request, nodeCwd, childEnv);
				compare(
					{ ...answers(jiffReply, request), transitions: jiffTransitions },
					{ ...answers(temporalReply, request), transitions: nodeTransitions },
				);
				const jiffTzdata = text(jiffReply.tzdbVersion),
					nodeTzdata = text(temporalReply.tzVersion);
				report = {
					nativeArtifact: options.nativeArtifact,
					node: options.node,
					sources,
					oracle: {
						sha256: nativeHash,
						bytes: nativeSize,
						lockSha256: lockSha,
						sourceSha256: sourceSha,
						protocolSha256: protocolSha,
					},
					versions: {
						jiff: "0.2.38",
						jiffTzdb: "0.1.9",
						jiffTzdata,
						node: text(temporalReply.version),
						nodeTzdata,
					},
					counts: {
						transitions: jiffTransitions.length,
						walls: walls.length,
						instants: instants.length,
						schedules: schedules.length,
					},
					warnings:
						jiffTzdata === nodeTzdata
							? []
							: ["Node and jiff tzdata versions differ; all compared answers agree"],
					boundary:
						"Fresh compiled-oracle comparison of the actual reviewed native schedule module and authenticated Node. Native artifact identity is measured, but compiled application/source provenance and installed-binary behavior remain separate native-build acceptance gates.",
				};
				return {
					status: 0,
					stdout: JSON.stringify({
						version: temporalReply.version,
						temporal: temporalReply.temporal,
						disabled: temporalReply.disabled,
					}),
					stderr: "",
				};
			},
		});
		if (!report) throw new Error("schedule comparison did not execute");
		for (const row of sources) verifyFile(repo, row);
		verifyFile(root, options.nativeArtifact);
		return report;
	} finally {
		cleanup(temporary);
	}
}
