import { createHash } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AffectedPackage,
	CargoGraphProjection,
	CargoPackagePaths,
	ProjectionTuple,
	ValidatedCargoPaths,
} from "../src/cargo-graph.ts";
import type { CaptureFailure, EvidenceDirectory, NativeCaptureResult } from "../src/evidence.ts";
import type { NativeInputsSnapshot } from "../src/inputs.ts";
import type { NativeCommand } from "../src/native-capture.ts";
import type {
	NativeToolName,
	NativeToolProvenance,
	NativeVersionProbe,
} from "../src/tool-provenance.ts";

// Synthetic orchestration controls only. No process is launched, and no fixture
// represents an admitted observation, current audit, review, or native basis.
// Evidence sealing/readers and the explicit original-input identity test use
// their real existing public APIs and actual owned temporary files.
const control = vi.hoisted(() => ({
	root: "",
	parent: "",
	repo: "",
	home: "",
	tools: "",
	evidence: "",
	graph: undefined as CargoGraphProjection | undefined,
	metadata: undefined as unknown,
	boundMetadata: undefined as unknown,
	boundPaths: undefined as ValidatedCargoPaths | undefined,
	pathFault: "" as "" | "missing-member" | "wrong-member" | "extra-member",
	inputFactories: 0,
	toolFactories: 0,
	inputCaptures: 0,
	inputCaptureFail: false,
	inputBinds: 0,
	inputChecks: 0,
	inputCheckGate: undefined as Promise<void> | undefined,
	inputCheckEntered: undefined as (() => void) | undefined,
	toolChecks: 0,
	inputCloses: 0,
	toolCloses: 0,
	inputPending: 0,
	toolPending: 0,
	inputsChanged: false,
	toolsChanged: false,
	toolEnvironment: undefined as Readonly<Record<string, string | undefined>> | undefined,
	commands: [] as { id: string; command: NativeCommand }[],
	timeline: [] as string[],
	readerAdmissions: 0,
	afterCapturedRead: undefined as ((id: string, stream: "stdout" | "stderr") => void) | undefined,
	captures: [] as { evidence: EvidenceDirectory; result: NativeCaptureResult }[],
	evidenceOwners: [] as EvidenceDirectory[],
	requestedTargets: [] as (readonly AffectedPackage[])[],
	graphFault: "" as
		| ""
		| "digest"
		| "count"
		| "missing-root"
		| "missing-target"
		| "missing-syn-parent",
	ancestorFault: "" as "" | "missing" | "duplicate" | "digest" | "target",
	captureFailure: null as CaptureFailure | null,
	metadataExit: 0,
	metadataSignal: null as string | null,
	cloneMetadataCapture: false,
	throwAfterCapture: false,
	invalidJson: false,
	captureGate: undefined as Promise<void> | undefined,
	captureGateId: "metadata" as "tool-cargo" | "metadata",
	captureEntered: undefined as (() => void) | undefined,
	closeGate: undefined as Promise<void> | undefined,
	closeEntered: undefined as (() => void) | undefined,
	closeFault: "" as "" | "policy" | "lock" | "metadata-reader",
	failedHandles: [] as {
		handle: fs.FileHandle;
		close: () => Promise<void>;
		attempts: number;
		successful: number;
	}[],
	closeFaults: 0,
	lockOpenCalls: 0,
	lockStatGate: undefined as Promise<void> | undefined,
	lockStatEntered: undefined as (() => void) | undefined,
	lockStatParked: false,
	openReturnGate: undefined as Promise<void> | undefined,
	openReturnEntered: undefined as (() => void) | undefined,
	openReturnParked: false,
	handoffHandle: undefined as fs.FileHandle | undefined,
	handoffOriginalClose: undefined as (() => Promise<void>) | undefined,
	handoffReads: 0,
	handoffCloses: 0,
	handoffPhysicalCloses: 0,
}));

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		lstat: async (...args: Parameters<typeof actual.lstat>) => {
			const result = await actual.lstat(...args);
			if (
				args[0] === path.join(control.repo, "crates/Cargo.lock") &&
				control.lockStatGate &&
				!control.lockStatParked
			) {
				control.lockStatParked = true;
				control.lockStatEntered?.();
				await control.lockStatGate;
			}
			return result;
		},
		open: async (...args: Parameters<typeof actual.open>) => {
			const file = typeof args[0] === "string" ? args[0] : "";
			const readOnly = args[1] === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			if (readOnly && file === path.join(control.repo, "crates/Cargo.lock"))
				control.lockOpenCalls++;
			const handle = await actual.open(...args);
			if (
				readOnly &&
				file === path.join(control.repo, "crates/Cargo.lock") &&
				control.openReturnGate &&
				!control.openReturnParked
			) {
				control.openReturnParked = true;
				const close = handle.close.bind(handle),
					read = handle.read.bind(handle);
				control.handoffHandle = handle;
				control.handoffOriginalClose = close;
				handle.read = ((...readArgs: unknown[]) => {
					control.handoffReads++;
					return Reflect.apply(read, handle, readArgs);
				}) as typeof handle.read;
				handle.close = async () => {
					control.handoffCloses++;
					await close();
					control.handoffPhysicalCloses++;
				};
				control.openReturnEntered?.();
				await control.openReturnGate;
			}
			const selected =
				(control.closeFault === "policy" && file === path.join(control.repo, "crates/deny.toml")) ||
				(control.closeFault === "lock" && file === path.join(control.repo, "crates/Cargo.lock")) ||
				(control.closeFault === "metadata-reader" && file.endsWith("capture-metadata.stdout.bin"));
			if (readOnly && selected) {
				const close = handle.close.bind(handle);
				const original = { handle, close, attempts: 0, successful: 0 };
				control.failedHandles.push(original);
				handle.close = async () => {
					original.attempts++;
					if (control.closeFault !== "") {
						control.closeFaults++;
						throw new Error("SYNTHETIC_CLOSE_REFUSED");
					}
					await close();
					original.successful++;
				};
			}
			return handle;
		},
	};
});

