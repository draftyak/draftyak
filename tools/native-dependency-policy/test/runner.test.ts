import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AuthoritySnapshot, AuthorityTransport } from "../src/authority.ts";
import type { Binding } from "../src/decision.ts";
import { BOUNDED_TUPLES } from "../src/decision.ts";
import type {
	CurrentEvidenceBinding,
	NativePolicyCollector,
	NativePolicyEvidence,
	NativeRunContext,
	ProducedPolicyEvidence,
	ProducerCode,
} from "../src/runner.ts";

const network = vi.hoisted(() => ({
	request: vi.fn(() => {
		throw Error("unexpected synthetic HTTPS request");
	}),
}));
vi.mock("node:https", () => ({ request: network.request }));
const { createNativePolicyProducer, runNativePolicy, nativeRunAuthority, ProducerError } =
	await import("../src/runner.ts");
const { AuthorityError } = await import("../src/authority.ts");
const NOW = Date.parse("2026-10-20T16:00:00Z"),
	REVISION = "a".repeat(40),
	OTHER = "b".repeat(40);
const SOURCE = "registry+https://github.com/rust-lang/crates.io-index";
const BINDING: Binding = {
	graph: "1".repeat(64),
	lock: "2".repeat(64),
	inputs: "3".repeat(64),
	basis: "4".repeat(64),
	releases: "5".repeat(64),
	security: "6".repeat(64),
	policy: "7".repeat(64),
};
const findings = () =>
	BOUNDED_TUPLES.map(([name, version, advisory]) => ({
		name,
		version,
		source: SOURCE,
		advisory,
		ancestor: "f".repeat(64),
	}));
const counts = (errors = 0, warnings = 0, notes = 0, helps = 0) => ({
	errors,
	warnings,
	notes,
	helps,
});
function dto(): ProducedPolicyEvidence {
	return {
		runId: randomUUID(),
		reportDigest: "8".repeat(64),
		binding: { ...BINDING },
		audit: {
			complete: true,
			fullExit: 1,
			advisoryExit: 1,
			unexpectedErrors: 0,
			findings: findings(),
			counts: {
				advisories: counts(5),
				bans: counts(0, 33),
				licenses: counts(0, 0, 0, 521),
				sources: counts(),
			},
		},
		rawExits: { full: { exitCode: 1, signal: null }, advisory: { exitCode: 1, signal: null } },
		evidenceObservedAt: NOW + 1,
		sourceRevisions: {
			database: "a".repeat(40),
			releases: "b".repeat(64),
			security: "c".repeat(64),
		},
		failure: null,
	};
}
function active() {
	return {
		version: 1,
		state: "active",
		gate: "open",
		evidenceKind: "actual-source",
		confirmation: "unchanged-scope",
		binding: { ...BINDING },
		review: {
			at: new Date(NOW - 60_000).toISOString().replace(".000Z", "Z"),
			due: new Date(NOW + 3_600_000).toISOString().replace(".000Z", "Z"),
		},
		exceptions: findings(),
	};
}
function renewed() {
	const legacy = active();
	return {
		version: 2,
		state: legacy.state,
		termination: "release-or-validated-fix",
		evidenceKind: legacy.evidenceKind,
		confirmation: legacy.confirmation,
		binding: legacy.binding,
		review: legacy.review,
		exceptions: legacy.exceptions,
	};
}
function setup(record: unknown = active(), data: ProducedPolicyEvidence = dto()) {
	const events: string[] = [];
	let clock = NOW,
		current = REVISION,
		calls = 0;
	const authority: AuthorityTransport = {
		currentRevision: async () => {
			events.push("authority-current");
			calls++;
			return current;
		},
		recordAt: async () => {
			events.push("authority-record");
			return Buffer.from(JSON.stringify(record));
		},
	};
	const collector: NativePolicyCollector = {
		collect: async () => {
			events.push("collect");
			clock = NOW + 10;
			return data;
		},
		revalidate: async (_ctx, sealed) => {
			events.push("revalidate");
			clock = NOW + 20;
			return {
				reportDigest: sealed.reportDigest,
				binding: sealed.binding,
				sourceRevisions: sealed.sourceRevisions,
			};
		},
	};
	const producer = createNativePolicyProducer(collector);
	return {
		events,
		authority,
		collector,
		producer,
		data,
		clock: () => {
			events.push("clock");
			return clock;
		},
		setClock: (v: number) => {
			clock = v;
		},
		setCurrent: (v: string) => {
			current = v;
		},
		authorityCalls: () => calls,
		run: () =>
			runNativePolicy({
				phase: "item",
				authority,
				producer,
				completionClock: () => {
					events.push("clock");
					return clock;
				},
			}),
	};
}
function modified(
	data: ProducedPolicyEvidence,
	path: readonly (string | number)[],
	value: unknown,
): ProducedPolicyEvidence {
	const result = structuredClone(data);
	let target: unknown = result;
	for (const key of path.slice(0, -1)) target = (target as Record<string, unknown>)[String(key)];
	(target as Record<string, unknown>)[String(path.at(-1))] = value;
	return result;
}
const current = (data: ProducedPolicyEvidence): CurrentEvidenceBinding => ({
	reportDigest: data.reportDigest,
	binding: data.binding,
	sourceRevisions: data.sourceRevisions,
});
const retainedTestHandles = new Set<fs.FileHandle>();

