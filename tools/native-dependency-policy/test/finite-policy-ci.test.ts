import { constants, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CURRENT_FINITE_GRAPH_TERM } from "../src/decision.ts";
import type { NativeInputsSnapshot } from "../src/inputs.ts";
import type { NativeCommand } from "../src/native-capture.ts";
import type {
	NativeToolName,
	NativeToolProvenance,
	NativeVersionProbe,
} from "../src/tool-provenance.ts";

// Hermetic orchestration fixtures only: every native seam and the graph/guard
// are mocked. Real owned files exercise the bridge's config FileHandle lifetime.
// These fixtures establish no genuine native result, graph approval or basis.
const control = vi.hoisted(() => ({
	root: "",
	parent: "",
	repo: "",
	home: "",
	temporary: "",
	cargo: "",
	deny: "",
	lock: "",
	acceptedGraph: Object.freeze({ fixtureGraph: true }),
	boundMetadata: undefined as unknown,
	wrongGraph: false,
	mutateInputAtGuard: false,
	mutationDetected: false,
	denyExit: 0,
	treeUnconfirmed: false,
	captureIds: [] as string[],
	guardCalls: 0,
	projectorCalls: 0,
	inputFactories: 0,
	toolFactories: 0,
	inputCloseCalls: 0,
	toolCloseCalls: 0,
	readerCloseCalls: 0,
	inputCloseFinished: false,
	toolCloseFinished: false,
	inputCloseGate: undefined as Promise<void> | undefined,
	inputCloseEntered: undefined as (() => void) | undefined,
	configWriteOpens: 0,
	configCloseAttempts: 0,
	physicalConfigCloses: 0,
	configCloseFault: false,
	configHandle: undefined as fs.FileHandle | undefined,
	configFallbackClose: undefined as (() => Promise<void>) | undefined,
	resolutionInputJoined: false,
	childEnvironmentSafe: true,
}));

