import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { type CargoDenyReports, parseCargoDenyReports } from "./cargo-deny.ts";
import {
	type AffectedPackage,
	type CargoGraphProjection,
	projectCargoGraph,
} from "./cargo-graph.ts";
import type { DatabaseBasis } from "./current-basis.ts";
import {
	createDatabaseSource,
	type DatabaseObservation,
	type DatabaseSource,
	DatabaseSourceError,
} from "./database-source.ts";
import {
	closeEvidenceReaders,
	createEvidenceDirectory,
	type EvidenceDirectory,
	evidenceReaderStatus,
	type NativeCaptureResult,
	readCapturedBytes,
} from "./evidence.ts";
import {
	createNativeInputsSource,
	NativeInputsError,
	type NativeInputsSnapshot,
	type NativeInputsSource,
} from "./inputs.ts";
import { proposedMobileHttpConfig } from "./mobile-http-policy.ts";
import { captureNativeProcess, type NativeCommand } from "./native-capture.ts";
import { parseStrictJson } from "./strict-json.ts";
import {
	createNativeToolProvenanceSource,
	type NativeToolProvenance,
	type NativeToolProvenanceSource,
	ToolProvenanceError,
} from "./tool-provenance.ts";

const HOUR = 3_600_000;
const CLOSE_MS = 15_000;
const POLICY_BYTES = 65_536;
const POLICY_SHA = "3dfd2b249ce43734a7ec281e10d1353a3bb9ce68a7684fa36639ea98f64791d0";
const DATABASE_URL = "https://github.com/RustSec/advisory-db";
const CACHE_CHILD = "advisory-db-3157b0e258782691";
const noFollow = constants.O_NOFOLLOW ?? 0;
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const environmentKeys = new Set([
	"SystemRoot",
	"SYSTEMROOT",
	"PATH",
	"HOME",
	"USERPROFILE",
	"TEMP",
	"TMP",
	"TMPDIR",
	"CARGO",
	"CARGO_HOME",
	"RUSTUP_HOME",
	"RUSTUP_TOOLCHAIN",
	"CARGO_NET_OFFLINE",
	"CARGO_TERM_COLOR",
	"NO_COLOR",
]);

export type NativeAuditSourceCode =
	| "NATIVE_AUDIT_INVALID"
	| "NATIVE_AUDIT_CHANGED"
	| "NATIVE_AUDIT_INCOMPLETE"
	| "NATIVE_AUDIT_STALE"
	| "NATIVE_AUDIT_CLOSED"
	| "NATIVE_AUDIT_RESOURCE_PENDING"
	| "NATIVE_AUDIT_PROCESS_UNCONFIRMED";

export class NativeAuditSourceError extends Error {
	readonly code: NativeAuditSourceCode;
	constructor(code: NativeAuditSourceCode) {
		super("native audit data source refused");
		this.name = "NativeAuditSourceError";
		this.code = code;
	}
}
function refuse(code: NativeAuditSourceCode = "NATIVE_AUDIT_INVALID"): never {
	throw new NativeAuditSourceError(code);
}
function failure(error: unknown): NativeAuditSourceError {
	if (error instanceof NativeAuditSourceError) return error;
	if (
		(error instanceof NativeInputsError && error.code === "INPUTS_CHANGED") ||
		(error instanceof DatabaseSourceError && error.code === "DATABASE_SOURCE_CHANGED") ||
		error instanceof ToolProvenanceError
	)
		return new NativeAuditSourceError("NATIVE_AUDIT_CHANGED");
	return new NativeAuditSourceError("NATIVE_AUDIT_INVALID");
}

