import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildHeavyShardReceipt,
	collectHeavyShardReceipts,
	type HeavyShardReceipt,
	planHeavyShards,
	validateHeavyShard,
	writeHeavyShardReceipt,
} from "./heavy-shards.ts";
import { UsageError } from "./lib.ts";

const captured = Object.freeze({
	checkoutSha: "a".repeat(40),
	treeSha: "b".repeat(40),
	lockfileSha256: "c".repeat(64),
	nodeVersion: "26.12.0",
	platform: "linux",
	architecture: "x64",
});
const currentRun = Object.freeze({ id: "123456", attempt: "2" });
const selection = "spikes/zeta\nspikes/alpha";
const temporary: string[] = [];

function folder(): string {
	const value = mkdtempSync(path.join(os.tmpdir(), "draftyak-heavy-shards-"));
	temporary.push(value);
	return value;
}

function receipt(id = "spike-001", spike = "spikes/alpha"): HeavyShardReceipt {
	return buildHeavyShardReceipt({
		spikes: selection,
		id,
		spike,
		source: captured,
		run: currentRun,
		commandResult: "success",
	});
}

function writeRaw(root: string, id: string, value: unknown): void {
	writeFileSync(path.join(root, `heavy-shard-${id}.json`), `${JSON.stringify(value)}\n`);
}

function complete(root: string): void {
	writeHeavyShardReceipt(root, receipt("spike-002", "spikes/zeta"));
	writeHeavyShardReceipt(root, receipt());
}

afterEach(() => {
	for (const value of temporary.splice(0)) {
		if (path.dirname(value) !== path.resolve(os.tmpdir()))
			throw new Error("fixture cleanup refused");
		rmSync(value, { recursive: true, force: true });
	}
});

describe("heavy shard planning", () => {
	it("sorts the exact selected union into one importer per indexed shard", () => {
		const plan = planHeavyShards("spikes/zeta\nspikes/alpha\nspikes/nested/example");
		expect(plan).toEqual({
			selected: true,
			count: 3,
			shards: [
				{ id: "spike-001", spike: "spikes/alpha" },
				{ id: "spike-002", spike: "spikes/nested/example" },
				{ id: "spike-003", spike: "spikes/zeta" },
			],
			matrix: {
				include: [
					{ id: "spike-001", spike: "spikes/alpha" },
					{ id: "spike-002", spike: "spikes/nested/example" },
					{ id: "spike-003", spike: "spikes/zeta" },
				],
			},
		});
	});

	it("keeps assignment deterministic across input ordering and CRLF", () => {
		expect(planHeavyShards("spikes/zeta\r\nspikes/alpha")).toEqual(
			planHeavyShards("spikes/alpha\nspikes/zeta"),
		);
	});
	it("preserves selected suites outside the current spike directory vocabulary", () => {
		expect(planHeavyShards("experiments/python-runtime\napps/android-host/probe").shards).toEqual([
			{ id: "spike-001", spike: "apps/android-host/probe" },
			{ id: "spike-002", spike: "experiments/python-runtime" },
		]);
	});

	it("uses an unselected harmless matrix placeholder for the empty union", () => {
		expect(planHeavyShards("")).toEqual({
			selected: false,
			count: 0,
			shards: [],
			matrix: { include: [{ id: "spike-empty", spike: "" }] },
		});
		expect(planHeavyShards(undefined)).toEqual(planHeavyShards(""));
		expect(() => validateHeavyShard("", "spike-empty", "")).toThrow(UsageError);
	});

	it("preserves all one hundred selected importers", () => {
		const paths = Array.from({ length: 100 }, (_, index) => `spikes/example-${index}`);
		const plan = planHeavyShards(paths.join("\n"));
		expect(plan.count).toBe(100);
		expect(plan.shards.map((shard) => shard.spike)).toEqual([...paths].sort());
		expect(plan.shards[99]?.id).toBe("spike-100");
	});

	it("returns immutable assignments without a mutable coverage alias", () => {
		const plan = planHeavyShards(selection);
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.shards)).toBe(true);
		expect(Object.isFrozen(plan.matrix)).toBe(true);
		expect(plan.shards.every(Object.isFrozen)).toBe(true);
	});

	it.each([
		{ name: "nontext selection", value: ["spikes/example"] },
		{ name: "duplicate importer", value: "spikes/example\nspikes/example" },
		{ name: "empty interior entry", value: "spikes/example\n\nspikes/other" },
		{ name: "trailing empty entry", value: "spikes/example\n" },
		{ name: "absolute product path", value: "/packages/example" },
		{ name: "empty segment", value: "spikes//example" },
		{ name: "parent traversal", value: "spikes/example/../other" },
		{ name: "dot traversal", value: "spikes/./example" },
		{ name: "absolute path", value: "/spikes/example" },
		{ name: "backslash path", value: "spikes\\example" },
		{ name: "filter expression", value: "...{./spikes/example}" },
		{ name: "shell punctuation", value: "spikes/example;other" },
		{ name: "overlong path", value: `spikes/${"a".repeat(194)}` },
		{
			name: "too many importers",
			value: Array.from({ length: 101 }, (_, i) => `spikes/a-${i}`).join("\n"),
		},
		{ name: "oversized selection", value: "a".repeat(16 * 1024 + 1) },
	])("refuses $name", ({ value }) => {
		expect(() => planHeavyShards(value)).toThrow(UsageError);
	});

	it("requires the assigned ID and importer together", () => {
		expect(validateHeavyShard(selection, "spike-002", "spikes/zeta")).toEqual({
			id: "spike-002",
			spike: "spikes/zeta",
		});
		expect(() => validateHeavyShard(selection, "spike-002", "spikes/alpha")).toThrow(UsageError);
		expect(() => validateHeavyShard(selection, "spike-003", "spikes/zeta")).toThrow(UsageError);
	});
});