describe("trusted collector resource lifecycle", () => {
	it("rejects serialized finalizer flags and accessors without invoking them", () => {
		const f = setup();
		let accessed = 0;
		expect(() =>
			createNativePolicyProducer({
				collect: f.collector.collect,
				revalidate: f.collector.revalidate,
				finalize: false as unknown as () => Promise<void>,
			}),
		).toThrow(ProducerError);
		const collector = {
			collect: f.collector.collect,
			revalidate: f.collector.revalidate,
			get finalize() {
				accessed++;
				return async () => undefined;
			},
		};
		expect(() => createNativePolicyProducer(collector)).toThrow(ProducerError);
		expect(accessed).toBe(0);
	});
	it("never invokes collection or finalization for an authority preflight refusal", async () => {
		const f = setup({
			version: 1,
			state: "refusal-only",
			reason: "ACTUAL_SOURCE_CONFIRMATION_REQUIRED",
		});
		const collect = vi.fn(f.collector.collect),
			revalidate = vi.fn(f.collector.revalidate),
			finalize = vi.fn(async () => undefined);
		const p = createNativePolicyProducer({ collect, revalidate, finalize });
		const outcome = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: f.clock,
		});
		expect(outcome.output.reason).toBe("ACTUAL_SOURCE_CONFIRMATION_REQUIRED");
		expect(collect).not.toHaveBeenCalled();
		expect(revalidate).not.toHaveBeenCalled();
		expect(finalize).not.toHaveBeenCalled();
	});
	it.each([
		["collect-throw", "BASIS_UNAVAILABLE"],
		["invalid-evidence", "EVIDENCE_INVALID"],
		["revalidate-throw", "INPUTS_CHANGED"],
		["invalid-revalidation", "EVIDENCE_INVALID"],
		["authority-change", "AUTHORITY_CHANGED"],
		["clock-error", "CLOCK_INVALID"],
	] as const)("finalizes exactly once after collection enters on %s", async (mode, reason) => {
		const f = setup(),
			finalize = vi.fn(async () => {
				f.events.push("finalize");
			});
		const p = createNativePolicyProducer({
			collect: async (context) => {
				if (mode === "collect-throw") throw new ProducerError("BASIS_UNAVAILABLE");
				const data = await f.collector.collect(context);
				return mode === "invalid-evidence" ? modified(data, ["runId"], "invalid") : data;
			},
			revalidate: async (context, data) => {
				if (mode === "revalidate-throw") throw new ProducerError("INPUTS_CHANGED");
				const checked = await f.collector.revalidate(context, data);
				if (mode === "authority-change") f.setCurrent(OTHER);
				return mode === "invalid-revalidation" ? { ...checked, reportDigest: "invalid" } : checked;
			},
			finalize,
		});
		let clockReads = 0;
		const outcome = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock:
				mode === "clock-error"
					? () => {
							if (++clockReads === 1) return NOW;
							throw Error("invented clock fault");
						}
					: f.clock,
		});
		expect(outcome.output.reason).toBe(reason);
		expect(outcome.exitCode).not.toBe(0);
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(outcome.output).not.toHaveProperty("finalizerFailure");
	});
	it("finalizes before the last authority and completion clock checks on a normal synthetic pass", async () => {
		const f = setup(),
			finalize = vi.fn(async () => {
				f.events.push("finalize");
				f.setClock(NOW + 30);
			});
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: f.collector.revalidate,
			finalize,
		});
		const outcome = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: f.clock,
		});
		expect(outcome.exitCode).toBe(0);
		expect(finalize).toHaveBeenCalledTimes(1);
		expect(f.events).toEqual([
			"clock",
			"authority-current",
			"authority-record",
			"authority-current",
			"collect",
			"revalidate",
			"finalize",
			"authority-current",
			"clock",
		]);
	});
	it("never returns an otherwise passing verdict when real finalization reports pending resources", async () => {
		const f = setup(),
			finalize = vi.fn(async () => {
				throw new ProducerError("CAPTURE_FAILED");
			});
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: f.collector.revalidate,
			finalize,
		});
		const outcome = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: f.clock,
		});
		expect(outcome.exitCode).toBe(2);
		expect(outcome.output.verdict).toBe("refuse");
		expect(outcome.output.reason).toBe("CAPTURE_FAILED");
		expect(outcome.output.finalizerFailure).toBe("CAPTURE_FAILED");
		expect(outcome.output.accepted).toEqual([]);
		expect(outcome.output.audit).toEqual(f.data.audit);
		expect(finalize).toHaveBeenCalledTimes(1);
	});
	it.each(["collect", "policy"] as const)(
		"preserves the primary %s refusal alongside technical finalizer failure",
		async (mode) => {
			const record = active();
			if (mode === "policy")
				record.review.due = new Date(NOW + 1000).toISOString().replace(".000Z", "Z");
			const f = setup(record),
				finalize = vi.fn(async () => {
					if (mode === "policy") f.setClock(NOW + 1000);
					throw new ProducerError("CAPTURE_FAILED");
				});
			const p = createNativePolicyProducer({
				collect:
					mode === "collect"
						? async () => {
								throw new ProducerError("BASIS_UNAVAILABLE");
							}
						: f.collector.collect,
				revalidate: f.collector.revalidate,
				finalize,
			});
			const outcome = await runNativePolicy({
				phase: "item",
				authority: f.authority,
				producer: p,
				completionClock: f.clock,
			});
			expect(outcome.output.reason).toBe(
				mode === "collect" ? "BASIS_UNAVAILABLE" : "REVIEW_REQUIRED",
			);
			expect(outcome.output.finalizerFailure).toBe("CAPTURE_FAILED");
			expect(finalize).toHaveBeenCalledTimes(1);
		},
	);
	it("maps a hostile finalizer error to a fixed code without losing finalization control", async () => {
		const f = setup(),
			error = new ProducerError("CAPTURE_FAILED");
		Object.defineProperty(error, "code", {
			get: () => {
				throw Error("untrusted-prose");
			},
		});
		const finalize = vi.fn(async () => {
			throw error;
		});
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: f.collector.revalidate,
			finalize,
		});
		const outcome = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: f.clock,
		});
		expect(outcome.output.reason).toBe("PRODUCER_UNAVAILABLE");
		expect(outcome.output.finalizerFailure).toBe("PRODUCER_UNAVAILABLE");
		expect(JSON.stringify(outcome)).not.toContain("untrusted-prose");
		expect(finalize).toHaveBeenCalledTimes(1);
	});
	it.each(["authority", "age"] as const)(
		"awaits finalization and observes %s changes before any success is returned",
		async (mode) => {
			const f = setup(),
				entered = Promise.withResolvers<void>(),
				release = Promise.withResolvers<void>();
			const finalize = vi.fn(async () => {
				entered.resolve();
				await release.promise;
				if (mode === "authority") f.setCurrent(OTHER);
				else f.setClock(NOW + 3_600_100);
			});
			const p = createNativePolicyProducer({
				collect: f.collector.collect,
				revalidate: f.collector.revalidate,
				finalize,
			});
			let returned = false;
			const running = runNativePolicy({
				phase: "item",
				authority: f.authority,
				producer: p,
				completionClock: f.clock,
			}).then((outcome) => {
				returned = true;
				return outcome;
			});
			try {
				await Promise.race([entered.promise, running]);
				// Let a prematurely returned run settle while the finalizer is still held.
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(finalize).toHaveBeenCalledTimes(1);
				expect(returned).toBe(false);
				release.resolve();
				const outcome = await running;
				expect(outcome.output.reason).toBe(
					mode === "authority" ? "AUTHORITY_CHANGED" : "EVIDENCE_STALE",
				);
				expect(outcome.exitCode).not.toBe(0);
			} finally {
				release.resolve();
				await running;
			}
		},
	);
	it("does not finalize a registered producer whose replacement method never enters collection", async () => {
		const f = setup(),
			collect = vi.fn(f.collector.collect),
			finalize = vi.fn(async () => undefined);
		const p = createNativePolicyProducer({ collect, revalidate: f.collector.revalidate, finalize });
		p.produce = async () => {
			throw Error("invented before-entry fault");
		};
		const outcome = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: f.clock,
		});
		expect(outcome.output.reason).toBe("PRODUCER_UNAVAILABLE");
		expect(collect).not.toHaveBeenCalled();
		expect(finalize).not.toHaveBeenCalled();
	});
	it("finalizes the actual entered collector even when its receipt is foreign to the selected producer", async () => {
		const a = setup(),
			b = setup(),
			finalizeA = vi.fn(async () => undefined),
			finalizeB = vi.fn(async () => undefined);
		const selected = createNativePolicyProducer({
			collect: a.collector.collect,
			revalidate: a.collector.revalidate,
			finalize: finalizeA,
		});
		const entered = createNativePolicyProducer({
			collect: b.collector.collect,
			revalidate: b.collector.revalidate,
			finalize: finalizeB,
		});
		selected.produce = (context) => entered.produce(context);
		const outcome = await runNativePolicy({
			phase: "item",
			authority: a.authority,
			producer: selected,
			completionClock: () => NOW + 100,
		});
		expect(outcome.output.reason).toBe("EVIDENCE_INVALID");
		expect(finalizeA).not.toHaveBeenCalled();
		expect(finalizeB).toHaveBeenCalledTimes(1);
	});
	it("snapshots the finalizer function at construction rather than accepting later mutation", async () => {
		const f = setup(),
			original = vi.fn(async () => undefined),
			replacement = vi.fn(async () => undefined);
		const collector: NativePolicyCollector = {
			collect: f.collector.collect,
			revalidate: f.collector.revalidate,
			finalize: original,
		};
		const p = createNativePolicyProducer(collector);
		collector.finalize = replacement;
		expect(original).not.toHaveBeenCalled();
		const outcome = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: f.clock,
		});
		expect(outcome.exitCode).toBe(0);
		expect(original).toHaveBeenCalledTimes(1);
		expect(replacement).not.toHaveBeenCalled();
	});
	it("closes an actual invented file resource before the final verdict and never deletes foreign data", async () => {
		const parent = await fs.realpath(os.tmpdir()),
			directory = await fs.mkdtemp(path.join(parent, "native-policy-finalizer-"));
		const file = path.join(directory, "invented-resource");
		const directoryIdentity = await fs.lstat(directory, { bigint: true });
		let fileIdentity: { dev: bigint; ino: bigint } | undefined;
		let handle: fs.FileHandle | undefined;
		const f = setup(),
			finalize = vi.fn(async () => {
				if (handle) {
					await handle.close();
					retainedTestHandles.delete(handle);
				}
			});
		const p = createNativePolicyProducer({
			collect: async (context) => {
				handle = await fs.open(file, "wx");
				retainedTestHandles.add(handle);
				const stat = await handle.stat({ bigint: true });
				fileIdentity = { dev: stat.dev, ino: stat.ino };
				await handle.writeFile("invented unit resource");
				return f.collector.collect(context);
			},
			revalidate: f.collector.revalidate,
			finalize,
		});
		try {
			const outcome = await runNativePolicy({
				phase: "item",
				authority: f.authority,
				producer: p,
				completionClock: f.clock,
			});
			expect(outcome.exitCode).toBe(0);
			expect(finalize).toHaveBeenCalledTimes(1);
			expect(handle?.fd).toBe(-1);
		} finally {
			// Unexpected pending handles stay strongly retained; no hidden close retry or cleanup occurs.
			if (handle?.fd === -1 && fileIdentity) {
				expect(path.dirname(directory)).toBe(parent);
				expect(await fs.realpath(directory)).toBe(directory);
				expect(path.basename(directory)).toMatch(/^native-policy-finalizer-[A-Za-z0-9_-]+$/);
				const currentDirectory = await fs.lstat(directory, { bigint: true }),
					currentFile = await fs.lstat(file, { bigint: true });
				expect([currentDirectory.dev, currentDirectory.ino]).toEqual([
					directoryIdentity.dev,
					directoryIdentity.ino,
				]);
				expect(currentDirectory.isSymbolicLink()).toBe(false);
				expect(currentDirectory.isDirectory()).toBe(true);
				expect([currentFile.dev, currentFile.ino]).toEqual([fileIdentity.dev, fileIdentity.ino]);
				expect(currentFile.isFile()).toBe(true);
				expect(currentFile.nlink).toBe(1n);
				expect(await fs.readdir(directory)).toEqual(["invented-resource"]);
				await fs.unlink(file);
				await fs.rmdir(directory);
			}
		}
	});
});