/** Placement and command inputs are data, not an approval or a policy receipt. */
export interface NativeAuditSourceOptions {
	readonly repositoryRoot: string;
	readonly databaseRoot: string;
	readonly cargoHome: string;
	readonly evidenceDirectory: string;
	readonly expectedCargo?: string;
	readonly expectedDeny?: string;
	readonly environment: Readonly<Record<string, string>>;
}
export interface NativeAuditData {
	readonly kind: "SAME_ROOT_STRICT_AUDIT_DATA";
	readonly authority: false;
	readonly reusableNativeSourceBasis: false;
	readonly runId: string;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly observedAt: number;
	readonly database: DatabaseBasis;
	readonly graphDigest: string;
	readonly graph: CargoGraphProjection;
	readonly environmentDigest: string;
	readonly inputDigest: string;
	readonly lockDigest: string;
	readonly toolsDigest: string;
	readonly policySha256: string;
	readonly effectivePolicySha256: string;
	readonly reportDigest: string;
	readonly report: CargoDenyReports;
	readonly strictPass: boolean;
	readonly captures: readonly Readonly<{
		id: string;
		exitCode: number;
		stdoutBytes: number;
		stdoutSha256: string;
		stderrBytes: number;
		stderrSha256: string;
	}>[];
}
declare const observationBrand: unique symbol;
export interface NativeAuditObservation {
	readonly [observationBrand]: true;
}
export interface NativeAuditResources {
	readonly activeOperations: number;
	readonly activeToolOperations: number;
	readonly pendingToolFiles: number;
	readonly activeInputOperations: number;
	readonly pendingInputFiles: number;
	readonly activeReaders: number;
	readonly pendingReaders: number;
	readonly pendingFiles: number;
	readonly processUnconfirmed: boolean;
	readonly complete: boolean;
	/** Captures and the effective config are retained; no database data is deleted. */
	readonly dataRetained: true;
}
export interface NativeAuditSource {
	observe(): Promise<NativeAuditObservation>;
	revalidate(observation: NativeAuditObservation): Promise<void>;
	data(observation: NativeAuditObservation): NativeAuditData;
	closeResources(): Promise<NativeAuditResources>;
}
interface FileFact {
	readonly file: string;
	readonly identity: string;
	readonly sha256: string;
}
interface State {
	readonly options: NativeAuditSourceOptions;
	readonly handles: Set<fs.FileHandle>;
	readonly toolSource: NativeToolProvenanceSource;
	readonly inputsSource: NativeInputsSource;
	phase: "idle" | "observing" | "complete" | "checking" | "failed";
	stopping: boolean;
	operation: Promise<unknown> | undefined;
	closing: Promise<NativeAuditResources> | undefined;
	evidence: EvidenceDirectory | undefined;
	tools: NativeToolProvenance | undefined;
	inputs: NativeInputsSnapshot | undefined;
	database: DatabaseSource | undefined;
	databaseObservation: DatabaseObservation | undefined;
	firstDatabase: DatabaseBasis | undefined;
	policy: FileFact | undefined;
	config: FileFact | undefined;
	startedAt: number;
	lastAt: number;
	monotonicStart: number;
	readersUncertain: boolean;
	processUnconfirmed: boolean;
	readonly captures: NativeCaptureResult[];
}
const observations = new WeakMap<NativeAuditObservation, { owner: State; data: NativeAuditData }>();
// Failed close handles remain strongly held for an explicit resource-only close.
const retainedHandles = new Set<fs.FileHandle>();