vi.mock("node:fs/promises", async (original) => {
	const actual = await original<typeof import("node:fs/promises")>();
	return {
		...actual,
		open: async (...args: Parameters<typeof actual.open>) => {
			const handle = await actual.open(...args);
			if (
				typeof args[0] === "string" &&
				(args[0].endsWith("/finite-deny.toml") || args[0].endsWith("\\finite-deny.toml")) &&
				typeof args[1] === "number" &&
				(args[1] & constants.O_CREAT) !== 0
			) {
				control.configWriteOpens++;
				const close = handle.close.bind(handle);
				if (control.configCloseFault) {
					control.configHandle = handle;
					// Cleanup retains the original method on this exact actual FileHandle.
					control.configFallbackClose = close;
				}
				handle.close = async () => {
					control.configCloseAttempts++;
					if (control.configCloseFault)
						throw new Error("fixture close refused before physical close");
					await close();
					control.physicalConfigCloses++;
				};
			}
			return handle;
		},
	};
});
vi.mock("../src/inputs.ts", () => ({
	createNativeInputsSource: vi.fn(() => {
		control.inputFactories++;
		let snapshot: NativeInputsSnapshot | undefined,
			original: Buffer | undefined,
			bound = false;
		const resourceStatus = () => ({ activeOperations: 0, pendingFiles: 0, complete: true });
		return {
			capture: async () => {
				original = await fs.readFile(control.lock);
				snapshot = Object.freeze({
					inputDigest: "1".repeat(64),
					lockDigest: "2".repeat(64),
				}) as NativeInputsSnapshot;
				return snapshot;
			},
			bindCargoPaths: async (value: NativeInputsSnapshot, metadata: unknown) => {
				if (value !== snapshot) throw new Error("fixture snapshot mismatch");
				control.boundMetadata = metadata;
				bound = true;
				return Object.freeze({ fixturePaths: true });
			},
			assertUnchanged: async (value: NativeInputsSnapshot) => {
				if (!bound || value !== snapshot || !original) throw new Error("fixture phase mismatch");
				if (!(await fs.readFile(control.lock)).equals(original)) {
					control.mutationDetected = true;
					throw new Error("fixture original input changed");
				}
			},
			resourceStatus,
			closeResources: async () => {
				control.inputCloseCalls++;
				control.inputCloseEntered?.();
				await control.inputCloseGate;
				control.inputCloseFinished = true;
				return resourceStatus();
			},
		};
	}),
}));
vi.mock("../src/tool-provenance.ts", () => ({
	createNativeToolProvenanceSource: vi.fn(() => {
		control.toolFactories++;
		const resourceStatus = () => ({ activeOperations: 0, pendingFiles: 0, complete: true });
		return {
			capture: async (
				_root: string,
				probe: NativeVersionProbe,
				environment: Readonly<Record<string, string | undefined>>,
			) => {
				control.resolutionInputJoined = environment.DRAFTYAK_CARGO_DENY === control.deny;
				for (const name of ["cargo", "rustc", "cargo-deny"] as const) {
					const file =
						name === "cargo"
							? control.cargo
							: name === "cargo-deny"
								? control.deny
								: path.join(control.root, "rustc");
					if ((await probe(file, ["--version"])).code !== 0)
						throw new Error("fixture version refused");
				}
				return Object.freeze({ digest: "3".repeat(64) }) as NativeToolProvenance;
			},
			nativeToolPath: async (_snapshot: NativeToolProvenance, name: NativeToolName) =>
				name === "cargo" ? control.cargo : control.deny,
			assertUnchanged: async () => undefined,
			resourceStatus,
			closeResources: async () => {
				control.toolCloseCalls++;
				control.toolCloseFinished = true;
				return resourceStatus();
			},
		};
	}),
}));
vi.mock("../src/evidence.ts", () => ({
	createEvidenceDirectory: vi.fn(async ({ directory }: { directory: string }) => {
		await fs.mkdir(directory);
		return Object.freeze({ runId: "fixture-capture-owner" });
	}),
	evidenceReaderStatus: vi.fn(() => ({ active: 0, pending: 0 })),
	closeEvidenceReaders: vi.fn(async () => {
		control.readerCloseCalls++;
		return { active: 0, pending: 0, attempted: 0, closed: 0 };
	}),
	readCapturedBytes: vi.fn(async (_owner: unknown, result: { id: string }, stream: string) =>
		Buffer.from(
			result.id === "full-locked-metadata" && stream === "stdout"
				? '{"fixtureMetadata":true}'
				: "fixture-output",
		),
	),
}));
vi.mock("../src/native-capture.ts", () => ({
	captureNativeProcess: vi.fn(
		async (owner: { runId: string }, id: string, command: NativeCommand) => {
			control.captureIds.push(id);
			control.childEnvironmentSafe &&= !Object.hasOwn(command.env, "DRAFTYAK_CARGO_DENY");
			const deny = id === "finite-policy-check";
			return Object.freeze({
				runId: owner.runId,
				id,
				exitCode: deny ? control.denyExit : 0,
				signal: null,
				failure: deny && control.treeUnconfirmed ? "TREE_UNCONFIRMED" : null,
				stdout: { file: "fixture.stdout", bytes: 0, sha256: "4".repeat(64) },
				stderr: { file: "fixture.stderr", bytes: 0, sha256: "5".repeat(64) },
			});
		},
	),
}));
vi.mock("../src/cargo-graph.ts", () => ({
	projectCargoGraph: vi.fn((metadata: unknown, _paths: unknown, targets: readonly unknown[]) => {
		control.projectorCalls++;
		if (metadata !== control.boundMetadata || targets.length !== 0)
			throw new Error("fixture producer mismatch");
		return control.wrongGraph ? Object.freeze({ fixtureGraph: false }) : control.acceptedGraph;
	}),
}));
vi.mock("../src/mobile-http-policy.ts", () => ({
	proposedMobileHttpConfig: vi.fn((graph: unknown, bytes: unknown) => {
		control.guardCalls++;
		if (
			graph !== control.acceptedGraph ||
			!Buffer.isBuffer(bytes) ||
			!bytes.equals(Buffer.from("fixture-candidate-policy\n"))
		)
			throw new Error("PROPOSED_HTTP_GRAPH_REFUSED");
		if (control.mutateInputAtGuard) writeFileSync(control.lock, "fixture-mutated-lock\n");
		return Buffer.from("fixture-effective-policy\n");
	}),
}));

import {
	FinitePolicyCiError,
	type FinitePolicyCiOptions,
	runFinitePolicyCi,
} from "../src/finite-policy-ci.ts";