vi.mock("../src/inputs.ts", async (original) => {
	const actual = await original<typeof import("../src/inputs.ts")>();
	return {
		...actual,
		createNativeInputsSource: vi.fn(() => {
			control.inputFactories++;
			let originalSnapshot: NativeInputsSnapshot | undefined;
			let lock: Buffer | undefined;
			let bound = false;
			const resourceStatus = () => ({
				activeOperations: 0,
				pendingFiles: control.inputPending,
				complete: control.inputPending === 0,
			});
			return {
				capture: async (root: string, home: string) => {
					control.timeline.push("inputs-capture");
					if (control.inputCaptureFail) throw new actual.NativeInputsError("INPUTS_CHANGED");
					if (root !== control.repo || home !== control.home || originalSnapshot)
						throw new Error("SYNTHETIC_INPUT_PLACEMENT");
					control.inputCaptures++;
					lock = await fs.readFile(path.join(root, "crates/Cargo.lock"));
					originalSnapshot = Object.freeze({
						inputDigest: "1".repeat(64),
						lockDigest: hash(lock),
					}) as NativeInputsSnapshot;
					control.timeline.push("inputs-captured");
					return originalSnapshot;
				},
				bindCargoPaths: async (value: NativeInputsSnapshot, metadata: unknown) => {
					if (value !== originalSnapshot || bound || !lock)
						throw new Error("SYNTHETIC_INPUT_OWNERSHIP");
					bound = true;
					control.inputBinds++;
					control.boundMetadata = metadata;
					const packages: CargoPackagePaths[] = MEMBERS.map(([manifestPath, name]) =>
						Object.freeze({
							id: `fixture:${name}`,
							manifestPath,
							targets: Object.freeze([]),
						}),
					);
					if (control.pathFault === "missing-member") packages.pop();
					if (control.pathFault === "wrong-member" && packages[0])
						packages[0] = { ...packages[0], manifestPath: "crates/invented-foreign/Cargo.toml" };
					if (control.pathFault === "extra-member")
						packages.push({
							id: "fixture:invented-extra",
							manifestPath: "crates/invented-extra/Cargo.toml",
							targets: Object.freeze([]),
						});
					const paths: ValidatedCargoPaths = Object.freeze({
						workspacePackages: Object.freeze(packages),
						rootIds: Object.freeze(packages.map((row) => row.id)),
					});
					control.boundPaths = paths;
					return paths;
				},
				assertUnchanged: async (value: NativeInputsSnapshot) => {
					if (!bound || value !== originalSnapshot || !lock)
						throw new Error("SYNTHETIC_INPUT_PHASE");
					control.inputChecks++;
					control.inputCheckEntered?.();
					await control.inputCheckGate;
					if (
						control.inputsChanged ||
						!(await fs.readFile(path.join(control.repo, "crates/Cargo.lock"))).equals(lock)
					)
						throw new actual.NativeInputsError("INPUTS_CHANGED");
				},
				resourceStatus,
				closeResources: async () => {
					control.inputCloses++;
					control.closeEntered?.();
					await control.closeGate;
					return resourceStatus();
				},
			};
		}),
	};
});

vi.mock("../src/tool-provenance.ts", async (original) => {
	const actual = await original<typeof import("../src/tool-provenance.ts")>();
	return {
		...actual,
		createNativeToolProvenanceSource: vi.fn(() => {
			control.toolFactories++;
			let snapshot: NativeToolProvenance | undefined;
			const resourceStatus = () => ({
				activeOperations: 0,
				pendingFiles: control.toolPending,
				complete: control.toolPending === 0,
			});
			return {
				capture: async (
					root: string,
					probe: NativeVersionProbe,
					environment?: Readonly<Record<string, string | undefined>>,
				) => {
					if (root !== control.repo || snapshot) throw new Error("SYNTHETIC_TOOL_PLACEMENT");
					control.toolEnvironment = environment;
					for (const name of ["cargo", "rustc", "cargo-deny"] as const) {
						const result = await probe(
							path.join(control.tools, name),
							name === "cargo-deny" ? ["--version"] : ["--version", "--verbose"],
						);
						if (result.code !== 0) throw new Error("SYNTHETIC_VERSION_FAILED");
					}
					snapshot = Object.freeze({
						digest: "3".repeat(64),
						tools: syntheticTools(),
					}) as NativeToolProvenance;
					return snapshot;
				},
				nativeToolPath: async (value: NativeToolProvenance, name: NativeToolName) => {
					if (value !== snapshot || control.toolsChanged) throw new actual.ToolProvenanceError();
					return path.join(control.tools, name);
				},
				assertUnchanged: async (value: NativeToolProvenance) => {
					control.toolChecks++;
					if (value !== snapshot || control.toolsChanged) throw new actual.ToolProvenanceError();
				},
				resourceStatus,
				closeResources: async () => {
					control.toolCloses++;
					return resourceStatus();
				},
			};
		}),
	};
});

vi.mock("../src/evidence.ts", async (original) => {
	const actual = await original<typeof import("../src/evidence.ts")>();
	return {
		...actual,
		createEvidenceDirectory: async (
			options: Parameters<typeof actual.createEvidenceDirectory>[0],
		) => {
			const owner = await actual.createEvidenceDirectory(options);
			control.evidenceOwners.push(owner);
			return owner;
		},
		readCapturedBytes: async (...args: Parameters<typeof actual.readCapturedBytes>) => {
			control.readerAdmissions++;
			const bytes = await actual.readCapturedBytes(...args);
			control.afterCapturedRead?.(args[1].id, args[2]);
			return bytes;
		},
	};
});

vi.mock("../src/native-capture.ts", async () => {
	const evidence = await import("../src/evidence.ts");
	return {
		captureNativeProcess: vi.fn(
			async (owner: EvidenceDirectory, id: string, command: NativeCommand) => {
				control.timeline.push(`capture:${id}`);
				control.commands.push({ id, command });
				if (id === control.captureGateId) {
					control.captureEntered?.();
					await control.captureGate;
				}
				const session = await evidence.beginCapture(owner, id);
				await session.stdout.append(
					Buffer.from(
						id === "metadata"
							? control.invalidJson
								? "{"
								: JSON.stringify(control.metadata)
							: "SYNTHETIC_VERSION\n",
					),
				);
				await session.stderr.append(Buffer.alloc(0));
				const result = await evidence.sealCapture(session, {
					exitCode: id === "metadata" ? control.metadataExit : 0,
					signal: id === "metadata" ? control.metadataSignal : null,
					failure: id === "metadata" ? control.captureFailure : null,
				});
				control.captures.push({ evidence: owner, result });
				if (id === "metadata" && control.throwAfterCapture)
					throw new Error("SYNTHETIC_CAPTURE_UNKNOWN");
				return id === "metadata" && control.cloneMetadataCapture ? { ...result } : result;
			},
		),
	};
});

vi.mock("../src/cargo-graph.ts", async (original) => {
	const actual = await original<typeof import("../src/cargo-graph.ts")>();
	return {
		...actual,
		projectCargoGraph: vi.fn(
			(metadata: unknown, paths: ValidatedCargoPaths, affected: readonly AffectedPackage[]) => {
				if (metadata !== control.boundMetadata || paths !== control.boundPaths)
					throw new Error("SYNTHETIC_PROJECTION_OWNERSHIP");
				control.requestedTargets.push(affected.map((row) => ({ ...row })));
				return projectedFixture(affected);
			},
		),
	};
});

