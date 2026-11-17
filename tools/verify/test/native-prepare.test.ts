import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control protocol only: no acquisition, installed-tool inspection or preparation runs.
const factories = vi.hoisted(() => ({ acquire: vi.fn(), inspect: vi.fn(), prepare: vi.fn() }));
vi.mock("../lib/inventory-native-build.ts", () => ({
	acquireInventoryNativeNodeInputs: factories.acquire,
	inspectInventoryNativeToolchain: factories.inspect,
	prepareInventoryNativeBuild: factories.prepare,
}));

import { parseNativePrepareArgs, runNativePrepare } from "../native-prepare.ts";

const output: string[] = [];
const receiptFile = path.resolve("synthetic-receipt.json");
const sha256 = "1".repeat(64);

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

beforeEach(() => {
	output.length = 0;
	for (const factory of Object.values(factories)) factory.mockReset();
	const write = ((chunk: unknown, encodingOrCallback?: unknown, callback?: unknown) => {
		output.push(String(chunk));
		const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
		if (typeof done === "function") queueMicrotask(() => done(null));
		return true;
	}) as typeof process.stdout.write;
	vi.spyOn(process.stdout, "write").mockImplementation(write);
	vi.spyOn(process.stderr, "write").mockImplementation(write);
});
afterEach(() => vi.restoreAllMocks());

describe("explicit native preparation control protocol", () => {
	it.each([
		[],
		["--prepare", "--inspect"],
		["--prepare", "--prepare"],
		["--prepare", "--offline", "--online"],
		["--inspect", "--compiler=other"],
		["position"],
	])("rejects invalid arguments before admitting any factory: %j", async (...args) => {
		expect(await runNativePrepare(args)).toBe(2);
		for (const factory of Object.values(factories)) expect(factory).not.toHaveBeenCalled();
	});

	it("defaults to offline and requires one explicit action", () => {
		expect(parseNativePrepareArgs(["--prepare"])).toEqual({ action: "prepare", offline: true });
		expect(parseNativePrepareArgs(["--", "--online", "--acquire-only"])).toEqual({
			action: "acquire-only",
			offline: false,
		});
	});

	it("keeps inspect acquisition-free even with an online flag", async () => {
		factories.inspect.mockImplementation(async function* () {
			yield { kind: "metadata", complete: true, files: [receiptFile] };
			return { receiptFile, sha256 };
		});
		expect(await runNativePrepare(["--online", "--inspect"])).toBe(0);
		expect(factories.acquire).not.toHaveBeenCalled();
		expect(factories.prepare).not.toHaveBeenCalled();
		expect(output.join("")).toContain('"action":"inspect"');
	});

	it("refuses a failed stage, joins its held cleanup and never admits its successor", async () => {
		const entered = deferred();
		const release = deferred();
		let advanced = false;
		let cleaned = false;
		factories.inspect.mockImplementation(async function* () {
			try {
				yield { kind: "command", complete: true, files: [receiptFile], code: 1, signal: null };
				advanced = true;
				return { receiptFile, sha256 };
			} finally {
				entered.resolve();
				await release.promise;
				cleaned = true;
			}
		});
		const pending = runNativePrepare(["--inspect"]);
		let settled = false;
		void pending.then(() => {
			settled = true;
		});
		await entered.promise;
		await Promise.resolve();
		const beforeRelease = { settled, advanced };
		release.resolve();
		expect(await pending).toBe(1);
		expect(beforeRelease).toEqual({ settled: false, advanced: false });
		expect(cleaned).toBe(true);
		expect(output.join("")).not.toContain('"event":"inventory-native-result"');
	});

	it("does not start preparation after acquisition fails or repeat exception prose", async () => {
		factories.acquire.mockRejectedValue(new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"));
		expect(await runNativePrepare(["--prepare"])).toBe(1);
		expect(factories.acquire).toHaveBeenCalledWith({ offline: true });
		expect(factories.prepare).not.toHaveBeenCalled();
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
		expect(output.join("")).toContain('"event":"inventory-native-failure"');
	});
});
