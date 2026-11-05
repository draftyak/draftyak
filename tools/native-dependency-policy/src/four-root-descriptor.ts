import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import {
	type AffectedPackage,
	type CargoGraphProjection,
	type ProjectionTuple,
	projectCargoGraph,
	type ValidatedCargoPaths,
} from "./cargo-graph.ts";
import {
	closeEvidenceReaders,
	createEvidenceDirectory,
	type EvidenceDirectory,
	evidenceReaderStatus,
	readCapturedBytes,
} from "./evidence.ts";
import {
	createNativeInputsSource,
	type NativeInputsSnapshot,
	type NativeInputsSource,
} from "./inputs.ts";
import { captureNativeProcess, type NativeCaptureResult } from "./native-capture.ts";
import { parseStrictJson } from "./strict-json.ts";
import {
	createNativeToolProvenanceSource,
	type NativeToolFact,
	type NativeToolName,
	type NativeToolProvenance,
	type NativeToolProvenanceSource,
} from "./tool-provenance.ts";

const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const GRAPH = "a4662c495976436a169207f85fe6ecd21aea53adbcb6d7e8ecb8349a18d446ce";
const LOCK = "f8a940be9d97416d8e07af0ce7acbe8d35f45177176de227cf0a64c5aa8cb6bf";
const POLICY = "3dfd2b249ce43734a7ec281e10d1353a3bb9ce68a7684fa36639ea98f64791d0";
const MEMBERS = [
	["apps/app/src-tauri/Cargo.toml", "draftyak-desktop"],
	["crates/draftyak-desktop-pairing/Cargo.toml", "draftyak-desktop-pairing"],
	["crates/draftyak-protocol/Cargo.toml", "draftyak-protocol"],
	["crates/draftyak-transport/Cargo.toml", "draftyak-transport"],
] as const;
const TARGETS = [
	["glib", "0.18.5", "RUSTSEC-2024-0429", "D102"],
	["proc-macro-error", "1.0.4", "RUSTSEC-2024-0370", "D102"],
	["zvariant", "5.15.1", "RUSTSEC-2026-0370", "D130"],
	["zbus_names", "4.3.5", "RUSTSEC-2026-0371", "D130"],
	["zvariant_derive", "5.15.1", "RUSTSEC-2026-0372", "D130"],
] as const;
const SYN = ["1.0.109", "2.0.119", "3.0.9"] as const;
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
const HOUR = 3_600_000;
const CLOSE_MS = 15_000;
const FILE_LIMIT = 8 * 1024 * 1024;
const MAX_ROWS = 20_000;
const compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));
const encoded = (value: unknown): string => {
	const result = JSON.stringify(value);
	if (typeof result !== "string") return refuse();
	return result;
};
const hash = (value: Uint8Array | string): string =>
	createHash("sha256").update(value).digest("hex");

export type FourRootDescriptorCode =
	| "FOUR_ROOT_INVALID"
	| "FOUR_ROOT_CHANGED"
	| "FOUR_ROOT_INCOMPLETE"
	| "FOUR_ROOT_RESOURCES"
	| "FOUR_ROOT_STALE";