import {
	beginCapture,
	closeEvidenceReaders,
	createEvidenceDirectory,
	evidenceReaderStatus,
	readCapturedBytes,
	sealCapture,
} from "../src/evidence.ts";
import {
	createFourRootDescriptorSource,
	FourRootDescriptorError,
} from "../src/four-root-descriptor.ts";

type Source = ReturnType<typeof createFourRootDescriptorSource>;
type Observation = Awaited<ReturnType<Source["observe"]>>;
const sources: Source[] = [];
const GRAPH_DIGEST = "a4662c495976436a169207f85fe6ecd21aea53adbcb6d7e8ecb8349a18d446ce";
const LOCK_SHA = "f8a940be9d97416d8e07af0ce7acbe8d35f45177176de227cf0a64c5aa8cb6bf";
const POLICY_SHA = "3dfd2b249ce43734a7ec281e10d1353a3bb9ce68a7684fa36639ea98f64791d0";
const REGISTRY = "registry+https://github.com/rust-lang/crates.io-index";
const MEMBERS = [
	["crates/draftyak-protocol/Cargo.toml", "draftyak-protocol"],
	["crates/draftyak-desktop-pairing/Cargo.toml", "draftyak-desktop-pairing"],
	["crates/draftyak-transport/Cargo.toml", "draftyak-transport"],
	["apps/app/src-tauri/Cargo.toml", "draftyak-desktop"],
] as const;
const TARGETS = [
	["RUSTSEC-2024-0429", "D102", "glib", "0.18.5"],
	["RUSTSEC-2024-0370", "D102", "proc-macro-error", "1.0.4"],
	["RUSTSEC-2026-0370", "D130", "zvariant", "5.15.1"],
	["RUSTSEC-2026-0371", "D130", "zbus_names", "4.3.5"],
	["RUSTSEC-2026-0372", "D130", "zvariant_derive", "5.15.1"],
] as const;
const graphBytes = readFileSync(
	new URL("./fixtures/mobile-http-approved-graph.json", import.meta.url),
);
const policyBytes = readFileSync(
	new URL("./fixtures/mobile-http-approved-policy.toml", import.meta.url),
);
const lockBytes = readFileSync(new URL("../../../crates/Cargo.lock", import.meta.url));
const rootManifest = readFileSync(new URL("../../../crates/Cargo.toml", import.meta.url));
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const identity = (value: ProjectionTuple): string => JSON.stringify(value);
function tuple(value: unknown): ProjectionTuple {
	if (!Array.isArray(value)) throw new Error("SYNTHETIC_TUPLE_INVALID");
	return value as ProjectionTuple;
}
function freshGraph(): CargoGraphProjection {
	return JSON.parse(graphBytes.toString("utf8")) as CargoGraphProjection;
}
function projectedFixture(affected: readonly AffectedPackage[]): CargoGraphProjection {
	const value = freshGraph();
	const payload = value.tuplePayload as unknown as unknown[];
	const rows = tuple(payload[3]);
	let edges = tuple(payload[4]);
	const roots = tuple(tuple(payload[2])[2]);
	const ancestorDigests = affected.map((target) => {
		const row = rows.find((entry) => {
			const header = tuple(tuple(entry)[0]);
			return (
				header[0] === target.source && header[1] === target.name && header[2] === target.version
			);
		});
		if (!row) throw new Error("SYNTHETIC_TARGET_MISSING");
		const targetIdentity = tuple(tuple(row)[0]);
		const selected = new Set([identity(targetIdentity)]);
		let changed = true;
		while (changed) {
			changed = false;
			for (const entry of edges) {
				const edge = tuple(entry),
					from = identity(tuple(edge[0]));
				if (selected.has(identity(tuple(edge[1]))) && !selected.has(from)) {
					selected.add(from);
					changed = true;
				}
			}
		}
		const selectedRows = rows.filter((entry) => selected.has(identity(tuple(tuple(entry)[0]))));
		const selectedEdges = edges.filter((entry) => {
			const edge = tuple(entry);
			return selected.has(identity(tuple(edge[0]))) && selected.has(identity(tuple(edge[1])));
		});
		const tuplePayload: ProjectionTuple = [
			"ancestor",
			1,
			targetIdentity,
			roots.filter((entry) => selected.has(identity(tuple(entry)))),
			selectedRows,
			selectedEdges,
		];
		return {
			target: { ...target },
			digest: createHash("sha256")
				.update("draftyak/native-dependency-policy/ancestor/v1\0")
				.update(JSON.stringify(tuplePayload))
				.digest("hex"),
			packageCount: selectedRows.length,
			tuplePayload,
		};
	});
	if (control.ancestorFault === "missing") ancestorDigests.pop();
	if (control.ancestorFault === "duplicate" && ancestorDigests[0])
		ancestorDigests.push(ancestorDigests[0]);
	if (control.ancestorFault === "digest" && ancestorDigests[0])
		ancestorDigests[0].digest = "0".repeat(64);
	if (control.ancestorFault === "target" && ancestorDigests[0])
		ancestorDigests[0].target = { ...ancestorDigests[0].target, name: "invented-target" };
	if (control.graphFault === "missing-root") (payload[2] as unknown[])[2] = roots.slice(1);
	if (control.graphFault === "missing-target")
		payload[3] = rows.filter((entry) => tuple(tuple(entry)[0])[1] !== "glib");
	if (control.graphFault === "missing-syn-parent") {
		edges = edges.filter((entry) => tuple(tuple(entry)[1])[1] !== "syn");
		payload[4] = edges;
	}
	return {
		...value,
		packageCount: control.graphFault === "count" ? 552 : value.packageCount,
		digest: control.graphFault === "digest" ? "0".repeat(64) : value.digest,
		ancestorDigests,
	};
}

function syntheticTools(): NativeToolProvenance["tools"] {
	return (["cargo", "rustc", "cargo-deny"] as const).map((name) => ({
		name,
		version: name === "cargo-deny" ? ("0.20.2" as const) : ("1.95.0" as const),
		host:
			name === "cargo-deny"
				? null
				: process.platform === "win32"
					? "x86_64-pc-windows-msvc"
					: "x86_64-unknown-linux-gnu",
		sha256: "4".repeat(64),
		format: process.platform === "win32" ? ("PE32+-x86_64" as const) : ("ELF64-x86_64" as const),
		identityBoundary:
			name === "cargo-deny"
				? ("official-release-executable" as const)
				: ("trusted-host-toolchain" as const),
	}));
}
function options() {
	return {
		repositoryRoot: control.repo,
		cargoHome: control.home,
		evidenceDirectory: control.evidence,
		environment: {
			PATH: control.tools,
			CARGO_HOME: control.home,
			CARGO_NET_OFFLINE: "true",
			RUSTUP_TOOLCHAIN: "1.95.0",
			CARGO_TERM_COLOR: "never",
			NO_COLOR: "1",
		},
	};
}
function source(value: unknown = options()): Source {
	const result = createFourRootDescriptorSource(
		value as Parameters<typeof createFourRootDescriptorSource>[0],
	);
	sources.push(result);
	return result;
}
async function outcome(action: () => unknown | Promise<unknown>) {
	try {
		await action();
		return { resolved: true, code: null as string | null };
	} catch (error) {
		return {
			resolved: false,
			code: error instanceof FourRootDescriptorError ? error.code : "OTHER",
		};
	}
}
function metadataForRealInputs() {
	const packages = MEMBERS.map(([manifest, name]) => ({
		id: `fixture:${name}`,
		name,
		version: "0.0.0",
		source: null,
		manifest_path: path.join(control.repo, manifest),
		dependencies: [],
		targets: [
			{
				name: name.replaceAll("-", "_"),
				kind: ["lib"],
				src_path: path.join(control.repo, path.dirname(manifest), "src/lib.rs"),
			},
		],
	}));
	return {
		workspace_root: path.join(control.repo, "crates"),
		packages,
		workspace_members: packages.map((row) => row.id),
	};
}

