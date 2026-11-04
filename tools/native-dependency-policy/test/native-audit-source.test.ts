import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ValidatedCargoPaths } from "../src/cargo-graph.ts";
import type { EvidenceDirectory, NativeCaptureResult } from "../src/evidence.ts";
import type { NativeInputsSnapshot } from "../src/inputs.ts";
import type { NativeCommand } from "../src/native-capture.ts";
import type {
	NativeToolName,
	NativeToolProvenance,
	NativeVersionProbe,
} from "../src/tool-provenance.ts";

// Tool/input/R/policy admission are controlled orchestration fixtures. Capture files,
// sealing, immutable reads, reader status and reader closes use the real module.
// The policy seam never certifies these small graphs as genuine approved553 input.
// Only the explicit real-guard refusal below calls the actual policy function.
// Supplied completion metadata is not evidence of a native process or policy basis.
const FIXTURE_POLICY_SHA = "3dfd2b249ce43734a7ec281e10d1353a3bb9ce68a7684fa36639ea98f64791d0";
const REQWEST_DENY_ROW = '    { name = "reqwest" },\n';
const control = vi.hoisted(() => ({
	ids: [] as string[],
	commands: [] as NativeCommand[],
	captures: new Map<string, NativeCaptureResult>(),
	mode: "good" as "good" | "missing-summary" | "unconfirmed" | "tampered-full",
	mobilePolicyMode: "orchestration-fixture" as "orchestration-fixture" | "real-guard",
	rechecks: 0,
	changedRecheck: 0,
	inputsChanged: false,
	closeFault: false,
	closeAttempts: 0,
	physicalCloses: 0,
	readGate: undefined as Promise<void> | undefined,
	readEntered: undefined as (() => void) | undefined,
	afterCapture: undefined as ((id: string) => void) | undefined,
	evidenceDirectory: "",
	environment: undefined as Readonly<Record<string, string | undefined>> | undefined,
	metadata: null as Record<string, unknown> | null,
	paths: null as ValidatedCargoPaths | null,
	reportMode: "pass" as "pass" | "licenses" | "combined",
	findingName: "invented-crate",
	fullExit: undefined as number | undefined,
	realToolCapture: false,
	toolFile: "",
	toolCloseFault: false,
	toolCloseAttempts: 0,
	toolPhysicalCloses: 0,
	toolHandle: undefined as fs.FileHandle | undefined,
	toolOriginalClose: undefined as (() => Promise<void>) | undefined,
	toolPaths: undefined as Partial<Record<NativeToolName, string>> | undefined,
	realInputs: false,
	inputFile: "",
	inputCloseFault: false,
	inputCloseAttempts: 0,
	inputPhysicalCloses: 0,
	inputHandle: undefined as fs.FileHandle | undefined,
	inputOriginalClose: undefined as (() => Promise<void>) | undefined,
	dependencyCount: 2,
}));

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (
				String(args[0]) === control.inputFile &&
				args[1] === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
			) {
				const close = handle.close.bind(handle);
				control.inputHandle = handle;
				control.inputOriginalClose = close;
				handle.close = async () => {
					control.inputCloseAttempts++;
					if (control.inputCloseFault)
						throw new Error("invented input close fault before physical close");
					await close();
					control.inputPhysicalCloses++;
				};
			}
			if (
				String(args[0]) === control.toolFile &&
				args[1] === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
			) {
				const close = handle.close.bind(handle);
				control.toolHandle = handle;
				control.toolOriginalClose = close;
				handle.close = async () => {
					control.toolCloseAttempts++;
					if (control.toolCloseFault)
						throw new Error("invented provenance close fault before physical close");
					await close();
					control.toolPhysicalCloses++;
				};
			}
			if (
				String(args[0]).endsWith("capture-strict-full.stdout.bin") &&
				args[1] === (constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
			) {
				const close = handle.close.bind(handle);
				handle.close = async () => {
					control.closeAttempts++;
					if (control.closeFault) throw new Error("invented reader close fault");
					await close();
					control.physicalCloses++;
				};
				if (control.readGate) {
					control.readEntered?.();
					await control.readGate;
				}
			}
			return handle;
		},
	};
});
vi.mock("../src/tool-provenance.ts", async (original) => {
	const actual = await original<typeof import("../src/tool-provenance.ts")>();
	const capture = vi.fn(
		async (
			_root: string,
			probe: NativeVersionProbe,
			environment?: Readonly<Record<string, string | undefined>>,
		) => {
			control.environment = environment;
			for (const name of ["cargo", "rustc", "cargo-deny"]) {
				const result = await probe(`/invented-tools/${name}`, ["--version"]);
				expect(result.code).toBe(0);
			}
			return Object.freeze({ digest: "3".repeat(64) });
		},
	);
	const toolPath = vi.fn(
		async (_snapshot: NativeToolProvenance, name: NativeToolName) =>
			control.toolPaths?.[name] ?? `/invented-tools/${name}`,
	);
	const unchanged = vi.fn(async (_snapshot: NativeToolProvenance) => undefined);
	return {
		...actual,
		captureNativeToolProvenance: capture,
		nativeToolPath: toolPath,
		assertNativeToolsUnchanged: unchanged,
		createNativeToolProvenanceSource: vi.fn(() => {
			const owner = actual.createNativeToolProvenanceSource(),
				real = control.realToolCapture;
			return Object.freeze({
				capture: (
					root: string,
					probe: NativeVersionProbe,
					environment?: Readonly<Record<string, string | undefined>>,
				) => (real ? owner.capture(root, probe, environment) : capture(root, probe, environment)),
				nativeToolPath: (snapshot: NativeToolProvenance, name: NativeToolName) =>
					real ? owner.nativeToolPath(snapshot, name) : toolPath(snapshot, name),
				assertUnchanged: (snapshot: NativeToolProvenance) =>
					real ? owner.assertUnchanged(snapshot) : unchanged(snapshot),
				resourceStatus: owner.resourceStatus,
				closeResources: owner.closeResources,
			});
		}),
	};
});
vi.mock("../src/inputs.ts", async (original) => {
	const actual = await original<typeof import("../src/inputs.ts")>();
	const capture = vi.fn(
		async () =>
			Object.freeze({
				inputDigest: "1".repeat(64),
				lockDigest: "2".repeat(64),
			}) as NativeInputsSnapshot,
	);
	const bind = vi.fn(async () => {
		if (!control.paths) throw new Error("missing invented path bindings");
		return control.paths;
	});
	const unchanged = vi.fn(async () => {
		if (control.inputsChanged) throw new actual.NativeInputsError("INPUTS_CHANGED");
	});
	return {
		...actual,
		captureNativeInputs: capture,
		bindNativeCargoPaths: bind,
		assertNativeInputsUnchanged: unchanged,
		createNativeInputsSource: vi.fn(() => {
			const owner = actual.createNativeInputsSource(),
				real = control.realInputs;
			return Object.freeze({
				capture: (root: string, home: string) => (real ? owner.capture(root, home) : capture()),
				bindCargoPaths: (snapshot: NativeInputsSnapshot, metadata: unknown) =>
					real ? owner.bindCargoPaths(snapshot, metadata) : bind(),
				assertUnchanged: (snapshot: NativeInputsSnapshot) =>
					real ? owner.assertUnchanged(snapshot) : unchanged(),
				resourceStatus: owner.resourceStatus,
				closeResources: owner.closeResources,
			});
		}),
	};
});
vi.mock("../src/database-source.ts", async (original) => {
	const actual = await original<typeof import("../src/database-source.ts")>();
	return {
		...actual,
		createDatabaseSource: vi.fn(() => ({
			observe: vi.fn(async () => Object.freeze({ testOnly: true })),
			revalidate: vi.fn(async () => {
				control.rechecks++;
				if (control.rechecks === control.changedRecheck)
					throw new actual.DatabaseSourceError("DATABASE_SOURCE_CHANGED");
				return Object.freeze({ testOnly: true });
			}),
			basis: vi.fn(() =>
				Object.freeze({
					delivery: "independent-current-head",
					commit: "a".repeat(40),
					currentCommit: "a".repeat(40),
					revision: "b".repeat(64),
					observedAt: Date.now(),
				}),
			),
		})),
	};
});
vi.mock("../src/mobile-http-policy.ts", async (original) => {
	const actual = await original<typeof import("../src/mobile-http-policy.ts")>();
	return {
		...actual,
		proposedMobileHttpConfig: vi.fn((graph: unknown, policyBytes: unknown) => {
			if (control.mobilePolicyMode === "real-guard")
				return actual.proposedMobileHttpConfig(graph, policyBytes);
			// TEST ONLY: the small orchestration graph is never certified as approved553.
			// This fixture preserves the real candidate's exact row transformation only.
			if (
				!Buffer.isBuffer(policyBytes) ||
				createHash("sha256").update(policyBytes).digest("hex") !== FIXTURE_POLICY_SHA
			)
				throw new Error("controlled policy fixture refused");
			const text = policyBytes.toString("utf8");
			if (text.split(REQWEST_DENY_ROW).length !== 2)
				throw new Error("controlled policy fixture row refused");
			return Buffer.from(text.replace(REQWEST_DENY_ROW, ""), "utf8");
		}),
	};
});
vi.mock("../src/native-capture.ts", async () => {
	const evidence = await import("../src/evidence.ts");
	return {
		captureNativeProcess: vi.fn(
			async (owner: EvidenceDirectory, id: string, command: NativeCommand) => {
				control.ids.push(id);
				control.commands.push(command);
				const session = await evidence.beginCapture(owner, id);
				let stdout = "",
					stderr = "";
				if (id.startsWith("tool-version-")) stdout = "invented tool version\n";
				if (id === "locked-metadata") stdout = JSON.stringify(control.metadata);
				const report = auditFixture(control.reportMode, control.findingName);
				if (id === "strict-full" && control.mode !== "missing-summary") stderr = report.fullStderr;
				if (id === "strict-advisory") {
					stdout = report.advisoryStdout;
					stderr = report.advisoryStderr;
				}
				await session.stdout.append(Buffer.from(stdout));
				await session.stderr.append(Buffer.from(stderr));
				const result = await evidence.sealCapture(
					session,
					id === "strict-full" && control.mode === "unconfirmed"
						? { exitCode: null, signal: null, failure: "TREE_UNCONFIRMED" }
						: {
								exitCode:
									id === "strict-full"
										? (control.fullExit ?? report.fullExit)
										: id === "strict-advisory"
											? report.advisoryExit
											: 0,
								signal: null,
								failure: null,
							},
				);
				control.captures.set(id, result);
				if (id === "strict-advisory" && control.mode === "tampered-full") {
					const full = control.captures.get("strict-full");
					if (!full) throw new Error("invented missing full capture");
					await fs.appendFile(path.join(control.evidenceDirectory, full.stdout.file), " ");
				}
				control.afterCapture?.(id);
				return result;
			},
		),
	};
});

