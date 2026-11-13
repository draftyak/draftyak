import { AsyncLocalStorage } from "node:async_hooks";
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { PluginStdioResult } from "@draftyak/protocol/plugin-stdio";
import { afterEach, describe, expect, it } from "vitest";
import { type InstalledBundle, verifyBundle } from "../../src/artifacts/index.ts";
import {
	createPluginProcessOwner,
	type OwnedPluginProcess,
	type PluginProcessCloseResult,
	PluginProcessError,
	type PluginProcessOptions,
	type PluginProcessOwner,
} from "../../src/plugins/supervisor/owned-process.ts";

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

interface Ready {
	readonly pid: number;
	readonly nodeOptions: boolean;
	readonly keyEnvironment: boolean;
	readonly writeDenied: boolean;
}

interface Observation {
	readonly process: OwnedPluginProcess;
	readonly ready: Promise<Ready>;
	readonly output: Promise<readonly [string, string]>;
}

interface Root {
	readonly directory: string;
	readonly parent: string;
	dev: bigint | null;
	ino: bigint | null;
}

interface Harness {
	readonly owner: PluginProcessOwner;
	readonly roots: Root[];
	readonly acquisitions: Set<Promise<InstalledBundle>>;
	readonly operations: Set<Promise<unknown>>;
	readonly launches: Set<Promise<OwnedPluginProcess>>;
	readonly handles: Set<OwnedPluginProcess>;
	readonly reads: Set<Promise<unknown>>;
	cleanup?: Promise<void>;
	ownerClose?: Promise<PluginProcessCloseResult>;
}

const harnesses = new Set<Harness>();
const bodies = new Set<Promise<void>>();
let teardown: Promise<void> | undefined;

function retain<T>(set: Set<Promise<T>>, promise: Promise<T>): Promise<T> {
	set.add(promise);
	// Observe immediately, while leaving the original rejection available to its oracle.
	void Promise.allSettled([promise]);
	return promise;
}

function acquire(options?: PluginProcessOptions): Harness {
	if (teardown) throw new Error("Owned process teardown already reserved");
	const record: Harness = {
		owner: createPluginProcessOwner(options),
		roots: [],
		acquisitions: new Set(),
		operations: new Set(),
		launches: new Set(),
		handles: new Set(),
		reads: new Set(),
	};
	harnesses.add(record);
	return record;
}

function childSource(mode: "natural" | "hold" | "fallback"): string {
	return [
		'import { writeFileSync } from "node:fs";',
		"const mode = " + JSON.stringify(mode) + ";",
		"let writeDenied = false;",
		'try { writeFileSync(new URL("./unexpected-write.txt", import.meta.url), "DYTEST"); }',
		'catch (error) { writeDenied = error?.code === "ERR_ACCESS_DENIED"; }',
		'process.stdout.write(JSON.stringify({pid:process.pid,nodeOptions:Object.hasOwn(process.env,"NODE_OPTIONS"),keyEnvironment:Object.hasOwn(process.env,"DYTEST_SUPERVISOR_KEY"),writeDenied})+"\\n");',
		'process.stderr.write("DYTEST-stderr\\n");',
		'if (mode === "natural") { process.stdout.write("DYTEST-natural\\n"); process.exitCode = 7; }',
		"else {",
		" const keep = setInterval(() => {}, 60000);",
		' if (mode === "fallback") process.on("SIGTERM", () => process.stdout.write("DYTEST-term\\n"));',
		" process.stdin.resume();",
		' process.stdin.on("end", () => { process.stdout.write("DYTEST-input-ended\\n"); if (mode !== "fallback") clearInterval(keep); });',
		"}",
		"",
	].join("\n");
}

function operation<T>(h: Harness, producer: () => Promise<T>): Promise<T> {
	const original = Promise.resolve().then(producer);
	retain(h.operations, original);
	return original;
}