function fixtureOptions(): FinitePolicyCiOptions {
	return {
		repositoryRoot: control.repo,
		cargoHome: control.home,
		cargo: control.cargo,
		deny: control.deny,
		environment: {
			PATH: control.root,
			CARGO_HOME: control.home,
			CARGO: control.cargo,
			CARGO_TERM_COLOR: "never",
			NO_COLOR: "1",
		},
	};
}
// Assertions receive only fabricated predicates/counts, never raw errors, paths,
// environments, metadata or captures, including when the tested function refuses.
async function observed(input: unknown = fixtureOptions()) {
	try {
		return {
			resolved: true,
			code: await runFinitePolicyCi(input as FinitePolicyCiOptions),
			finiteError: false,
			resourcePending: false,
			processUnconfirmed: false,
			complete: null as boolean | null,
			ownFiles: null as number | null,
			activeReaders: null as number | null,
			pendingReaders: null as number | null,
		};
	} catch (error) {
		const finite = error instanceof FinitePolicyCiError,
			resources = finite ? error.resources : null;
		return {
			resolved: false,
			code: null,
			finiteError: finite,
			resourcePending: finite && error.code === "FINITE_POLICY_CI_RESOURCE_PENDING",
			processUnconfirmed: resources?.processUnconfirmed === true,
			complete: resources?.complete ?? null,
			ownFiles: resources?.ownFiles ?? null,
			activeReaders: resources?.activeReaders ?? null,
			pendingReaders: resources?.pendingReaders ?? null,
		};
	}
}