import { createDatabaseSource } from "../src/database-source.ts";
import { retainedEvidenceReaderStatus } from "../src/evidence.ts";
import { captureNativeInputs, retainedNativeInputsResourceStatus } from "../src/inputs.ts";
import { proposedMobileHttpConfig } from "../src/mobile-http-policy.ts";
import {
	createNativeAuditSource,
	type NativeAuditSource,
	NativeAuditSourceError,
	type NativeAuditSourceOptions,
} from "../src/native-audit-source.ts";
import { retainedNativeToolResourceStatus } from "../src/tool-provenance.ts";

function syntheticToolBytes(): Buffer {
	const result = Buffer.alloc(512);
	if (process.platform === "linux") {
		result.write("7f454c46", 0, "hex");
		result[4] = 2;
		result[5] = 1;
		result[6] = 1;
		result.writeUInt16LE(3, 16);
		result.writeUInt16LE(62, 18);
		result.writeUInt32LE(1, 20);
		result.writeUInt16LE(64, 52);
	} else {
		result.write("MZ");
		result.writeUInt32LE(128, 60);
		result.writeUInt32LE(0x4550, 128);
		result.writeUInt16LE(0x8664, 132);
		result.writeUInt16LE(240, 148);
		result.writeUInt16LE(2, 150);
		result.writeUInt16LE(0x20b, 152);
	}
	return result;
}
function auditFixture(mode: "pass" | "licenses" | "combined", name: string) {
	const count = (errors = 0) => ({ errors, warnings: 0, notes: 0, helps: 0 });
	const combined = mode === "combined",
		licensed = mode !== "pass";
	const advisory = {
		id: "RUSTSEC-2026-9999",
		package: name,
		informational: "unsound",
		categories: ["memory-corruption"],
		collection: "crates",
		source: null,
		date: "2026-01-01",
		withdrawn: null,
		aliases: [],
		cvss: null,
		description: "invented notice",
		"expect-deleted": false,
		keywords: [],
		license: "CC0-1.0",
		references: [],
		related: [],
		title: "invented notice",
		url: "https://example.invalid/advisory",
	};
	const diagnostic = {
		type: "diagnostic",
		fields: {
			code: "unsound",
			severity: "error",
			message: "invented issue",
			advisory,
			graphs: [{ Krate: { name, version: "1.0.0" } }],
		},
	};
	const diagnostics: unknown[] = [];
	if (combined)
		diagnostics.push(diagnostic, {
			type: "diagnostic",
			fields: { code: "duplicate", severity: "error", message: "invented duplicate" },
		});
	if (licensed)
		diagnostics.push({
			type: "diagnostic",
			fields: { code: "unlicensed", severity: "error", message: "invented license issue" },
		});
	diagnostics.push({
		type: "summary",
		fields: {
			advisories: count(combined ? 1 : 0),
			bans: count(combined ? 1 : 0),
			licenses: count(licensed ? 1 : 0),
			sources: count(),
		},
	});
	const finding = {
		advisory,
		kind: "unsound",
		affected: null,
		package: {
			checksum: null,
			dependencies: [],
			name,
			replace: null,
			source: "registry+https://github.com/rust-lang/crates.io-index",
			version: "1.0.0",
		},
		versions: { patched: [], unaffected: [] },
	};
	const advisoryRows: unknown[] = combined ? [diagnostic] : [];
	advisoryRows.push({ type: "summary", fields: { advisories: count(combined ? 1 : 0) } });
	return {
		fullStderr: `${diagnostics.map((row) => JSON.stringify(row)).join("\n")}\n`,
		advisoryStderr: `${advisoryRows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		advisoryStdout: `${JSON.stringify({ lockfile: { "dependency-count": control.dependencyCount }, settings: { ignore: [], informational_warnings: ["notice", "unmaintained", "unsound"], severity: null, target_arch: [], target_os: [] }, vulnerabilities: [], warnings: combined ? { unsound: [finding] } : {} })}\n`,
		fullExit: combined ? 7 : licensed ? 4 : 0,
		advisoryExit: combined ? 1 : 0,
	};
}
function graphFixture(
	repository: string,
	changed = false,
): { metadata: Record<string, unknown>; paths: ValidatedCargoPaths } {
	const base = repository.replaceAll("\\", "/"),
		registry = "registry+https://github.com/rust-lang/crates.io-index";
	const target = (name: string, directory: string) => ({
		name,
		kind: ["lib"],
		crate_types: ["lib"],
		src_path: `${base}/${directory}/src/lib.rs`,
		edition: "2021",
		doc: true,
		doctest: true,
		test: true,
	});
	const rootTarget = target("invented-root", "crates/invented-root");
	const dependency = {
		name: "invented-crate",
		source: registry,
		req: "*",
		kind: null,
		rename: null,
		optional: false,
		uses_default_features: true,
		features: [],
		target: null,
		registry: null,
	};
	const packages = [
		{
			id: "root",
			name: "invented-root",
			version: "0.0.0",
			source: null,
			manifest_path: `${base}/crates/invented-root/Cargo.toml`,
			dependencies: [dependency],
			targets: [rootTarget],
			features: { default: [], changed: [] },
			license: "MIT",
			edition: "2021",
			rust_version: "1.95",
			links: null,
			default_run: null,
		},
		{
			id: "dep",
			name: "invented-crate",
			version: "1.0.0",
			source: registry,
			manifest_path: `${base}/cache/invented-crate/Cargo.toml`,
			dependencies: [],
			targets: [target("invented-crate", "cache/invented-crate")],
			features: { default: [] },
			license: "MIT",
			edition: "2021",
			rust_version: "1.95",
			links: null,
			default_run: null,
		},
	];
	return {
		metadata: {
			version: 1,
			packages,
			workspace_members: ["root"],
			workspace_default_members: ["root"],
			workspace_root: `${base}/crates`,
			target_directory: `${base}/target`,
			build_directory: `${base}/target`,
			metadata: null,
			resolve: {
				root: null,
				nodes: [
					{
						id: "root",
						features: changed ? ["changed"] : [],
						dependencies: ["dep"],
						deps: [
							{ name: "invented_crate", pkg: "dep", dep_kinds: [{ kind: null, target: null }] },
						],
					},
					{ id: "dep", features: [], dependencies: [], deps: [] },
				],
			},
		},
		paths: {
			rootIds: ["root"],
			workspacePackages: [
				{
					id: "root",
					manifestPath: "crates/invented-root/Cargo.toml",
					targets: [
						{
							name: rootTarget.name,
							kinds: rootTarget.kind,
							sourcePath: rootTarget.src_path,
							relativePath: "crates/invented-root/src/lib.rs",
						},
					],
				},
			],
		},
	};
}

let temporary: string;
let selected: NativeAuditSourceOptions;
let source: NativeAuditSource;
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function physicalInputGraph(repository: string): Promise<Record<string, unknown>> {
	for (const file of ["crates/Cargo.toml", "crates/Cargo.lock", "rust-toolchain.toml"])
		await fs.writeFile(path.join(repository, file), `# invented ${file}\n`);
	const packages: Record<string, unknown>[] = [];
	for (const [directory, name] of [
		["crates/draftyak-protocol", "draftyak-protocol"],
		["crates/draftyak-desktop-pairing", "draftyak-desktop-pairing"],
		["crates/draftyak-transport", "draftyak-transport"],
		["apps/app/src-tauri", "draftyak-desktop"],
	] as const) {
		await fs.mkdir(path.join(repository, directory, "src"), { recursive: true });
		await fs.writeFile(
			path.join(repository, directory, "Cargo.toml"),
			`[package]\nname = "${name}"\nversion = "0.0.0"\n`,
		);
		await fs.writeFile(
			path.join(repository, directory, "src/lib.rs"),
			"// invented target, never opened\n",
		);
		packages.push({
			id: `path+${repository.replaceAll("\\", "/")}/${directory}#${name}@0.0.0`,
			name,
			version: "0.0.0",
			source: null,
			manifest_path: path.join(repository, directory, "Cargo.toml"),
			dependencies: [],
			targets: [
				{
					name: name.replaceAll("-", "_"),
					kind: ["lib"],
					crate_types: ["lib"],
					src_path: path.join(repository, directory, "src/lib.rs"),
					edition: "2024",
					doc: true,
					doctest: true,
					test: true,
				},
			],
			features: {},
			license: "MIT",
			edition: "2024",
			rust_version: "1.95",
			links: null,
			default_run: null,
		});
	}
	const ids = packages.map((row) => row.id);
	control.dependencyCount = packages.length;
	return {
		version: 1,
		packages,
		workspace_members: ids,
		workspace_default_members: ids,
		workspace_root: path.join(repository, "crates"),
		target_directory: path.join(repository, "target"),
		build_directory: path.join(repository, "target"),
		metadata: null,
		resolve: {
			root: null,
			nodes: ids.map((id) => ({ id, features: [], dependencies: [], deps: [] })),
		},
	};
}
beforeEach(async () => {
	vi.clearAllMocks();
	control.ids = [];
	control.commands = [];
	control.captures.clear();
	control.mode = "good";
	control.mobilePolicyMode = "orchestration-fixture";
	control.rechecks = 0;
	control.changedRecheck = 0;
	control.inputsChanged = false;
	control.closeFault = false;
	control.closeAttempts = 0;
	control.physicalCloses = 0;
	control.readGate = undefined;
	control.readEntered = undefined;
	control.afterCapture = undefined;
	control.environment = undefined;
	control.reportMode = "pass";
	control.findingName = "invented-crate";
	control.fullExit = undefined;
	control.realToolCapture = false;
	control.toolFile = "";
	control.toolCloseFault = false;
	control.toolCloseAttempts = 0;
	control.toolPhysicalCloses = 0;
	control.toolHandle = undefined;
	control.toolOriginalClose = undefined;
	control.toolPaths = undefined;
	control.realInputs = false;
	control.inputFile = "";
	control.inputCloseFault = false;
	control.inputCloseAttempts = 0;
	control.inputPhysicalCloses = 0;
	control.inputHandle = undefined;
	control.inputOriginalClose = undefined;
	control.dependencyCount = 2;
	temporary = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), "draftyak-native-audit-unit-")),
	);
	const repositoryRoot = path.join(temporary, "checkout"),
		cargoHome = path.join(temporary, "cargo-home"),
		cache = path.join(temporary, "public-db");
	await fs.mkdir(path.join(repositoryRoot, "crates"), { recursive: true });
	await fs.mkdir(cargoHome);
	await fs.mkdir(cache);
	const databaseRoot = path.join(cache, "advisory-db-3157b0e258782691");
	await fs.mkdir(databaseRoot);
	await fs.copyFile(
		new URL("./fixtures/mobile-http-approved-policy.toml", import.meta.url),
		path.join(repositoryRoot, "crates/deny.toml"),
	);
	selected = {
		repositoryRoot,
		databaseRoot,
		cargoHome,
		evidenceDirectory: path.join(temporary, "audit-data"),
		environment: {
			CARGO_HOME: cargoHome,
			CARGO_NET_OFFLINE: "true",
			CARGO_TERM_COLOR: "never",
			NO_COLOR: "1",
		},
	};
	control.evidenceDirectory = selected.evidenceDirectory;
	const graph = graphFixture(repositoryRoot);
	control.metadata = graph.metadata;
	control.paths = graph.paths;
	source = createNativeAuditSource(selected);
});
afterEach(async () => {
	vi.restoreAllMocks();
	control.closeFault = false;
	expect(retainedEvidenceReaderStatus()).toEqual({ active: 0, pending: 0 });
	expect(retainedNativeToolResourceStatus().complete).toBe(true);
	expect(retainedNativeInputsResourceStatus().complete).toBe(true);
	// Each case explicitly closes its source. No afterEach close retry masks a fault.
	const resolved = await fs.realpath(temporary),
		parent = await fs.realpath(os.tmpdir());
	expect(path.dirname(resolved)).toBe(parent);
	expect(path.basename(resolved)).toMatch(/^draftyak-native-audit-unit-[A-Za-z0-9_-]+$/);
	expect((await fs.lstat(resolved)).isSymbolicLink()).toBe(false);
	await fs.rm(resolved, { recursive: true });
	await expect(fs.lstat(resolved)).rejects.toMatchObject({ code: "ENOENT" });
});