export class FourRootDescriptorError extends Error {
	readonly code: FourRootDescriptorCode;
	constructor(code: FourRootDescriptorCode = "FOUR_ROOT_INVALID") {
		super("four-root descriptor refused");
		this.name = "FourRootDescriptorError";
		this.code = code;
	}
}
export interface FourRootDescriptorOptions {
	readonly repositoryRoot: string;
	readonly cargoHome: string;
	readonly evidenceDirectory: string;
	readonly environment: Readonly<Record<string, string>>;
}
export interface FourRootCaptureData {
	readonly id: string;
	readonly tool: NativeToolName;
	readonly argv: readonly string[];
	readonly cwd: ".";
	readonly invocationDigest: string;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly exitCode: 0;
	readonly signal: null;
	readonly failure: null;
	readonly stdout: Readonly<{ bytes: number; sha256: string }>;
	readonly stderr: Readonly<{ bytes: number; sha256: string }>;
}
interface RegistryPackage extends AffectedPackage {
	readonly checksum: string;
}
/** Fixed declared-target observations, not findings from a current advisory audit. */
export interface FourRootAdvisoryData {
	readonly id: string;
	readonly family: "D102" | "D130";
	readonly package: RegistryPackage;
	readonly ancestor: CargoGraphProjection["ancestorDigests"][number];
	readonly routes: readonly string[];
}
export interface FourRootSynParent extends RegistryPackage {
	readonly selectionCaptureId: "metadata";
	/** Features are the captured all-feature union, not runtime activation. */
	readonly resolvedFeatures: readonly string[];
	readonly declaredSynDependencies: readonly ProjectionTuple[];
	readonly resolvedEdges: readonly ProjectionTuple[];
}
export interface FourRootSynData {
	readonly version: string;
	readonly source: string;
	readonly checksum: string;
	readonly directParents: readonly FourRootSynParent[];
}
export interface FourRootDescriptorData {
	readonly kind: "FOUR_ROOT_DESCRIPTOR_DATA";
	readonly authority: false;
	readonly reusableNativeSourceBasis: false;
	readonly runId: string;
	readonly startedAt: number;
	readonly completedAt: number;
	readonly observedAt: number;
	readonly inputDigest: string;
	readonly lockDigest: string;
	readonly policySha256: string;
	readonly toolsDigest: string;
	readonly tools: readonly NativeToolFact[];
	readonly environmentDigest: string;
	readonly selection: Readonly<{
		command: "cargo metadata";
		formatVersion: 1;
		allFeatures: true;
		locked: true;
		offline: true;
		noDeps: false;
		filterPlatform: null;
		defaultFeatureSelection: "cargo-defaults";
		targetActivity: "UNKNOWN";
		cfgActivity: "UNKNOWN";
	}>;
	readonly graph: CargoGraphProjection;
	readonly advisories: readonly FourRootAdvisoryData[];
	readonly syn: readonly FourRootSynData[];
	readonly captures: readonly FourRootCaptureData[];
	readonly observationDigest: string;
}
declare const observationBrand: unique symbol;
export interface FourRootDescriptorObservation {
	readonly [observationBrand]: true;
}
export interface FourRootDescriptorResources {
	readonly activeOperations: number;
	readonly activeCaptures: number;
	readonly pendingFiles: number;
	readonly activeInputOperations: number;
	readonly pendingInputFiles: number;
	readonly activeToolOperations: number;
	readonly pendingToolFiles: number;
	readonly activeReaders: number;
	readonly pendingReaders: number;
	readonly processUnconfirmed: boolean;
	readonly cleanupUnconfirmed: boolean;
	readonly complete: boolean;
	readonly dataRetained: true;
}
export interface FourRootDescriptorSource {
	observe(): Promise<FourRootDescriptorObservation>;
	data(observation: FourRootDescriptorObservation): FourRootDescriptorData;
	revalidate(observation: FourRootDescriptorObservation): Promise<void>;
	resourceStatus(): FourRootDescriptorResources;
	closeResources(): Promise<FourRootDescriptorResources>;
}
interface HeldFile {
	readonly file: fs.FileHandle;
	closing: Promise<void> | undefined;
}
interface FileFact {
	readonly relative: string;
	readonly identity: string;
	readonly sha256: string;
}
interface CaptureAttempt {
	readonly id: string;
	promise: Promise<NativeCaptureResult> | undefined;
	result: NativeCaptureResult | undefined;
	settled: boolean;
	confirmed: boolean;
	data: FourRootCaptureData | undefined;
}
interface State {
	readonly options: FourRootDescriptorOptions;
	readonly files: Set<HeldFile>;
	readonly facts: Map<string, FileFact>;
	readonly attempts: CaptureAttempt[];
	readonly operations: Set<Promise<unknown>>;
	inputsSource: NativeInputsSource | undefined;
	toolSource: NativeToolProvenanceSource | undefined;
	inputs: NativeInputsSnapshot | undefined;
	tools: NativeToolProvenance | undefined;
	evidence: EvidenceDirectory | undefined;
	data: FourRootDescriptorData | undefined;
	started: boolean;
	stopping: boolean;
	failed: boolean;
	cleanupUnconfirmed: boolean;
	closing: Promise<void> | undefined;
}
const retained = new Set<State>();
const observations = new WeakMap<FourRootDescriptorObservation, State>();
const refuse = (code: FourRootDescriptorCode = "FOUR_ROOT_INVALID"): never => {
	throw new FourRootDescriptorError(code);
};
function record(value: unknown): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		types.isProxy(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
		Object.getOwnPropertySymbols(value).length
	)
		return refuse();
	const out: Record<string, unknown> = Object.create(null);
	for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
		if (!("value" in descriptor)) return refuse();
		out[key] = descriptor.value;
	}
	return out;
}
function text(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 8192 ||
		!value.isWellFormed() ||
		Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
	)
		return refuse();
	return value;
}
function absolute(value: unknown): string {
	const full = text(value);
	if (
		!path.isAbsolute(full) ||
		full.startsWith("\\\\") ||
		full.startsWith("//") ||
		full
			.split(/[\\/]/)
			.some(
				(part) =>
					part === "." || part === ".." || (process.platform === "win32" && /[. ]$/.test(part)),
			)
	)
		return refuse();
	return path.resolve(full);
}
function inside(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function options(value: FourRootDescriptorOptions): FourRootDescriptorOptions {
	const input = record(value);
	if (
		Object.keys(input).sort().join(" ") !== "cargoHome environment evidenceDirectory repositoryRoot"
	)
		return refuse();
	const repositoryRoot = absolute(input.repositoryRoot),
		cargoHome = absolute(input.cargoHome),
		evidenceDirectory = absolute(input.evidenceDirectory);
	if (
		inside(repositoryRoot, evidenceDirectory) ||
		inside(cargoHome, evidenceDirectory) ||
		inside(evidenceDirectory, repositoryRoot) ||
		inside(evidenceDirectory, cargoHome)
	)
		return refuse();
	const selected = record(input.environment),
		environment: Record<string, string> = Object.create(null);
	let bytes = 0;
	for (const key of Object.keys(selected).sort(compare)) {
		const entry = text(selected[key]);
		if (
			!ENVIRONMENT.has(key) ||
			Object.keys(environment).some((prior) => prior.toUpperCase() === key.toUpperCase())
		)
			return refuse();
		bytes += Buffer.byteLength(key) + Buffer.byteLength(entry);
		if (bytes > 32_768) return refuse();
		environment[key] = entry;
	}
	if (
		environment.CARGO_HOME !== cargoHome ||
		environment.CARGO_NET_OFFLINE !== "true" ||
		environment.CARGO_TERM_COLOR !== "never" ||
		environment.NO_COLOR !== "1" ||
		environment.RUSTUP_TOOLCHAIN !== "1.95.0" ||
		!environment.PATH
	)
		return refuse();
	if (environment.PATH.split(path.delimiter).some((entry) => absolute(entry) !== entry))
		return refuse();
	if (environment.CARGO !== undefined) absolute(environment.CARGO);
	return Object.freeze({
		repositoryRoot,
		cargoHome,
		evidenceDirectory,
		environment: Object.freeze(environment),
	});
}
function freeze<T>(value: T): T {
	if (value !== null && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}
function openState(state: State): void {
	if (state.stopping || state.failed) refuse("FOUR_ROOT_RESOURCES");
}
function clock(state: State): number {
	const now = Date.now();
	if (!Number.isSafeInteger(now) || now < 0) {
		state.failed = true;
		return refuse("FOUR_ROOT_STALE");
	}
	return now;
}
function age(state: State): void {
	if (!state.data) return;
	const now = clock(state);
	if (now < state.data.observedAt || now - state.data.observedAt >= HOUR) {
		state.failed = true;
		refuse("FOUR_ROOT_STALE");
	}
}
function owned<T>(state: State, work: () => Promise<T>): Promise<T> {
	try {
		openState(state);
	} catch (error) {
		return Promise.reject(error);
	}
	if (state.operations.size)
		return Promise.reject(new FourRootDescriptorError("FOUR_ROOT_RESOURCES"));
	retained.add(state);
	const operation = Promise.resolve()
		.then(work)
		.catch((error) => {
			state.failed = true;
			throw error instanceof FourRootDescriptorError
				? error
				: new FourRootDescriptorError("FOUR_ROOT_INCOMPLETE");
		});
	state.operations.add(operation);
	void operation.finally(() => state.operations.delete(operation)).catch(() => undefined);
	return operation;
}
function identity(stat: BigIntStats): string {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.ino === 0n ||
		stat.nlink !== 1n ||
		stat.size > BigInt(FILE_LIMIT)
	)
		return refuse();
	return encoded([
		String(stat.dev),
		String(stat.ino),
		String(stat.size),
		String(stat.mtimeNs),
		String(stat.ctimeNs),
		String(stat.mode),
	]);
}
async function directory(full: string): Promise<void> {
	let current = path.parse(full).root;
	for (const part of path.relative(current, full).split(path.sep).filter(Boolean)) {
		const names = await fs.readdir(current);
		if (names.filter((name) => name.toLowerCase() === part.toLowerCase()).join("\0") !== part)
			return refuse();
		current = path.join(current, part);
		const stat = await fs.lstat(current);
		if (!stat.isDirectory() || stat.isSymbolicLink() || (await fs.realpath(current)) !== current)
			return refuse();
	}
}
function closeFile(state: State, held: HeldFile): Promise<void> {
	if (held.closing) return held.closing;
	if (!state.files.has(held)) return Promise.resolve();
	const closing = Promise.resolve()
		.then(() => held.file.close())
		.then(() => {
			state.files.delete(held);
		});
	held.closing = closing;
	void closing
		.finally(() => {
			if (held.closing === closing) held.closing = undefined;
		})
		.catch(() => undefined);
	return closing;
}
async function fileBytes(state: State, relative: string, expected: string): Promise<Buffer> {
	openState(state);
	const filename = path.join(state.options.repositoryRoot, relative);
	await directory(path.dirname(filename));
	const initial = identity(await fs.lstat(filename, { bigint: true }));
	openState(state);
	const held: HeldFile = {
		file: await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)),
		closing: undefined,
	};
	state.files.add(held);
	try {
		openState(state);
		if (identity(await held.file.stat({ bigint: true })) !== initial)
			return refuse("FOUR_ROOT_CHANGED");
		const chunks: Buffer[] = [];
		let size = 0;
		for (;;) {
			const chunk = Buffer.alloc(Math.min(65_536, FILE_LIMIT + 1 - size));
			const read = await held.file.read(chunk, 0, chunk.length, size);
			if (!read.bytesRead) break;
			size += read.bytesRead;
			if (size > FILE_LIMIT) return refuse();
			chunks.push(chunk.subarray(0, read.bytesRead));
		}
		const bytes = Buffer.concat(chunks),
			sha256 = hash(bytes);
		if (
			sha256 !== expected ||
			identity(await held.file.stat({ bigint: true })) !== initial ||
			identity(await fs.lstat(filename, { bigint: true })) !== initial
		)
			return refuse("FOUR_ROOT_CHANGED");
		await directory(path.dirname(filename));
		const previous = state.facts.get(relative);
		if (previous && (previous.identity !== initial || previous.sha256 !== sha256))
			return refuse("FOUR_ROOT_CHANGED");
		state.facts.set(relative, { relative, identity: initial, sha256 });
		return bytes;
	} finally {
		await closeFile(state, held);
	}
}
async function bytes(
	state: State,
	attempt: CaptureAttempt,
	stream: "stdout" | "stderr",
): Promise<Uint8Array> {
	openState(state);
	if (!state.evidence || !attempt.result) return refuse("FOUR_ROOT_INCOMPLETE");
	const result = await readCapturedBytes(state.evidence, attempt.result, stream);
	openState(state);
	return result;
}
async function native(
	state: State,
	id: string,
	tool: NativeToolName,
	executable: string,
	argv: readonly string[],
	normalized: readonly string[],
	deadlineMs: number,
): Promise<{ result: NativeCaptureResult; stdout: Uint8Array; stderr: Uint8Array }> {
	openState(state);
	if (!state.evidence || state.attempts.some((value) => value.id === id)) return refuse();
	const startedAt = clock(state);
	const attempt: CaptureAttempt = {
		id,
		promise: undefined,
		result: undefined,
		settled: false,
		confirmed: false,
		data: undefined,
	};
	state.attempts.push(attempt);
	try {
		attempt.promise = captureNativeProcess(state.evidence, id, {
			executable,
			args: argv,
			cwd: state.options.repositoryRoot,
			env: state.options.environment,
			deadlineMs,
		});
		attempt.result = await attempt.promise;
		const result = attempt.result;
		if (result.failure !== null || result.signal !== null || result.exitCode !== 0)
			return refuse("FOUR_ROOT_INCOMPLETE");
		const stdout = await bytes(state, attempt, "stdout"),
			stderr = await bytes(state, attempt, "stderr");
		attempt.confirmed = true;
		const completedAt = clock(state);
		if (completedAt < startedAt || completedAt - startedAt >= HOUR)
			return refuse("FOUR_ROOT_STALE");
		const captureData: FourRootCaptureData = {
			id,
			tool,
			argv: [...normalized],
			cwd: ".",
			invocationDigest: hash(encoded([executable, argv, state.options.repositoryRoot])),
			startedAt,
			completedAt,
			exitCode: 0,
			signal: null,
			failure: null,
			stdout: { bytes: result.stdout.bytes, sha256: result.stdout.sha256 },
			stderr: { bytes: result.stderr.bytes, sha256: result.stderr.sha256 },
		};
		attempt.data = freeze(captureData);
		return { result, stdout, stderr };
	} catch (error) {
		throw error instanceof FourRootDescriptorError
			? error
			: new FourRootDescriptorError("FOUR_ROOT_INCOMPLETE");
	} finally {
		attempt.settled = true;
	}
}
function checksumRows(bytes: Uint8Array): Map<string, string | null> {
	const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	const rows = new Map<string, string | null>();
	for (const block of source.split(/^\[\[package\]\]\r?$/m).slice(1)) {
		const field = (name: string, optional = false): string | null => {
			const values = [...block.matchAll(new RegExp(`^${name} = "([^"\\r\\n]+)"\\r?$`, "gm"))];
			if (optional && values.length === 0) return null;
			if (values.length !== 1) return refuse("FOUR_ROOT_INCOMPLETE");
			return text(values[0]?.[1]);
		};
		const name = field("name"),
			version = field("version"),
			registry = field("source", true),
			checksum = field("checksum", true);
		if (
			registry !== null &&
			(registry !== REGISTRY || !checksum || !/^[a-f0-9]{64}$/.test(checksum))
		)
			return refuse();
		if (registry === null && checksum !== null) return refuse();
		const key = encoded([registry, name, version]);
		if (rows.has(key)) return refuse();
		rows.set(key, checksum);
	}
	if (rows.size !== 553) return refuse("FOUR_ROOT_INCOMPLETE");
	return rows;
}
function list(value: unknown): ProjectionTuple {
	if (!Array.isArray(value) || value.length > MAX_ROWS) return refuse("FOUR_ROOT_INCOMPLETE");
	return value as ProjectionTuple;
}
function graphFacts(
	graph: CargoGraphProjection,
	checksums: Map<string, string | null>,
): { advisories: FourRootAdvisoryData[]; syn: FourRootSynData[] } {
	const payload = graph.tuplePayload;
	if (
		graph.version !== 1 ||
		graph.packageCount !== 553 ||
		graph.digest !== GRAPH ||
		hash(`draftyak/native-dependency-policy/graph/v1\0${encoded(payload)}`) !== GRAPH ||
		payload[0] !== "graph" ||
		payload[1] !== 1
	)
		return refuse("FOUR_ROOT_INCOMPLETE");
	const rows = list(payload[3]).map(list),
		edges = list(payload[4]).map(list),
		roots = list(list(payload[2])[2]).map(list);
	if (rows.length !== 553 || roots.length !== 4 || graph.ancestorDigests.length !== 5)
		return refuse();
	const byKey = new Map<string, ProjectionTuple>(),
		forward = new Map<string, Set<string>>();
	for (const row of rows) {
		const identity = list(row[0]),
			key = encoded(identity);
		if (byKey.has(key) || !checksums.has(encoded(identity.slice(0, 3)))) return refuse();
		byKey.set(key, row);
		forward.set(key, new Set());
	}
	if (
		encoded(
			roots.map((key) => [key[3], key[1]]).sort((a, b) => compare(encoded(a), encoded(b))),
		) !== encoded(MEMBERS)
	)
		return refuse();
	for (const edge of edges) {
		const from = encoded(edge[0]),
			to = encoded(edge[1]);
		if (!byKey.has(from) || !byKey.has(to)) return refuse();
		forward.get(from)?.add(to);
	}
	const registryPackage = (key: ProjectionTuple): RegistryPackage => {
		const [source, name, version] = key,
			checksum = checksums.get(encoded([source, name, version]));
		if (source !== REGISTRY || typeof name !== "string" || typeof version !== "string" || !checksum)
			return refuse();
		return { source, name, version, checksum };
	};
	const find = (name: string, version: string): ProjectionTuple => {
		const matches = rows
			.map((row) => list(row[0]))
			.filter((key) => key[0] === REGISTRY && key[1] === name && key[2] === version);
		if (matches.length !== 1 || !matches[0]) return refuse();
		return matches[0];
	};
	const paths = (target: ProjectionTuple): string[] => {
		const wanted = encoded(target),
			result = new Set<string>();
		let visits = 0;
		const walk = (key: string, trail: string[]): void => {
			if (++visits > 200_000 || trail.length > 128) refuse("FOUR_ROOT_INCOMPLETE");
			if (key === wanted) {
				result.add(
					[...trail, key]
						.map((value) => {
							const row = byKey.get(value);
							if (!row) return refuse();
							const id = list(row[0]);
							return `${id[1]} ${id[2]}`;
						})
						.join(" > "),
				);
				if (result.size > 4096) refuse();
				return;
			}
			for (const next of forward.get(key) ?? [])
				if (!trail.includes(next) && next !== key) walk(next, [...trail, key]);
		};
		// Restrict traversal to the target's real ancestor closure without changing its edges.
		const reaching = new Set<string>([wanted]);
		for (;;) {
			const before = reaching.size;
			for (const edge of edges) if (reaching.has(encoded(edge[1]))) reaching.add(encoded(edge[0]));
			if (before === reaching.size) break;
		}
		const saved = new Map(forward);
		for (const [key, values] of forward)
			forward.set(key, new Set([...values].filter((value) => reaching.has(value))));
		for (const root of roots) {
			const key = encoded(root);
			if (reaching.has(key)) walk(key, []);
		}
		for (const [key, values] of saved) forward.set(key, values);
		return [...result].sort(compare);
	};
	const seenAncestors = new Set<string>();
	const advisories = TARGETS.map(([name, version, id, family]): FourRootAdvisoryData => {
		const key = find(name, version),
			ancestor = graph.ancestorDigests.find(
				(value) =>
					value.target.source === REGISTRY &&
					value.target.name === name &&
					value.target.version === version,
			);
		if (
			!ancestor ||
			seenAncestors.has(encoded(ancestor.target)) ||
			hash(`draftyak/native-dependency-policy/ancestor/v1\0${encoded(ancestor.tuplePayload)}`) !==
				ancestor.digest ||
			ancestor.packageCount !== list(ancestor.tuplePayload[4]).length ||
			encoded(ancestor.tuplePayload[2]) !== encoded(key)
		)
			return refuse();
		seenAncestors.add(encoded(ancestor.target));
		const routes = paths(key);
		if (
			!routes.length ||
			(family === "D102" && !routes.some((route) => route.startsWith("draftyak-desktop ")))
		)
			return refuse("FOUR_ROOT_INCOMPLETE");
		return { id, family, package: registryPackage(key), ancestor, routes };
	});
	const actualSyn = rows
		.map((row) => list(row[0]))
		.filter((key) => key[1] === "syn")
		.map((key) => text(key[2]))
		.sort(compare);
	if (encoded(actualSyn) !== encoded(SYN)) return refuse();
	const syn = SYN.map((version) => {
		const key = find("syn", version),
			matching = edges.filter((edge) => encoded(edge[1]) === encoded(key)),
			parentKeys = [...new Set(matching.map((edge) => encoded(edge[0])))].sort(compare);
		if (!parentKeys.length) return refuse();
		const directParents = parentKeys.map((parent) => {
			const row = byKey.get(parent);
			if (!row) return refuse();
			const resolvedEdges = matching.filter((edge) => encoded(edge[0]) === parent);
			const declarations = list(row[4])
				.map(list)
				.filter((dependency) => dependency[0] === "syn" && dependency[1] === REGISTRY);
			const joined = new Map<string, ProjectionTuple>();
			for (const edge of resolvedEdges) {
				const alias = text(edge[2]).replaceAll("-", "_");
				for (const kind of list(edge[3]).map(list)) {
					const matches = declarations.filter(
						(dependency) =>
							text(dependency[4] ?? dependency[0]).replaceAll("-", "_") === alias &&
							dependency[3] === kind[0] &&
							dependency[8] === kind[1],
					);
					if (matches.length !== 1 || !matches[0]) return refuse("FOUR_ROOT_INCOMPLETE");
					joined.set(encoded(matches[0]), matches[0]);
				}
			}
			const declaredSynDependencies = [...joined.entries()]
				.sort(([a], [b]) => compare(a, b))
				.map(([, value]) => value);
			return {
				...registryPackage(list(row[0])),
				selectionCaptureId: "metadata" as const,
				resolvedFeatures: list(row[1]).map(text),
				declaredSynDependencies,
				resolvedEdges,
			};
		});
		if (directParents.some((parent) => !parent.declaredSynDependencies.length)) return refuse();
		return { version, source: REGISTRY, checksum: registryPackage(key).checksum, directParents };
	});
	return { advisories, syn };
}
async function unchanged(state: State): Promise<void> {
	openState(state);
	age(state);
	if (!state.inputs || !state.tools || !state.inputsSource || !state.toolSource) return refuse();
	await state.inputsSource.assertUnchanged(state.inputs);
	openState(state);
	await state.toolSource.assertUnchanged(state.tools);
	openState(state);
	await fileBytes(state, "crates/Cargo.lock", LOCK);
	await fileBytes(state, "crates/deny.toml", POLICY);
	for (const attempt of state.attempts) {
		await bytes(state, attempt, "stdout");
		await bytes(state, attempt, "stderr");
	}
	openState(state);
	age(state);
}
function resources(state: State): FourRootDescriptorResources {
	const inputs = state.inputsSource?.resourceStatus(),
		tools = state.toolSource?.resourceStatus(),
		readers = state.evidence ? evidenceReaderStatus(state.evidence) : { active: 0, pending: 0 };
	const result = {
		activeOperations: state.operations.size,
		activeCaptures: state.attempts.filter((attempt) => !attempt.settled).length,
		pendingFiles: state.files.size,
		activeInputOperations: inputs?.activeOperations ?? 0,
		pendingInputFiles: inputs?.pendingFiles ?? 0,
		activeToolOperations: tools?.activeOperations ?? 0,
		pendingToolFiles: tools?.pendingFiles ?? 0,
		activeReaders: readers.active,
		pendingReaders: readers.pending,
		processUnconfirmed: state.attempts.some((attempt) => !attempt.confirmed),
		cleanupUnconfirmed: state.cleanupUnconfirmed,
	};
	return Object.freeze({
		...result,
		complete: Object.values(result).every((value) => value === 0 || value === false),
		dataRetained: true,
	});
}
async function collect(state: State): Promise<FourRootDescriptorObservation> {
	if (state.started) return refuse();
	state.started = true;
	const startedAt = clock(state);
	state.inputsSource = createNativeInputsSource();
	state.toolSource = createNativeToolProvenanceSource();
	state.evidence = await createEvidenceDirectory({
		checkoutRoot: state.options.repositoryRoot,
		directory: state.options.evidenceDirectory,
	});
	openState(state);
	state.inputs = await state.inputsSource.capture(
		state.options.repositoryRoot,
		state.options.cargoHome,
	);
	if (state.inputs.lockDigest !== LOCK) return refuse("FOUR_ROOT_CHANGED");
	openState(state);
	let probe = 0;
	const names: readonly NativeToolName[] = ["cargo", "rustc", "cargo-deny"];
	state.tools = await state.toolSource.capture(
		state.options.repositoryRoot,
		async (file, args) => {
			const tool = names[probe++],
				expected = tool === "cargo-deny" ? ["--version"] : ["--version", "--verbose"];
			if (!tool || encoded(args) !== encoded(expected)) return refuse();
			const captured = await native(
				state,
				tool === "cargo-deny" ? "tool-deny" : `tool-${tool}`,
				tool,
				file,
				args,
				args,
				15_000,
			);
			return { code: captured.result.exitCode, stdout: captured.stdout, stderr: captured.stderr };
		},
		state.options.environment,
	);
	if (probe !== 3) return refuse("FOUR_ROOT_INCOMPLETE");
	openState(state);
	const cargo = await state.toolSource.nativeToolPath(state.tools, "cargo");
	if (state.options.environment.CARGO !== undefined && state.options.environment.CARGO !== cargo)
		return refuse("FOUR_ROOT_CHANGED");
	const argv = [
		"metadata",
		"--manifest-path",
		"crates/Cargo.toml",
		"--format-version",
		"1",
		"--locked",
		"--offline",
		"--all-features",
	];
	const captured = await native(state, "metadata", "cargo", cargo, argv, argv, 120_000);
	const metadata = parseStrictJson(captured.stdout),
		paths: ValidatedCargoPaths = await state.inputsSource.bindCargoPaths(state.inputs, metadata);
	if (
		paths.rootIds.length !== 4 ||
		encoded(paths.workspacePackages.map((value) => value.manifestPath).sort(compare)) !==
			encoded(MEMBERS.map((value) => value[0]).sort(compare))
	)
		return refuse("FOUR_ROOT_INCOMPLETE");
	const lock = await fileBytes(state, "crates/Cargo.lock", LOCK);
	await fileBytes(state, "crates/deny.toml", POLICY);
	const graph = projectCargoGraph(
		metadata,
		paths,
		TARGETS.map(([name, version]) => ({ source: REGISTRY, name, version })),
	);
	const facts = graphFacts(graph, checksumRows(lock));
	await unchanged(state);
	const completedAt = clock(state);
	if (
		completedAt < startedAt ||
		completedAt - startedAt >= HOUR ||
		state.files.size ||
		state.attempts.some((value) => !value.confirmed) ||
		!state.inputsSource.resourceStatus().complete ||
		!state.toolSource.resourceStatus().complete ||
		evidenceReaderStatus(state.evidence).active ||
		evidenceReaderStatus(state.evidence).pending
	)
		return refuse("FOUR_ROOT_RESOURCES");
	const data = {
		kind: "FOUR_ROOT_DESCRIPTOR_DATA" as const,
		authority: false as const,
		reusableNativeSourceBasis: false as const,
		runId: state.evidence.runId,
		startedAt,
		completedAt,
		observedAt: startedAt,
		inputDigest: state.inputs.inputDigest,
		lockDigest: state.inputs.lockDigest,
		policySha256: POLICY,
		toolsDigest: state.tools.digest,
		tools: state.tools.tools,
		environmentDigest: hash(encoded(state.options.environment)),
		selection: {
			command: "cargo metadata" as const,
			formatVersion: 1 as const,
			allFeatures: true as const,
			locked: true as const,
			offline: true as const,
			noDeps: false as const,
			filterPlatform: null,
			defaultFeatureSelection: "cargo-defaults" as const,
			targetActivity: "UNKNOWN" as const,
			cfgActivity: "UNKNOWN" as const,
		},
		graph,
		...facts,
		captures: state.attempts.map((value) => {
			if (!value.data) return refuse();
			return value.data;
		}),
	};
	state.data = freeze({
		...data,
		observationDigest: hash(`draftyak/four-root-descriptor/data/v1\0${encoded(data)}`),
	});
	const observation = Object.freeze(Object.create(null)) as FourRootDescriptorObservation;
	observations.set(observation, state);
	return observation;
}
function observation(state: State, token: FourRootDescriptorObservation): FourRootDescriptorData {
	openState(state);
	age(state);
	if (observations.get(token) !== state || !state.data) return refuse();
	return state.data;
}
async function close(state: State): Promise<FourRootDescriptorResources> {
	state.stopping = true;
	if (!state.closing) {
		const closing = Promise.resolve().then(async () => {
			await Promise.allSettled([...state.operations]);
			const closers: Array<() => Promise<unknown>> = [
				...[...state.files].map((file) => () => closeFile(state, file)),
			];
			const inputs = state.inputsSource,
				tools = state.toolSource,
				evidence = state.evidence;
			if (inputs) closers.push(() => inputs.closeResources());
			if (tools) closers.push(() => tools.closeResources());
			if (evidence) closers.push(() => closeEvidenceReaders(evidence));
			const outcomes = await Promise.allSettled(
				closers.map((closer) => Promise.resolve().then(closer)),
			);
			if (outcomes.some((result) => result.status === "rejected")) state.cleanupUnconfirmed = true;
		});
		state.closing = closing;
		void closing
			.finally(() => {
				if (state.closing === closing) state.closing = undefined;
			})
			.catch(() => {
				state.cleanupUnconfirmed = true;
			});
	}
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			state.closing,
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					state.cleanupUnconfirmed = true;
					resolve();
				}, CLOSE_MS);
			}),
		]);
	} catch {
		state.cleanupUnconfirmed = true;
	} finally {
		if (timer) clearTimeout(timer);
	}
	const status = resources(state);
	if (status.complete) retained.delete(state);
	else retained.add(state);
	return status;
}

/** Collects fixed technical union DATA; no selection, permission or review is accepted from callers. */
export function createFourRootDescriptorSource(
	input: FourRootDescriptorOptions,
): FourRootDescriptorSource {
	const state: State = {
		options: options(input),
		files: new Set(),
		facts: new Map(),
		attempts: [],
		operations: new Set(),
		inputsSource: undefined,
		toolSource: undefined,
		inputs: undefined,
		tools: undefined,
		evidence: undefined,
		data: undefined,
		started: false,
		stopping: false,
		failed: false,
		cleanupUnconfirmed: false,
		closing: undefined,
	};
	return Object.freeze({
		observe: () => owned(state, () => collect(state)),
		data: (token: FourRootDescriptorObservation) => {
			if (state.operations.size) return refuse("FOUR_ROOT_RESOURCES");
			return observation(state, token);
		},
		revalidate: (token: FourRootDescriptorObservation) =>
			owned(state, async () => {
				observation(state, token);
				await unchanged(state);
				observation(state, token);
			}),
		resourceStatus: () => resources(state),
		closeResources: () => close(state),
	});
}