describe("runner-owned authority context", () => {
	it("returns the actual immutable loaded snapshot only during its genuine run context", async () => {
		const record = active(),
			f = setup(record);
		let savedContext: NativeRunContext | undefined, savedAuthority: AuthoritySnapshot | undefined;
		const p = createNativePolicyProducer({
			collect: async (context) => {
				savedContext = context;
				savedAuthority = nativeRunAuthority(context);
				expect(savedAuthority.revision).toBe(REVISION);
				expect(savedAuthority.recordDigest).toBe(
					createHash("sha256").update(JSON.stringify(record)).digest("hex"),
				);
				expect(Object.isFrozen(savedAuthority)).toBe(true);
				expect(Object.isFrozen(savedAuthority.record)).toBe(true);
				for (const copied of [
					{ ...context },
					JSON.parse(JSON.stringify(context)),
					Object.create(context),
				])
					expect(() => nativeRunAuthority(copied as NativeRunContext)).toThrow(ProducerError);
				let accessed = 0;
				const foreign = new Proxy(context, {
					get: () => {
						accessed++;
						throw Error("not observed");
					},
				});
				expect(() => nativeRunAuthority(foreign)).toThrow(ProducerError);
				expect(accessed).toBe(0);
				return f.collector.collect(context);
			},
			revalidate: async (context, data) => {
				expect(nativeRunAuthority(context)).toBe(savedAuthority);
				return current(data);
			},
			finalize: async () => {
				if (!savedContext) throw Error("missing invented context");
				expect(nativeRunAuthority(savedContext)).toBe(savedAuthority);
			},
		});
		const outcome = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: () => NOW + 100,
		});
		expect(outcome.exitCode).toBe(0);
		const endedContext = savedContext;
		if (!endedContext) throw Error("missing invented context");
		expect(() => nativeRunAuthority(endedContext)).toThrow(ProducerError);
		expect(() => nativeRunAuthority({ phase: "item", startedAt: NOW } as NativeRunContext)).toThrow(
			ProducerError,
		);
	});
});

