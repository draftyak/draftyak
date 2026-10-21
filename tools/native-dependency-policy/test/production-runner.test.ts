import {
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorityTransport } from "../src/authority.ts";
import type { Phase } from "../src/options.ts";
import type { RunnerResult } from "../src/runner.ts";

const external = vi.hoisted(() => ({
	request: vi.fn(() => {
		throw new Error("unexpected HTTPS request in offline integration test");
	}),
	spawn: vi.fn(() => {
		throw new Error("unexpected native process in offline integration test");
	}),
	execFile: vi.fn(() => {
		throw new Error("unexpected native process in offline integration test");
	}),
}));
vi.mock("node:https", () => ({ request: external.request }));
vi.mock("node:child_process", () => ({ spawn: external.spawn, execFile: external.execFile }));

const { createProductionProducer } = await import("../src/production.ts");
const { runNativePolicy } = await import("../src/runner.ts");
const NOW = Date.parse("2026-10-20T16:00:00Z");
const REVISION = "a".repeat(40);
const CHANGED = "b".repeat(40);
const PHASES: readonly Phase[] = ["item", "m4-gate"];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
let temporary: string;
let checkout: string;
let directory: string;

beforeEach(async () => {
	vi.clearAllMocks();
	temporary = await realpath(await mkdtemp(path.join(os.tmpdir(), "draftyak-production-test-")));
	checkout = path.join(temporary, "checkout");
	directory = path.join(temporary, "evidence");
	await mkdir(checkout);
	await writeFile(path.join(checkout, "sentinel"), "synthetic checkout remains unchanged");
});

afterEach(async () => {
	try {
		expect(external.request).not.toHaveBeenCalled();
		expect(external.spawn).not.toHaveBeenCalled();
		expect(external.execFile).not.toHaveBeenCalled();
		expect(await readFile(path.join(checkout, "sentinel"), "utf8")).toBe(
			"synthetic checkout remains unchanged",
		);
	} finally {
		const resolved = await realpath(temporary);
		expect(path.isAbsolute(resolved)).toBe(true);
		expect(path.dirname(resolved)).toBe(await realpath(os.tmpdir()));
		expect(path.basename(resolved)).toMatch(/^draftyak-production-test-[A-Za-z0-9_-]+$/);
		expect((await lstat(resolved)).isSymbolicLink()).toBe(false);
		await rm(resolved, { recursive: true });
		await expect(lstat(resolved)).rejects.toMatchObject({ code: "ENOENT" });
	}
});