function ownedDirectory(h: Harness): Promise<string> {
	return operation(h, async () => {
		const parent = await realpath(tmpdir());
		const directory = await mkdtemp(path.join(parent, "draftyak-owned-process-"));
		const root: Root = { directory, parent, dev: null, ino: null };
		h.roots.push(root);
		const stat = await lstat(directory, { bigint: true });
		root.dev = stat.dev;
		root.ino = stat.ino;
		return directory;
	});
}

function bundle(h: Harness, mode: "natural" | "hold" | "fallback"): Promise<InstalledBundle> {
	const original = Promise.resolve().then(async () => {
		const directory = await ownedDirectory(h);
		const bytes = Buffer.from(childSource(mode), "utf8");
		await writeFile(path.join(directory, "entry.mjs"), bytes, { flag: "wx", mode: 0o600 });
		await operation(h, () => chmod(path.join(directory, "entry.mjs"), 0o444));
		await operation(h, () => chmod(directory, 0o555));
		const value: InstalledBundle = Object.freeze({
			directory,
			inventory: Object.freeze({
				name: "@draftyak/owned-process-test",
				version: "1.0.0",
				integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
				entry: "entry.mjs",
				files: Object.freeze([
					Object.freeze({
						path: "entry.mjs",
						bytes: bytes.length,
						sha256: createHash("sha256").update(bytes).digest("hex"),
					}),
				]),
			}),
		});
		expect(await verifyBundle(value)).toBe(path.join(directory, "entry.mjs"));
		return value;
	});
	return retain(h.acquisitions, original);
}

async function collect(stream: Readable, line?: (value: string) => void): Promise<string> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	let pending = "";
	for await (const raw of stream) {
		const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
		bytes += chunk.length;
		if (bytes > 64 * 1024) throw new Error("Owned child output exceeded its test bound");
		chunks.push(chunk);
		if (line) {
			pending += chunk.toString("utf8");
			let end = pending.indexOf("\n");
			while (end >= 0) {
				line(pending.slice(0, end));
				pending = pending.slice(end + 1);
				end = pending.indexOf("\n");
			}
		}
	}
	return Buffer.concat(chunks).toString("utf8");
}

function observe(h: Harness, process: OwnedPluginProcess): Observation {
	h.handles.add(process);
	void Promise.allSettled([process.closed]);
	const first = deferred<Ready>();
	let received = false;
	const stdout = Promise.resolve().then(async () => {
		try {
			return await collect(process.io.outputs[0], (line) => {
				if (received) return;
				const value: unknown = JSON.parse(line);
				if (
					!value ||
					typeof value !== "object" ||
					!("pid" in value) ||
					typeof value.pid !== "number" ||
					!("nodeOptions" in value) ||
					typeof value.nodeOptions !== "boolean" ||
					!("keyEnvironment" in value) ||
					typeof value.keyEnvironment !== "boolean" ||
					!("writeDenied" in value) ||
					typeof value.writeDenied !== "boolean"
				)
					throw new Error("Owned child readiness DATA unavailable");
				received = true;
				first.resolve(value as Ready);
			});
		} finally {
			if (!received) first.reject(new Error("Owned child ended before readiness"));
		}
	});
	const stderr = Promise.resolve().then(() => collect(process.io.outputs[1]));
	retain(h.reads, stdout);
	retain(h.reads, stderr);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("Owned child readiness deadline")), 5_000);
	});
	const ready = Promise.race([first.promise, limit]);
	void ready.then(
		() => clearTimeout(timer),
		() => clearTimeout(timer),
	);
	retain(h.reads, ready);
	const output = Promise.all([stdout, stderr]);
	retain(h.reads, output);
	return { process, ready, output };
}

function launch(h: Harness, value: InstalledBundle, signal?: AbortSignal) {
	const entered = deferred<void>();
	const original = Promise.resolve().then(() => {
		try {
			const pending = h.owner.launch(value, signal);
			entered.resolve(undefined);
			return pending;
		} catch (error) {
			entered.resolve(undefined);
			throw error;
		}
	});
	retain(h.launches, original);
	const observed = original.then((process) => observe(h, process));
	retain(h.reads, observed);
	return { entered: entered.promise, original, observed };
}

