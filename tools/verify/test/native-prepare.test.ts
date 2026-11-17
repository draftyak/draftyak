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
const ubuntuMock = vi.hoisted(() => ({
	module: undefined as object | undefined,
	permission: undefined as PropertyDescriptor | undefined,
}));
vi.mock("../lib/inventory-native-build.ts", () => ({
	acquireInventoryNativeNodeInputs: factories.acquire,
	inspectInventoryNativeToolchain: factories.inspect,
	prepareInventoryNativeBuild: factories.prepare,
}));
vi.mock("../lib/inventory-native-ubuntu-inputs.mjs", () => {
	const module = {
		acquireInventoryUbuntuInputs: factories.ubuntu,
		getInventoryUbuntuRefusalCode: factories.ubuntuRefusal,
		isInventoryUbuntuRefusalCode: factories.ubuntuKnown,
	};
	if (ubuntuMock.permission !== undefined)
		Object.defineProperty(module, "getInventoryUbuntuPermissionContext", ubuntuMock.permission);
	ubuntuMock.module = module;
	return module;
});

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

	it("emits fixed macOS resource facts while retaining the failed capture lifecycle", async () => {
		const refusal = {
			status: "unqualified-installed-posix-toolchain",
			code: "system-owner-or-permissions",
			role: "sdk-directory",
			stage: "ancestor",
			failedPredicate: "owner",
		};
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
		expect(
			records().find((record) => record.event === "inventory-native-capture")?.refusal,
		).toEqual(refusal);
		expect({ advanced, cleaned }).toEqual({ advanced: false, cleaned: true });
		expect(records().some((record) => record.event === "inventory-native-result")).toBe(false);
	});

	it.each([
		[
			"unknown role",
			{ role: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE", stage: "file", failedPredicate: "owner" },
		],
		[
			"unknown stage",
			{
				role: "sdk-directory",
				stage: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE",
				failedPredicate: "owner",
			},
		],
		[
			"unknown predicate",
			{ role: "sdk-directory", stage: "file", failedPredicate: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" },
		],
		["missing role", { stage: "file", failedPredicate: "owner" }],
		["missing stage", { role: "sdk-directory", failedPredicate: "owner" }],
		["missing predicate", { role: "sdk-directory", stage: "file" }],
		[
			"unrelated code",
			{
				role: "sdk-directory",
				stage: "file",
				failedPredicate: "owner",
				code: "metadata-command-refused",
			},
		],
	] as const)("keeps unknown or partial macOS facts opaque: %s", async (_name, context) => {
		const refusal = {
			status: "unqualified-installed-posix-toolchain",
			...context,
			code: "code" in context ? context.code : "system-owner-or-permissions",
		};
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
		expect(
			Object.hasOwn(
				records().find((record) => record.event === "inventory-native-capture") ?? {},
				"refusal",
			),
		).toBe(false);
		expect(records().some((record) => record.event === "inventory-native-result")).toBe(false);
		expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	});
});

function permissionExport(descriptor: PropertyDescriptor | undefined): void {
	ubuntuMock.permission =
		descriptor === undefined ? undefined : { ...descriptor, configurable: true };
	if (ubuntuMock.module === undefined) return;
	if (ubuntuMock.permission === undefined)
		Reflect.deleteProperty(ubuntuMock.module, "getInventoryUbuntuPermissionContext");
	else
		Object.defineProperty(
			ubuntuMock.module,
			"getInventoryUbuntuPermissionContext",
			ubuntuMock.permission,
		);
}