function active() {
	return {
		version: 1,
		state: "active",
		gate: "open",
		evidenceKind: "actual-source",
		confirmation: "unchanged-scope",
		binding: {
			graph: "1".repeat(64),
			lock: "2".repeat(64),
			inputs: "3".repeat(64),
			basis: "4".repeat(64),
			releases: "5".repeat(64),
			security: "6".repeat(64),
			policy: "7".repeat(64),
		},
		review: { at: "2026-10-20T15:59:00Z", due: "2026-10-20T17:00:00Z" },
		exceptions: [],
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

function authority(
	record: unknown,
	final?: () => Promise<string>,
): { transport: AuthorityTransport; calls: () => number } {
	let calls = 0;
	return {
		calls: () => calls,
		transport: {
			async currentRevision() {
				calls++;
				return calls === 3 && final ? final() : REVISION;
			},
			async recordAt(revision) {
				expect(revision).toBe(REVISION);
				return Buffer.from(JSON.stringify(record));
			},
		},
	};
}

function producer(destination = directory) {
	return createProductionProducer({ repositoryRoot: checkout, evidenceDirectory: destination });
}

function noAudit(result: RunnerResult) {
	expect(result.output.verdict).toBe("refuse");
	expect(result.output.audit).toBeNull();
	expect(result.output.reportDigest).toBeNull();
	expect(result.output.binding).toBeNull();
	expect(result.output.accepted).toEqual([]);
	const json = JSON.stringify(result.output);
	expect(Buffer.byteLength(json)).toBeLessThanOrEqual(32_768);
	for (const privatePath of [temporary, checkout, directory])
		expect(json).not.toContain(privatePath);
	expect(json).not.toContain("draftyak-production-test-");
}

async function absent() {
	await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
	expect(await readdir(temporary)).toEqual(["checkout"]);
}

describe("real production factory and policy runner", () => {
	it("constructs without creating its evidence directory or reading authority", async () => {
		const trusted = authority(active());
		producer();
		expect(trusted.calls()).toBe(0);
		await absent();
	});

	it.each(PHASES)(
		"preflights the trusted initial record before filesystem creation: %s",
		async (phase) => {
			const trusted = authority({
				version: 1,
				state: "refusal-only",
				reason: "ACTUAL_SOURCE_CONFIRMATION_REQUIRED",
			});
			const result = await runNativePolicy({
				phase,
				authority: trusted.transport,
				producer: producer(),
				completionClock: () => NOW,
			});
			expect(result.exitCode).toBe(1);
			expect(result.output.reason).toBe("ACTUAL_SOURCE_CONFIRMATION_REQUIRED");
			expect(result.output.phase).toBe(phase);
			expect(result.output.runId).toBeNull();
			expect(result.output.rawExits).toBeNull();
			expect(trusted.calls()).toBe(2);
			noAudit(result);
			await absent();
		},
	);

	it.each(PHASES)(
		"active authority still refuses unavailable production evidence: %s",
		async (phase) => {
			const trusted = authority(active(), async () => {
				expect((await lstat(directory)).isDirectory()).toBe(true);
				expect(await readdir(directory)).toEqual([]);
				return REVISION;
			});
			const result = await runNativePolicy({
				phase,
				authority: trusted.transport,
				producer: producer(),
				completionClock: () => NOW,
			});
			expect(result.exitCode).toBe(2);
			expect(result.output.reason).toBe("BASIS_UNAVAILABLE");
			expect(result.output.phase).toBe(phase);
			expect(result.output.runId).toMatch(UUID);
			expect(result.output.rawExits).toEqual({ full: null, advisory: null });
			expect(result.output.authorityRevision).toBe(REVISION);
			expect(trusted.calls()).toBe(3);
			noAudit(result);
			expect(await readdir(temporary)).toEqual(["checkout", "evidence"]);
		},
	);
	it.each(PHASES)(
		"explicit v2 renewal cannot activate unavailable production evidence: %s",
		async (phase) => {
			const trusted = authority(renewed());
			const result = await runNativePolicy({
				phase,
				authority: trusted.transport,
				producer: producer(),
				completionClock: () => NOW,
			});
			expect(result.exitCode).toBe(2);
			expect(result.output.reason).toBe("BASIS_UNAVAILABLE");
			expect(result.output.runId).toMatch(UUID);
			expect(result.output.rawExits).toEqual({ full: null, advisory: null });
			expect(trusted.calls()).toBe(3);
			noAudit(result);
		},
	);
	for (const state of ["release-closed", "removed", "revoked"]) {
		it.each(PHASES)(
			`delivered v2 ${state} stops production before evidence creation: %s`,
			async (phase) => {
				const trusted = authority({ version: 2, state });
				const result = await runNativePolicy({
					phase,
					authority: trusted.transport,
					producer: producer(),
					completionClock: () => NOW,
				});
				expect(result.exitCode).toBe(1);
				expect(result.output.reason).toBe("TERMINAL_STATE");
				expect(result.output.runId).toBeNull();
				expect(result.output.rawExits).toBeNull();
				expect(trusted.calls()).toBe(2);
				noAudit(result);
				await absent();
			},
		);
	}

	for (const state of ["removed", "revoked", "expired", "gate-closed"]) {
		it.each(PHASES)(
			`delivered ${state} authority stops before filesystem creation: %s`,
			async (phase) => {
				const trusted = authority({ version: 1, state });
				const result = await runNativePolicy({
					phase,
					authority: trusted.transport,
					producer: producer(),
					completionClock: () => NOW,
				});
				expect(result.exitCode).toBe(1);
				expect(result.output.reason).toBe("TERMINAL_STATE");
				expect(result.output.runId).toBeNull();
				expect(result.output.rawExits).toBeNull();
				expect(trusted.calls()).toBe(2);
				noAudit(result);
				await absent();
			},
		);
	}

	it.each(PHASES)(
		"malformed trusted record stops before filesystem creation: %s",
		async (phase) => {
			const trusted = authority({ ...active(), confirmation: "unverified" });
			const result = await runNativePolicy({
				phase,
				authority: trusted.transport,
				producer: producer(),
				completionClock: () => NOW,
			});
			expect(result.exitCode).toBe(2);
			expect(result.output.reason).toBe("AUTHORITY_INVALID");
			expect(result.output.runId).toBeNull();
			noAudit(result);
			await absent();
		},
	);

	it.each(PHASES)(
		"final authority change overrides unavailable basis after collection: %s",
		async (phase) => {
			const trusted = authority(active(), async () => {
				expect((await lstat(directory)).isDirectory()).toBe(true);
				expect(await readdir(directory)).toEqual([]);
				return CHANGED;
			});
			const result = await runNativePolicy({
				phase,
				authority: trusted.transport,
				producer: producer(),
				completionClock: () => NOW,
			});
			expect(result.exitCode).toBe(1);
			expect(result.output.reason).toBe("AUTHORITY_CHANGED");
			expect(result.output.runId).toMatch(UUID);
			expect(result.output.rawExits).toEqual({ full: null, advisory: null });
			expect(trusted.calls()).toBe(3);
			noAudit(result);
		},
	);

	it("uses fresh real run UUIDs and refuses an already used evidence directory", async () => {
		const first = await runNativePolicy({
			phase: "item",
			authority: authority(active()).transport,
			producer: producer(),
			completionClock: () => NOW,
		});
		expect(first.output.reason).toBe("BASIS_UNAVAILABLE");
		expect(first.output.runId).toMatch(UUID);
		const secondDirectory = path.join(temporary, "second-evidence");
		const second = await runNativePolicy({
			phase: "m4-gate",
			authority: authority(active()).transport,
			producer: producer(secondDirectory),
			completionClock: () => NOW,
		});
		expect(second.output.reason).toBe("BASIS_UNAVAILABLE");
		expect(second.output.runId).toMatch(UUID);
		expect(second.output.runId).not.toBe(first.output.runId);
		expect((await lstat(secondDirectory)).isDirectory()).toBe(true);
		expect(await readdir(secondDirectory)).toEqual([]);
		const repeated = await runNativePolicy({
			phase: "item",
			authority: authority(active()).transport,
			producer: producer(),
			completionClock: () => NOW,
		});
		expect(repeated.exitCode).toBe(2);
		expect(repeated.output.verdict).toBe("refuse");
		expect(repeated.output.reason).toBe("PRODUCER_UNAVAILABLE");
		expect(repeated.output.runId).toBeNull();
		expect(repeated.output.rawExits).toBeNull();
		noAudit(first);
		noAudit(second);
		noAudit(repeated);
		expect(JSON.stringify(second.output)).not.toContain(secondDirectory);
		expect(await readdir(directory)).toEqual([]);
	});
});