beforeAll(() => {
	expect(graphBytes.length).toBe(1538960);
	expect(hash(graphBytes)).toBe("643c93dbe52baf54637ba8ddf28ce24ad514fd2404e3a79a37d25aa7e2ce914e");
	expect(hash(policyBytes)).toBe(POLICY_SHA);
	expect(hash(lockBytes)).toBe(LOCK_SHA);
	expect(hash(rootManifest)).toBe(
		"d0988937cc04f26399882097f1cf2017062d510c5a1c56775a4ae61dbf1a25c4",
	);
});
beforeEach(async () => {
	vi.clearAllMocks();
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T12:00:00Z"));
	Object.assign(control, {
		inputFactories: 0,
		toolFactories: 0,
		inputCaptures: 0,
		inputBinds: 0,
		inputCaptureFail: false,
		inputChecks: 0,
		toolChecks: 0,
		inputCloses: 0,
		toolCloses: 0,
		inputCheckGate: undefined,
		inputCheckEntered: undefined,
		inputPending: 0,
		toolPending: 0,
		inputsChanged: false,
		toolsChanged: false,
		boundMetadata: undefined,
		boundPaths: undefined,
		pathFault: "",
		toolEnvironment: undefined,
		commands: [],
		timeline: [],
		readerAdmissions: 0,
		afterCapturedRead: undefined,
		captures: [],
		evidenceOwners: [],
		requestedTargets: [],
		graphFault: "",
		ancestorFault: "",
		captureFailure: null,
		metadataExit: 0,
		metadataSignal: null,
		cloneMetadataCapture: false,
		throwAfterCapture: false,
		invalidJson: false,
		captureGate: undefined,
		captureGateId: "metadata",
		captureEntered: undefined,
		closeGate: undefined,
		closeEntered: undefined,
		closeFault: "",
		failedHandles: [],
		closeFaults: 0,
		lockOpenCalls: 0,
		lockStatGate: undefined,
		lockStatEntered: undefined,
		lockStatParked: false,
		openReturnGate: undefined,
		openReturnEntered: undefined,
		openReturnParked: false,
		handoffHandle: undefined,
		handoffOriginalClose: undefined,
		handoffReads: 0,
		handoffCloses: 0,
		handoffPhysicalCloses: 0,
	});
	control.parent = await fs.realpath(os.tmpdir());
	control.root = await fs.realpath(
		await fs.mkdtemp(path.join(control.parent, "draftyak-four-root-unit-")),
	);
	control.repo = path.join(control.root, "repo");
	control.home = path.join(control.root, "cargo-home");
	control.tools = path.join(control.root, "tools");
	control.evidence = path.join(control.root, "evidence");
	await fs.mkdir(control.home);
	await fs.mkdir(control.tools);
	for (const [manifest, name] of MEMBERS) {
		const directory = path.dirname(path.join(control.repo, manifest));
		await fs.mkdir(path.join(directory, "src"), { recursive: true });
		await fs.writeFile(
			path.join(control.repo, manifest),
			`[package]\nname = "${name}"\nversion = "0.0.0"\n`,
		);
		await fs.writeFile(path.join(directory, "src/lib.rs"), "pub fn invented() {}\n");
	}
	await fs.writeFile(path.join(control.repo, "crates/Cargo.toml"), rootManifest);
	await fs.writeFile(path.join(control.repo, "crates/Cargo.lock"), lockBytes);
	await fs.writeFile(path.join(control.repo, "crates/deny.toml"), policyBytes);
	await fs.writeFile(
		path.join(control.repo, "rust-toolchain.toml"),
		'[toolchain]\nchannel = "1.95.0"\n',
	);
	control.metadata = { fixture: "invented-four-root-metadata", version: 1 };
});
afterEach(async () => {
	control.closeFault = "";
	control.inputPending = 0;
	control.toolPending = 0;
	for (const result of sources.splice(0)) {
		const status = await result.closeResources();
		if (
			status.activeOperations +
				status.activeCaptures +
				status.pendingFiles +
				status.activeInputOperations +
				status.pendingInputFiles +
				status.activeToolOperations +
				status.pendingToolFiles +
				status.activeReaders +
				status.pendingReaders !==
			0
		)
			throw new Error("SYNTHETIC_CLEANUP_PENDING");
	}
	for (const failed of control.failedHandles) await failed.close();
	await control.handoffOriginalClose?.();
	for (const owner of control.evidenceOwners) {
		await closeEvidenceReaders(owner);
		expect(evidenceReaderStatus(owner)).toEqual({ active: 0, pending: 0 });
	}
	vi.restoreAllMocks();
	const info = await fs.lstat(control.root);
	if (
		!info.isDirectory() ||
		info.isSymbolicLink() ||
		path.dirname(control.root) !== control.parent ||
		!path.basename(control.root).startsWith("draftyak-four-root-unit-") ||
		(await fs.realpath(control.root)) !== control.root
	)
		throw new Error("SYNTHETIC_CLEANUP_BOUNDARY");
	await fs.rm(control.root, { recursive: true, force: false });
	let absent = false;
	try {
		await fs.lstat(control.root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT")
			throw new Error("SYNTHETIC_CLEANUP_UNKNOWN");
		absent = true;
	}
	expect(absent).toBe(true);
});

describe("four-root descriptor synthetic orchestration", () => {
	it("constructs inertly and refuses caller graph, selection, owner and approval injection", () => {
		const original = source();
		const factories = control.inputFactories + control.toolFactories;
		expect(
			control.inputCaptures +
				control.inputBinds +
				control.commands.length +
				control.evidenceOwners.length,
		).toBe(0);
		expect(original.resourceStatus().activeOperations).toBe(0);
		for (const extra of [
			{ graph: freshGraph() },
			{ selection: { allFeatures: false } },
			{ inputsSource: {} },
			{ approved: true },
		]) {
			let refused = false;
			try {
				source({ ...options(), ...extra });
			} catch (error) {
				refused = error instanceof FourRootDescriptorError && error.code === "FOUR_ROOT_INVALID";
			}
			expect(refused).toBe(true);
		}
		expect(control.inputFactories + control.toolFactories).toBe(factories);
		expect(
			control.inputCaptures +
				control.inputBinds +
				control.commands.length +
				control.evidenceOwners.length,
		).toBe(0);
	});
	it("records only the fixed union command and captures its original owner-bound provenance", async () => {
		const value = source(),
			observation = await value.observe(),
			data = value.data(observation);
		expect(data.kind).toBe("FOUR_ROOT_DESCRIPTOR_DATA");
		expect(data.authority).toBe(false);
		expect(data.reusableNativeSourceBasis).toBe(false);
		expect(data.selection).toEqual({
			command: "cargo metadata",
			formatVersion: 1,
			allFeatures: true,
			locked: true,
			offline: true,
			noDeps: false,
			filterPlatform: null,
			defaultFeatureSelection: "cargo-defaults",
			targetActivity: "UNKNOWN",
			cfgActivity: "UNKNOWN",
		});
		const selected = control.commands.filter((entry) => entry.id === "metadata");
		expect(selected.length).toBe(1);
		expect(selected[0]?.command.args).toEqual([
			"metadata",
			"--manifest-path",
			"crates/Cargo.toml",
			"--format-version",
			"1",
			"--locked",
			"--offline",
			"--all-features",
		]);
		expect(selected[0]?.command.cwd === control.repo).toBe(true);
		expect(selected[0]?.command.executable === path.join(control.tools, "cargo")).toBe(true);
		expect(data.captures.map((entry) => entry.id).sort()).toEqual([
			"metadata",
			"tool-cargo",
			"tool-deny",
			"tool-rustc",
		]);
		expect(
			data.captures.every(
				(entry) =>
					entry.exitCode === 0 &&
					entry.cwd === "." &&
					/^[a-f0-9]{64}$/.test(entry.invocationDigest),
			),
		).toBe(true);
		for (const captured of data.captures) {
			const original = control.captures.find((entry) => entry.result.id === captured.id)?.result;
			const originalCommand = control.commands.find((entry) => entry.id === captured.id)?.command;
			expect(captured.argv).toEqual(originalCommand?.args);
			expect(original !== undefined).toBe(true);
			expect(captured.stdout).toEqual({
				bytes: original?.stdout.bytes,
				sha256: original?.stdout.sha256,
			});
			expect(captured.stderr).toEqual({
				bytes: original?.stderr.bytes,
				sha256: original?.stderr.sha256,
			});
			expect(captured.startedAt <= captured.completedAt).toBe(true);
		}
		expect(data.inputDigest).toBe("1".repeat(64));
		expect(data.lockDigest).toBe(LOCK_SHA);
		expect(data.policySha256).toBe(POLICY_SHA);
		expect(data.graph.digest).toBe(GRAPH_DIGEST);
		expect(data.graph.packageCount).toBe(553);
		expect(control.inputCaptures).toBe(1);
		expect(
			control.timeline.indexOf("inputs-captured") >= 0 &&
				control.timeline.indexOf("inputs-captured") <
					control.timeline.indexOf("capture:tool-cargo"),
		).toBe(true);
		expect(control.inputBinds).toBe(1);
		expect(control.inputChecks > 0 && control.toolChecks > 0).toBe(true);
		for (const key of [
			"reviewer",
			"reviewedAt",
			"expiresAt",
			"basis",
			"approval",
			"markedB",
			"humanM",
			"audit",
		])
			expect(Object.hasOwn(data, key)).toBe(false);
		expect(
			Object.isFrozen(data) && Object.isFrozen(data.selection) && Object.isFrozen(data.captures),
		).toBe(true);
	});
	it("retains all five distinct declared targets and App-inclusive routes without claiming audit findings", async () => {
		const value = source(),
			data = value.data(await value.observe());
		expect(
			data.advisories
				.map((row) => [row.id, row.family, row.package.name, row.package.version])
				.sort(),
		).toEqual(TARGETS.map((row) => [...row]).sort());
		expect(data.advisories.length).toBe(5);
		expect(
			data.advisories.every(
				(row) =>
					row.package.source === REGISTRY &&
					/^[a-f0-9]{64}$/.test(row.package.checksum) &&
					row.routes.length > 0,
			),
		).toBe(true);
		for (const row of data.advisories) {
			const expectedRoot = row.family === "D102" ? "draftyak-desktop" : "draftyak-transport";
			expect(row.routes.every((route) => route.startsWith(`${expectedRoot} `))).toBe(true);
		}
		expect(
			data.advisories.every(
				(row) =>
					row.ancestor.target.source === row.package.source &&
					row.ancestor.target.name === row.package.name &&
					row.ancestor.target.version === row.package.version,
			),
		).toBe(true);
		expect(Object.hasOwn(data, "findings") || Object.hasOwn(data, "strictPass")).toBe(false);
	});
	it("derives each Syn parent union from projected resolved edges with exact identity and declaration detail", async () => {
		const value = source(),
			data = value.data(await value.observe()),
			graph = freshGraph();
		expect(data.syn.map((row) => row.version).sort()).toEqual(["1.0.109", "2.0.119", "3.0.9"]);
		for (const row of data.syn) {
			const edges = tuple(graph.tuplePayload[4])
				.map(tuple)
				.filter((edge) => tuple(edge[1])[1] === "syn" && tuple(edge[1])[2] === row.version);
			const parents = [
				...new Set(edges.map((edge) => JSON.stringify(tuple(edge[0]).slice(0, 3)))),
			].sort();
			expect(
				row.directParents
					.map((parent) => JSON.stringify([parent.source, parent.name, parent.version]))
					.sort(),
			).toEqual(parents);
			expect(row.source).toBe(REGISTRY);
			expect(/^[a-f0-9]{64}$/.test(row.checksum)).toBe(true);
			expect(row.directParents.length > 0).toBe(true);
			for (const parent of row.directParents) {
				const packageRow = tuple(
					tuple(graph.tuplePayload[3]).find((entry) => {
						const header = tuple(tuple(entry)[0]);
						return (
							header[0] === parent.source &&
							header[1] === parent.name &&
							header[2] === parent.version
						);
					}),
				);
				expect(parent.resolvedFeatures).toEqual(packageRow[1]);
				expect(parent.resolvedEdges).toEqual(
					edges.filter(
						(edge) =>
							JSON.stringify(tuple(edge[0]).slice(0, 3)) ===
							JSON.stringify([parent.source, parent.name, parent.version]),
					),
				);
				expect(parent.declaredSynDependencies.length > 0).toBe(true);
				expect(parent.selectionCaptureId).toBe("metadata");
				expect(
					Object.hasOwn(parent, "active") ||
						Object.hasOwn(parent, "lockOnly") ||
						Object.hasOwn(parent, "cfg"),
				).toBe(false);
			}
		}
		// The pinned public fixture declares both dev and normal ^2 dependencies,
		// while this exact observed edge selects only normal/null.
		const syn2 = data.syn.find((row) => row.version === "2.0.119");
		const derived = syn2?.directParents.find(
			(parent) =>
				parent.source === REGISTRY &&
				parent.name === "num_enum_derive" &&
				parent.version === "0.7.6",
		);
		expect(derived !== undefined).toBe(true);
		expect(derived?.declaredSynDependencies).toEqual([
			[
				"syn",
				REGISTRY,
				"^2",
				"normal",
				null,
				false,
				true,
				["derive", "extra-traits", "parsing"],
				null,
				null,
				null,
			],
		]);
	});
	it("snapshots the closed environment instead of retaining the caller's mutable map", async () => {
		const supplied = options(),
			value = source(supplied);
		supplied.environment.PATH = "changed-after-construction";
		await value.observe();
		expect(control.toolEnvironment?.PATH === control.tools).toBe(true);
		expect(
			control.commands.every(
				(entry) =>
					entry.command.env.PATH === control.tools && entry.command.env.CARGO_HOME === control.home,
			),
		).toBe(true);
		expect(Object.isFrozen(control.toolEnvironment)).toBe(true);
	});
	it("captures the original input snapshot before any probe and launches nothing if that capture fails", async () => {
		control.inputCaptureFail = true;
		expect((await outcome(() => source().observe())).resolved).toBe(false);
		expect(control.timeline).toEqual(["inputs-capture"]);
		expect(control.commands.length).toBe(0);
	});
	it("retains the original observation times and digest during revalidation", async () => {
		const start = Date.parse("2026-11-18T12:00:00Z");
		let metadataStderrReads = 0,
			armed = false;
		control.afterCapturedRead = (id, stream) => {
			if (id === "metadata" && stream === "stderr" && ++metadataStderrReads === 2) {
				// Final original-stream recheck: one valid completion sample, then
				// a rollback that must not become an unchecked emitted timestamp.
				armed = true;
				vi.mocked(Date.now)
					.mockReturnValue(start - 1)
					.mockReturnValueOnce(start + 1);
			}
		};
		const value = source(),
			observation = await value.observe();
		control.afterCapturedRead = undefined;
		expect(armed).toBe(true);
		vi.mocked(Date.now).mockReturnValue(start + 2);
		const before = vi.mocked(Date.now).mock.calls.length;
		const initial = value.data(observation);
		expect(vi.mocked(Date.now).mock.calls.length - before).toBe(1);
		expect(initial.startedAt).toBe(start);
		expect(initial.observedAt).toBe(start);
		expect(initial.completedAt).toBe(start + 1);
		expect(
			initial.captures.every(
				(capture) =>
					capture.completedAt >= capture.startedAt &&
					capture.completedAt - capture.startedAt < 3_600_000,
			),
		).toBe(true);
		vi.mocked(Date.now).mockReturnValue(start + 1000);
		await value.revalidate(observation);
		const after = value.data(observation);
		expect([after.startedAt, after.completedAt, after.observedAt, after.observationDigest]).toEqual(
			[initial.startedAt, initial.completedAt, initial.observedAt, initial.observationDigest],
		);
		expect((await outcome(() => value.observe())).resolved).toBe(false);
	});
	it.each(["data-clone", "revalidate-clone", "cross-source"] as const)(
		"refuses a foreign observation before any prior failure: %s",
		async (kind) => {
			const value = source(),
				observation = await value.observe();
			let result: Awaited<ReturnType<typeof outcome>>;
			if (kind === "cross-source") {
				const other = source({
					...options(),
					evidenceDirectory: path.join(control.root, "other-evidence"),
				});
				result = await outcome(() => other.data(observation));
			} else {
				const clone = { ...observation } as Observation;
				result = await outcome(() =>
					kind === "data-clone" ? value.data(clone) : value.revalidate(clone),
				);
			}
			expect(result.resolved).toBe(false);
		},
	);
	it.each([-1, 0, 1])(
		"enforces the original observation's one-hour age at offset %s",
		async (offset) => {
			const start = Date.parse("2026-11-18T12:00:00Z");
			for (const method of ["data", "revalidate"] as const) {
				vi.mocked(Date.now).mockReset().mockReturnValue(start);
				const value = source({
					...options(),
					evidenceDirectory: path.join(control.root, `age-${method}`),
				});
				const observation = await value.observe(),
					data = value.data(observation);
				vi.mocked(Date.now).mockReturnValue(data.observedAt + 3_600_000 + offset);
				const result = await outcome(() =>
					method === "data" ? value.data(observation) : value.revalidate(observation),
				);
				expect(result.resolved).toBe(offset < 0);
				if (offset >= 0) {
					expect(result.code).toBe("FOUR_ROOT_STALE");
					vi.mocked(Date.now).mockReturnValue(data.observedAt + 1);
					expect((await outcome(() => value.data(observation))).resolved).toBe(false);
					expect((await outcome(() => value.revalidate(observation))).resolved).toBe(false);
				}
			}
		},
	);
	it("refuses clock rollback and invalid captured intervals without revival", async () => {
		const value = source(),
			observation = await value.observe(),
			data = value.data(observation);
		vi.mocked(Date.now)
			.mockReturnValue(data.observedAt + 1)
			.mockReturnValueOnce(data.observedAt + 1)
			.mockReturnValueOnce(data.observedAt - 1);
		const before = vi.mocked(Date.now).mock.calls.length;
		const first = value.data(observation);
		const consumed = vi.mocked(Date.now).mock.calls.length - before;
		expect(consumed).toBe(1);
		expect(first.observationDigest).toBe(data.observationDigest);
		const rollback = await outcome(() => value.data(observation));
		expect(rollback.resolved).toBe(false);
		expect(rollback.code).toBe("FOUR_ROOT_STALE");
		vi.mocked(Date.now).mockReturnValue(data.observedAt + 1);
		expect((await outcome(() => value.data(observation))).resolved).toBe(false);
		expect((await outcome(() => value.revalidate(observation))).resolved).toBe(false);
		for (const interval of [-1, 3_600_000]) {
			const start = data.observedAt;
			// Checked collect start, first original capture start, then its bad
			// completion. Later clocks are valid so a bad interval cannot hide
			// behind an unrelated final-observation age refusal.
			vi.mocked(Date.now)
				.mockReset()
				.mockReturnValue(start + 20)
				.mockReturnValueOnce(start)
				.mockReturnValueOnce(start + 10)
				.mockReturnValueOnce(start + 10 + interval);
			const capture = source({
				...options(),
				evidenceDirectory: path.join(control.root, `capture-interval-${interval}`),
			});
			const refused = await outcome(() => capture.observe());
			expect(refused.resolved).toBe(false);
			expect(refused.code).toBe("FOUR_ROOT_STALE");
		}
	});
	it("does not release data while an original revalidation is still running", async () => {
		const value = source(),
			observation = await value.observe();
		let release!: () => void, entered!: () => void;
		control.inputCheckGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		control.inputCheckEntered = entered;
		const checking = outcome(() => value.revalidate(observation));
		try {
			await waiting;
			expect((await outcome(() => value.data(observation))).resolved).toBe(false);
			release();
			expect((await checking).resolved).toBe(true);
		} finally {
			release();
			await checking;
		}
	});
	it.each(["digest", "count", "missing-root", "missing-target", "missing-syn-parent"] as const)(
		"refuses an incomplete or changed complete graph: %s",
		async (fault) => {
			control.graphFault = fault;
			expect((await outcome(() => source().observe())).resolved).toBe(false);
		},
	);
	it.each(["missing", "duplicate", "digest", "target"] as const)(
		"refuses incomplete or inconsistent five-target projection: %s",
		async (fault) => {
			control.ancestorFault = fault;
			expect((await outcome(() => source().observe())).resolved).toBe(false);
		},
	);
	it.each(["missing-member", "wrong-member", "extra-member"] as const)(
		"requires the exact original four-member path binding: %s",
		async (fault) => {
			control.pathFault = fault;
			expect((await outcome(() => source().observe())).resolved).toBe(false);
			expect(control.requestedTargets.length).toBe(0);
		},
	);
	it.each(["lock", "policy"] as const)("requires the exact original %s bytes", async (file) => {
		await fs.appendFile(
			path.join(control.repo, file === "lock" ? "crates/Cargo.lock" : "crates/deny.toml"),
			"\n",
		);
		expect((await outcome(() => source().observe())).resolved).toBe(false);
	});
	it.each(["input", "tool"] as const)(
		"refuses changed original %s provenance during revalidation",
		async (which) => {
			const value = source(),
				observation = await value.observe();
			if (which === "input") control.inputsChanged = true;
			else control.toolsChanged = true;
			expect((await outcome(() => value.revalidate(observation))).resolved).toBe(false);
		},
	);
	it("rechecks the original sealed metadata bytes during revalidation", async () => {
		const value = source(),
			observation = await value.observe();
		const captured = control.captures.find((entry) => entry.result.id === "metadata");
		if (!captured) throw new Error("SYNTHETIC_METADATA_MISSING");
		await fs.appendFile(path.join(control.evidence, captured.result.stdout.file), "\n");
		expect((await outcome(() => value.revalidate(observation))).resolved).toBe(false);
	});
	it.each(["STDOUT_LIMIT", "STDERR_LIMIT", "TIMED_OUT", "TREE_UNCONFIRMED"] as const)(
		"cannot complete after a metadata capture failure: %s",
		async (failure) => {
			control.captureFailure = failure;
			expect((await outcome(() => source().observe())).resolved).toBe(false);
		},
	);
	it.each(["exit", "signal", "json", "clone"] as const)(
		"requires successful strict original metadata evidence: %s",
		async (fault) => {
			if (fault === "exit") control.metadataExit = 7;
			if (fault === "signal") control.metadataSignal = "SIGTERM";
			if (fault === "json") control.invalidJson = true;
			if (fault === "clone") control.cloneMetadataCapture = true;
			expect((await outcome(() => source().observe())).resolved).toBe(false);
		},
	);
	it("retains capture uncertainty even after all scoped reader counts are zero", async () => {
		control.throwAfterCapture = true;
		const value = source();
		expect((await outcome(() => value.observe())).resolved).toBe(false);
		const resources = await value.closeResources();
		expect(resources.processUnconfirmed).toBe(true);
		expect(resources.complete).toBe(false);
		expect(resources.activeReaders + resources.pendingReaders).toBe(0);
	});
	it.each(["policy", "lock", "metadata-reader"] as const)(
		"refuses completeness while an actual owned %s FileHandle close failed",
		async (file) => {
			control.closeFault = file;
			const value = source();
			expect((await outcome(() => value.observe())).resolved).toBe(false);
			const originals = control.failedHandles.slice();
			expect(originals.length > 0 && control.closeFaults > 0).toBe(true);
			for (const original of originals) {
				expect((await original.handle.stat()).isFile()).toBe(true);
				expect(original.attempts > 0).toBe(true);
				expect(original.successful).toBe(0);
			}
			expect(value.resourceStatus().complete).toBe(false);
			const attemptsBeforeRefusal = originals.map((original) => original.attempts);
			const refusedClose = await value.closeResources();
			expect(refusedClose.complete).toBe(false);
			expect(refusedClose.processUnconfirmed || refusedClose.cleanupUnconfirmed).toBe(true);
			for (let index = 0; index < originals.length; index++) {
				const original = originals[index];
				if (!original) throw new Error("SYNTHETIC_HANDLE_MISSING");
				expect(original.attempts > (attemptsBeforeRefusal[index] ?? -1)).toBe(true);
				expect(original.successful).toBe(0);
				expect((await original.handle.stat()).isFile()).toBe(true);
			}
			const attemptsBeforeRelease = originals.map((original) => original.attempts);
			control.closeFault = "";
			const after = await value.closeResources();
			// These checkpoints run BEFORE afterEach's saved-method fallback can help.
			expect(control.failedHandles.length).toBe(originals.length);
			for (let index = 0; index < originals.length; index++) {
				const original = originals[index];
				if (!original) throw new Error("SYNTHETIC_HANDLE_MISSING");
				expect(original.attempts).toBe((attemptsBeforeRelease[index] ?? -1) + 1);
				expect(original.successful).toBe(1);
				let physicallyClosed = false;
				try {
					await original.handle.stat();
				} catch {
					physicallyClosed = true;
				}
				expect(physicallyClosed).toBe(true);
			}
			expect(
				after.pendingFiles +
					after.pendingInputFiles +
					after.pendingToolFiles +
					after.activeReaders +
					after.pendingReaders,
			).toBe(0);
			expect(after.processUnconfirmed).toBe(refusedClose.processUnconfirmed);
			expect(after.cleanupUnconfirmed).toBe(refusedClose.cleanupUnconfirmed);
			expect(after.complete).toBe(false);
		},
	);
	it.each(["input", "tool"] as const)(
		"cannot call a pending original %s owner complete",
		async (owner) => {
			const value = source(),
				observation = await value.observe();
			if (owner === "input") control.inputPending = 1;
			else control.toolPending = 1;
			const resources = await value.closeResources();
			expect(resources.complete).toBe(false);
			expect(resources.pendingInputFiles + resources.pendingToolFiles).toBe(1);
			expect((await outcome(() => value.revalidate(observation))).resolved).toBe(false);
		},
	);
	it("waits for its original scoped closer and fences data as soon as closing starts", async () => {
		const value = source(),
			observation = await value.observe();
		let release!: () => void,
			entered!: () => void,
			settled = false;
		control.closeGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		control.closeEntered = entered;
		const closing = value.closeResources().then((result) => {
			settled = true;
			return result;
		});
		try {
			await waiting;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			expect((await outcome(() => value.data(observation))).resolved).toBe(false);
			release();
			const status = await closing;
			expect(status.complete).toBe(true);
			expect(
				status.activeOperations +
					status.activeCaptures +
					status.pendingFiles +
					status.activeReaders +
					status.pendingReaders,
			).toBe(0);
		} finally {
			release();
			await closing;
		}
	});
	it("joins its original operation before final scoped cleanup and fences new work", async () => {
		let release!: () => void, entered!: () => void;
		control.captureGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		control.captureEntered = entered;
		const value = source(),
			observing = outcome(() => value.observe());
		await waiting;
		let closed = false;
		const closing = value.closeResources().then((result) => {
			closed = true;
			return result;
		});
		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(closed).toBe(false);
			expect(value.resourceStatus().activeCaptures).toBe(1);
			expect((await outcome(() => value.observe())).resolved).toBe(false);
			release();
			await observing;
			const status = await closing;
			expect(
				status.activeOperations +
					status.activeCaptures +
					status.activeReaders +
					status.pendingReaders,
			).toBe(0);
			expect(control.inputCloses > 0 && control.toolCloses > 0).toBe(true);
		} finally {
			release();
			await observing;
			await closing;
		}
	});
	it.each(["tool-cargo", "metadata"] as const)(
		"admits no reader or later command after closing during original %s capture",
		async (captureId) => {
			let release!: () => void, entered!: () => void;
			control.captureGateId = captureId;
			control.captureGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const waiting = new Promise<void>((resolve) => {
				entered = resolve;
			});
			control.captureEntered = entered;
			const value = source(),
				observing = outcome(() => value.observe());
			await waiting;
			const readersBeforeFence = control.readerAdmissions,
				commandsBeforeFence = control.commands.length;
			let settled = false;
			const closing = value.closeResources().then((result) => {
				settled = true;
				return result;
			});
			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(settled).toBe(false);
				release();
				expect((await observing).resolved).toBe(false);
				const status = await closing;
				expect(control.readerAdmissions).toBe(readersBeforeFence);
				expect(control.commands.length).toBe(commandsBeforeFence);
				expect(
					status.activeOperations +
						status.activeCaptures +
						status.activeReaders +
						status.pendingReaders +
						status.pendingFiles,
				).toBe(0);
			} finally {
				release();
				await observing;
				await closing;
			}
		},
	);
	it("opens no new lock handle after closing while its original lstat is pending", async () => {
		let release!: () => void, entered!: () => void;
		control.lockStatGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		control.lockStatEntered = entered;
		const value = source(),
			observing = outcome(() => value.observe());
		await waiting;
		const opensBeforeFence = control.lockOpenCalls;
		const closing = value.closeResources();
		try {
			release();
			expect((await observing).resolved).toBe(false);
			const status = await closing;
			expect(control.lockOpenCalls).toBe(opensBeforeFence);
			expect(status.pendingFiles + status.activeOperations + status.activeCaptures).toBe(0);
		} finally {
			release();
			await observing;
			await closing;
		}
	});
	it("registers and closes the exact original handle returned across the close fence without reading it", async () => {
		let release!: () => void, entered!: () => void;
		control.openReturnGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const waiting = new Promise<void>((resolve) => {
			entered = resolve;
		});
		control.openReturnEntered = entered;
		const value = source(),
			observing = outcome(() => value.observe());
		await waiting;
		const held = control.handoffHandle;
		const closing = value.closeResources();
		try {
			expect(held !== undefined).toBe(true);
			release();
			expect((await observing).resolved).toBe(false);
			const status = await closing;
			expect(control.handoffReads).toBe(0);
			expect(control.handoffCloses).toBe(1);
			expect(control.handoffPhysicalCloses).toBe(1);
			let physicallyClosed = false;
			try {
				await held?.stat();
			} catch {
				physicallyClosed = true;
			}
			expect(physicallyClosed).toBe(true);
			expect(status.pendingFiles + status.activeOperations + status.activeCaptures).toBe(0);
		} finally {
			release();
			await observing;
			await closing;
		}
	});
});