describe("heavy shard completion receipts", () => {
	it.each([undefined, "failure", "cancelled", "skipped"])(
		"refuses a completion marker without successful command outcome %s",
		(commandResult) => {
			expect(() =>
				buildHeavyShardReceipt({
					spikes: selection,
					id: "spike-001",
					spike: "spikes/alpha",
					source: captured,
					run: currentRun,
					commandResult,
				}),
			).toThrow(UsageError);
		},
	);

	it("writes one bounded regular receipt and refuses overwriting its identity", () => {
		const root = folder();
		const file = writeHeavyShardReceipt(root, receipt());
		expect(path.basename(file)).toBe("heavy-shard-spike-001.json");
		const bytes = readFileSync(file);
		expect(bytes.length).toBeLessThan(4096);
		expect(JSON.parse(bytes.toString("utf8"))).toEqual(receipt());
		expect(() => writeHeavyShardReceipt(root, receipt())).toThrow(UsageError);
	});

	it("collects out-of-order artifact files into the complete original sorted union", () => {
		const root = folder();
		complete(root);
		expect(collectHeavyShardReceipts(selection, captured, currentRun, root)).toEqual({
			source: captured,
			completed: [
				{ id: "spike-001", spike: "spikes/alpha" },
				{ id: "spike-002", spike: "spikes/zeta" },
			],
		});
	});

	it("permits no artifacts for the genuinely empty selection", () => {
		expect(collectHeavyShardReceipts("", captured, currentRun, folder()).completed).toEqual([]);
	});

	it("refuses a missing shard rather than treating partial coverage as complete", () => {
		const root = folder();
		writeHeavyShardReceipt(root, receipt());
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it("refuses extra files even when every expected shard is present", () => {
		const root = folder();
		complete(root);
		writeFileSync(path.join(root, "unexpected.json"), "{}\n");
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it("refuses duplicate identities hidden behind different expected filenames", () => {
		const root = folder();
		writeRaw(root, "spike-001", receipt());
		writeRaw(root, "spike-002", receipt());
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it.each([
		{ name: "commit", patch: { checkoutSha: "d".repeat(40) } },
		{ name: "tree", patch: { treeSha: "d".repeat(40) } },
		{ name: "lockfile", patch: { lockfileSha256: "d".repeat(64) } },
		{ name: "Node", patch: { nodeVersion: "26.11.0" } },
		{ name: "platform", patch: { platform: "win32" } },
		{ name: "architecture", patch: { architecture: "arm64" } },
	])("refuses a mismatched $name Source field", ({ patch }) => {
		const root = folder();
		writeRaw(root, "spike-001", { ...receipt(), source: { ...captured, ...patch } });
		writeHeavyShardReceipt(root, receipt("spike-002", "spikes/zeta"));
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it.each([
		{ name: "run", run: { id: "123457", attempt: "2" } },
		{ name: "attempt", run: { id: "123456", attempt: "1" } },
	])("refuses a stale $name receipt", ({ run }) => {
		const root = folder();
		writeRaw(root, "spike-001", { ...receipt(), run });
		writeHeavyShardReceipt(root, receipt("spike-002", "spikes/zeta"));
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it.each([
		{ name: "completion", patch: { completed: false } },
		{ name: "version", patch: { version: 2 } },
		{ name: "importer", patch: { spike: "spikes/other" } },
		{ name: "extra metadata", patch: { extra: true } },
	])("refuses invalid $name metadata", ({ patch }) => {
		const root = folder();
		writeRaw(root, "spike-001", { ...receipt(), ...patch });
		writeHeavyShardReceipt(root, receipt("spike-002", "spikes/zeta"));
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it("refuses oversized files before parsing JSON", () => {
		const root = folder();
		writeFileSync(path.join(root, "heavy-shard-spike-001.json"), " ".repeat(4097));
		writeHeavyShardReceipt(root, receipt("spike-002", "spikes/zeta"));
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it("refuses invalid UTF-8 and duplicate JSON fields", () => {
		const root = folder();
		const file = path.join(root, "heavy-shard-spike-001.json");
		writeFileSync(file, Buffer.from([255]));
		writeHeavyShardReceipt(root, receipt("spike-002", "spikes/zeta"));
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
		writeFileSync(
			file,
			`${JSON.stringify(receipt()).replace('"version":1', '"version":1,"version":1')}\n`,
		);
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it("refuses directories and symlinks in place of receipt files", () => {
		const root = folder();
		const outside = folder();
		writeHeavyShardReceipt(root, receipt("spike-002", "spikes/zeta"));
		symlinkSync(outside, path.join(root, "heavy-shard-spike-001.json"), "junction");
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, root)).toThrow(
			UsageError,
		);
	});

	it("refuses a symlinked artifact root and nested artifact directories", () => {
		const root = folder();
		const actual = folder();
		complete(actual);
		const linked = path.join(root, "linked");
		symlinkSync(actual, linked, "junction");
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, linked)).toThrow(
			UsageError,
		);
		const nested = folder();
		complete(nested);
		mkdirSync(path.join(nested, "nested"));
		expect(() => collectHeavyShardReceipts(selection, captured, currentRun, nested)).toThrow(
			UsageError,
		);
	});
});