describe("authority-first orchestration", () => {
	it("creates a producer without invoking either callback", () => {
		const collect = vi.fn(async () => dto()),
			revalidate = vi.fn(async (_context: NativeRunContext, data: ProducedPolicyEvidence) =>
				current(data),
			),
			finalize = vi.fn(async () => undefined);
		createNativePolicyProducer({ collect, revalidate, finalize });
		expect(collect).not.toHaveBeenCalled();
		expect(revalidate).not.toHaveBeenCalled();
		expect(finalize).not.toHaveBeenCalled();
	});
	for (const [name, record, reason, exit] of [
		[
			"initial refusal",
			{ version: 1, state: "refusal-only", reason: "ACTUAL_SOURCE_CONFIRMATION_REQUIRED" },
			"ACTUAL_SOURCE_CONFIRMATION_REQUIRED",
			1,
		],
		["terminal gate", { version: 1, state: "gate-closed" }, "TERMINAL_STATE", 1],
		["revoked", { version: 1, state: "revoked" }, "TERMINAL_STATE", 1],
		["release closure", { version: 2, state: "release-closed" }, "TERMINAL_STATE", 1],
		["renewed removal", { version: 2, state: "removed" }, "TERMINAL_STATE", 1],
		["renewed revocation", { version: 2, state: "revoked" }, "TERMINAL_STATE", 1],
		["invalid active", { version: 1, state: "active" }, "AUTHORITY_INVALID", 2],
	] as const)
		it(`${name} refuses before any native producer`, async () => {
			const f = setup(record);
			const result = await f.run();
			expect(result.exitCode).toBe(exit);
			expect(result.output.reason).toBe(reason);
			expect(result.output.audit).toBeNull();
			expect(f.events).not.toContain("collect");
			expect(f.events).not.toContain("revalidate");
			expect(network.request).not.toHaveBeenCalled();
		});
	it("orders collection and both current checks before the final completion clock", async () => {
		const f = setup(),
			result = await f.run();
		expect(result.exitCode).toBe(0);
		expect(result.output.verdict).toBe("pass-with-scoped-exceptions");
		expect(result.output.accepted).toHaveLength(5);
		expect(f.events).toEqual([
			"clock",
			"authority-current",
			"authority-record",
			"authority-current",
			"collect",
			"revalidate",
			"authority-current",
			"clock",
		]);
		expect(result.output.rawExits).toEqual(f.data.rawExits);
		expect(result.output.reportDigest).toBe(f.data.reportDigest);
		expect(result.output.runId).toBe(f.data.runId);
		expect(network.request).not.toHaveBeenCalled();
	});
	it("allows a synthetic zero-error strict pass only with matching empty authority scope", async () => {
		const record = active();
		record.exceptions = [];
		const data = dto();
		const zero = {
			...data,
			audit: {
				complete: true as const,
				fullExit: 0,
				advisoryExit: 0,
				unexpectedErrors: 0,
				findings: [],
				counts: {
					advisories: counts(),
					bans: counts(),
					licenses: counts(0, 0, 0, 4),
					sources: counts(),
				},
			},
			rawExits: { full: { exitCode: 0, signal: null }, advisory: { exitCode: 0, signal: null } },
		};
		const result = await setup(record, zero).run();
		expect(result.exitCode).toBe(0);
		expect(result.output.verdict).toBe("strict-pass");
		expect(result.output.accepted).toEqual([]);
	});
	it("keeps the gate phase at zero exceptions", async () => {
		const f = setup(),
			result = await runNativePolicy({
				phase: "m4-gate",
				authority: f.authority,
				producer: f.producer,
				completionClock: f.clock,
			});
		expect(result.exitCode).toBe(1);
		expect(result.output.reason).toBe("GATE_EXCEPTIONS_FORBIDDEN");
		expect(result.output.audit?.fullExit).toBe(1);
	});
	it.each(["item", "m4-gate"] as const)(
		"retains strict exits for explicit renewed authority in phase %s",
		async (phase) => {
			const f = setup(renewed());
			const result = await runNativePolicy({
				phase,
				authority: f.authority,
				producer: f.producer,
				completionClock: f.clock,
			});
			expect(result.exitCode).toBe(0);
			expect(result.output.verdict).toBe("pass-with-scoped-exceptions");
			expect(result.output.accepted).toEqual(findings());
			expect(result.output.rawExits).toEqual(f.data.rawExits);
			expect(result.output.audit?.fullExit).toBe(1);
			expect(result.output.audit?.advisoryExit).toBe(1);
			expect(result.output.authorityRevision).toBe(REVISION);
		},
	);
	it.each(["item", "m4-gate"] as const)(
		"does not retain earlier v2 authority when closure is delivered during phase %s",
		async (phase) => {
			const f = setup(renewed());
			const records: Record<string, unknown> = {
				[REVISION]: renewed(),
				[OTHER]: { version: 2, state: "release-closed" },
			};
			const selected: string[] = [];
			f.authority.recordAt = async (revision) => {
				selected.push(revision);
				return Buffer.from(JSON.stringify(records[revision]));
			};
			const producer = createNativePolicyProducer({
				collect: f.collector.collect,
				revalidate: async (_context, data) => {
					f.setCurrent(OTHER);
					return current(data);
				},
			});
			const result = await runNativePolicy({
				phase,
				authority: f.authority,
				producer,
				completionClock: f.clock,
			});
			expect(result.exitCode).toBe(1);
			expect(result.output.reason).toBe("AUTHORITY_CHANGED");
			expect(result.output.audit).toEqual(f.data.audit);
			expect(result.output.rawExits).toEqual(f.data.rawExits);
			expect(result.output.accepted).toEqual([]);
			expect(selected).toEqual([REVISION]);
			const later = await runNativePolicy({
				phase,
				authority: f.authority,
				producer: f.producer,
				completionClock: f.clock,
			});
			expect(later.output.reason).toBe("TERMINAL_STATE");
			expect(later.output.audit).toBeNull();
			expect(selected).toEqual([REVISION, OTHER]);
		},
	);
	it("refuses missing current authority without running a producer or printing upstream text", async () => {
		const f = setup();
		f.authority.currentRevision = async () => {
			throw Error("untrusted-prose");
		};
		const result = await f.run();
		expect(result.exitCode).toBe(2);
		expect(result.output.reason).toBe("AUTHORITY_UNAVAILABLE");
		expect(f.events).not.toContain("collect");
		expect(JSON.stringify(result)).not.toContain("untrusted-prose");
	});
});