function closeOwner(h: Harness): Promise<PluginProcessCloseResult> {
	if (h.ownerClose) return h.ownerClose;
	// Reserve before the producer so reentry and synchronous failure cannot retry it.
	const reserved = deferred<PluginProcessCloseResult>();
	h.ownerClose = reserved.promise;
	void Promise.allSettled([reserved.promise]);
	try {
		const original = h.owner.close();
		h.ownerClose = original;
		void original.then(reserved.resolve, reserved.reject);
	} catch (error) {
		reserved.reject(error);
	}
	return h.ownerClose;
}

// Reserve and observe the call before invoking the synchronous input boundary itself.
function launchNow(h: Harness, value: InstalledBundle): ReturnType<typeof launch> {
	const entered = deferred<void>();
	const reserved = deferred<OwnedPluginProcess>();
	retain(h.launches, reserved.promise);
	const observed = reserved.promise.then((process) => observe(h, process));
	retain(h.reads, observed);
	try {
		const original = h.owner.launch(value);
		retain(h.launches, original);
		void original.then(reserved.resolve, reserved.reject);
	} catch (error) {
		reserved.reject(error);
	} finally {
		entered.resolve(undefined);
	}
	return { entered: entered.promise, original: reserved.promise, observed };
}

async function checkRoot(root: Root): Promise<void> {
	const stat = await lstat(root.directory, { bigint: true });
	if (
		root.dev === null ||
		root.ino === null ||
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		stat.dev !== root.dev ||
		stat.ino !== root.ino ||
		(await realpath(root.directory)) !== root.directory ||
		path.dirname(root.directory) !== root.parent ||
		!path.basename(root.directory).startsWith("draftyak-owned-process-")
	)
		throw new Error("Owned child test root identity changed");
}

async function joinAllResources(owners: readonly Harness[]): Promise<void> {
	const closing = owners.map(closeOwner);
	void Promise.allSettled(closing);
	// Expected launch/read refusals still join their originals; only physical failures bar cleanup.
	await Promise.allSettled(
		owners.flatMap((h) => [...h.acquisitions, ...h.launches, ...h.operations]),
	);
	const handles = owners.flatMap((h) => [...h.handles]);
	const handleCloses = handles.map((p) => Promise.resolve().then(() => p.close()));
	const [closedOwners, physical] = await Promise.all([
		Promise.allSettled(closing),
		Promise.allSettled([...handleCloses, ...handles.map((p) => p.closed)]),
	]);
	await Promise.allSettled(owners.flatMap((h) => [...h.reads]));
	const errors: unknown[] = [];
	for (const result of closedOwners) {
		if (result.status === "rejected") errors.push(result.reason);
		else if (result.value.cleanupFailures !== 0)
			errors.push(new Error("Original owner reported a physical cleanup failure"));
	}
	for (const result of physical) if (result.status === "rejected") errors.push(result.reason);
	// Validate EVERY owned root before permitting the first per-harness deletion.
	const identities = await Promise.allSettled(
		owners.flatMap((h) => h.roots.map((root) => checkRoot(root))),
	);
	for (const result of identities) if (result.status === "rejected") errors.push(result.reason);
	if (errors.length) throw new AggregateError(errors, "Shared process cleanup barrier refused");
}

function cleanup(h: Harness, barrier: Promise<void>): Promise<void> {
	if (h.cleanup) return h.cleanup;
	h.cleanup = Promise.resolve().then(async () => {
		await barrier;
		for (const root of h.roots) {
			await checkRoot(root);
			await operation(h, () => chmod(root.directory, 0o700));
			for (const name of ["entry.mjs", "extra.txt", "unexpected-write.txt"]) {
				try {
					await operation(h, () => chmod(path.join(root.directory, name), 0o600));
				} catch (error) {
					if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
						throw error;
				}
			}
			await rm(root.directory, { recursive: true });
		}
		harnesses.delete(h);
	});
	void Promise.allSettled([h.cleanup]);
	return h.cleanup;
}