describe("same-root audit data orchestration with controlled tool/input/R/policy fixtures", () => {
	it.each(["cargo", "cargo-deny"] as const)(
		"refuses a different captured %s before input or audit work",
		async (role) => {
			const expectedCargo = path.join(temporary, "selected-cargo");
			const expectedDeny = path.join(temporary, "selected-deny");
			control.toolPaths = {
				cargo: expectedCargo,
				"cargo-deny": expectedDeny,
				[role]: path.join(temporary, "different-tool"),
			};
			const constrained = createNativeAuditSource({ ...selected, expectedCargo, expectedDeny });
			try {
				await expect(constrained.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_CHANGED" });
				expect(captureNativeInputs).not.toHaveBeenCalled();
				expect(control.ids).toEqual(["tool-version-0", "tool-version-1", "tool-version-2"]);
				expect(createDatabaseSource).not.toHaveBeenCalled();
			} finally {
				expect((await constrained.closeResources()).complete).toBe(true);
				expect((await source.closeResources()).complete).toBe(true);
			}
		},
	);
	it("uses the constrained deny only for resolution and preserves child environments", async () => {
		const expectedCargo = path.join(temporary, "selected-cargo");
		const expectedDeny = path.join(temporary, "selected-deny");
		control.toolPaths = { cargo: expectedCargo, "cargo-deny": expectedDeny };
		const constrained = createNativeAuditSource({ ...selected, expectedCargo, expectedDeny });
		try {
			const observation = await constrained.observe();
			expect(control.environment?.DRAFTYAK_CARGO_DENY === expectedDeny).toBe(true);
			for (const command of control.commands) {
				expect(Object.hasOwn(command.env, "DRAFTYAK_CARGO_DENY")).toBe(false);
				expect(command.env).toEqual(selected.environment);
			}
			expect(
				control.commands.find((command) => command.args[0] === "metadata")?.executable ===
					expectedCargo,
			).toBe(true);
			await constrained.revalidate(observation);
		} finally {
			expect((await constrained.closeResources()).complete).toBe(true);
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it.each(["expectedCargo", "expectedDeny"])(
		"refuses relative or accessor %s without IO",
		async (key) => {
			try {
				expect(() => createNativeAuditSource({ ...selected, [key]: "relative-tool" })).toThrow();
				const getter = vi.fn(() => path.join(temporary, "selected-tool"));
				const input = Object.defineProperty({ ...selected }, key, {
					get: getter,
					enumerable: true,
				});
				expect(() => createNativeAuditSource(input)).toThrow();
				expect(getter).not.toHaveBeenCalled();
				expect(control.ids).toEqual([]);
			} finally {
				expect((await source.closeResources()).complete).toBe(true);
			}
		},
	);
	it("refuses the real fixed graph guard before config, database or audit dispatch", async () => {
		control.mobilePolicyMode = "real-guard";
		try {
			const refused = await source.observe().then(
				() => false,
				(error: unknown) =>
					error instanceof NativeAuditSourceError && error.code === "NATIVE_AUDIT_CHANGED",
			);
			expect(refused).toBe(true);
			expect(proposedMobileHttpConfig).toHaveBeenCalledTimes(1);
			const graph = vi.mocked(proposedMobileHttpConfig).mock.calls[0]?.[0];
			expect(
				typeof graph === "object" &&
					graph !== null &&
					"packageCount" in graph &&
					graph.packageCount === 2,
			).toBe(true);
			let configAbsent = false;
			try {
				await fs.lstat(path.join(selected.evidenceDirectory, "strict-deny.toml"));
			} catch (error) {
				configAbsent =
					typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
			}
			expect(configAbsent).toBe(true);
			expect(createDatabaseSource).toHaveBeenCalledTimes(0);
			expect(
				control.ids.filter((id) => id === "strict-full" || id === "strict-advisory").length,
			).toBe(0);
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("binds real captured input snapshots before their post-metadata unchanged checks", async () => {
		await source.closeResources();
		control.metadata = await physicalInputGraph(selected.repositoryRoot);
		control.realInputs = true;
		source = createNativeAuditSource(selected);
		try {
			const observation = await source.observe(),
				data = source.data(observation);
			expect(data.strictPass).toBe(true);
			expect(data.inputDigest).toMatch(/^[a-f0-9]{64}$/);
			expect(control.ids).toContain("locked-metadata");
			expect(control.ids).toContain("strict-full");
			await source.revalidate(observation);
			expect(source.data(observation)).toBe(data);
		} finally {
			expect(await source.closeResources()).toMatchObject({
				complete: true,
				activeInputOperations: 0,
				pendingInputFiles: 0,
			});
		}
	});
	it("includes an actual input FileHandle close refusal in aggregate resource completion", async () => {
		await source.closeResources();
		control.metadata = await physicalInputGraph(selected.repositoryRoot);
		control.realInputs = true;
		control.inputFile = path.join(selected.repositoryRoot, "crates/Cargo.toml");
		control.inputCloseFault = true;
		source = createNativeAuditSource(selected);
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_INVALID" });
			const handle = control.inputHandle;
			if (!handle) throw new Error("expected actual synthetic input FileHandle");
			expect(handle.fd).toBeGreaterThanOrEqual(0);
			expect(control.inputCloseAttempts).toBe(1);
			expect(control.inputPhysicalCloses).toBe(0);
			expect(control.ids).not.toContain("locked-metadata");
			const pending = await source.closeResources();
			expect(pending).toMatchObject({
				complete: false,
				activeOperations: 0,
				activeInputOperations: 0,
				pendingInputFiles: 1,
				pendingFiles: 1,
			});
			expect(control.inputCloseAttempts).toBe(2);
			expect(handle.fd).toBeGreaterThanOrEqual(0);
			control.inputCloseFault = false;
			expect(await source.closeResources()).toMatchObject({
				complete: true,
				activeInputOperations: 0,
				pendingInputFiles: 0,
				pendingFiles: 0,
			});
			expect(control.inputCloseAttempts).toBe(3);
			expect(control.inputPhysicalCloses).toBe(1);
			expect(handle.fd).toBe(-1);
			expect(pending.complete).toBe(false);
		} finally {
			control.inputCloseFault = false;
			const cleanup = await source.closeResources();
			try {
				expect(cleanup.complete).toBe(true);
			} finally {
				if (control.inputHandle && control.inputHandle.fd >= 0)
					await control.inputOriginalClose?.();
			}
		}
	});
	it("includes an actual provenance FileHandle close refusal in aggregate resource completion", async () => {
		await source.closeResources();
		const directory = path.join(temporary, "synthetic-tools");
		await fs.mkdir(directory);
		const suffix = process.platform === "linux" ? "" : ".exe";
		for (const name of ["cargo", "rustc", "cargo-deny"]) {
			const file = path.join(directory, name + suffix);
			await fs.writeFile(file, syntheticToolBytes());
			await fs.chmod(file, 0o755);
		}
		control.realToolCapture = true;
		control.toolFile = path.join(directory, "cargo" + suffix);
		control.toolCloseFault = true;
		source = createNativeAuditSource({
			...selected,
			evidenceDirectory: path.join(temporary, "provenance-close-data"),
			environment: { ...selected.environment, PATH: directory },
		});
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_CHANGED" });
			if (process.platform !== "win32" && process.platform !== "linux") {
				expect(control.toolHandle).toBeUndefined();
				return;
			}
			const handle = control.toolHandle;
			if (!handle) throw new Error("expected actual synthetic provenance FileHandle");
			expect(handle.fd).toBeGreaterThanOrEqual(0);
			expect(control.toolCloseAttempts).toBe(1);
			expect(control.toolPhysicalCloses).toBe(0);
			expect(control.ids).toEqual([]);
			const pending = await source.closeResources();
			expect(pending).toMatchObject({
				complete: false,
				activeOperations: 0,
				activeToolOperations: 0,
				pendingToolFiles: 1,
				pendingFiles: 1,
				dataRetained: true,
			});
			expect(control.toolCloseAttempts).toBe(2);
			expect(control.toolPhysicalCloses).toBe(0);
			expect(handle.fd).toBeGreaterThanOrEqual(0);
			control.toolCloseFault = false;
			expect(await source.closeResources()).toMatchObject({
				complete: true,
				activeToolOperations: 0,
				pendingToolFiles: 0,
				pendingFiles: 0,
				dataRetained: true,
			});
			expect(control.toolCloseAttempts).toBe(3);
			expect(control.toolPhysicalCloses).toBe(1);
			expect(handle.fd).toBe(-1);
			expect(pending.complete).toBe(false);
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_CLOSED" });
		} finally {
			control.toolCloseFault = false;
			const cleanup = await source.closeResources();
			try {
				expect(cleanup.complete).toBe(true);
			} finally {
				if (control.toolHandle && control.toolHandle.fd >= 0) await control.toolOriginalClose?.();
			}
		}
	});
	it("constructs without IO and refuses accessor or unknown configuration fields", async () => {
		try {
			expect(control.ids).toEqual([]);
			await expect(fs.lstat(selected.evidenceDirectory)).rejects.toMatchObject({ code: "ENOENT" });
			let accessed = 0;
			const invalid = {
				...selected,
				get approved() {
					accessed++;
					return true;
				},
			};
			expect(() => createNativeAuditSource(invalid)).toThrow();
			expect(accessed).toBe(0);
			expect(() =>
				createNativeAuditSource({
					...selected,
					environment: { ...selected.environment, HTTPS_PROXY: "https://example.invalid" },
				}),
			).toThrow();
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("binds sealed fixture captures, preserves every other policy byte and returns data only", async () => {
		try {
			const observation = await source.observe(),
				data = source.data(observation);
			expect(data).toMatchObject({
				kind: "SAME_ROOT_STRICT_AUDIT_DATA",
				authority: false,
				reusableNativeSourceBasis: false,
				strictPass: true,
			});
			expect(data.report.complete).toBe(true);
			expect(data.policySha256 === FIXTURE_POLICY_SHA).toBe(true);
			expect(data.captures).toHaveLength(6);
			expect(data.graph.packageCount).toBe(2);
			expect(data.graph.ancestorDigests).toEqual([]);
			expect(data.graphDigest).toBe(data.graph.digest);
			expect(Object.isFrozen(control.environment)).toBe(true);
			for (const command of control.commands) expect(command.env).toBe(control.environment);
			expect(createDatabaseSource).toHaveBeenCalledWith({ databaseRoot: selected.databaseRoot });
			expect(Object.isFrozen(data.report.counts)).toBe(true);
			expect(control.ids).toEqual([
				"tool-version-0",
				"tool-version-1",
				"tool-version-2",
				"locked-metadata",
				"strict-full",
				"strict-advisory",
			]);
			const metadata = control.commands[3],
				full = control.commands[4],
				advisory = control.commands[5];
			expect(metadata?.args).toContain("--all-features");
			expect(metadata?.args).toContain("--locked");
			expect(metadata?.args).toContain("--offline");
			expect(full?.args).not.toContain("--audit-compatible-output");
			expect(advisory?.args.slice(-2)).toEqual(["--audit-compatible-output", "advisories"]);
			const config = await fs.readFile(
					path.join(selected.evidenceDirectory, "strict-deny.toml"),
					"utf8",
				),
				original = await fs.readFile(
					path.join(selected.repositoryRoot, "crates/deny.toml"),
					"utf8",
				);
			expect(config).toContain("ignore = []\n");
			expect(config).toContain(
				`db-path = ${JSON.stringify(path.dirname(selected.databaseRoot).replaceAll("\\", "/"))}\n`,
			);
			expect(config).toContain('db-urls = ["https://github.com/RustSec/advisory-db"]\n');
			const oldIgnore = original.slice(
				original.indexOf("ignore = [\n"),
				original.indexOf("\n]\n", original.indexOf("ignore = [\n")) + 3,
			);
			const inverse = config
				.replace(/^db-path = .*\ndb-urls = .*\n/mu, "")
				.replace("ignore = []\n", oldIgnore);
			expect(original.split(REQWEST_DENY_ROW).length).toBe(2);
			expect(config.includes(REQWEST_DENY_ROW)).toBe(false);
			expect(inverse === original.replace(REQWEST_DENY_ROW, "")).toBe(true);
			expect(Buffer.byteLength(original) - Buffer.byteLength(inverse)).toBe(26);
			await source.revalidate(observation);
			expect(control.rechecks).toBe(7);
			expect(source.data(observation)).toBe(data);
			expect(JSON.stringify(data)).not.toContain(temporary);
			const other = createNativeAuditSource({
				...selected,
				evidenceDirectory: path.join(temporary, "other-data"),
			});
			expect(() => other.data(observation)).toThrow();
			expect((await other.closeResources()).complete).toBe(true);
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
		expect((await fs.lstat(selected.databaseRoot)).isDirectory()).toBe(true);
	});
	it.each([
		["licenses", 4, 0],
		["combined", 7, 1],
	] as const)(
		"retains complete %s diagnostic data with actual exit pair %d/%d",
		async (mode, fullExit, advisoryExit) => {
			control.reportMode = mode;
			try {
				const data = source.data(await source.observe());
				expect(data).toMatchObject({
					authority: false,
					reusableNativeSourceBasis: false,
					strictPass: false,
				});
				expect(data.report).toMatchObject({
					complete: true,
					fullExitCode: fullExit,
					advisoryExitCode: advisoryExit,
				});
				expect(data.captures.find((row) => row.id === "strict-full")?.exitCode).toBe(fullExit);
				expect(data.captures.find((row) => row.id === "strict-advisory")?.exitCode).toBe(
					advisoryExit,
				);
				expect(data.report.counts.licenses.errors).toBe(1);
				if (mode === "combined") {
					expect(data.graph.ancestorDigests).toHaveLength(1);
					expect(data.graph.ancestorDigests[0]).toMatchObject({
						target: {
							source: "registry+https://github.com/rust-lang/crates.io-index",
							name: "invented-crate",
							version: "1.0.0",
						},
						packageCount: 2,
					});
					expect(data.graph.ancestorDigests[0]?.digest).toMatch(/^[a-f0-9]{64}$/);
				} else expect(data.graph.ancestorDigests).toEqual([]);
			} finally {
				expect((await source.closeResources()).complete).toBe(true);
			}
		},
	);
	it("passes one frozen environment to resolution and every command, binding changed maps by digest only", async () => {
		const mutable = selected.environment as Record<string, string>;
		mutable.PATH = path.join(temporary, "different-tools");
		let other: NativeAuditSource | undefined;
		try {
			const before = source.data(await source.observe());
			expect(control.environment?.PATH).toBeUndefined();
			for (const command of control.commands) expect(command.env).toBe(control.environment);
			other = createNativeAuditSource({
				...selected,
				evidenceDirectory: path.join(temporary, "changed-environment"),
			});
			const after = other.data(await other.observe());
			expect(control.environment?.PATH).toBe(mutable.PATH);
			expect(after.environmentDigest).not.toBe(before.environmentDigest);
			expect(JSON.stringify(after)).not.toContain(mutable.PATH);
			expect(() =>
				createNativeAuditSource({
					...selected,
					environment: { ...selected.environment, CARGO_HOME: temporary },
				}),
			).toThrow();
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
			if (other) expect((await other.closeResources()).complete).toBe(true);
		}
	});
	it("refuses a complete report whose affected identity is absent from the retained metadata", async () => {
		control.reportMode = "combined";
		control.findingName = "missing-crate";
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_INVALID" });
			expect(control.ids.slice(-2)).toEqual(["strict-full", "strict-advisory"]);
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("binds synthetic feature ancestor paths under the explicit unit policy seam", async () => {
		control.reportMode = "combined";
		let other: NativeAuditSource | undefined;
		try {
			const before = source.data(await source.observe());
			control.metadata = graphFixture(selected.repositoryRoot, true).metadata;
			other = createNativeAuditSource({
				...selected,
				evidenceDirectory: path.join(temporary, "changed-graph"),
			});
			const after = other.data(await other.observe());
			expect(after.graphDigest).not.toBe(before.graphDigest);
			expect(after.graph.ancestorDigests[0]?.digest).not.toBe(
				before.graph.ancestorDigests[0]?.digest,
			);
			expect(after.graph.ancestorDigests[0]?.packageCount).toBe(2);
			expect(Object.isFrozen(after.graph.ancestorDigests[0]?.tuplePayload)).toBe(true);
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
			if (other) expect((await other.closeResources()).complete).toBe(true);
		}
	});
	it("leaves out-of-range exits to the complete report parser and refuses them", async () => {
		control.fullExit = 16;
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_INCOMPLETE" });
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("refuses changed R after full completion before dispatching advisory", async () => {
		control.changedRecheck = 2;
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_CHANGED" });
			expect(control.ids).toContain("strict-full");
			expect(control.ids).not.toContain("strict-advisory");
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("refuses changed inputs without dispatching either audit", async () => {
		control.afterCapture = (id) => {
			if (id === "locked-metadata") control.inputsChanged = true;
		};
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_CHANGED" });
			expect(control.ids).not.toContain("strict-full");
			expect(control.ids).not.toContain("strict-advisory");
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("refuses a changed original policy instead of broadening its transformation", async () => {
		await fs.appendFile(path.join(selected.repositoryRoot, "crates/deny.toml"), "\n");
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_CHANGED" });
			expect(control.ids).not.toContain("strict-full");
			expect(proposedMobileHttpConfig).toHaveBeenCalledTimes(0);
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("refuses missing full statistics even when both supplied exit codes are zero", async () => {
		control.mode = "missing-summary";
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_INCOMPLETE" });
			expect(control.ids.slice(-2)).toEqual(["strict-full", "strict-advisory"]);
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("rereads the original sealed full capture and refuses later byte replacement", async () => {
		control.mode = "tampered-full";
		try {
			await expect(source.observe()).rejects.toMatchObject({
				code: "NATIVE_AUDIT_RESOURCE_PENDING",
			});
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("preserves unconfirmed subprocess state without another native dispatch or data deletion", async () => {
		control.mode = "unconfirmed";
		await expect(source.observe()).rejects.toMatchObject({
			code: "NATIVE_AUDIT_PROCESS_UNCONFIRMED",
		});
		expect(control.ids).not.toContain("strict-advisory");
		expect(await source.closeResources()).toMatchObject({
			complete: false,
			processUnconfirmed: true,
			pendingFiles: 0,
			pendingReaders: 0,
			dataRetained: true,
		});
		expect((await fs.lstat(selected.databaseRoot)).isDirectory()).toBe(true);
	});
	it("does not dispatch advisory after the original one-hour observation window expires", async () => {
		const now = Date.now();
		let expired = false;
		vi.spyOn(Date, "now").mockImplementation(() => now + (expired ? 3_600_000 : 0));
		control.afterCapture = (id) => {
			if (id === "strict-full") expired = true;
		};
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_STALE" });
			expect(control.ids).not.toContain("strict-advisory");
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("refuses backward checked wall time even when it remains after the operation start", async () => {
		const base = Date.now();
		let now = base;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		control.afterCapture = (id) => {
			if (id === "tool-version-0") now = base + 10;
			if (id === "locked-metadata") now = base + 9;
		};
		try {
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_STALE" });
			expect(control.ids).toContain("locked-metadata");
			expect(control.ids).not.toContain("strict-full");
		} finally {
			expect((await source.closeResources()).complete).toBe(true);
		}
	});
	it("keeps a failed reader close pending, with one explicit scoped attempt and no hidden retry", async () => {
		control.closeFault = true;
		try {
			await expect(source.observe()).rejects.toMatchObject({
				code: "NATIVE_AUDIT_RESOURCE_PENDING",
			});
			expect(control.closeAttempts).toBe(1);
			expect(retainedEvidenceReaderStatus()).toEqual({ active: 0, pending: 1 });
			const pending = await source.closeResources();
			expect(control.closeAttempts).toBe(2);
			expect(pending).toMatchObject({ complete: false, pendingReaders: 1, dataRetained: true });
			expect(control.ids).not.toContain("strict-advisory");
			control.closeFault = false;
			expect((await source.closeResources()).complete).toBe(true);
			expect(control.closeAttempts).toBe(3);
			expect(pending.pendingReaders).toBe(1);
			expect(pending.complete).toBe(false);
			await expect(source.observe()).rejects.toMatchObject({ code: "NATIVE_AUDIT_CLOSED" });
		} finally {
			control.closeFault = false;
		}
	});
	it("joins a held real reader before closing and blocks any later audit dispatch", async () => {
		const held = deferred(),
			release = deferred();
		control.readGate = release.promise;
		control.readEntered = held.resolve;
		const operation = source.observe().then(
			() => ({ accepted: true }),
			(error) => ({ accepted: false, error }),
		);
		try {
			await held.promise;
			const close = source.closeResources();
			await Promise.resolve();
			expect(control.closeAttempts).toBe(0);
			expect(retainedEvidenceReaderStatus().active).toBe(1);
			release.resolve();
			const outcome = await operation;
			expect(outcome.accepted).toBe(false);
			expect(await close).toMatchObject({
				complete: true,
				activeOperations: 0,
				activeReaders: 0,
				pendingReaders: 0,
			});
			expect(control.closeAttempts).toBe(1);
			expect(control.physicalCloses).toBe(1);
			expect(control.ids).not.toContain("strict-advisory");
		} finally {
			release.resolve();
			await operation;
		}
	});
});