describe("final revalidation and immutable captured data", () => {
	it("freezes every nested DTO before asynchronous revalidation", async () => {
		const f = setup();
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: async (ctx, sealed) => {
				expect(Object.isFrozen(ctx)).toBe(true);
				expect(Object.isFrozen(sealed)).toBe(true);
				expect(Object.isFrozen(sealed.binding)).toBe(true);
				expect(Object.isFrozen(sealed.audit?.counts.advisories)).toBe(true);
				expect(Object.isFrozen(sealed.audit?.findings[0])).toBe(true);
				expect(Object.isFrozen(sealed.rawExits.full)).toBe(true);
				expect(() => {
					(sealed.binding as Record<string, unknown>).graph = "0".repeat(64);
				}).toThrow();
				expect(() => {
					(sealed.audit?.findings[0] as unknown as Record<string, unknown>).source =
						"untrusted-prose";
				}).toThrow();
				await Promise.resolve();
				return current(sealed);
			},
		});
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: () => NOW + 100,
		});
		expect(result.exitCode).toBe(0);
	});
	it("snapshots the collector DTO so later source-object mutation cannot rewrite evidence", async () => {
		const f = setup();
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: async (_ctx, sealed) => {
				(f.data.binding as Record<string, unknown>).graph = "0".repeat(64);
				(f.data.audit?.counts.advisories as unknown as Record<string, unknown>).errors = 0;
				return current(sealed);
			},
		});
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: () => NOW + 100,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output.binding?.graph).toBe(BINDING.graph);
		expect(result.output.audit?.counts.advisories.errors).toBe(5);
	});
	for (const field of ["database", "releases", "security"] as const)
		it(`refuses a changed current ${field} revision and preserves the audit`, async () => {
			const f = setup();
			const p = createNativePolicyProducer({
				collect: f.collector.collect,
				revalidate: async (_ctx, sealed) => {
					if (!sealed.sourceRevisions) throw Error("fixture");
					return {
						...current(sealed),
						sourceRevisions: { ...sealed.sourceRevisions, [field]: "d".repeat(64) },
					};
				},
			});
			const result = await runNativePolicy({
				phase: "item",
				authority: f.authority,
				producer: p,
				completionClock: () => NOW + 100,
			});
			expect(result.exitCode).toBe(1);
			expect(result.output.reason).toBe("SOURCE_CHANGED");
			expect(result.output.audit?.counts.advisories.errors).toBe(5);
			expect(result.output.rawExits?.full?.exitCode).toBe(1);
		});
	it("refuses a changed report digest during final revalidation", async () => {
		const f = setup();
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: async (_ctx, sealed) => ({ ...current(sealed), reportDigest: "9".repeat(64) }),
		});
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: () => NOW + 100,
		});
		expect(result.output.reason).toBe("INPUTS_CHANGED");
		expect(result.output.audit?.findings).toHaveLength(5);
	});
	it("refuses a changed native input binding during final revalidation", async () => {
		const f = setup();
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: async (_ctx, sealed) => ({
				...current(sealed),
				binding: { ...BINDING, lock: "9".repeat(64) },
			}),
		});
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: () => NOW + 100,
		});
		expect(result.output.reason).toBe("INPUTS_CHANGED");
	});
	it("rechecks authority after native/source revalidation and retains captured failures", async () => {
		const f = setup();
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: async (_ctx, sealed) => {
				f.setCurrent(OTHER);
				return current(sealed);
			},
		});
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: () => NOW + 100,
		});
		expect(result.exitCode).toBe(1);
		expect(result.output.reason).toBe("AUTHORITY_CHANGED");
		expect(result.output.audit?.fullExit).toBe(1);
		expect(f.authorityCalls()).toBe(3);
	});
	it("performs the authority check even when source revalidation fails", async () => {
		const f = setup();
		const p = createNativePolicyProducer({
			collect: f.collector.collect,
			revalidate: async () => {
				f.setCurrent(OTHER);
				throw new ProducerError("BASIS_UNAVAILABLE");
			},
		});
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: () => NOW + 100,
		});
		expect(result.output.reason).toBe("AUTHORITY_CHANGED");
		expect(result.output.audit?.fullExit).toBe(1);
	});
	it("uses completion after the final authority await for freshness", async () => {
		const f = setup();
		const original = f.authority.currentRevision;
		f.authority.currentRevision = async () => {
			const value = await original();
			if (f.authorityCalls() === 3) f.setClock(NOW + 3_600_002);
			return value;
		};
		const result = await f.run();
		expect(result.output.reason).toBe("EVIDENCE_STALE");
		expect(result.output.audit?.advisoryExit).toBe(1);
	});
	it("does not refresh an old observation timestamp to the completion time", async () => {
		const f = setup(),
			data = modified(f.data, ["evidenceObservedAt"], NOW - 3_600_000 + 100);
		const original = f.authority.currentRevision;
		f.authority.currentRevision = async () => {
			const revision = await original();
			if (f.authorityCalls() === 3) f.setClock(NOW + 200);
			return revision;
		};
		const p = createNativePolicyProducer({
			collect: async () => data,
			revalidate: async (_ctx, sealed) => current(sealed),
		});
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: f.clock,
		});
		expect(result.output.reason).toBe("EVIDENCE_STALE");
		expect(result.output.audit?.fullExit).toBe(1);
	});
	it("uses completion after final authority checks for review cutoff", async () => {
		const f = setup();
		const original = f.authority.currentRevision;
		f.authority.currentRevision = async () => {
			const value = await original();
			if (f.authorityCalls() === 3) f.setClock(NOW + 3_600_000);
			return value;
		};
		const data = modified(f.data, ["evidenceObservedAt"], NOW + 2_000_000);
		const p = createNativePolicyProducer({
			collect: async () => data,
			revalidate: async (_ctx, sealed) => current(sealed),
		});
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: p,
			completionClock: f.clock,
		});
		expect(result.output.reason).toBe("REVIEW_REQUIRED");
	});
	it("refuses a backwards or invalid completion clock with retained audit", async () => {
		for (const end of [NOW - 1, Number.NaN]) {
			const f = setup();
			let reads = 0;
			const result = await runNativePolicy({
				phase: "item",
				authority: f.authority,
				producer: f.producer,
				completionClock: () => (reads++ === 0 ? NOW : end),
			});
			expect(result.exitCode).toBe(2);
			expect(result.output.reason).toBe("CLOCK_INVALID");
			expect(result.output.audit?.counts.bans.warnings).toBe(33);
		}
	});
});