function absolute(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4096 ||
		!value.isWellFormed() ||
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters before using a native path.
		/[\u0000-\u001f\u007f"']/u.test(value) ||
		!path.isAbsolute(value) ||
		value.startsWith("\\\\") ||
		value.startsWith("//") ||
		path.resolve(value).replaceAll("\\", "/") !== value.replaceAll("\\", "/") ||
		value.split(/[\\/]/u).some((part) => part === "." || part === "..")
	)
		return refuse();
	return path.resolve(value);
}
function record(value: unknown, keys?: readonly string[]): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		types.isProxy(value) ||
		Array.isArray(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		return refuse();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") return refuse();
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) return refuse();
		result[key] = descriptor.value;
	}
	if (
		keys &&
		(Object.keys(result).length !== keys.length || keys.some((key) => !Object.hasOwn(result, key)))
	)
		return refuse();
	return result;
}
function options(value: NativeAuditSourceOptions): NativeAuditSourceOptions {
	const required = [
		"repositoryRoot",
		"databaseRoot",
		"cargoHome",
		"evidenceDirectory",
		"environment",
	];
	const allowed = [...required, "expectedCargo", "expectedDeny"];
	const input = record(value);
	if (
		required.some((key) => !Object.hasOwn(input, key)) ||
		Object.keys(input).some((key) => !allowed.includes(key))
	)
		return refuse();
	const repositoryRoot = absolute(input.repositoryRoot),
		databaseRoot = absolute(input.databaseRoot),
		cargoHome = absolute(input.cargoHome),
		evidenceDirectory = absolute(input.evidenceDirectory),
		expectedCargo = input.expectedCargo === undefined ? undefined : absolute(input.expectedCargo),
		expectedDeny = input.expectedDeny === undefined ? undefined : absolute(input.expectedDeny);
	if (path.basename(databaseRoot) !== CACHE_CHILD) return refuse();
	const raw = record(input.environment),
		environment: Record<string, string> = Object.create(null),
		seen = new Set<string>();
	if (Object.keys(raw).length > environmentKeys.size) return refuse();
	for (const [key, value] of Object.entries(raw)) {
		const folded = process.platform === "win32" ? key.toUpperCase() : key;
		if (
			!environmentKeys.has(key) ||
			seen.has(folded) ||
			typeof value !== "string" ||
			value.length > 32768 ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Native environment values cannot contain control characters.
			/[\u0000-\u001f\u007f]/u.test(value)
		)
			return refuse();
		seen.add(folded);
		environment[key] = value;
	}
	if (
		environment.CARGO_HOME !== cargoHome ||
		environment.CARGO_NET_OFFLINE !== "true" ||
		environment.CARGO_TERM_COLOR !== "never" ||
		environment.NO_COLOR !== "1" ||
		(expectedCargo !== undefined &&
			environment.CARGO !== undefined &&
			environment.CARGO !== expectedCargo)
	)
		return refuse();
	return Object.freeze({
		repositoryRoot,
		databaseRoot,
		cargoHome,
		evidenceDirectory,
		...(expectedCargo === undefined ? {} : { expectedCargo }),
		...(expectedDeny === undefined ? {} : { expectedDeny }),
		environment: Object.freeze(environment),
	});
}
function inside(parent: string, child: string): boolean {
	const relative = path.relative(parent, child);
	return (
		relative === "" ||
		(!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
	);
}
async function directory(file: string): Promise<string> {
	const before = await fs.lstat(file, { bigint: true });
	if (!before.isDirectory() || before.isSymbolicLink() || (await fs.realpath(file)) !== file)
		return refuse();
	const after = await fs.lstat(file, { bigint: true });
	if (before.dev !== after.dev || before.ino !== after.ino || !after.isDirectory())
		return refuse("NATIVE_AUDIT_CHANGED");
	return file;
}
function stamp(stat: BigIntStats): string {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1n ||
		stat.size > BigInt(POLICY_BYTES)
	)
		return refuse();
	return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
		":",
	);
}
function guard(state: State): void {
	if (state.stopping) refuse("NATIVE_AUDIT_CLOSED");
	const now = Date.now();
	if (
		!Number.isSafeInteger(now) ||
		now < state.lastAt ||
		now - state.startedAt >= HOUR ||
		performance.now() - state.monotonicStart >= HOUR
	)
		refuse("NATIVE_AUDIT_STALE");
	state.lastAt = now;
}
async function closeFile(state: State, handle: fs.FileHandle): Promise<void> {
	await handle.close();
	state.handles.delete(handle);
	retainedHandles.delete(handle);
}
async function readFile(state: State, file: string): Promise<{ bytes: Buffer; fact: FileFact }> {
	guard(state);
	const initial = await fs.lstat(file, { bigint: true }),
		identity = stamp(initial);
	if ((await fs.realpath(file)) !== file) return refuse();
	guard(state);
	const handle = await fs.open(file, constants.O_RDONLY | noFollow);
	state.handles.add(handle);
	retainedHandles.add(handle);
	try {
		if (stamp(await handle.stat({ bigint: true })) !== identity)
			return refuse("NATIVE_AUDIT_CHANGED");
		const bytes = Buffer.alloc(Number(initial.size));
		let offset = 0;
		while (offset < bytes.length) {
			guard(state);
			const next = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (next.bytesRead === 0) return refuse("NATIVE_AUDIT_CHANGED");
			offset += next.bytesRead;
		}
		if (
			(await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0 ||
			stamp(await handle.stat({ bigint: true })) !== identity ||
			stamp(await fs.lstat(file, { bigint: true })) !== identity ||
			(await fs.realpath(file)) !== file
		)
			return refuse("NATIVE_AUDIT_CHANGED");
		guard(state);
		return { bytes, fact: { file, identity, sha256: hash(bytes) } };
	} finally {
		try {
			await closeFile(state, handle);
		} catch {
			refuse("NATIVE_AUDIT_RESOURCE_PENDING");
		}
	}
}
function strictPolicy(bytes: Buffer, cacheParent: string, graph: CargoGraphProjection): Buffer {
	if (hash(bytes) !== POLICY_SHA) return refuse("NATIVE_AUDIT_CHANGED");
	let guarded: Buffer;
	try {
		guarded = proposedMobileHttpConfig(graph, bytes);
	} catch {
		return refuse("NATIVE_AUDIT_CHANGED");
	}
	const text = new TextDecoder("utf-8", { fatal: true }).decode(guarded),
		marker = "[advisories]\n";
	const start = text.indexOf(marker),
		next = text.indexOf("\n[", start + marker.length);
	if (start < 0 || next < 0 || text.indexOf(marker, start + 1) >= 0) return refuse();
	const section = text.slice(start + marker.length, next),
		begin = section.indexOf("ignore = [\n"),
		end = section.indexOf("\n]\n", begin);
	if (
		begin < 0 ||
		end < begin ||
		section.indexOf("ignore = [\n", begin + 1) >= 0 ||
		/\bdb-(?:path|urls)\s*=/u.test(section)
	)
		return refuse();
	const changed = `${section.slice(0, begin)}ignore = []\n${section.slice(end + 3)}`;
	const parent = absolute(cacheParent).replaceAll("\\", "/");
	return Buffer.from(
		`${text.slice(0, start + marker.length)}db-path = ${JSON.stringify(parent)}\ndb-urls = ["${DATABASE_URL}"]\n${changed}${text.slice(next)}`,
	);
}
async function writeConfig(state: State, bytes: Buffer): Promise<FileFact> {
	const file = path.join(state.options.evidenceDirectory, "strict-deny.toml");
	guard(state);
	await directory(state.options.evidenceDirectory);
	guard(state);
	const handle = await fs.open(
		file,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
		0o600,
	);
	state.handles.add(handle);
	retainedHandles.add(handle);
	try {
		guard(state);
		await handle.writeFile(bytes);
		await handle.sync();
		const identity = stamp(await handle.stat({ bigint: true }));
		await directory(state.options.evidenceDirectory);
		if (
			stamp(await fs.lstat(file, { bigint: true })) !== identity ||
			(await fs.realpath(file)) !== file
		)
			return refuse("NATIVE_AUDIT_CHANGED");
		guard(state);
	} finally {
		try {
			await closeFile(state, handle);
		} catch {
			refuse("NATIVE_AUDIT_RESOURCE_PENDING");
		}
	}
	const captured = await readFile(state, file);
	if (captured.fact.sha256 !== hash(bytes)) return refuse("NATIVE_AUDIT_CHANGED");
	return captured.fact;
}
function readers(state: State): void {
	if (!state.evidence) return;
	const status = evidenceReaderStatus(state.evidence);
	if (status.active !== 0 || status.pending !== 0) state.readersUncertain = true;
	if (state.readersUncertain) refuse("NATIVE_AUDIT_RESOURCE_PENDING");
}
async function captured(
	state: State,
	capture: NativeCaptureResult,
	stream: "stdout" | "stderr",
): Promise<Uint8Array> {
	guard(state);
	readers(state);
	if (!state.evidence) return refuse();
	try {
		const bytes = await readCapturedBytes(state.evidence, capture, stream);
		guard(state);
		readers(state);
		return bytes;
	} catch (error) {
		state.readersUncertain = true;
		if (error instanceof NativeAuditSourceError) throw error;
		return refuse("NATIVE_AUDIT_RESOURCE_PENDING");
	}
}
async function native(
	state: State,
	id: string,
	command: Omit<NativeCommand, "cwd" | "env">,
): Promise<NativeCaptureResult> {
	guard(state);
	readers(state);
	const evidence = state.evidence;
	if (!evidence || state.processUnconfirmed) return refuse("NATIVE_AUDIT_PROCESS_UNCONFIRMED");
	let result: NativeCaptureResult,
		dispatched = false;
	try {
		result = await Promise.resolve().then(() => {
			guard(state);
			readers(state);
			dispatched = true;
			return captureNativeProcess(evidence, id, {
				...command,
				cwd: state.options.repositoryRoot,
				env: state.options.environment,
			});
		});
	} catch (error) {
		if (dispatched) state.processUnconfirmed = true;
		throw error;
	}
	state.captures.push(result);
	if (result.failure === "TREE_UNCONFIRMED" || (result.exitCode === null && result.signal === null))
		state.processUnconfirmed = true;
	guard(state);
	if (state.processUnconfirmed) return refuse("NATIVE_AUDIT_PROCESS_UNCONFIRMED");
	if (result.failure !== null || result.signal !== null || result.exitCode === null)
		return refuse("NATIVE_AUDIT_INCOMPLETE");
	return result;
}
async function unchanged(state: State): Promise<void> {
	guard(state);
	readers(state);
	if (state.tools) {
		await state.toolSource.assertUnchanged(state.tools);
		guard(state);
	}
	if (state.inputs) {
		await state.inputsSource.assertUnchanged(state.inputs);
		guard(state);
	}
	for (const before of [state.policy, state.config]) {
		if (!before) continue;
		const now = await readFile(state, before.file);
		if (now.fact.identity !== before.identity || now.fact.sha256 !== before.sha256)
			return refuse("NATIVE_AUDIT_CHANGED");
	}
	guard(state);
	readers(state);
}
async function currentDatabase(state: State): Promise<void> {
	guard(state);
	if (!state.database || !state.databaseObservation || !state.firstDatabase) return refuse();
	const next = await state.database.revalidate(state.databaseObservation),
		basis = state.database.basis(next);
	if (
		basis.commit !== state.firstDatabase.commit ||
		basis.revision !== state.firstDatabase.revision ||
		basis.currentCommit !== basis.commit ||
		basis.observedAt < state.firstDatabase.observedAt
	)
		return refuse("NATIVE_AUDIT_CHANGED");
	state.databaseObservation = next;
	guard(state);
	if (Date.now() - state.firstDatabase.observedAt >= HOUR) return refuse("NATIVE_AUDIT_STALE");
}
function auditArgs(state: State, advisory: boolean): readonly string[] {
	if (!state.config) return refuse();
	return Object.freeze([
		"--manifest-path",
		path.join(state.options.repositoryRoot, "crates/Cargo.toml"),
		"--config",
		state.config.file,
		"--all-features",
		"--locked",
		"--offline",
		"--format",
		"json",
		"--color",
		"never",
		"check",
		"--show-stats",
		...(advisory ? ["--audit-compatible-output", "advisories"] : []),
	]);
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		if (Object.isFrozen(value)) return value;
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
async function collect(state: State): Promise<NativeAuditObservation> {
	const selected = state.options;
	guard(state);
	await directory(selected.repositoryRoot);
	await directory(selected.cargoHome);
	await directory(selected.databaseRoot);
	await directory(path.dirname(selected.databaseRoot));
	if (
		inside(selected.repositoryRoot, selected.evidenceDirectory) ||
		inside(path.dirname(selected.databaseRoot), selected.evidenceDirectory) ||
		inside(selected.evidenceDirectory, selected.databaseRoot) ||
		inside(selected.repositoryRoot, selected.databaseRoot) ||
		inside(selected.databaseRoot, selected.repositoryRoot)
	)
		return refuse();
	guard(state);
	state.evidence = await createEvidenceDirectory({
		checkoutRoot: selected.repositoryRoot,
		directory: selected.evidenceDirectory,
	});
	guard(state);
	let version = 0;
	state.tools = await state.toolSource.capture(
		selected.repositoryRoot,
		async (file, args) => {
			const result = await native(state, `tool-version-${version++}`, {
				executable: file,
				args,
				deadlineMs: 30_000,
			});
			if (result.exitCode !== 0) return refuse("NATIVE_AUDIT_INCOMPLETE");
			return {
				code: result.exitCode,
				stdout: await captured(state, result, "stdout"),
				stderr: await captured(state, result, "stderr"),
			};
		},
		selected.expectedDeny === undefined
			? selected.environment
			: Object.freeze({
					...selected.environment,
					DRAFTYAK_CARGO_DENY: selected.expectedDeny,
				}),
	);
	guard(state);
	if (
		(selected.expectedCargo !== undefined &&
			(await state.toolSource.nativeToolPath(state.tools, "cargo")) !== selected.expectedCargo) ||
		(selected.expectedDeny !== undefined &&
			(await state.toolSource.nativeToolPath(state.tools, "cargo-deny")) !== selected.expectedDeny)
	)
		return refuse("NATIVE_AUDIT_CHANGED");
	guard(state);
	state.inputs = await state.inputsSource.capture(selected.repositoryRoot, selected.cargoHome);
	guard(state);
	const cargo = await state.toolSource.nativeToolPath(state.tools, "cargo");
	const metadata = await native(state, "locked-metadata", {
		executable: cargo,
		args: [
			"metadata",
			"--manifest-path",
			path.join(selected.repositoryRoot, "crates/Cargo.toml"),
			"--format-version",
			"1",
			"--locked",
			"--offline",
			"--all-features",
		],
		deadlineMs: 120_000,
	});
	if (metadata.exitCode !== 0) return refuse("NATIVE_AUDIT_INCOMPLETE");
	const metadataObject = parseStrictJson(await captured(state, metadata, "stdout"));
	await captured(state, metadata, "stderr");
	const paths = await state.inputsSource.bindCargoPaths(state.inputs, metadataObject),
		initialGraph = projectCargoGraph(metadataObject, paths, []);
	const original = await readFile(state, path.join(selected.repositoryRoot, "crates/deny.toml"));
	state.policy = original.fact;
	state.config = await writeConfig(
		state,
		strictPolicy(original.bytes, path.dirname(selected.databaseRoot), initialGraph),
	);
	state.database = createDatabaseSource({ databaseRoot: selected.databaseRoot });
	state.databaseObservation = await state.database.observe();
	state.firstDatabase = state.database.basis(state.databaseObservation);
	if (state.firstDatabase.commit !== state.firstDatabase.currentCommit)
		return refuse("NATIVE_AUDIT_CHANGED");
	const deny = await state.toolSource.nativeToolPath(state.tools, "cargo-deny"),
		pair: NativeCaptureResult[] = [];
	for (const advisory of [false, true]) {
		await unchanged(state);
		await currentDatabase(state);
		const result = await native(state, advisory ? "strict-advisory" : "strict-full", {
			executable: deny,
			args: auditArgs(state, advisory),
			deadlineMs: 600_000,
		});
		pair.push(result);
		await captured(state, result, "stdout");
		await captured(state, result, "stderr");
		await currentDatabase(state);
		await unchanged(state);
	}
	const full = pair[0],
		advisory = pair[1];
	if (!full || !advisory || !state.config || !state.policy || !state.firstDatabase) return refuse();
	let report: CargoDenyReports;
	try {
		report = parseCargoDenyReports({
			full: {
				stdout: await captured(state, full, "stdout"),
				stderr: await captured(state, full, "stderr"),
				exitCode: full.exitCode,
				signal: full.signal,
			},
			advisory: {
				stdout: await captured(state, advisory, "stdout"),
				stderr: await captured(state, advisory, "stderr"),
				exitCode: advisory.exitCode,
				signal: advisory.signal,
			},
			denyWarnings: false,
		});
	} catch (error) {
		if (error instanceof NativeAuditSourceError) throw error;
		return refuse("NATIVE_AUDIT_INCOMPLETE");
	}
	await currentDatabase(state);
	await unchanged(state);
	const affected = new Map<string, AffectedPackage>();
	for (const finding of report.findings) {
		const target = { source: finding.source, name: finding.name, version: finding.version };
		affected.set(JSON.stringify([target.source, target.name, target.version]), target);
	}
	const targets = [...affected.entries()]
		.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
		.map(([, target]) => target);
	// Both the complete graph and each affected ancestor closure use the original native metadata/paths.
	const graph = projectCargoGraph(metadataObject, paths, targets);
	if (graph.digest !== initialGraph.digest) return refuse("NATIVE_AUDIT_CHANGED");
	const environmentDigest = hash(
		Buffer.from(
			`draftyak/native-dependency-policy/audit-environment/v1\0${JSON.stringify(Object.entries(selected.environment).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))))}`,
		),
	);
	const reportDigest = hash(Buffer.from(JSON.stringify(report)));
	freeze(report);
	const completedAt = Date.now();
	guard(state);
	const data = freeze<NativeAuditData>({
		kind: "SAME_ROOT_STRICT_AUDIT_DATA",
		authority: false,
		reusableNativeSourceBasis: false,
		runId: state.evidence.runId,
		startedAt: state.startedAt,
		completedAt,
		observedAt: Math.min(state.startedAt, state.firstDatabase.observedAt),
		database: state.firstDatabase,
		graphDigest: graph.digest,
		graph,
		environmentDigest,
		inputDigest: state.inputs.inputDigest,
		lockDigest: state.inputs.lockDigest,
		toolsDigest: state.tools.digest,
		policySha256: state.policy.sha256,
		effectivePolicySha256: state.config.sha256,
		reportDigest,
		report,
		strictPass: report.fullExitCode === 0 && report.advisoryExitCode === 0,
		captures: state.captures.map((result) => ({
			id: result.id,
			exitCode: result.exitCode ?? -1,
			stdoutBytes: result.stdout.bytes,
			stdoutSha256: result.stdout.sha256,
			stderrBytes: result.stderr.bytes,
			stderrSha256: result.stderr.sha256,
		})),
	});
	guard(state);
	const observation = Object.freeze({}) as NativeAuditObservation;
	observations.set(observation, { owner: state, data });
	return observation;
}
function resourceStatus(state: State): NativeAuditResources {
	const status = state.evidence ? evidenceReaderStatus(state.evidence) : { active: 0, pending: 0 };
	const tools = state.toolSource.resourceStatus();
	const inputs = state.inputsSource.resourceStatus();
	const activeOperations = state.operation ? 1 : 0;
	return Object.freeze({
		activeOperations,
		activeToolOperations: tools.activeOperations,
		pendingToolFiles: tools.pendingFiles,
		activeInputOperations: inputs.activeOperations,
		pendingInputFiles: inputs.pendingFiles,
		activeReaders: status.active,
		pendingReaders: status.pending,
		pendingFiles: state.handles.size + tools.pendingFiles + inputs.pendingFiles,
		processUnconfirmed: state.processUnconfirmed,
		complete:
			activeOperations === 0 &&
			status.active === 0 &&
			status.pending === 0 &&
			state.handles.size === 0 &&
			tools.complete &&
			inputs.complete &&
			!state.processUnconfirmed,
		dataRetained: true,
	});
}
async function closeResources(state: State): Promise<NativeAuditResources> {
	state.stopping = true;
	if (!state.closing) {
		const closing = Promise.resolve().then(async () => {
			if (state.operation) await state.operation.catch(() => undefined);
			const work: Promise<unknown>[] = [...state.handles].map((handle) => closeFile(state, handle));
			work.push(state.toolSource.closeResources());
			work.push(state.inputsSource.closeResources());
			if (state.evidence) work.push(closeEvidenceReaders(state.evidence));
			await Promise.allSettled(work);
			return resourceStatus(state);
		});
		state.closing = closing;
		void closing
			.finally(() => {
				if (state.closing === closing) state.closing = undefined;
			})
			.catch(() => undefined);
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		state.closing,
		new Promise<NativeAuditResources>((resolve) => {
			timer = setTimeout(() => resolve(resourceStatus(state)), CLOSE_MS);
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/** Fixed native factories only. This source produces audit data, never a policy allowance. */
export function createNativeAuditSource(input: NativeAuditSourceOptions): NativeAuditSource {
	const state: State = {
		options: options(input),
		handles: new Set(),
		toolSource: createNativeToolProvenanceSource(),
		inputsSource: createNativeInputsSource(),
		phase: "idle",
		stopping: false,
		operation: undefined,
		closing: undefined,
		evidence: undefined,
		tools: undefined,
		inputs: undefined,
		database: undefined,
		databaseObservation: undefined,
		firstDatabase: undefined,
		policy: undefined,
		config: undefined,
		startedAt: 0,
		lastAt: 0,
		monotonicStart: 0,
		readersUncertain: false,
		processUnconfirmed: false,
		captures: [],
	};
	const saved = (observation: NativeAuditObservation): NativeAuditData => {
		const receipt = observations.get(observation);
		if (!receipt || receipt.owner !== state) return refuse();
		const now = Date.now();
		if (now < receipt.data.completedAt || now - receipt.data.observedAt >= HOUR)
			return refuse("NATIVE_AUDIT_STALE");
		return receipt.data;
	};
	return Object.freeze({
		observe() {
			if (state.phase !== "idle" || state.stopping)
				return Promise.reject(new NativeAuditSourceError("NATIVE_AUDIT_CLOSED"));
			state.phase = "observing";
			state.startedAt = Date.now();
			state.monotonicStart = performance.now();
			state.lastAt = state.startedAt;
			const operation = collect(state)
				.then(
					(observation) => {
						state.phase = "complete";
						return observation;
					},
					(error) => {
						state.phase = "failed";
						throw failure(error);
					},
				)
				.finally(() => {
					if (state.operation === operation) state.operation = undefined;
				});
			state.operation = operation;
			return operation;
		},
		revalidate(observation: NativeAuditObservation) {
			saved(observation);
			if (state.phase !== "complete" || state.stopping)
				return Promise.reject(new NativeAuditSourceError("NATIVE_AUDIT_CLOSED"));
			state.phase = "checking";
			const operation = (async () => {
				await unchanged(state);
				await currentDatabase(state);
				for (const result of state.captures) {
					await captured(state, result, "stdout");
					await captured(state, result, "stderr");
				}
				await currentDatabase(state);
				await unchanged(state);
				saved(observation);
			})()
				.then(
					() => {
						state.phase = "complete";
					},
					(error) => {
						state.phase = "failed";
						throw failure(error);
					},
				)
				.finally(() => {
					if (state.operation === operation) state.operation = undefined;
				});
			state.operation = operation;
			return operation;
		},
		data: saved,
		closeResources: () => closeResources(state),
	});
}