describe("existing original-owner APIs used by the descriptor", () => {
	it("reads the original sealed capture and rejects a byte-identical capture lookalike", async () => {
		const owner = await createEvidenceDirectory({
			checkoutRoot: control.repo,
			directory: path.join(control.root, "original-evidence"),
		});
		const session = await beginCapture(owner, "identity");
		await session.stdout.append(Buffer.from("invented owned bytes\n"));
		await session.stderr.append(Buffer.alloc(0));
		const result = await sealCapture(session, { exitCode: 0, signal: null, failure: null });
		expect(
			Buffer.from(await readCapturedBytes(owner, result, "stdout")).equals(
				Buffer.from("invented owned bytes\n"),
			),
		).toBe(true);
		let refused = false;
		try {
			await readCapturedBytes(owner, { ...result }, "stdout");
		} catch {
			refused = true;
		}
		expect(refused).toBe(true);
	});
	it("rejects a digest-identical input snapshot clone and binds the original snapshot only once", async () => {
		const actual = await vi.importActual<typeof import("../src/inputs.ts")>("../src/inputs.ts");
		const owner = actual.createNativeInputsSource();
		try {
			const snapshot = await owner.capture(control.repo, control.home);
			const metadata = metadataForRealInputs();
			let cloneRefused = false,
				secondBindRefused = false;
			try {
				await owner.bindCargoPaths({ ...snapshot } as NativeInputsSnapshot, metadata);
			} catch (error) {
				cloneRefused = error instanceof actual.NativeInputsError;
			}
			expect(cloneRefused).toBe(true);
			const paths = await owner.bindCargoPaths(snapshot, metadata);
			expect(paths.workspacePackages.length).toBe(4);
			await owner.assertUnchanged(snapshot);
			try {
				await owner.bindCargoPaths(snapshot, metadata);
			} catch (error) {
				secondBindRefused = error instanceof actual.NativeInputsError;
			}
			expect(secondBindRefused).toBe(true);
		} finally {
			const resources = await owner.closeResources();
			expect(resources.complete).toBe(true);
			expect(resources.activeOperations + resources.pendingFiles).toBe(0);
		}
	});
});