describe("opaque per-run producer receipts", () => {
	it("rejects an unregistered producer before calling its arbitrary produce function", async () => {
		const f = setup(),
			produce = vi.fn(async () => ({ runId: f.data.runId }) as NativePolicyEvidence);
		const result = await runNativePolicy({
			phase: "item",
			authority: f.authority,
			producer: { produce },
			completionClock: () => NOW + 100,
		});
		expect(result.output.reason).toBe("EVIDENCE_INVALID");
		expect(produce).not.toHaveBeenCalled();
	});
	it("rejects a serialized receipt", async () => {
		const f = setup(),
			original = f.producer.produce;
		f.producer.produce = async (ctx) =>
			JSON.parse(JSON.stringify(await original(ctx))) as NativePolicyEvidence;
		const result = await f.run();
		expect(result.output.reason).toBe("EVIDENCE_INVALID");
		expect(result.output.audit).toBeNull();
	});
	it("rejects a foreign producer receipt for the same context", async () => {
		const a = setup(),
			b = createNativePolicyProducer(a.collector);
		a.producer.produce = (ctx) => b.produce(ctx);
		const result = await a.run();
		expect(result.output.reason).toBe("EVIDENCE_INVALID");
		expect(result.output.audit).toBeNull();
	});
	it("rejects a replayed consumed receipt", async () => {
		const f = setup(),
			original = f.producer.produce;
		let saved: NativePolicyEvidence | undefined;
		f.producer.produce = async (ctx) => {
			if (saved) return saved;
			saved = await original(ctx);
			return saved;
		};
		expect((await f.run()).exitCode).toBe(0);
		expect((await f.run()).output.reason).toBe("EVIDENCE_INVALID");
	});
	it("rejects an unused receipt from an earlier failed run context", async () => {
		const f = setup(),
			original = f.producer.produce;
		let saved: NativePolicyEvidence | undefined;
		f.producer.produce = async (ctx) => {
			if (saved) return saved;
			saved = await original(ctx);
			throw Error("untrusted-prose");
		};
		expect((await f.run()).output.reason).toBe("PRODUCER_UNAVAILABLE");
		expect((await f.run()).output.reason).toBe("EVIDENCE_INVALID");
	});
	it("rejects a reused capture run UUID even through a new receipt", async () => {
		const f = setup();
		expect((await f.run()).exitCode).toBe(0);
		f.setClock(NOW);
		expect((await f.run()).output.reason).toBe("EVIDENCE_INVALID");
	});
	it("does not allow a context to collect twice", async () => {
		const f = setup();
		let saved: NativeRunContext | undefined;
		const p = createNativePolicyProducer({
			collect: async (ctx) => {
				saved = ctx;
				return dto();
			},
			revalidate: async (_ctx, sealed) => current(sealed),
		});
		expect(
			(
				await runNativePolicy({
					phase: "item",
					authority: f.authority,
					producer: p,
					completionClock: () => NOW + 100,
				})
			).exitCode,
		).toBe(0);
		if (!saved) throw Error("fixture");
		await expect(p.produce(saved)).rejects.toMatchObject({ code: "EVIDENCE_INVALID" });
	});
});

