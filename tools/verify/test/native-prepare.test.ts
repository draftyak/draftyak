import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Control protocol only: no acquisition, installed-tool inspection or preparation runs.
const factories = vi.hoisted(() => ({
	acquire: vi.fn(),
	inspect: vi.fn(),
	prepare: vi.fn(),
	ubuntu: vi.fn(),
	ubuntuRefusal: vi.fn(),
	ubuntuKnown: vi.fn(),
}));
vi.mock("../lib/inventory-native-build.ts", () => ({
	acquireInventoryNativeNodeInputs: factories.acquire,
	inspectInventoryNativeToolchain: factories.inspect,
	prepareInventoryNativeBuild: factories.prepare,
}));
vi.mock("../lib/inventory-native-ubuntu-inputs.mjs", () => ({
	acquireInventoryUbuntuInputs: factories.ubuntu,
	getInventoryUbuntuRefusalCode: factories.ubuntuRefusal,
	isInventoryUbuntuRefusalCode: factories.ubuntuKnown,
}));

import { parseNativePrepareArgs, runNativePrepare } from "../native-prepare.ts";

const output: string[] = [];
const receiptFile = path.resolve("synthetic-receipt.json");
const sha256 = "1".repeat(64);
const posixRefusal = {
	status: "unqualified-installed-posix-toolchain",
	code: "metadata-command-refused",
};
const windowsRefusal = {
	status: "unqualified-installed-windows-toolchain",
	stage: "compiler-signatures",
};
let platformDescriptor: PropertyDescriptor | undefined;

function selectLinuxProtocol(): void {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (!descriptor?.configurable || platformDescriptor !== undefined)
		throw new Error("Synthetic platform routing is unavailable");
	platformDescriptor = descriptor;
	Object.defineProperty(process, "platform", { ...descriptor, value: "linux" });
}

