// Fixed CI policy checks preserve command exits and own their input resources.
import { createHash, randomUUID } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { RepositoryAuthority } from "./authority.ts";
import { projectCargoGraph } from "./cargo-graph.ts";
import { CURRENT_FINITE_GRAPH_TERM } from "./decision.ts";
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
	type NativeInputsSnapshot,
	type NativeInputsSource,
} from "./inputs.ts";
import { proposedMobileHttpConfig } from "./mobile-http-policy.ts";
import { captureNativeProcess } from "./native-capture.ts";
import { createProductionProducer } from "./production.ts";
import { runNativePolicy } from "./runner.ts";
import { parseStrictJson } from "./strict-json.ts";
import {
	createNativeToolProvenanceSource,
	type NativeToolProvenance,
	type NativeToolProvenanceSource,
} from "./tool-provenance.ts";

const HOUR = 3_600_000;
const POLICY_BYTES = 65_536;
const noFollow = constants.O_NOFOLLOW ?? 0;
const ENVIRONMENT = new Set([
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
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface FinitePolicyCiOptions {
	readonly repositoryRoot: string;
	readonly cargoHome: string;
	readonly cargo: string;
	readonly deny: string;
	readonly environment: Readonly<Record<string, string>>;
}
export type FinitePolicyCiCode =
	| "FINITE_POLICY_CI_REFUSED"
	| "FINITE_POLICY_CI_CHANGED"
	| "FINITE_POLICY_CI_STALE"
	| "FINITE_POLICY_CI_RESOURCE_PENDING"
	| "FINITE_POLICY_CI_PROCESS_UNCONFIRMED";
export interface FinitePolicyCiResources {
	readonly ownFiles: number;
	readonly inputOperations: number | null;
	readonly inputFiles: number | null;
	readonly toolOperations: number | null;
	readonly toolFiles: number | null;
	readonly activeReaders: number | null;
	readonly pendingReaders: number | null;
	readonly processUnconfirmed: boolean;
	readonly resourceUncertain: boolean;
	readonly complete: boolean;
	readonly dataRetained: true;
}
export class FinitePolicyCiError extends Error {
	readonly code: FinitePolicyCiCode;
	readonly commandExitCode: number | null;
	readonly resources: FinitePolicyCiResources | null;
	constructor(
		code: FinitePolicyCiCode,
		commandExitCode: number | null = null,
		resources: FinitePolicyCiResources | null = null,
	) {
		super("finite policy CI refused");
		this.name = "FinitePolicyCiError";
		this.code = code;
		this.commandExitCode = commandExitCode;
		this.resources = resources;
	}
}
function refuse(code: FinitePolicyCiCode = "FINITE_POLICY_CI_REFUSED"): never {
	throw new FinitePolicyCiError(code);
}
interface FileFact {
	readonly file: string;
	readonly identity: string;
	readonly sha256: string;
}
interface FileTicket {
	readonly handle: fs.FileHandle;
	closing: Promise<void> | undefined;
}
interface State {
	readonly options: FinitePolicyCiOptions;
	readonly inputs: NativeInputsSource;
	readonly tools: NativeToolProvenanceSource;
	readonly files: Set<FileTicket>;
	readonly startedAt: number;
	readonly monotonicStart: number;
	lastAt: number;
	evidence: EvidenceDirectory | undefined;
	evidenceDirectory: string | undefined;
	evidenceIdentity: string | undefined;
	input: NativeInputsSnapshot | undefined;
	provenance: NativeToolProvenance | undefined;
	policy: FileFact | undefined;
	config: FileFact | undefined;
	repositoryIdentity: string | undefined;
	cargoHomeIdentity: string | undefined;
	processUnconfirmed: boolean;
	resourceUncertain: boolean;
	commandExitCode: number | null;
}
// A failed own FileHandle close remains strongly reachable; no global/foreign closer or retry.
const retained = new Set<State>();

function record(value: unknown): Record<string, unknown> {
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
		if (!descriptor || !Object.hasOwn(descriptor, "value")) return refuse();
		result[key] = descriptor.value as unknown;
	}
	return result;
}
function hasAsciiControl(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}
function absolute(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 4096 ||
		!value.isWellFormed() ||
		hasAsciiControl(value) ||
		/["']/u.test(value) ||
		!path.isAbsolute(value) ||
		value.startsWith("\\\\") ||
		value.startsWith("//") ||
		path.resolve(value).replaceAll("\\", "/") !== value.replaceAll("\\", "/") ||
		value.split(/[\\/]/u).some((part) => part === "." || part === "..")
	)
		return refuse();
	return path.resolve(value);
}
function options(value: FinitePolicyCiOptions): FinitePolicyCiOptions {
	const input = record(value),
		keys = ["repositoryRoot", "cargoHome", "cargo", "deny", "environment"];
	if (Object.keys(input).length !== keys.length || keys.some((key) => !Object.hasOwn(input, key)))
		return refuse();
	const repositoryRoot = absolute(input.repositoryRoot),
		cargoHome = absolute(input.cargoHome),
		cargo = absolute(input.cargo),
		deny = absolute(input.deny),
		raw = record(input.environment);
	const environment: Record<string, string> = Object.create(null),
		seen = new Set<string>();
	let bytes = 0;
	for (const [key, value] of Object.entries(raw)) {
		const folded = process.platform === "win32" ? key.toUpperCase() : key;
		if (
			!ENVIRONMENT.has(key) ||
			seen.has(folded) ||
			typeof value !== "string" ||
			!value.isWellFormed() ||
			hasAsciiControl(value) ||
			Buffer.byteLength(value) > 8192
		)
			return refuse();
		bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
		if (bytes > 32768) return refuse();
		seen.add(folded);
		environment[key] = value;
	}
	if (
		!environment.PATH ||
		environment.CARGO_HOME !== cargoHome ||
		(environment.CARGO !== undefined && environment.CARGO !== cargo) ||
		environment.CARGO_TERM_COLOR !== "never" ||
		environment.NO_COLOR !== "1"
	)
		return refuse();
	return Object.freeze({
		repositoryRoot,
		cargoHome,
		cargo,
		deny,
		environment: Object.freeze(environment),
	});
}
function gate(state: State): void {
	const now = Date.now();
	if (
		!Number.isSafeInteger(now) ||
		now < state.lastAt ||
		now >= CURRENT_FINITE_GRAPH_TERM.expiresAt ||
		now - state.startedAt >= HOUR ||
		performance.now() - state.monotonicStart >= HOUR
	)
		refuse("FINITE_POLICY_CI_STALE");
	state.lastAt = now;
	if (state.processUnconfirmed) refuse("FINITE_POLICY_CI_PROCESS_UNCONFIRMED");
	if (state.resourceUncertain) refuse("FINITE_POLICY_CI_RESOURCE_PENDING");
}
function directoryStamp(stat: BigIntStats): string {
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n) return refuse();
	return [stat.dev, stat.ino, stat.mode].join(":");
}
async function directory(file: string, expected?: string): Promise<string> {
	const parsed = path.parse(file);
	let current = parsed.root;
	for (const component of path.relative(parsed.root, file).split(path.sep).filter(Boolean)) {
		current = path.join(current, component);
		const before = directoryStamp(await fs.lstat(current, { bigint: true }));
		if (
			(await fs.realpath(current)) !== current ||
			directoryStamp(await fs.lstat(current, { bigint: true })) !== before
		)
			return refuse("FINITE_POLICY_CI_CHANGED");
	}
	const identity = directoryStamp(await fs.lstat(file, { bigint: true }));
	if (expected !== undefined && identity !== expected) return refuse("FINITE_POLICY_CI_CHANGED");
	return identity;
}
function fileStamp(stat: BigIntStats): string {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.nlink !== 1n ||
		stat.ino === 0n ||
		stat.size < 0n ||
		stat.size > BigInt(POLICY_BYTES)
	)
		return refuse();
	return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(
		":",
	);
}
function own(state: State, handle: fs.FileHandle): FileTicket {
	const ticket: FileTicket = { handle, closing: undefined };
	state.files.add(ticket);
	retained.add(state);
	return ticket;
}
function closeFile(state: State, ticket: FileTicket): Promise<void> {
	if (!ticket.closing) {
		ticket.closing = Promise.resolve()
			.then(() => ticket.handle.close())
			.then(
				() => {
					state.files.delete(ticket);
				},
				() => {
					state.resourceUncertain = true;
					return refuse("FINITE_POLICY_CI_RESOURCE_PENDING");
				},
			);
	}
	return ticket.closing;
}
async function readPolicyFile(
	state: State,
	file: string,
): Promise<{ bytes: Buffer; fact: FileFact }> {
	gate(state);
	await directory(path.dirname(file));
	if (state.evidenceDirectory && path.dirname(file) === state.evidenceDirectory)
		await directory(state.evidenceDirectory, state.evidenceIdentity);
	const initial = await fs.lstat(file, { bigint: true }),
		identity = fileStamp(initial);
	if ((await fs.realpath(file)) !== file) return refuse();
	gate(state);
	const ticket = own(state, await fs.open(file, constants.O_RDONLY | noFollow));
	try {
		if (fileStamp(await ticket.handle.stat({ bigint: true })) !== identity)
			return refuse("FINITE_POLICY_CI_CHANGED");
		const bytes = Buffer.alloc(Number(initial.size));
		let offset = 0;
		while (offset < bytes.length) {
			gate(state);
			const next = await ticket.handle.read(bytes, offset, bytes.length - offset, offset);
			if (next.bytesRead === 0) return refuse("FINITE_POLICY_CI_CHANGED");
			offset += next.bytesRead;
		}
		if (
			(await ticket.handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0 ||
			fileStamp(await ticket.handle.stat({ bigint: true })) !== identity ||
			fileStamp(await fs.lstat(file, { bigint: true })) !== identity ||
			(await fs.realpath(file)) !== file
		)
			return refuse("FINITE_POLICY_CI_CHANGED");
		gate(state);
		return { bytes, fact: Object.freeze({ file, identity, sha256: hash(bytes) }) };
	} finally {
		await closeFile(state, ticket);
	}
}
async function writeConfig(state: State, bytes: Buffer): Promise<FileFact> {
	if (!state.evidenceDirectory || !state.evidenceIdentity) return refuse();
	const file = path.join(state.evidenceDirectory, "finite-deny.toml");
	gate(state);
	await directory(state.evidenceDirectory, state.evidenceIdentity);
	gate(state);
	const ticket = own(
		state,
		await fs.open(
			file,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
			0o600,
		),
	);
	try {
		gate(state);
		await ticket.handle.writeFile(bytes);
		await ticket.handle.sync();
		const identity = fileStamp(await ticket.handle.stat({ bigint: true }));
		await directory(state.evidenceDirectory, state.evidenceIdentity);
		if (
			fileStamp(await fs.lstat(file, { bigint: true })) !== identity ||
			(await fs.realpath(file)) !== file
		)
			return refuse("FINITE_POLICY_CI_CHANGED");
		gate(state);
	} finally {
		await closeFile(state, ticket);
	}
	const captured = await readPolicyFile(state, file);
	if (captured.fact.sha256 !== hash(bytes)) return refuse("FINITE_POLICY_CI_CHANGED");
	return captured.fact;
}
function readers(state: State): void {
	if (!state.evidence) return;
	const current = evidenceReaderStatus(state.evidence);
	if (current.active !== 0 || current.pending !== 0) state.resourceUncertain = true;
	gate(state);
}
async function captured(
	state: State,
	result: NativeCaptureResult,
	stream: "stdout" | "stderr",
): Promise<Uint8Array> {
	gate(state);
	readers(state);
	if (!state.evidence) return refuse();
	try {
		const bytes = await readCapturedBytes(state.evidence, result, stream);
		readers(state);
		return bytes;
	} catch {
		state.resourceUncertain = true;
		return refuse("FINITE_POLICY_CI_RESOURCE_PENDING");
	}
}
async function native(
	state: State,
	id: string,
	executable: string,
	args: readonly string[],
	deadlineMs: number,
): Promise<NativeCaptureResult> {
	gate(state);
	readers(state);
	const evidence = state.evidence;
	if (!evidence) return refuse();
	let result: NativeCaptureResult;
	try {
		result = await captureNativeProcess(evidence, id, {
			executable,
			args,
			cwd: state.options.repositoryRoot,
			env: state.options.environment,
			deadlineMs: Math.min(deadlineMs, HOUR - (Date.now() - state.startedAt)),
		});
	} catch {
		// No sealed completion receipt can prove the state of a possibly dispatched child.
		state.processUnconfirmed = true;
		return refuse("FINITE_POLICY_CI_PROCESS_UNCONFIRMED");
	}
	state.commandExitCode = result.exitCode;
	if (result.failure === "TREE_UNCONFIRMED" || (result.exitCode === null && result.signal === null))
		state.processUnconfirmed = true;
	gate(state);
	if (result.failure !== null || result.signal !== null || result.exitCode === null)
		return refuse();
	return result;
}
async function unchanged(state: State): Promise<void> {
	gate(state);
	readers(state);
	await directory(state.options.repositoryRoot, state.repositoryIdentity);
	await directory(state.options.cargoHome, state.cargoHomeIdentity);
	if (!state.provenance || !state.input) return refuse();
	await state.tools.assertUnchanged(state.provenance);
	gate(state);
	await state.inputs.assertUnchanged(state.input);
	for (const before of [state.policy, state.config]) {
		if (!before) continue;
		const now = await readPolicyFile(state, before.file);
		if (now.fact.identity !== before.identity || now.fact.sha256 !== before.sha256)
			return refuse("FINITE_POLICY_CI_CHANGED");
	}
	readers(state);
}
async function collect(state: State): Promise<number> {
	const selected = state.options;
	gate(state);
	state.repositoryIdentity = await directory(selected.repositoryRoot);
	state.cargoHomeIdentity = await directory(selected.cargoHome);
	const temporary = absolute(os.tmpdir());
	await directory(temporary);
	gate(state);
	state.evidenceDirectory = path.join(temporary, `draftyak-finite-policy-ci-${randomUUID()}`);
	state.evidence = await createEvidenceDirectory({
		checkoutRoot: selected.repositoryRoot,
		directory: state.evidenceDirectory,
	});
	state.evidenceIdentity = await directory(state.evidenceDirectory);
	let version = 0;
	state.provenance = await state.tools.capture(
		selected.repositoryRoot,
		async (file, args) => {
			const result = await native(state, `tool-${version++}`, file, args, 30_000);
			return {
				code: result.exitCode,
				stdout: await captured(state, result, "stdout"),
				stderr: await captured(state, result, "stderr"),
			};
		},
		Object.freeze({ ...selected.environment, DRAFTYAK_CARGO_DENY: selected.deny }),
	);
	const cargo = await state.tools.nativeToolPath(state.provenance, "cargo");
	const deny = await state.tools.nativeToolPath(state.provenance, "cargo-deny");
	if (cargo !== selected.cargo || deny !== selected.deny) return refuse("FINITE_POLICY_CI_CHANGED");
	gate(state);
	state.input = await state.inputs.capture(selected.repositoryRoot, selected.cargoHome);
	gate(state);
	const selectedCargo = await state.tools.nativeToolPath(state.provenance, "cargo");
	if (selectedCargo !== cargo) return refuse("FINITE_POLICY_CI_CHANGED");
	const manifest = path.join(selected.repositoryRoot, "crates/Cargo.toml");
	const metadata = await native(
		state,
		"full-locked-metadata",
		cargo,
		[
			"metadata",
			"--manifest-path",
			manifest,
			"--format-version",
			"1",
			"--locked",
			"--all-features",
		],
		120_000,
	);
	const metadataBytes = await captured(state, metadata, "stdout");
	await captured(state, metadata, "stderr");
	if (metadata.exitCode !== 0) return metadata.exitCode ?? refuse();
	const metadataObject = parseStrictJson(metadataBytes);
	const paths = await state.inputs.bindCargoPaths(state.input, metadataObject);
	gate(state);
	const initialGraph = projectCargoGraph(metadataObject, paths, []);
	const original = await readPolicyFile(
		state,
		path.join(selected.repositoryRoot, "crates/deny.toml"),
	);
	state.policy = original.fact;
	// Reject current54e and any other policy/graph before exclusive temporary config creation.
	const effective = proposedMobileHttpConfig(initialGraph, original.bytes);
	state.config = await writeConfig(state, effective);
	await unchanged(state);
	const selectedDeny = await state.tools.nativeToolPath(state.provenance, "cargo-deny");
	if (selectedDeny !== deny) return refuse("FINITE_POLICY_CI_CHANGED");
	const result = await native(
		state,
		"finite-policy-check",
		deny,
		[
			"--manifest-path",
			manifest,
			"--config",
			state.config.file,
			"--all-features",
			"--locked",
			"--format",
			"json",
			"--color",
			"never",
			"check",
			"--show-stats",
		],
		600_000,
	);
	await captured(state, result, "stdout");
	await captured(state, result, "stderr");
	await unchanged(state);
	return result.exitCode ?? refuse();
}
async function finish(state: State): Promise<FinitePolicyCiResources> {
	let inputs: ReturnType<NativeInputsSource["resourceStatus"]> | null = null;
	let tools: ReturnType<NativeToolProvenanceSource["resourceStatus"]> | null = null;
	let evidence: { readonly active: number; readonly pending: number } | null = null;
	try {
		inputs = state.inputs.resourceStatus();
		tools = state.tools.resourceStatus();
		evidence = state.evidence ? evidenceReaderStatus(state.evidence) : { active: 0, pending: 0 };
		if (
			!inputs.complete ||
			!tools.complete ||
			evidence.active !== 0 ||
			evidence.pending !== 0 ||
			state.files.size !== 0
		)
			state.resourceUncertain = true;
	} catch {
		state.resourceUncertain = true;
	}
	const closes: Promise<unknown>[] = [state.inputs.closeResources(), state.tools.closeResources()];
	if (state.evidence) closes.push(closeEvidenceReaders(state.evidence));
	for (const ticket of state.files) closes.push(closeFile(state, ticket));
	const settled = await Promise.allSettled(closes);
	if (settled.some((value) => value.status !== "fulfilled")) state.resourceUncertain = true;
	try {
		inputs = state.inputs.resourceStatus();
	} catch {
		inputs = null;
		state.resourceUncertain = true;
	}
	try {
		tools = state.tools.resourceStatus();
	} catch {
		tools = null;
		state.resourceUncertain = true;
	}
	try {
		evidence = state.evidence ? evidenceReaderStatus(state.evidence) : { active: 0, pending: 0 };
	} catch {
		evidence = null;
		state.resourceUncertain = true;
	}
	const complete =
		inputs !== null &&
		tools !== null &&
		evidence !== null &&
		inputs.complete &&
		inputs.activeOperations === 0 &&
		inputs.pendingFiles === 0 &&
		tools.complete &&
		tools.activeOperations === 0 &&
		tools.pendingFiles === 0 &&
		evidence.active === 0 &&
		evidence.pending === 0 &&
		state.files.size === 0 &&
		!state.processUnconfirmed &&
		!state.resourceUncertain;
	if (complete) retained.delete(state);
	return Object.freeze({
		ownFiles: state.files.size,
		inputOperations: inputs?.activeOperations ?? null,
		inputFiles: inputs?.pendingFiles ?? null,
		toolOperations: tools?.activeOperations ?? null,
		toolFiles: tools?.pendingFiles ?? null,
		activeReaders: evidence?.active ?? null,
		pendingReaders: evidence?.pending ?? null,
		processUnconfirmed: state.processUnconfirmed,
		resourceUncertain: state.resourceUncertain,
		complete,
		dataRetained: true,
	});
}

/** Fixed CI dependency check, not the seven-source policy command or an allowance constructor. */
export async function runFinitePolicyCi(input: FinitePolicyCiOptions): Promise<number> {
	const selected = options(input),
		startedAt = Date.now();
	const state: State = {
		options: selected,
		inputs: createNativeInputsSource(),
		tools: createNativeToolProvenanceSource(),
		files: new Set(),
		startedAt,
		lastAt: startedAt,
		monotonicStart: performance.now(),
		evidence: undefined,
		evidenceDirectory: undefined,
		evidenceIdentity: undefined,
		input: undefined,
		provenance: undefined,
		policy: undefined,
		config: undefined,
		repositoryIdentity: undefined,
		cargoHomeIdentity: undefined,
		processUnconfirmed: false,
		resourceUncertain: false,
		commandExitCode: null,
	};
	retained.add(state);
	let code: number | undefined, failure: FinitePolicyCiCode | undefined;
	try {
		code = await collect(state);
	} catch (error) {
		failure = error instanceof FinitePolicyCiError ? error.code : "FINITE_POLICY_CI_REFUSED";
	}
	const resources = await finish(state);
	if (!resources.complete || failure || code === undefined) {
		throw new FinitePolicyCiError(
			failure ??
				(state.processUnconfirmed
					? "FINITE_POLICY_CI_PROCESS_UNCONFIRMED"
					: "FINITE_POLICY_CI_RESOURCE_PENDING"),
			state.commandExitCode,
			resources,
		);
	}
	gate(state);
	return code;
}

const ENTRY_CODES: ReadonlySet<string> = new Set([
	"FINITE_POLICY_CI_REFUSED",
	"FINITE_POLICY_CI_CHANGED",
	"FINITE_POLICY_CI_STALE",
	"FINITE_POLICY_CI_RESOURCE_PENDING",
	"FINITE_POLICY_CI_PROCESS_UNCONFIRMED",
]);
const ENTRY_KEYS: readonly string[] = [
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
];
function entryRefuse(): never {
	throw new Error("FINITE_POLICY_CI_ENTRY_REFUSED");
}
function entryRequired(value: string | undefined): string {
	if (!value || !path.isAbsolute(value)) return entryRefuse();
	return value;
}
function entryAlias(first: string | undefined, second: string | undefined): string | undefined {
	if (first !== undefined && second !== undefined && first !== second) return entryRefuse();
	return first ?? second;
}
async function entryMain(): Promise<void> {
	const entry = fileURLToPath(import.meta.url);
	if (
		process.argv.length !== 2 ||
		process.argv[1] === undefined ||
		path.resolve(process.argv[1]) !== entry
	)
		return entryRefuse();
	const environment: Record<string, string> = Object.create(null);
	for (const key of ENTRY_KEYS) {
		const value = process.env[key];
		if (value !== undefined) environment[key] = value;
	}
	const selectedPath = entryAlias(process.env.PATH, process.env.Path);
	if (selectedPath !== undefined) environment.PATH = selectedPath;
	const systemRoot = entryAlias(process.env.SystemRoot, process.env.SYSTEMROOT);
	if (systemRoot !== undefined) environment.SYSTEMROOT = systemRoot;
	const cargo = entryRequired(environment.CARGO),
		cargoHome = entryRequired(environment.CARGO_HOME),
		deny = entryRequired(process.env.DRAFTYAK_CARGO_DENY),
		databaseRoot = entryRequired(process.env.DRAFTYAK_NATIVE_POLICY_DATABASE_ROOT);
	const result = await runNativePolicy({
		phase: "item",
		authority: new RepositoryAuthority(),
		producer: createProductionProducer({
			repositoryRoot: path.resolve(path.dirname(entry), "../../.."),
			databaseRoot,
			cargoHome,
			expectedCargo: cargo,
			expectedDeny: deny,
			environment: Object.freeze(environment),
		}),
	});
	// The runner has already finalized collection and checked current authority and time.
	const encoded = JSON.stringify(result.output);
	if (Buffer.byteLength(encoded) > 65_536) return entryRefuse();
	process.stdout.write(encoded + "\n");
	process.exitCode = result.exitCode;
}
function entryFailed(error: unknown): void {
	// A refusal is nonzero even when the last actual command happened to return zero.
	process.exitCode = 1;
	const known = error instanceof FinitePolicyCiError && ENTRY_CODES.has(error.code);
	const resources = known ? error.resources : null;
	console.error(
		JSON.stringify({
			code: known ? error.code : "FINITE_POLICY_CI_ENTRY_REFUSED",
			refused: true,
			resourcesKnown: resources !== null,
			resourcesComplete: resources?.complete === true,
			processUnconfirmed: resources?.processUnconfirmed === true,
			resourceUncertain: resources === null || resources.resourceUncertain,
		}),
	);
}

// Importing this module never dispatches the bridge. The actual entry has no flags or operands.
if (import.meta.main) void entryMain().catch(entryFailed);