async function permissionFailure(
	owner: HeldCase,
	descriptor: PropertyDescriptor | undefined,
	code: unknown = "ubuntu-system-permissions",
	known: unknown = true,
	error: unknown = new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"),
) {
	selectLinuxProtocol();
	permissionExport(descriptor);
	factories.acquire.mockResolvedValue(nodeInputs());
	factories.ubuntu.mockRejectedValue(error);
	factories.ubuntuRefusal.mockReturnValue(code);
	factories.ubuntuKnown.mockReturnValue(known);
	owner.admit();
	const pending = runNativePrepare(["--prepare"]);
	owner.run(pending);
	owner.drain(async () => {
		try {
			await pending;
		} finally {
			permissionExport(undefined);
		}
	});
	expect(await pending).toBe(1);
	expect(factories.prepare).not.toHaveBeenCalled();
	expect(records().some((record) => record.event === "inventory-native-result")).toBe(false);
	expect(output.join("")).not.toContain("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
	return records().find((record) => record.event === "inventory-native-failure");
}

describe("Ubuntu permission failure context", () => {
	const context = { role: "compiler", lexical: "ancestor", write: "both" };
	const refusal = { stage: "ubuntu-inputs", code: "ubuntu-system-permissions" };
	it("emits only a complete normalized tuple from the actual rejected error", () =>
		heldCase(async (owner) => {
			let reads = 0;
			const error = Object.create(null) as object;
			for (const field of ["message", "code", "permission", "role", "lexical", "write"])
				Object.defineProperty(error, field, {
					get() {
						reads++;
						throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
					},
				});
			const owned = new WeakMap<object, object>([[error, context]]);
			const lookup = vi.fn((value: object) => owned.get(value));
			expect(
				await permissionFailure(owner, { value: lookup }, "ubuntu-system-permissions", true, error),
			).toEqual({
				event: "inventory-native-failure",
				action: "prepare",
				refusal: { ...refusal, permission: context },
			});
			expect(lookup).toHaveBeenCalledExactlyOnceWith(error);
			expect(reads).toBe(0);
		}));
	it.each([
		["missing", undefined],
		["nonfunction", { value: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
	] as const)("preserves the validated code with a %s optional export", (_name, descriptor) =>
		heldCase(async (owner) => {
			expect((await permissionFailure(owner, descriptor))?.refusal).toEqual(refusal);
		}),
	);
	it("preserves the validated code when the optional lookup throws", () =>
		heldCase(async (owner) => {
			const lookup = vi.fn(() => {
				throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
			});
			expect((await permissionFailure(owner, { value: lookup }))?.refusal).toEqual(refusal);
			expect(lookup).toHaveBeenCalledTimes(1);
		}));
	it("ignores an optional export accessor without invoking it", () =>
		heldCase(async (owner) => {
			let reads = 0;
			expect(
				(
					await permissionFailure(owner, {
						get() {
							reads++;
							throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
						},
					})
				)?.refusal,
			).toEqual(refusal);
			expect(reads).toBe(0);
		}));
	it.each([
		["no context", undefined],
		["null", null],
		["scalar", "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE"],
		["unknown role", { ...context, role: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
		["unknown lexical", { ...context, lexical: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
		["unknown write", { ...context, write: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
		["missing role", { lexical: "ancestor", write: "both" }],
		["missing lexical", { role: "compiler", write: "both" }],
		["missing write", { role: "compiler", lexical: "ancestor" }],
		["extra data", { ...context, path: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" }],
		["misplaced wrapper", { permission: context }],
		["misplaced platform tuple", { role: "compiler", stage: "file", failedPredicate: "owner" }],
		["foreign prototype", Object.create(context) as object],
	] as const)("drops %s while preserving the independently validated code", (_name, value) =>
		heldCase(async (owner) => {
			expect((await permissionFailure(owner, { value: () => value }))?.refusal).toEqual(refusal);
		}),
	);
	it.each(["role", "lexical", "write"] as const)("does not invoke a context %s accessor", (field) =>
		heldCase(async (owner) => {
			let reads = 0;
			const value = { ...context };
			Object.defineProperty(value, field, {
				enumerable: true,
				get() {
					reads++;
					throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
				},
			});
			expect((await permissionFailure(owner, { value: () => value }))?.refusal).toEqual(refusal);
			expect(reads).toBe(0);
		}),
	);
	it("does not serialize a foreign context hook or replace the validated code", () =>
		heldCase(async (owner) => {
			let calls = 0;
			const value = {
				...context,
				toJSON() {
					calls++;
					return { message: "RAW_DIAGNOSTIC_MUST_STAY_PRIVATE" };
				},
			};
			expect((await permissionFailure(owner, { value: () => value }))?.refusal).toEqual(refusal);
			expect(calls).toBe(0);
		}));
	it("keeps reflection refusal opaque without erasing the validated code", () =>
		heldCase(async (owner) => {
			const value = new Proxy(
				{},
				{
					getPrototypeOf() {
						throw new Error("RAW_DIAGNOSTIC_MUST_STAY_PRIVATE");
					},
				},
			);
			expect((await permissionFailure(owner, { value: () => value }))?.refusal).toEqual(refusal);
		}));
	it.each([
		[
			"other validated code",
			"ubuntu-system-owner",
			true,
			{ stage: "ubuntu-inputs", code: "ubuntu-system-owner" },
		],
		["unrecognized code", "ubuntu-system-permissions", false, { stage: "ubuntu-inputs" }],
	] as const)("does not call the permission getter for %s", (_name, code, known, expected) =>
		heldCase(async (owner) => {
			const lookup = vi.fn(() => context);
			expect((await permissionFailure(owner, { value: lookup }, code, known))?.refusal).toEqual(
				expected,
			);
			expect(lookup).not.toHaveBeenCalled();
		}),
	);
});

type RuntimeResourceLifecycle = {
	readonly kind: "command" | "metadata";
	readonly complete: boolean;
	readonly code: number | null;
	readonly signal: string | null;
};

// Generator flags describe this protocol fixture, never physical process closure.
async function inspectRuntimeResource(
	owner: HeldCase,
	refusal: unknown,
	lifecycle: RuntimeResourceLifecycle = { kind: "command", complete: true, code: 1, signal: null },
) {
	let advanced = false;
	let cleaned = false;
	const generator: AsyncGenerator<unknown, unknown, void> = (async function* () {
		try {
			yield { ...lifecycle, files: [receiptFile], refusal };
			advanced = true;
			return { receiptFile, sha256 };
		} finally {
			cleaned = true;
		}
	})();
	let draining: Promise<IteratorResult<unknown, unknown>> | undefined;
	owner.drain(() => {
		draining ??= generator.return(undefined);
		return draining;
	});
	factories.inspect.mockReturnValue(generator);
	owner.admit();
	const pending = runNativePrepare(["--inspect"]);
	owner.run(pending);
	const code = await pending;
	expect(output.join("")).not.toContain("RAW_RUNTIME_RESOURCE_MUST_STAY_PRIVATE");
	return {
		code,
		advanced,
		cleaned,
		capture: records().find((record) => record.event === "inventory-native-capture"),
	};
}

describe("Windows runtime resource failure diagnostics", () => {
	// Synthetic failure protocol only; these fields authenticate no file or signer.
	const resource = {
		ordinal: 1,
		kind: "dll",
		role: "runtime-dll",
		sha256Before: "a".repeat(64),
		signerNameRead: true,
		signerNameMatches: false,
	};
	const legacy = {
		status: "unqualified-installed-windows-toolchain",
		stage: "compiler-runtime-signatures",
		runtimeCondition: "microsoft-signer",
	};
	const refusal = { ...legacy, runtimeResource: resource };
	it("preserves the failed original capture and exact six-field projection", () =>
		heldCase(async (owner) => {
			const result = await inspectRuntimeResource(owner, refusal);
			expect(result.capture).toEqual({
				event: "inventory-native-capture",
				kind: "command",
				complete: true,
				files: [receiptFile],
				code: 1,
				signal: null,
				refusal,
			});
			const projected = result.capture?.refusal as { runtimeResource?: Record<string, unknown> };
			expect(Object.keys(projected.runtimeResource ?? {}).sort()).toEqual([
				"kind",
				"ordinal",
				"role",
				"sha256Before",
				"signerNameMatches",
				"signerNameRead",
			]);
			expect({ code: result.code, advanced: result.advanced, cleaned: result.cleaned }).toEqual({
				code: 1,
				advanced: false,
				cleaned: true,
			});
			expect(records().some((record) => record.event === "inventory-native-result")).toBe(false);
		}));
	it("preserves legacy refusal data when the optional resource is absent", () =>
		heldCase(async (owner) => {
			const result = await inspectRuntimeResource(owner, legacy);
			expect(result.capture?.refusal).toEqual(legacy);
			expect({ code: result.code, advanced: result.advanced, cleaned: result.cleaned }).toEqual({
				code: 1,
				advanced: false,
				cleaned: true,
			});
		}));
	it.each([
		[
			"name call failed",
			"microsoft-signer",
			{ ...resource, signerNameRead: false, signerNameMatches: null },
		],
		[
			"before hash",
			"file-ordinary",
			{ ...resource, sha256Before: null, signerNameRead: null, signerNameMatches: null },
		],
	] as const)(
		"carries only the complete permitted observation state: %s",
		(_name, runtimeCondition, runtimeResource) =>
			heldCase(async (owner) => {
				const input = { ...legacy, runtimeCondition, runtimeResource };
				const result = await inspectRuntimeResource(owner, input);
				expect(result.capture?.refusal).toEqual(input);
				expect(result.code).toBe(1);
				expect(result.advanced).toBe(false);
				expect(result.cleaned).toBe(true);
			}),
	);
	it.each([
		"ordinal",
		"kind",
		"role",
		"sha256Before",
		"signerNameRead",
		"signerNameMatches",
	] as const)("omits optional refusal data with a partial resource missing %s", (field) =>
		heldCase(async (owner) => {
			const value: Record<string, unknown> = { ...resource };
			delete value[field];
			const result = await inspectRuntimeResource(owner, { ...legacy, runtimeResource: value });
			expect(Object.hasOwn(result.capture ?? {}, "refusal")).toBe(false);
			expect({ code: result.code, advanced: result.advanced, cleaned: result.cleaned }).toEqual({
				code: 1,
				advanced: false,
				cleaned: true,
			});
		}),
	);
	it.each([
		["unknown kind", { ...resource, kind: "RAW_RUNTIME_RESOURCE_MUST_STAY_PRIVATE" }],
		["unknown role", { ...resource, role: "RAW_RUNTIME_RESOURCE_MUST_STAY_PRIVATE" }],
		["ordinal outside bound", { ...resource, ordinal: 10001 }],
		["kind/role mismatch", { ...resource, kind: "exe" }],
		["missing hash after name observation", { ...resource, sha256Before: null }],
		["unreturned name with comparison", { ...resource, signerNameRead: false }],
		["returned name without comparison", { ...resource, signerNameMatches: null }],
		["nonboolean name state", { ...resource, signerNameRead: "true" }],
	] as const)(
		"does not forward unknown or malformed resource correlations: %s",
		(_name, runtimeResource) =>
			heldCase(async (owner) => {
				const result = await inspectRuntimeResource(owner, { ...legacy, runtimeResource });
				expect(Object.hasOwn(result.capture ?? {}, "refusal")).toBe(false);
				expect(result.code).toBe(1);
				expect(result.advanced).toBe(false);
				expect(result.cleaned).toBe(true);
			}),
	);
	it.each([
		"ordinal",
		"kind",
		"role",
		"sha256Before",
		"signerNameRead",
		"signerNameMatches",
	] as const)("does not invoke a resource %s accessor", (field) =>
		heldCase(async (owner) => {
			let reads = 0;
			const value = { ...resource };
			Object.defineProperty(value, field, {
				enumerable: true,
				get() {
					reads++;
					throw new Error("RAW_RUNTIME_RESOURCE_MUST_STAY_PRIVATE");
				},
			});
			const result = await inspectRuntimeResource(owner, { ...legacy, runtimeResource: value });
			expect(Object.hasOwn(result.capture ?? {}, "refusal")).toBe(false);
			expect(reads).toBe(0);
			expect(result.code).toBe(1);
		}),
	);
	it.each([
		["symbol", { ...resource, [Symbol("fixed-extra")]: true }],
		[
			"private fields",
			{
				...resource,
				path: "RAW_RUNTIME_RESOURCE_MUST_STAY_PRIVATE",
				certificate: "RAW_RUNTIME_RESOURCE_MUST_STAY_PRIVATE",
				error: "RAW_RUNTIME_RESOURCE_MUST_STAY_PRIVATE",
			},
		],
	] as const)("refuses %s without leaking raw resource data", (_name, runtimeResource) =>
		heldCase(async (owner) => {
			const result = await inspectRuntimeResource(owner, { ...legacy, runtimeResource });
			expect(Object.hasOwn(result.capture ?? {}, "refusal")).toBe(false);
			expect(result.code).toBe(1);
		}),
	);
	it("does not invoke resource serialization hooks", () =>
		heldCase(async (owner) => {
			let calls = 0;
			const runtimeResource = {
				...resource,
				toJSON() {
					calls++;
					return { certificate: "RAW_RUNTIME_RESOURCE_MUST_STAY_PRIVATE" };
				},
			};
			const result = await inspectRuntimeResource(owner, { ...legacy, runtimeResource });
			expect(Object.hasOwn(result.capture ?? {}, "refusal")).toBe(false);
			expect(calls).toBe(0);
			expect(result.code).toBe(1);
		}));
	it.each([
		["other stage", { ...refusal, stage: "compiler-signatures" }],
		["no condition", { status: legacy.status, stage: legacy.stage, runtimeResource: resource }],
		["enumeration before candidate", { ...refusal, runtimeCondition: "enumerate" }],
		[
			"success-name facts at refusal condition",
			{ ...refusal, runtimeResource: { ...resource, signerNameMatches: true } },
		],
	] as const)(
		"keeps resource context scoped to permitted candidate-failure conditions: %s",
		(_name, input) =>
			heldCase(async (owner) => {
				const result = await inspectRuntimeResource(owner, input);
				expect(Object.hasOwn(result.capture ?? {}, "refusal")).toBe(false);
				expect(result.code).toBe(1);
			}),
	);
	it.each([
		["success", { kind: "command", complete: true, code: 0, signal: null }, 0],
		["incomplete", { kind: "command", complete: false, code: 1, signal: null }, 1],
		["other exit", { kind: "command", complete: true, code: 2, signal: null }, 1],
		["signal", { kind: "command", complete: true, code: 1, signal: "SIGTERM" }, 1],
		["unknown exit", { kind: "command", complete: true, code: null, signal: null }, 1],
		["metadata", { kind: "metadata", complete: true, code: 0, signal: null }, 0],
	] as const)(
		"drops resource diagnostics outside an eligible closed failed command: %s",
		(_name, lifecycle, expected) =>
			heldCase(async (owner) => {
				const result = await inspectRuntimeResource(owner, refusal, lifecycle);
				expect(result.capture).toEqual({
					event: "inventory-native-capture",
					...lifecycle,
					files: [receiptFile],
				});
				expect(result.code).toBe(expected);
				expect(result.advanced).toBe(expected === 0);
				expect(result.cleaned).toBe(true);
				expect(records().some((record) => record.event === "inventory-native-result")).toBe(
					expected === 0,
				);
			}),
	);
});