function records(): Record<string, unknown>[] {
	return output
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function nodeInputs() {
	return {
		version: "26.13.1",
		arch: process.arch,
		headers: path.resolve("synthetic-node-headers"),
		runtimeSha256: sha256,
	};
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

const heldCases = new Set<HeldCase>();
class HeldCase {
	readonly body: Promise<void>;
	private open = true;
	private readonly cancelled = deferred();
	private readonly releases: (() => void)[] = [];
	private readonly runs = new Set<Promise<unknown>>();
	private readonly drains: (() => Promise<unknown>)[] = [];
	private draining?: Promise<unknown>[];
	private teardown?: Promise<void>;

	constructor(work: (owner: HeldCase) => Promise<void>) {
		this.body = Promise.resolve().then(() => {
			this.admit();
			return work(this);
		});
	}
	admit(): void {
		if (!this.open) throw new Error("held case admission is closed");
	}
	release(work: () => void): void {
		this.releases.push(work);
	}
	drain(work: () => Promise<unknown>): void {
		this.drains.push(work);
	}
	run(original: Promise<unknown>): void {
		this.runs.add(original);
	}
	async wait(original: Promise<void>): Promise<void> {
		this.admit();
		await Promise.race([
			original,
			this.cancelled.promise.then(() => {
				throw new Error("held case wait was cancelled");
			}),
		]);
		this.admit();
	}
	close(): Promise<void> {
		this.open = false;
		for (const release of this.releases) release();
		// Cancel only this test wait, never fabricate the generator's cleanup entry.
		this.cancelled.resolve();
		this.draining ??= this.drains.map((drain) => Promise.resolve().then(drain));
		this.teardown ??= Promise.resolve().then(async () => {
			await Promise.allSettled([this.body]);
			const outcomes = await Promise.allSettled([...this.runs, ...(this.draining ?? [])]);
			if (outcomes.some((outcome) => outcome.status === "rejected"))
				throw new Error("held case originals did not settle successfully");
			heldCases.delete(this);
		});
		return this.teardown;
	}
}
function heldCase(work: (owner: HeldCase) => Promise<void>): Promise<void> {
	if (heldCases.size !== 0) throw new Error("an earlier held case retains teardown");
	const original = new HeldCase(work);
	heldCases.add(original);
	return original.body;
}
async function closeHeldCases(): Promise<void> {
	const outcomes = await Promise.allSettled([...heldCases].map((original) => original.close()));
	if (outcomes.some((outcome) => outcome.status === "rejected") || heldCases.size !== 0)
		throw new Error("held case teardown is unqualified");
}

beforeEach(() => {
	if (heldCases.size !== 0) throw new Error("an earlier held case retains teardown");
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
afterEach(async () => {
	await closeHeldCases();
	try {
		if (platformDescriptor !== undefined) {
			Object.defineProperty(process, "platform", platformDescriptor);
			platformDescriptor = undefined;
		}
	} finally {
		vi.restoreAllMocks();
	}
});
afterAll(closeHeldCases);

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

	it("refuses a failed stage, joins its held cleanup and never admits its successor", () =>
		heldCase(async (owner) => {
			const entered = deferred();
			const release = deferred();
			let advanced = false;
			let cleaned = false;
			const generator: AsyncGenerator<unknown, unknown, void> = (async function* () {
				try {
					yield {
						kind: "command",
						complete: true,
						files: [receiptFile],
						code: 1,
						signal: null,
						refusal: windowsRefusal,
					};
					advanced = true;
					return { receiptFile, sha256 };
				} finally {
					entered.resolve();
					await release.promise;
					cleaned = true;
				}
			})();
			let draining: Promise<IteratorResult<unknown, unknown>> | undefined;
			owner.release(() => release.resolve());
			owner.drain(() => {
				draining ??= generator.return(undefined);
				return draining;
			});
			factories.inspect.mockReturnValue(generator);
			owner.admit();
			const pending = runNativePrepare(["--inspect"]);
			owner.run(pending);
			let settled = false;
			void pending.then(() => {
				settled = true;
			});
			await owner.wait(entered.promise);
			await Promise.resolve();
			const beforeRelease = { settled, advanced };
			release.resolve();
			expect(await pending).toBe(1);
			expect(beforeRelease).toEqual({ settled: false, advanced: false });
			expect(cleaned).toBe(true);
			expect(output.join("")).not.toContain('"event":"inventory-native-result"');
		}));

	it("does not start preparation after acquisition fails or repeat exception prose", async () => {
		factories.acquire.mockRejectedValue(new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"));
		expect(await runNativePrepare(["--prepare"])).toBe(1);
		expect(factories.acquire).toHaveBeenCalledWith({ offline: true });
		expect(factories.prepare).not.toHaveBeenCalled();
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
		expect(output.join("")).toContain('"event":"inventory-native-failure"');
	});

	it.each([posixRefusal, windowsRefusal])(
		"copies a fixed refusal from a closed failed command without advancing: %j",
		async (refusal) => {
			let advanced = false;
			let cleaned = false;
			factories.inspect.mockImplementation(async function* () {
				try {
					yield {
						kind: "command",
						complete: true,
						files: [receiptFile],
						code: 1,
						signal: null,
						refusal,
					};
					advanced = true;
					return { receiptFile, sha256 };
				} finally {
					cleaned = true;
				}
			});
			expect(await runNativePrepare(["--inspect"])).toBe(1);
			expect(records().find((record) => record.event === "inventory-native-capture")).toEqual({
				event: "inventory-native-capture",
				kind: "command",
				files: [receiptFile],
				complete: true,
				code: 1,
				signal: null,
				refusal,
			});
			expect({ advanced, cleaned }).toEqual({ advanced: false, cleaned: true });
			expect(records().some((record) => record.event === "inventory-native-result")).toBe(false);
		},
	);

	it.each([
		["extra prose", { ...posixRefusal, message: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
		["unknown code", { ...posixRefusal, code: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
		["unknown stage", { ...windowsRefusal, stage: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
		[
			"unexpected query",
			{ ...windowsRefusal, query: { path: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" } },
		],
	] as const)("drops unvalidated optional refusal data: %s", async (_name, refusal) => {
		factories.inspect.mockImplementation(async function* () {
			yield {
				kind: "command",
				complete: true,
				files: [receiptFile],
				code: 1,
				signal: null,
				refusal,
			};
			return { receiptFile, sha256 };
		});
		expect(await runNativePrepare(["--inspect"])).toBe(1);
		const capture = records().find((record) => record.event === "inventory-native-capture");
		expect(capture).toBeDefined();
		expect(Object.hasOwn(capture ?? {}, "refusal")).toBe(false);
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	});

	it("does not invoke optional refusal accessors", async () => {
		let accessed = 0;
		const capture = {
			kind: "command",
			complete: true,
			files: [receiptFile],
			code: 1,
			signal: null,
		};
		Object.defineProperty(capture, "refusal", {
			get() {
				accessed++;
				throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
			},
		});
		factories.inspect.mockImplementation(async function* () {
			yield capture;
			return { receiptFile, sha256 };
		});
		expect(await runNativePrepare(["--inspect"])).toBe(1);
		expect(accessed).toBe(0);
		expect(
			Object.hasOwn(
				records().find((record) => record.event === "inventory-native-capture") ?? {},
				"refusal",
			),
		).toBe(false);
	});

	it("does not invoke getters or serialization hooks in a refusal descriptor", async () => {
		let accessed = 0;
		const refusal = { status: posixRefusal.status };
		Object.defineProperty(refusal, "code", {
			enumerable: true,
			get() {
				accessed++;
				return "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE";
			},
		});
		Object.defineProperty(refusal, "toJSON", {
			value() {
				accessed++;
				return { message: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" };
			},
		});
		factories.inspect.mockImplementation(async function* () {
			yield {
				kind: "command",
				complete: true,
				files: [receiptFile],
				code: 1,
				signal: null,
				refusal,
			};
			return { receiptFile, sha256 };
		});
		expect(await runNativePrepare(["--inspect"])).toBe(1);
		expect(accessed).toBe(0);
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	});

	it.each([
		["success", { kind: "command", complete: true, code: 0, signal: null }, 0],
		["incomplete", { kind: "command", complete: false, code: 1, signal: null }, 1],
		["another exit", { kind: "command", complete: true, code: 2, signal: null }, 1],
		["signal", { kind: "command", complete: true, code: 1, signal: "SIGTERM" }, 1],
		["metadata", { kind: "metadata", complete: true }, 0],
	] as const)(
		"keeps the lifecycle oracle independent of optional labels: %s",
		async (_name, lifecycle, expected) => {
			factories.inspect.mockImplementation(async function* () {
				yield { ...lifecycle, files: [receiptFile], refusal: windowsRefusal };
				return { receiptFile, sha256 };
			});
			expect(await runNativePrepare(["--inspect"])).toBe(expected);
			expect(
				Object.hasOwn(
					records().find((record) => record.event === "inventory-native-capture") ?? {},
					"refusal",
				),
			).toBe(false);
		},
	);

	it("reports a fixed Ubuntu refusal without reading arbitrary error properties", async () => {
		selectLinuxProtocol();
		let accessed = 0;
		const error = Object.create(null) as object;
		Object.defineProperties(error, {
			message: {
				get() {
					accessed++;
					throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
				},
			},
			code: {
				get() {
					accessed++;
					throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
				},
			},
		});
		const owned = new WeakMap<object, string>([[error, "ubuntu-input-acquisition-refused"]]);
		factories.acquire.mockResolvedValue(nodeInputs());
		factories.ubuntu.mockRejectedValue(error);
		factories.ubuntuRefusal.mockImplementation((value: object) => owned.get(value));
		factories.ubuntuKnown.mockImplementation(
			(value: unknown) => value === "ubuntu-input-acquisition-refused",
		);
		expect(await runNativePrepare(["--online", "--prepare"])).toBe(1);
		expect(factories.acquire).toHaveBeenCalledWith({ offline: false });
		expect(factories.ubuntu).toHaveBeenCalledWith({ offline: false });
		expect(factories.ubuntuRefusal).toHaveBeenCalledWith(error);
		expect(factories.prepare).not.toHaveBeenCalled();
		expect(accessed).toBe(0);
		expect(records().find((record) => record.event === "inventory-native-failure")).toEqual({
			event: "inventory-native-failure",
			action: "prepare",
			refusal: { stage: "ubuntu-inputs", code: "ubuntu-input-acquisition-refused" },
		});
		expect(records().some((record) => record.event === "inventory-native-result")).toBe(false);
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	});

	it.each([
		["unknown", undefined],
		["prose", "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"],
		["path", "ubuntu-../RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"],
		["line ending", "ubuntu-input-acquisition-refused\n"],
		["overlong", `ubuntu-${"x".repeat(97)}`],
		["non-string", { code: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
	] as const)("keeps an unrecognized Ubuntu lookup opaque: %s", async (_name, code) => {
		selectLinuxProtocol();
		factories.acquire.mockResolvedValue(nodeInputs());
		factories.ubuntu.mockRejectedValue(new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"));
		factories.ubuntuRefusal.mockReturnValue(code);
		factories.ubuntuKnown.mockReturnValue(true);
		expect(await runNativePrepare(["--acquire-only"])).toBe(1);
		expect(factories.acquire).toHaveBeenCalledWith({ offline: true });
		expect(factories.ubuntu).toHaveBeenCalledWith({ offline: true });
		expect(records().find((record) => record.event === "inventory-native-failure")).toEqual({
			event: "inventory-native-failure",
			action: "acquire-only",
			refusal: { stage: "ubuntu-inputs" },
		});
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	});

	it.each([
		["not recognized", false],
		["non-boolean", "true"],
	] as const)("requires an exact affirmative Ubuntu code predicate: %s", async (_name, known) => {
		selectLinuxProtocol();
		factories.acquire.mockResolvedValue(nodeInputs());
		factories.ubuntu.mockRejectedValue(new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"));
		factories.ubuntuRefusal.mockReturnValue("ubuntu-not-a-known-code");
		factories.ubuntuKnown.mockReturnValue(known);
		expect(await runNativePrepare(["--acquire-only"])).toBe(1);
		expect(records().find((record) => record.event === "inventory-native-failure")).toEqual({
			event: "inventory-native-failure",
			action: "acquire-only",
			refusal: { stage: "ubuntu-inputs" },
		});
	});

	it("keeps a failed Ubuntu lookup opaque and preserves the failed action", async () => {
		selectLinuxProtocol();
		factories.acquire.mockResolvedValue(nodeInputs());
		factories.ubuntu.mockRejectedValue(new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"));
		factories.ubuntuRefusal.mockImplementation(() => {
			throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
		});
		expect(await runNativePrepare(["--prepare"])).toBe(1);
		expect(factories.prepare).not.toHaveBeenCalled();
		expect(records().find((record) => record.event === "inventory-native-failure")).toEqual({
			event: "inventory-native-failure",
			action: "prepare",
			refusal: { stage: "ubuntu-inputs" },
		});
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	});

	it("keeps a failed Ubuntu code predicate opaque", async () => {
		selectLinuxProtocol();
		factories.acquire.mockResolvedValue(nodeInputs());
		factories.ubuntu.mockRejectedValue(new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"));
		factories.ubuntuRefusal.mockReturnValue("ubuntu-input-acquisition-refused");
		factories.ubuntuKnown.mockImplementation(() => {
			throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
		});
		expect(await runNativePrepare(["--prepare"])).toBe(1);
		expect(factories.prepare).not.toHaveBeenCalled();
		expect(records().find((record) => record.event === "inventory-native-failure")).toEqual({
			event: "inventory-native-failure",
			action: "prepare",
			refusal: { stage: "ubuntu-inputs" },
		});
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	});

	it("preserves successful Ubuntu routing without printing sibling metadata", async () => {
		selectLinuxProtocol();
		factories.acquire.mockResolvedValue(nodeInputs());
		factories.ubuntu.mockResolvedValue({ message: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" });
		expect(await runNativePrepare(["--acquire-only"])).toBe(0);
		expect(factories.ubuntuRefusal).not.toHaveBeenCalled();
		expect(records().some((record) => record.event === "inventory-native-ubuntu-inputs")).toBe(
			true,
		);
		expect(records().find((record) => record.event === "inventory-native-result")).toEqual({
			event: "inventory-native-result",
			action: "acquire-only",
		});
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	});
});