beforeEach(async () => {
	vi.restoreAllMocks();
	vi.clearAllMocks();
	vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-18T13:15:04Z"));
	Object.assign(control, {
		root: "",
		parent: "",
		boundMetadata: undefined,
		wrongGraph: false,
		mutateInputAtGuard: false,
		mutationDetected: false,
		denyExit: 0,
		treeUnconfirmed: false,
		captureIds: [],
		guardCalls: 0,
		projectorCalls: 0,
		inputFactories: 0,
		toolFactories: 0,
		inputCloseCalls: 0,
		toolCloseCalls: 0,
		readerCloseCalls: 0,
		inputCloseFinished: false,
		toolCloseFinished: false,
		inputCloseGate: undefined,
		inputCloseEntered: undefined,
		configWriteOpens: 0,
		configCloseAttempts: 0,
		physicalConfigCloses: 0,
		configCloseFault: false,
		configHandle: undefined,
		configFallbackClose: undefined,
		resolutionInputJoined: false,
		childEnvironmentSafe: true,
	});
	try {
		control.parent = await fs.realpath(os.tmpdir());
		control.root = await fs.realpath(
			await fs.mkdtemp(path.join(control.parent, "draftyak-finite-ci-unit-")),
		);
		control.repo = path.join(control.root, "repo");
		control.home = path.join(control.root, "cargo-home");
		control.temporary = path.join(control.root, "temporary");
		control.cargo = path.join(control.root, "fixture-cargo");
		control.deny = path.join(control.root, "fixture-deny");
		control.lock = path.join(control.repo, "crates", "Cargo.lock");
		await fs.mkdir(path.dirname(control.lock), { recursive: true });
		await fs.mkdir(control.home);
		await fs.mkdir(control.temporary);
		await fs.writeFile(control.lock, "fixture-original-lock\n");
		await fs.writeFile(
			path.join(control.repo, "crates", "deny.toml"),
			"fixture-candidate-policy\n",
		);
		vi.spyOn(os, "tmpdir").mockReturnValue(control.temporary);
	} catch {
		throw new Error("owned fixture setup refused");
	}
});
afterEach(async () => {
	vi.restoreAllMocks();
	try {
		// This exact retained actual handle is closed before any recursive cleanup.
		await control.configFallbackClose?.();
		if (!control.root) return;
		const info = await fs.lstat(control.root);
		if (
			path.dirname(control.root) !== control.parent ||
			!path.basename(control.root).startsWith("draftyak-finite-ci-unit-") ||
			!info.isDirectory() ||
			info.isSymbolicLink() ||
			(await fs.realpath(control.root)) !== control.root
		)
			throw new Error("fixture cleanup boundary refused");
		await fs.rm(control.root, { recursive: true, force: false });
		let absent = false;
		try {
			await fs.lstat(control.root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				throw new Error("fixture leftover check refused");
			absent = true;
		}
		if (!absent) throw new Error("fixture leftover check refused");
	} catch {
		throw new Error("owned fixture cleanup refused");
	}
});

describe("finite policy CI hermetic orchestration", () => {
	it.each([-1, 0, 1])(
		"checks the graph deadline after finalization at offset %s",
		async (offset) => {
			vi.mocked(Date.now).mockReturnValue(CURRENT_FINITE_GRAPH_TERM.expiresAt - 1);
			let release!: () => void, entered!: () => void;
			control.inputCloseGate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const closing = new Promise<void>((resolve) => {
				entered = resolve;
			});
			control.inputCloseEntered = entered;
			const pending = observed();
			try {
				await closing;
				vi.mocked(Date.now).mockReturnValue(CURRENT_FINITE_GRAPH_TERM.expiresAt + offset);
				release();
				const result = await pending;
				expect(result.resolved).toBe(offset < 0);
				if (offset < 0) expect(result.code).toBe(0);
				else expect(result.finiteError).toBe(true);
				expect(control.inputCloseFinished && control.toolCloseFinished).toBe(true);
				expect(control.inputCloseCalls).toBe(1);
				expect(control.toolCloseCalls).toBe(1);
			} finally {
				release();
				await pending;
			}
		},
	);
	it("preserves the deny exit only after scoped resource closure finishes", async () => {
		control.denyExit = 37;
		let release!: () => void,
			entered!: () => void,
			settled = false;
		control.inputCloseGate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const closing = new Promise<void>((resolve) => {
			entered = resolve;
		});
		control.inputCloseEntered = entered;
		const pending = observed().then((value) => {
			settled = true;
			return value;
		});
		try {
			await closing;
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(settled).toBe(false);
			release();
			const result = await pending;
			expect(result.resolved).toBe(true);
			expect(result.code === 37).toBe(true);
			expect(control.inputCloseFinished && control.toolCloseFinished).toBe(true);
			expect(control.inputCloseCalls).toBe(1);
			expect(control.toolCloseCalls).toBe(1);
			expect(control.readerCloseCalls).toBe(1);
			expect(control.captureIds.length).toBe(5);
			expect(control.resolutionInputJoined && control.childEnvironmentSafe).toBe(true);
		} finally {
			release();
			await pending;
		}
	});
	it("refuses a changed graph or candidate before config creation and deny", async () => {
		for (const changed of ["graph", "candidate"] as const) {
			control.wrongGraph = changed === "graph";
			let policyWritten = false;
			try {
				await fs.writeFile(
					path.join(control.repo, "crates", "deny.toml"),
					changed === "candidate" ? "fixture-unapproved-policy\n" : "fixture-candidate-policy\n",
				);
				policyWritten = true;
			} catch {
				/* Only the predicate reaches an assertion. */
			}
			expect(policyWritten).toBe(true);
			const result = await observed();
			expect(result.resolved).toBe(false);
			expect(result.finiteError).toBe(true);
			expect(control.configWriteOpens).toBe(0);
			expect(control.captureIds.filter((id) => id === "finite-policy-check").length).toBe(0);
		}
		expect(control.guardCalls).toBe(2);
	});
	it("retains an actual config FileHandle whose close rejected before physical close", async () => {
		control.configCloseFault = true;
		const result = await observed();
		let actualHandleStillOpen = false;
		try {
			actualHandleStillOpen = (await control.configHandle?.stat())?.isFile() === true;
		} catch {
			/* predicate only */
		}
		expect(result.resolved).toBe(false);
		expect(result.resourcePending).toBe(true);
		expect(result.complete).toBe(false);
		expect(result.ownFiles).toBe(1);
		expect(control.configCloseAttempts).toBe(1);
		expect(control.physicalConfigCloses).toBe(0);
		expect(actualHandleStillOpen).toBe(true);
		expect(typeof control.configFallbackClose === "function").toBe(true);
		expect(control.captureIds.filter((id) => id === "finite-policy-check").length).toBe(0);
	});
	it("keeps an unconfirmed capture tree sticky despite zero reader status", async () => {
		control.treeUnconfirmed = true;
		const result = await observed();
		expect(result.resolved).toBe(false);
		expect(result.finiteError).toBe(true);
		expect(result.processUnconfirmed).toBe(true);
		expect(result.complete).toBe(false);
		expect(result.activeReaders).toBe(0);
		expect(result.pendingReaders).toBe(0);
		expect(control.inputCloseFinished && control.toolCloseFinished).toBe(true);
	});
	it("refuses a changed original input before deny dispatch", async () => {
		control.mutateInputAtGuard = true;
		const result = await observed();
		expect(result.resolved).toBe(false);
		expect(result.finiteError).toBe(true);
		expect(control.mutationDetected).toBe(true);
		expect(control.guardCalls).toBe(1);
		expect(control.captureIds.filter((id) => id === "finite-policy-check").length).toBe(0);
		expect(control.inputCloseFinished && control.toolCloseFinished).toBe(true);
	});
	it("admits neither caller graph nor approval Boolean as physical options", async () => {
		for (const invalid of [
			{ ...fixtureOptions(), graph: control.acceptedGraph },
			{ ...fixtureOptions(), approved: true },
			true,
		]) {
			const result = await observed(invalid);
			expect(result.resolved).toBe(false);
			expect(result.finiteError).toBe(true);
		}
		expect(control.inputFactories).toBe(0);
		expect(control.toolFactories).toBe(0);
		expect(control.projectorCalls).toBe(0);
		expect(control.guardCalls).toBe(0);
		expect(control.captureIds.length).toBe(0);
		expect(control.configWriteOpens).toBe(0);
	});
});