describe("complete audit and refusal output", () => {
	it("retains complete counts and raw exits when current basis is unavailable", async () => {
		const data = {
			...dto(),
			failure: "BASIS_UNAVAILABLE" as const,
			binding: null,
			sourceRevisions: null,
			evidenceObservedAt: null,
		};
		const f = setup(active(), data),
			result = await f.run();
		expect(result.exitCode).toBe(2);
		expect(result.output.reason).toBe("BASIS_UNAVAILABLE");
		expect(result.output.audit?.counts).toEqual(data.audit?.counts);
		expect(result.output.rawExits).toEqual(data.rawExits);
		expect(f.authorityCalls()).toBe(3);
	});
	it("retains independently known raw exits/signals without inventing normalized counts", async () => {
		const data = {
			...dto(),
			failure: "CAPTURE_FAILED" as const,
			binding: null,
			audit: null,
			sourceRevisions: null,
			evidenceObservedAt: null,
			rawExits: {
				full: { exitCode: null, signal: "SIGTERM" },
				advisory: { exitCode: 255, signal: null },
			},
		};
		const result = await setup(active(), data).run();
		expect(result.output.audit).toBeNull();
		expect(result.output.rawExits).toEqual(data.rawExits);
		expect(result.output.reason).toBe("CAPTURE_FAILED");
	});
	it("permits a no-report producer refusal without inventing a report digest", async () => {
		const data = {
			...dto(),
			reportDigest: null,
			failure: "BASIS_UNAVAILABLE" as const,
			binding: null,
			audit: null,
			sourceRevisions: null,
			evidenceObservedAt: null,
			rawExits: { full: null, advisory: null },
		};
		const result = await setup(active(), data).run();
		expect(result.output.reportDigest).toBeNull();
		expect(result.output.audit).toBeNull();
		expect(result.output.reason).toBe("BASIS_UNAVAILABLE");
	});
	it("requires a report digest for retained audit data even on producer refusal", async () => {
		const data = {
			...dto(),
			reportDigest: null,
			failure: "BASIS_UNAVAILABLE" as const,
			binding: null,
			sourceRevisions: null,
			evidenceObservedAt: null,
		};
		const result = await setup(active(), data).run();
		expect(result.output.reason).toBe("EVIDENCE_INVALID");
		expect(result.output.audit).toBeNull();
	});
	it("retains other policy errors and original category-bit exits", async () => {
		let data = dto();
		data = modified(data, ["audit", "counts", "licenses", "errors"], 1);
		data = modified(data, ["audit", "unexpectedErrors"], 1);
		data = modified(data, ["audit", "fullExit"], 5);
		data = modified(data, ["rawExits", "full", "exitCode"], 5);
		const result = await setup(active(), data).run();
		expect(result.output.reason).toBe("AUDIT_INCOMPLETE");
		expect(result.output.audit?.fullExit).toBe(5);
		expect(result.output.audit?.unexpectedErrors).toBe(1);
		expect(result.output.audit?.counts.licenses.errors).toBe(1);
	});
	it("rejects unexpected non-advisory errors even when the raw full exit is one", async () => {
		let data = dto();
		data = modified(data, ["audit", "counts", "licenses", "errors"], 1);
		data = modified(data, ["audit", "unexpectedErrors"], 1);
		const result = await setup(active(), data).run();
		expect(result.output.reason).toBe("AUDIT_INCOMPLETE");
		expect(result.output.audit?.unexpectedErrors).toBe(1);
	});
	for (const key of Object.keys(BINDING) as readonly (keyof Binding)[])
		it(`checks exact ${key} policy binding`, async () => {
			const data = modified(dto(), ["binding", key], "0".repeat(64));
			const result = await setup(active(), data).run();
			expect(result.output.reason).toBe("BINDING_CHANGED");
		});
	it("checks ancestor scope independently", async () => {
		const data = modified(dto(), ["audit", "findings", 0, "ancestor"], "0".repeat(64));
		expect((await setup(active(), data).run()).output.reason).toBe("FINDINGS_CHANGED");
	});
	for (const [title, path, value] of [
		["unknown report field", ["extra"], "untrusted-prose"],
		["bad UUID", ["runId"], "untrusted-prose"],
		["bad report hash", ["reportDigest"], "8".repeat(63)],
		["bad revision", ["sourceRevisions", "security"], "current"],
		["unsafe count", ["audit", "counts", "advisories", "errors"], Number.MAX_SAFE_INTEGER + 1],
		["summary mismatch", ["audit", "counts", "advisories", "errors"], 6],
		["unexpected-error mismatch", ["audit", "unexpectedErrors"], 1],
		["raw exit mismatch", ["rawExits", "full", "exitCode"], 0],
		["error with zero exit", ["audit", "fullExit"], 0],
		["unknown category", ["audit", "counts", "future"], counts()],
		["partial audit labelled complete", ["audit", "complete"], false],
		[
			"unknown finding source",
			["audit", "findings", 0, "source"],
			"registry+https://example.invalid/index",
		],
		["unknown advisory", ["audit", "findings", 0, "advisory"], "RUSTSEC-2026-9999"],
		["wrong ancestor hash", ["audit", "findings", 0, "ancestor"], "f".repeat(63)],
		["source absent on success", ["sourceRevisions"], null],
		["binding absent on success", ["binding"], null],
		["time absent on success", ["evidenceObservedAt"], null],
		["report absent after capture", ["reportDigest"], null],
		["unknown producer code", ["failure"], "untrusted-prose"],
		["unknown signal", ["rawExits", "full", "signal"], "untrusted-prose"],
	] as const)
		it(`refuses ${title} without fabricated audit output`, async () => {
			const result = await setup(active(), modified(dto(), path, value)).run();
			expect(result.exitCode).toBe(2);
			expect(result.output.reason).toBe("EVIDENCE_INVALID");
			expect(result.output.audit).toBeNull();
			expect(JSON.stringify(result)).not.toContain("untrusted-prose");
		});
	it("refuses duplicate or sparse findings", async () => {
		for (const sparse of [false, true]) {
			const data = dto(),
				items = [...(data.audit?.findings ?? [])];
			const first = items[0];
			if (!first) throw Error("fixture");
			if (sparse) delete items[0];
			else items.push(first);
			const result = await setup(active(), modified(data, ["audit", "findings"], items)).run();
			expect(result.output.reason).toBe("EVIDENCE_INVALID");
		}
	});
	it("does not execute evidence field getters", async () => {
		const data = dto();
		let read = false;
		Object.defineProperty(data, "binding", {
			get() {
				read = true;
				return BINDING;
			},
		});
		expect((await setup(active(), data).run()).output.reason).toBe("EVIDENCE_INVALID");
		expect(read).toBe(false);
	});
	it("maps unknown thrown text and forged error codes to fixed safe reasons", async () => {
		for (const error of [
			Error("untrusted-prose"),
			new ProducerError("untrusted-prose" as ProducerCode),
		]) {
			const f = setup();
			const p = createNativePolicyProducer({
				collect: async () => {
					throw error;
				},
				revalidate: f.collector.revalidate,
			});
			const result = await runNativePolicy({
				phase: "item",
				authority: f.authority,
				producer: p,
				completionClock: () => NOW + 100,
			});
			expect(result.output.reason).toBe("PRODUCER_UNAVAILABLE");
			expect(JSON.stringify(result)).not.toContain("untrusted-prose");
		}
	});
	it("maps forged authority error codes to a fixed reason", async () => {
		const f = setup();
		f.authority.currentRevision = async () => {
			throw new AuthorityError("untrusted-prose" as never);
		};
		const result = await f.run();
		expect(result.output.reason).toBe("AUTHORITY_UNAVAILABLE");
		expect(JSON.stringify(result)).not.toContain("untrusted-prose");
	});
	it("returns bounded safe JSON with deeply frozen output", async () => {
		const result = await setup().run();
		expect(Buffer.byteLength(JSON.stringify(result.output))).toBeLessThan(32_768);
		expect(Object.isFrozen(result.output.audit?.findings)).toBe(true);
		expect(JSON.stringify(result.output)).not.toMatch(/untrusted-prose|stack|stdout|stderr/);
	});
});