function testcase(name: string, body: (h: Harness) => Promise<void>): void {
	it(name, () => {
		if (teardown || harnesses.size || bodies.size)
			throw new Error("Earlier owned process test resources remain retained");
		const original = Promise.resolve().then(() => body(acquire()));
		retain(bodies, original);
		return original;
	}, 20_000);
}

afterEach(() => {
	if (teardown) return teardown;
	const original = Promise.resolve().then(async () => {
		// Cancel every original owner before joining bodies that may need cancellation.
		// acquire() is now fenced, so that snapshot cannot miss a new owner.
		const closing = [...harnesses].map(closeOwner);
		void Promise.allSettled(closing);
		await Promise.allSettled([...bodies]);
		const owners = [...harnesses];
		const barrier = joinAllResources(owners);
		void Promise.allSettled([barrier]);
		await barrier;
		const results = await Promise.allSettled(owners.map((h) => cleanup(h, barrier)));
		const errors = results.filter((item) => item.status === "rejected");
		if (errors.length)
			throw new AggregateError(
				errors.map((item) => item.reason),
				"Owned process cleanup refused",
			);
		bodies.clear();
	});
	teardown = original;
	void original.then(
		() => {
			if (teardown === original) teardown = undefined;
		},
		() => {},
	);
	return original;
});

function unavailable(value: unknown): void {
	expect(value).toBeInstanceOf(PluginProcessError);
	if (!(value instanceof PluginProcessError))
		throw new Error("Expected fixed plugin process error");
	expect(value.code).toBe("PLUGIN_PROCESS_UNAVAILABLE");
	expect(value.name).toBe("PluginProcessError");
	expect(value.message).toBe("Plugin process unavailable");
	expect("cause" in value).toBe(false);
}

async function refusedLaunch(job: ReturnType<typeof launch>): Promise<void> {
	const result = await Promise.allSettled([job.original]);
	expect(result[0]?.status).toBe("rejected");
	if (result[0]?.status !== "rejected") throw new Error("Expected owned launch refusal");
	unavailable(result[0].reason);
}

async function live(
	h: Harness,
	value: InstalledBundle,
	signal?: AbortSignal,
): Promise<Observation> {
	const observation = await launch(h, value, signal).observed;
	const ready = await observation.ready;
	expect(ready.pid).toBe(observation.process.pid);
	expect(Number.isSafeInteger(ready.pid) && ready.pid > 0).toBe(true);
	return observation;
}

async function graceful(observation: Observation): Promise<PluginStdioResult> {
	observation.process.io.input.end();
	const result = await observation.process.closed;
	expect(result.code).toBe(0);
	expect(result.signal).toBeNull();
	expect(await observation.process.io.completion).toEqual(result);
	expect((await observation.output)[0]).toContain("DYTEST-input-ended\n");
	return result;
}

