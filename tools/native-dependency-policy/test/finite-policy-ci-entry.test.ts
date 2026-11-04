import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Fixed-entry wiring only. All three policy services return explicitly invented DATA.
// The real bridge and its dependencies are imported unchanged and remain inert.
const entry = fileURLToPath(new URL("../src/finite-policy-ci.ts", import.meta.url));
const preload = new URL("./fixtures/finite-policy-entry/preload.mjs", import.meta.url).href;
const repository = path.resolve(path.dirname(entry), "../../..");
type Row = Record<string, unknown>;
let root: string, parent: string, childrenJoined: boolean;

beforeEach(async () => {
	parent = await fs.realpath(os.tmpdir());
	root = await fs.realpath(await fs.mkdtemp(path.join(parent, "draftyak-entry-test-")));
	childrenJoined = true;
});
afterEach(async () => {
	expect(childrenJoined).toBe(true);
	expect(
		path.dirname(root) === parent && path.basename(root).startsWith("draftyak-entry-test-"),
	).toBe(true);
	const info = await fs.lstat(root);
	expect(info.isDirectory() && !info.isSymbolicLink() && (await fs.realpath(root)) === root).toBe(
		true,
	);
	await fs.rm(root, { recursive: true, force: false });
	let absent = false;
	try {
		await fs.lstat(root);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") absent = true;
		else throw error;
	}
	expect(absent).toBe(true);
});
function environment(mode: string): NodeJS.ProcessEnv {
	return {
		HOME: root,
		USERPROFILE: root,
		TEMP: root,
		TMP: root,
		TMPDIR: root,
		CARGO: path.join(root, "cargo"),
		CARGO_HOME: path.join(root, "cargo-home"),
		RUSTUP_HOME: path.join(root, "rustup"),
		RUSTUP_TOOLCHAIN: "test-only-toolchain",
		CARGO_NET_OFFLINE: "true",
		CARGO_TERM_COLOR: "never",
		NO_COLOR: "1",
		PATH: path.join(root, "search"),
		SystemRoot: path.join(root, "system"),
		DRAFTYAK_CARGO_DENY: path.join(root, "deny"),
		DRAFTYAK_NATIVE_POLICY_DATABASE_ROOT: path.join(root, "database"),
		DRAFTYAK_NATIVE_POLICY_PHASE: "release",
		DRAFTYAK_TEST_SELECTOR: "must-not-forward",
		TEST_ONLY_POLICY_ENTRY_ROOT: root,
		TEST_ONLY_POLICY_ENTRY_TRACE: path.join(root, "trace.json"),
		TEST_ONLY_POLICY_ENTRY_CASE: mode,
	};
}
function parsed(text: string): Row | null {
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" && !Array.isArray(value)
			? (value as Row)
			: null;
	} catch {
		return null;
	}
}
async function run(
	mode = "success",
	adjust?: (env: NodeJS.ProcessEnv) => void,
	operands: string[] = [],
	imported = false,
) {
	const env = environment(mode);
	adjust?.(env);
	const args = [
		"--import",
		preload,
		...(imported
			? [
					"--input-type=module",
					"--eval",
					`await import(${JSON.stringify(new URL("../src/finite-policy-ci.ts", import.meta.url).href)})`,
				]
			: [entry, ...operands]),
	];
	childrenJoined = false;
	const child = spawnSync(process.execPath, args, {
		cwd: repository,
		env,
		shell: false,
		windowsHide: true,
		encoding: "utf8",
		timeout: 10000,
		maxBuffer: 131072,
	});
	childrenJoined = !child.error && child.signal === null && Number.isInteger(child.status);
	expect(childrenJoined).toBe(true);
	const diagnosticCodes = [
		...new Set((child.stderr ?? "").match(/\b(?:ERR_[A-Z_]+|TEST_ONLY_[A-Z_]+)\b/g) ?? []),
	];
	expect(diagnosticCodes).toEqual([]);
	let trace: Row | null = null;
	try {
		trace = parsed(await fs.readFile(path.join(root, "trace.json"), "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	return {
		status: child.status,
		stdout: typeof child.stdout === "string" ? child.stdout : "",
		stderr: typeof child.stderr === "string" ? child.stderr : "",
		trace,
	};
}
function output(reason: string | null = null): Row {
	return {
		version: 1,
		phase: "item",
		verdict: reason === null ? "strict-pass" : "refuse",
		reason,
		authorityRevision: null,
		authorityRecordDigest: null,
		runId: null,
		reportDigest: null,
		binding: null,
		audit: null,
		rawExits: null,
		accepted: [],
	};
}
function entryRefused(result: Awaited<ReturnType<typeof run>>): void {
	expect(result.status !== null && result.status !== 0).toBe(true);
	expect(result.stdout.length === 0).toBe(true);
	expect(
		JSON.stringify(parsed(result.stderr)) ===
			JSON.stringify({
				code: "FINITE_POLICY_CI_ENTRY_REFUSED",
				refused: true,
				resourcesKnown: false,
				resourcesComplete: false,
				processUnconfirmed: false,
				resourceUncertain: true,
			}),
	).toBe(true);
}

describe("fixed policy CI entry with TEST_ONLY service substitutions", () => {
	it("keeps importing the actual module inert", async () => {
		const result = await run("success", undefined, [], true);
		expect(result.status).toBe(0);
		expect(result.trace === null && result.stdout.length === 0 && result.stderr.length === 0).toBe(
			true,
		);
	});
	it.each(["CARGO", "CARGO_HOME", "DRAFTYAK_CARGO_DENY", "DRAFTYAK_NATIVE_POLICY_DATABASE_ROOT"])(
		"refuses missing %s before any service constructor",
		async (key) => {
			const result = await run("success", (env) => {
				delete env[key];
			});
			entryRefused(result);
			expect(result.trace === null).toBe(true);
		},
	);
	it("refuses a relative database root before constructors", async () => {
		const result = await run("success", (env) => {
			env.DRAFTYAK_NATIVE_POLICY_DATABASE_ROOT = "relative";
		});
		entryRefused(result);
		expect(result.trace === null).toBe(true);
	});
	it("refuses an extra operand before constructors", async () => {
		const result = await run("success", undefined, ["unexpected"]);
		entryRefused(result);
		expect(result.trace === null).toBe(true);
	});
	it("dispatches item authority and producer with exact physical options and a sealed environment", async () => {
		const result = await run();
		expect(result.status).toBe(0);
		expect(JSON.stringify(parsed(result.stdout)) === JSON.stringify(output())).toBe(true);
		expect(result.stderr.length === 0).toBe(true);
		expect(
			JSON.stringify(result.trace) ===
				JSON.stringify({
					authority: 1,
					producer: 1,
					runner: 1,
					constructorArgsEmpty: true,
					physicalBindings: true,
					optionKeysExact: true,
					environmentKeysExact: true,
					environmentFrozenNullPrototype: true,
					selectorLeak: false,
					itemPhase: true,
					sameServices: true,
				}),
		).toBe(true);
	});
	it.each([
		["ordinary-failure", 1, "AUDIT_INVALID"],
		["stale", 2, "AUTHORITY_CHANGED"],
	] as const)(
		"preserves the synthetic runner %s result and exact exit",
		async (mode, code, reason) => {
			const result = await run(mode);
			expect(result.status).toBe(code);
			expect(JSON.stringify(parsed(result.stdout)) === JSON.stringify(output(reason))).toBe(true);
		},
	);
	it("preserves finalizer failure and nonzero exit even when raw commands exited zero", async () => {
		const result = await run("finalizer-failure");
		const expected = output("PRODUCER_UNAVAILABLE");
		expected.rawExits = {
			full: { exitCode: 0, signal: null },
			advisory: { exitCode: 0, signal: null },
		};
		expected.finalizerFailure = "PRODUCER_UNAVAILABLE";
		expect(result.status).toBe(2);
		expect(JSON.stringify(parsed(result.stdout)) === JSON.stringify(expected)).toBe(true);
	});
	it("maps an unknown service throw to a fixed nonzero refusal without exposing its payload", async () => {
		const result = await run("throw");
		entryRefused(result);
		expect(result.trace?.runner).toBe(1);
	});
	it("refuses oversized runner output before writing a partial result", async () => {
		entryRefused(await run("large-output"));
	});
});