describe("owned plugin process resources", () => {
	testcase(
		"runs a verified readonly bundle and preserves actual output and nonzero exit DATA",
		async (h) => {
			const observation = await live(h, await bundle(h, "natural"));
			expect((await observation.ready).writeDenied).toBe(true);
			const result = await observation.process.closed;
			expect(result.code).toBe(7);
			expect(result.signal).toBeNull();
			expect(await observation.process.io.completion).toEqual(result);
			const [stdout, stderr] = await observation.output;
			expect(stdout).toContain("DYTEST-natural\n");
			expect(stderr).toContain("DYTEST-stderr\n");
			expect(h.owner.owns(observation.process)).toBe(false);
		},
	);

	testcase(
		"accepts only the original live handle and shares exact handle close completion",
		async (h) => {
			const observation = await live(h, await bundle(h, "hold"));
			const process = observation.process;
			expect(h.owner.owns(process)).toBe(true);
			const other = acquire();
			const foreign = await live(other, await bundle(other, "hold"));
			expect(h.owner.owns(foreign.process)).toBe(false);
			expect(other.owner.owns(process)).toBe(false);
			expect(h.owner.owns({ ...process })).toBe(false);
			expect(h.owner.owns(Object.create(process))).toBe(false);
			let hooks = 0;
			expect(
				h.owner.owns(
					new Proxy(process, {
						get() {
							hooks++;
							throw new Error("Handle proxy invoked");
						},
					}),
				),
			).toBe(false);
			expect(hooks).toBe(0);
			expect(h.owner.owns(undefined)).toBe(false);
			expect(process.close()).toBe(process.closed);
			expect(process.close()).toBe(process.closed);
			await process.closed;
			expect(h.owner.owns(process)).toBe(false);
			await observation.output;
		},
	);

	for (const change of ["tampered", "extra", "missing"] as const) {
		testcase(
			"refuses a " + change + " bundle before launch while accepting a valid neighbor",
			async (h) => {
				const damaged = await bundle(h, "hold");
				await operation(h, () => chmod(damaged.directory, 0o700));
				const entry = path.join(damaged.directory, "entry.mjs");
				if (change === "tampered") {
					await operation(h, () => chmod(entry, 0o600));
					await writeFile(
						entry,
						Buffer.concat([await readFile(entry), Buffer.from("\n// DYTEST changed bytes\n")]),
					);
					await operation(h, () => chmod(entry, 0o444));
				} else if (change === "extra") {
					await writeFile(path.join(damaged.directory, "extra.txt"), "DYTEST-extra", {
						flag: "wx",
						mode: 0o444,
					});
				} else {
					await operation(h, () => chmod(entry, 0o600));
					await unlink(entry);
				}
				await operation(h, () => chmod(damaged.directory, 0o555));
				await refusedLaunch(launch(h, damaged));
				const neighbor = await live(h, await bundle(h, "hold"));
				expect(h.owner.owns(neighbor.process)).toBe(true);
				await graceful(neighbor);
			},
		);
	}

	for (const shape of ["proxy", "accessor", "symbol", "extra", "array iterator"] as const) {
		testcase(
			"refuses a bundle " + shape + " without invoking hooks and accepts its valid neighbor",
			async (h) => {
				const valid = await bundle(h, "hold");
				let hooks = 0;
				const hook = () => {
					hooks++;
					throw new Error("Bundle capture hook invoked");
				};
				let invalid: unknown;
				if (shape === "proxy") {
					invalid = new Proxy(valid, {
						get: hook,
						getPrototypeOf: hook,
						getOwnPropertyDescriptor: hook,
						ownKeys: hook,
					});
				} else if (shape === "accessor") {
					invalid = Object.defineProperty({ ...valid }, "inventory", {
						get: hook,
						enumerable: true,
					});
				} else if (shape === "symbol") {
					invalid = { ...valid, [Symbol("DYTEST unexpected bundle field")]: true };
				} else if (shape === "extra") {
					invalid = { ...valid, extra: true };
				} else {
					const files = [...valid.inventory.files];
					Object.defineProperty(files, Symbol.iterator, { get: hook });
					invalid = { ...valid, inventory: { ...valid.inventory, files } };
				}
				// Deliberately invalid input, never a capability or fixture authority.
				await refusedLaunch(launch(h, invalid as InstalledBundle));
				expect(hooks).toBe(0);
				const neighbor = await live(h, valid);
				await graceful(neighbor);
			},
		);
	}

	testcase(
		"retains mutable caller bundle DATA synchronously before its first asynchronous launch work",
		async (h) => {
			const valid = await bundle(h, "hold");
			const mutable = {
				directory: valid.directory,
				inventory: {
					...valid.inventory,
					files: valid.inventory.files.map((file) => ({ ...file })),
				},
			};
			const pending = launchNow(h, mutable);
			// No await between the actual launch call returning and these caller mutations.
			mutable.directory = path.join(valid.directory, "DYTEST-not-the-original-root");
			mutable.inventory.entry = "DYTEST-not-the-original-entry.mjs";
			mutable.inventory.files.splice(0, 1, {
				path: "DYTEST-not-the-original-entry.mjs",
				bytes: 0,
				sha256: "0".repeat(64),
			});
			const observation = await pending.observed;
			const ready = await observation.ready;
			expect(ready.pid).toBe(observation.process.pid);
			expect(ready.writeDenied).toBe(true);
			expect(h.owner.owns(observation.process)).toBe(true);
			await graceful(observation);
		},
	);

	testcase(
		"removes synthetic Node options and key environment without reading parent values",
		async (h) => {
			expect(Object.hasOwn(process.env, "DYTEST_SUPERVISOR_KEY")).toBe(false);
			const addedOptions = !Object.hasOwn(process.env, "NODE_OPTIONS");
			if (addedOptions) process.env.NODE_OPTIONS = "--max-old-space-size=128";
			process.env.DYTEST_SUPERVISOR_KEY = "DYTEST-synthetic-only";
			try {
				expect(Object.hasOwn(process.env, "NODE_OPTIONS")).toBe(true);
				const observation = await live(h, await bundle(h, "hold"));
				expect(await observation.ready).toMatchObject({
					nodeOptions: false,
					keyEnvironment: false,
					writeDenied: true,
				});
				await graceful(observation);
			} finally {
				if (addedOptions) delete process.env.NODE_OPTIONS;
				delete process.env.DYTEST_SUPERVISOR_KEY;
			}
		},
	);

	testcase("refuses an already-aborted launch and leaves its owner usable", async (h) => {
		const value = await bundle(h, "hold");
		const caller = new AbortController();
		caller.abort();
		await refusedLaunch(launch(h, value, caller.signal));
		const neighbor = await live(h, value);
		await graceful(neighbor);
	});

	testcase(
		"aborts an actually ready owned child and joins its input-end and descriptor completion",
		async (h) => {
			const caller = new AbortController();
			const observation = await live(h, await bundle(h, "hold"), caller.signal);
			expect(h.owner.owns(observation.process)).toBe(true);
			caller.abort();
			const result = await observation.process.closed;
			expect(result.code).toBe(0);
			expect(result.signal).toBeNull();
			expect((await observation.output)[0]).toContain("DYTEST-input-ended\n");
			expect(await observation.process.io.completion).toEqual(result);
			expect(h.owner.owns(observation.process)).toBe(false);
		},
	);

	testcase(
		"joins an entered pending launch and fences new work through cached owner close",
		async (h) => {
			const value = await bundle(h, "hold");
			const pending = launch(h, value);
			await pending.entered;
			let settled = false;
			void pending.original.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				},
			);
			const closing = closeOwner(h);
			expect(h.owner.close()).toBe(closing);
			const result = await closing;
			expect(result).toEqual({ cleanupFailures: 0 });
			expect(Object.isFrozen(result)).toBe(true);
			expect(settled).toBe(true);
			await refusedLaunch(pending);
			await refusedLaunch(launch(h, value));
		},
	);

	testcase(
		"refuses invalid stdio parent options without caller hooks and retains unexpected owners",
		async (h) => {
			const root = await ownedDirectory(h);
			const parent = path.join(root, "stdio");
			await operation(h, () => mkdir(parent, { mode: 0o700 }));
			let hooks = 0;
			const hook = () => {
				hooks++;
				throw new Error("Caller stdio option hook invoked");
			};
			const accessor = Object.defineProperty({}, "stdioParentDir", { enumerable: true, get: hook });
			const invalidOptions: unknown[] = [
				null,
				"DYTEST-options",
				[],
				{},
				{ stdioParentDir: "" },
				{ stdioParentDir: 7 },
				{ stdioParentDir: "DYTEST-relative" },
				{ stdioParentDir: parent + "\0" },
				{ stdioParentDir: parent, extra: true },
				{ stdioParentDir: parent, [Symbol("DYTEST-extra")]: true },
				accessor,
				new Proxy(
					{ stdioParentDir: parent },
					{
						get: hook,
						getPrototypeOf: hook,
						ownKeys: hook,
						getOwnPropertyDescriptor: hook,
					},
				),
			];
			for (const options of invalidOptions) {
				let caught: unknown;
				try {
					// Any unexpectedly returned real owner is recorded before assertions can fail.
					acquire(options as PluginProcessOptions);
				} catch (error) {
					caught = error;
				}
				unavailable(caught);
				expect(hooks).toBe(0);
			}
			const configured = acquire({ stdioParentDir: parent });
			const neighbor = await live(configured, await bundle(configured, "hold"));
			await graceful(neighbor);
		},
	);

	if (process.platform !== "win32") {
		testcase(
			"forwards the configured missing parent and accepts a real folder on the same owner",
			async (h) => {
				const root = await ownedDirectory(h);
				const parent = path.join(root, "stdio");
				const configured = acquire({ stdioParentDir: parent });
				const value = await bundle(configured, "hold");
				await refusedLaunch(launch(configured, value));
				await operation(h, () => mkdir(parent, { mode: 0o700 }));
				const neighbor = await live(configured, value);
				await graceful(neighbor);
				expect((await lstat(parent)).isDirectory()).toBe(true);
			},
		);

		testcase("retains the original parent option before caller mutation", async (h) => {
			const root = await ownedDirectory(h);
			const parent = path.join(root, "stdio");
			await operation(h, () => mkdir(parent, { mode: 0o700 }));
			const options = { stdioParentDir: parent };
			const configured = acquire(options);
			options.stdioParentDir = path.join(root, "DYTEST-missing-parent");
			const observation = await live(configured, await bundle(configured, "hold"));
			await graceful(observation);
			expect((await lstat(parent)).isDirectory()).toBe(true);
		});
	}

	testcase(
		"closing one configured owner preserves another child and their shared parent",
		async (h) => {
			const root = await ownedDirectory(h);
			const parent = path.join(root, "stdio");
			await operation(h, () => mkdir(parent, { mode: 0o700 }));
			const before = await lstat(parent, { bigint: true });
			const first = acquire({ stdioParentDir: parent });
			const nullOptions: PluginProcessOptions = Object.assign(Object.create(null), {
				stdioParentDir: parent,
			});
			const second = acquire(nullOptions);
			const one = await live(first, await bundle(first, "hold"));
			const two = await live(second, await bundle(second, "hold"));
			expect(await closeOwner(first)).toEqual({ cleanupFailures: 0 });
			await one.process.closed;
			expect(first.owner.owns(one.process)).toBe(false);
			expect(second.owner.owns(two.process)).toBe(true);
			const after = await lstat(parent, { bigint: true });
			expect([after.dev, after.ino]).toEqual([before.dev, before.ino]);
			expect(after.isDirectory()).toBe(true);
			// Actual remaining input EOF and child output prove IO survives the other owner's close.
			await graceful(two);
			expect((await lstat(parent)).isDirectory()).toBe(true);
		},
	);

	if (process.platform === "win32") {
		testcase(
			"applies reentrant owner close to the exact real pipe child before launch publication",
			async (h) => {
				const value = await bundle(h, "hold");
				const entry = path.join(value.directory, value.inventory.entry);
				const diagnostic = channel("child_process");
				const spawned = deferred<void>();
				const exited = deferred<void>();
				const closed = deferred<void>();
				const scope = new AsyncLocalStorage<symbol>();
				const marker = Symbol("DYTEST-owned-process-launch");
				let candidate: ChildProcess | undefined;
				let verifiedChild: ChildProcess | undefined;
				let sawSpawn = false;
				let sawExit = false;
				let sawClose = false;
				let matchingCandidates = 0;
				let callbackFailure: unknown;
				let closing: Promise<PluginProcessCloseResult> | undefined;
				let cleanupKillRequested = false;
				let killFailed = false;
				const onSpawn = () => {
					sawSpawn = true;
					const actual = candidate;
					// These native fields are unavailable in the synchronous publisher itself.
					if (
						actual?.spawnfile === process.execPath &&
						Array.isArray(actual.spawnargs) &&
						actual.spawnargs.at(-1) === entry
					)
						verifiedChild = actual;
					spawned.resolve(undefined);
				};
				const onError = () =>
					spawned.reject(new Error("Owned diagnostic child failed before spawn"));
				const onExit = () => {
					sawExit = true;
					exited.resolve(undefined);
				};
				const onClose = () => {
					sawClose = true;
					closed.resolve(undefined);
				};
				const retireObservations = () => {
					candidate?.removeListener("spawn", onSpawn);
					candidate?.removeListener("error", onError);
					candidate?.removeListener("exit", onExit);
					candidate?.removeListener("close", onClose);
				};
				const subscriber = (payload: unknown) => {
					if (scope.getStore() !== marker || !payload || typeof payload !== "object") return;
					const actual = Object.getOwnPropertyDescriptor(payload, "process")?.value;
					if (!(actual instanceof ChildProcess)) return;
					matchingCandidates++;
					if (candidate) return;
					// Causal observation only: this is NOT owned raw-child identity yet.
					candidate = actual;
					actual.once("spawn", onSpawn);
					actual.once("error", onError);
					actual.once("exit", onExit);
					actual.once("close", onClose);
					try {
						// Safe before metadata exists: revoke only our genuine owner, never the candidate.
						closing = closeOwner(h);
					} catch (error) {
						callbackFailure = error;
					}
				};
				void Promise.allSettled([spawned.promise]);
				diagnostic.subscribe(subscriber);
				const pending = scope.run(marker, () => launch(h, value));
				const refusal = refusedLaunch(pending);
				retain(h.reads, refusal);
				let timer: ReturnType<typeof setTimeout> | undefined;
				const deadline = new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error("Actual owned diagnostic spawn precondition missing")),
						5_000,
					);
				});
				try {
					await Promise.race([spawned.promise, deadline]);
					expect(callbackFailure).toBeUndefined();
					expect(matchingCandidates).toBe(1);
					const original = verifiedChild;
					if (!original) throw new Error("Actual owned diagnostic child not retained");
					expect(original.spawnfile).toBe(process.execPath);
					expect(original.spawnargs.at(-1)).toBe(entry);
					expect(original.stdin).not.toBeNull();
					// This is an ordinary assertion after the real spawn event, not a timeout oracle.
					expect(original.stdin?.writableEnded).toBe(true);
					expect(cleanupKillRequested).toBe(false);
					await refusal;
					if (!closing) throw new Error("Original owner close was not observed");
					expect(await closing).toEqual({ cleanupFailures: 0 });
					expect(sawExit).toBe(true);
					expect(sawClose).toBe(true);
				} finally {
					clearTimeout(timer);
					diagnostic.unsubscribe(subscriber);
					try {
						// An unverified candidate is never killed or joined.
						if (!verifiedChild) retireObservations();
						// Emergency backout never counts as the owner's successful-close oracle.
						if (verifiedChild && sawSpawn && !sawExit) {
							cleanupKillRequested = true;
							try {
								verifiedChild.kill("SIGKILL");
							} catch {
								killFailed = true;
							}
						}
						const ownerClosing = closing ?? closeOwner(h);
						await Promise.allSettled([
							pending.original,
							refusal,
							ownerClosing,
							...(verifiedChild ? [closed.promise] : []),
						]);
						// Failed or foreign candidates supply no raw-exit/close ownership witness.
						if (verifiedChild && sawSpawn) await exited.promise;
					} finally {
						retireObservations();
						scope.disable();
					}
				}
				if (killFailed) throw new Error("Owned diagnostic backout failed");
			},
		);
	}

	testcase("joins the real fallback child after input end and platform termination", async (h) => {
		const observation = await live(h, await bundle(h, "fallback"));
		const closing = observation.process.close();
		expect(closing).toBe(observation.process.closed);
		const result = await closing;
		const [stdout] = await observation.output;
		expect(stdout).toContain("DYTEST-input-ended\n");
		if (process.platform !== "win32") {
			expect(stdout).toContain("DYTEST-term\n");
			expect(result.signal).toBe("SIGKILL");
			expect(result.code).toBeNull();
		} else {
			expect(result.code !== null || result.signal !== null).toBe(true);
		}
		expect(await observation.process.io.completion).toEqual(result);
		expect(h.owner.owns(observation.process)).toBe(false);
	});
});
