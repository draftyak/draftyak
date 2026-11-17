import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { fstatSync, writeSync } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, open, readFile, realpath, rmdir, unlink, utimes } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, expect, it } from "vitest";

type Module = typeof import("../lib/inventory-native-operation.ts");
type Operation = Awaited<ReturnType<Module["InventoryCacheOperation"]["begin"]>>;
type Capture = ReturnType<Operation["openFile"]>;
interface FileOriginal {
	readonly file: string;
	readonly original: FileHandle;
	identity?: BigIntStats;
	close?: Promise<void>;
}
interface Resource {
	release?(): Promise<void>;
	releasePromise?: Promise<void>;
	join(): Promise<void>;
}
interface ChildOriginal {
	readonly original: ReturnType<typeof spawn>;
	joined: boolean;
	completion?: Promise<readonly unknown[]>;
}
const activeFixtures = new Set<Fixture>();
const activeCases = new Set<OwnedCase>();
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const canonical = (file: string): string =>
	process.platform === "win32" ? file.toLowerCase() : file;
const same = (left: BigIntStats, right: BigIntStats): boolean =>
	left.dev === right.dev && left.ino === right.ino;
const marker = Buffer.from("inventory-ubuntu-inputs-bootstrap-v1\n");
const repository = path.resolve(import.meta.dirname, "..", "..", "..");

class OwnedCase {
	open = true;
	readonly body: Promise<void>;
	fixture?: Fixture;
	private teardownPromise?: Promise<void>;

	constructor(work: (fixture: Fixture) => Promise<void>) {
		this.body = Promise.resolve().then(async () => {
			this.admit();
			const fixture = new Fixture(this);
			this.fixture = fixture;
			activeFixtures.add(fixture);
			await fixture.setup();
			this.admit();
			await work(fixture);
		});
	}
	admit(): void {
		if (!this.open) throw new Error("owned case admission is closed");
	}
	teardown(): Promise<void> {
		this.open = false;
		this.fixture?.releaseResources(); // Start EOF before joining a body waiting on that child.
		this.teardownPromise ??= Promise.resolve().then(async () => {
			await Promise.allSettled([this.body]); // The SAME whole setup/body, including late continuations.
			await this.fixture?.cleanup();
			activeCases.delete(this);
		});
		return this.teardownPromise;
	}
}

class Fixture {
	readonly directories: { file: string; identity?: BigIntStats; created: boolean }[] = [];
	readonly files: { file: string; identity: BigIntStats }[] = [];
	readonly originals: FileOriginal[] = [];
	readonly resources: Resource[] = [];
	readonly children: ChildOriginal[] = [];
	readonly sourceFiles: string[] = [];
	readonly verify: string;
	readonly cache: string;
	readonly key: string;
	private source?: Buffer;
	private sourceHash?: string;
	readonly root: string;
	readonly owner: OwnedCase;

	constructor(owner: OwnedCase) {
		this.owner = owner;
		this.root = path.join(repository, ".cache", `inventory-operation-unit-${randomUUID()}`);
		this.verify = path.join(this.root, "tools", "verify");
		this.cache = path.join(this.verify, ".cache", "inventory-native");
		this.key = path.join(this.verify, ".inventory-native-ubuntu-inputs-v1.lock");
	}

	admit(): void {
		this.owner.admit();
	}
	async setup(): Promise<void> {
		this.admit();
		const parent = path.join(repository, ".cache");
		try {
			await mkdir(parent, { mode: 0o700 });
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
		}
		this.admit();
		const info = await lstat(parent, { bigint: true });
		expect(info.isDirectory() && !info.isSymbolicLink()).toBe(true);
		expect(canonical(await realpath(parent))).toBe(canonical(parent));
		this.admit();
		this.source = await readFile(new URL("../lib/inventory-native-operation.ts", import.meta.url));
		this.sourceHash = hash(this.source);
		this.admit();
		await this.directory(this.root);
		await this.directory(path.join(this.root, "tools"));
		await this.directory(this.verify);
		await this.directory(path.join(this.verify, "lib"));
	}

	private bound(file: string): void {
		const relative = path.relative(this.root, file);
		expect(
			path.isAbsolute(file) &&
				relative !== ".." &&
				!relative.startsWith(`..${path.sep}`) &&
				!path.isAbsolute(relative),
		).toBe(true);
	}
	async directory(file: string): Promise<void> {
		this.admit();
		this.bound(file);
		const record = { file, created: false, identity: undefined as BigIntStats | undefined };
		this.directories.push(record);
		await mkdir(file, { mode: 0o700 });
		record.created = true;
		record.identity = await lstat(file, { bigint: true });
		this.admit();
	}
	async cacheDirectories(): Promise<void> {
		await this.directory(path.dirname(this.cache));
		await this.directory(this.cache);
	}
	private close(original: FileOriginal): Promise<void> {
		original.close ??= Promise.resolve().then(() => original.original.close());
		return original.close;
	}
	async write(file: string, bytes: Uint8Array): Promise<FileOriginal> {
		this.admit();
		this.bound(file);
		const original: FileOriginal = { file, original: await open(file, "wx", 0o600) };
		this.originals.push(original);
		let failed = false,
			failure: unknown;
		try {
			original.identity = await original.original.stat({ bigint: true });
			this.files.push({ file, identity: original.identity });
			this.admit();
			await original.original.writeFile(bytes);
			await original.original.sync();
		} catch (error) {
			failed = true;
			failure = error;
		}
		try {
			await this.close(original);
		} catch (error) {
			if (!failed) {
				failed = true;
				failure = error;
			}
		}
		if (failed) throw failure;
		this.admit();
		return original;
	}
	remember(capture: Capture): void {
		this.bound(capture.file);
		const identity = fstatSync(capture.fd, { bigint: true });
		this.files.push({ file: capture.file, identity });
	}
	capture(operation: Operation, name: string): Capture {
		this.admit();
		const original = operation.openFile(path.join(this.cache, name), "wx");
		this.remember(original);
		return original;
	}
	async module(name: string): Promise<Module> {
		this.admit();
		const file = path.join(this.verify, "lib", `${name}.ts`);
		if (!this.source) throw new Error("owned fixture source is unavailable");
		await this.write(file, this.source);
		this.sourceFiles.push(file);
		expect(hash(await readFile(file))).toBe(this.sourceHash);
		this.admit();
		const loaded = (await import(pathToFileURL(file).href)) as Module;
		this.admit();
		return loaded;
	}
	async begin(module: Module): Promise<{ operation: Operation; finish: () => Promise<void> }> {
		this.admit();
		const operation = await module.InventoryCacheOperation.begin();
		let completion: Promise<void> | undefined;
		const finish = (): Promise<void> => {
			completion ??= operation.finish(false);
			return completion;
		};
		this.resource({ join: finish }); // Record a late successful begin before refusing further work.
		this.admit();
		return {
			operation,
			finish: () => {
				this.admit();
				return finish();
			},
		};
	}
	resource(resource: Resource): void {
		this.resources.push(resource);
		if (!this.owner.open) this.releaseResources();
	}
	releaseResources(): void {
		for (const resource of this.resources) {
			if (resource.release && !resource.releasePromise) {
				resource.releasePromise = Promise.resolve().then(() => resource.release?.());
				void resource.releasePromise.catch(() => {}); // Observe; retain the SAME rejected promise.
			}
		}
	}
	async cleanup(): Promise<void> {
		this.releaseResources();
		const releases = await Promise.allSettled(
			this.resources.flatMap((resource) =>
				resource.releasePromise ? [resource.releasePromise] : [],
			),
		);
		const childJoins = await Promise.allSettled(
			this.children.map(
				(child) =>
					child.completion ??
					Promise.reject(new Error("owned fixture child registration is unqualified")),
			),
		);
		const closes = await Promise.allSettled(this.originals.map((original) => this.close(original)));
		if (
			childJoins.some((outcome) => outcome.status === "rejected") ||
			this.children.some((child) => !child.joined)
		)
			throw new Error("owned fixture child closure is unqualified");
		// Only now may a SUT finish close the capture parents, even if SUT registration was never reached.
		const joins = await Promise.allSettled(this.resources.map((resource) => resource.join()));
		if ([...releases, ...joins, ...closes].some((outcome) => outcome.status === "rejected"))
			throw new Error("owned fixture originals did not settle");
		for (const file of this.sourceFiles) expect(hash(await readFile(file))).toBe(this.sourceHash);
		for (const entry of [...this.files].reverse()) {
			this.bound(entry.file);
			const named = await lstat(entry.file, { bigint: true });
			expect(
				named.isFile() &&
					!named.isSymbolicLink() &&
					named.nlink === 1n &&
					same(named, entry.identity),
			).toBe(true);
			expect(canonical(await realpath(entry.file))).toBe(canonical(entry.file));
			await unlink(entry.file);
		}
		for (const entry of [...this.directories].reverse()) {
			if (!entry.created) continue;
			this.bound(entry.file);
			const named = await lstat(entry.file, { bigint: true });
			expect(
				entry.identity &&
					named.isDirectory() &&
					!named.isSymbolicLink() &&
					same(named, entry.identity),
			).toBe(true);
			expect(canonical(await realpath(entry.file))).toBe(canonical(entry.file));
			await rmdir(entry.file);
		}
		activeFixtures.delete(this);
	}
}

function owned(body: (fixture: Fixture) => Promise<void>): Promise<void> {
	if (activeCases.size !== 0) throw new Error("prior owned case teardown is unsettled");
	const original = new OwnedCase(body);
	activeCases.add(original); // The whole body promise is owned before its first callback/await.
	return original.body;
}

async function teardownCases(): Promise<void> {
	const originals = [...activeCases];
	const outcomes = await Promise.allSettled(originals.map((original) => original.teardown()));
	if (outcomes.some((outcome) => outcome.status === "rejected") || activeFixtures.size !== 0)
		throw new Error("owned case teardown remains unsettled");
}
afterEach(teardownCases);
afterAll(teardownCases);

it("owns the fixed outer marker before the first cache mutation", async () => {
	await owned(async (fixture) => {
		const module = await fixture.module("operation");
		const { operation, finish } = await fixture.begin(module);
		expect(await readFile(fixture.key)).toEqual(marker);
		await expect(lstat(path.dirname(fixture.cache))).rejects.toMatchObject({ code: "ENOENT" });
		await fixture.cacheDirectories();
		const file = path.join(fixture.cache, "owned-payload");
		fixture.admit();
		operation.writeFile(file, "bounded payload\n");
		fixture.files.push({ file, identity: await lstat(file, { bigint: true }) });
		expect(await readFile(file, "utf8")).toBe("bounded payload\n");
		await finish();
		await expect(lstat(fixture.key)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

it("refuses an existing old key without mutation or stale takeover", async () => {
	await owned(async (fixture) => {
		const module = await fixture.module("operation");
		await fixture.write(fixture.key, marker);
		fixture.admit();
		await utimes(fixture.key, 1, 1);
		const before = await lstat(fixture.key, { bigint: true });
		await expect(fixture.begin(module)).rejects.toMatchObject({ code: "EEXIST" });
		const after = await lstat(fixture.key, { bigint: true });
		expect(same(before, after) && before.mtimeNs === after.mtimeNs).toBe(true);
		expect(await readFile(fixture.key)).toEqual(marker);
		await expect(lstat(path.dirname(fixture.cache))).rejects.toMatchObject({ code: "ENOENT" });
	});
});

it("excludes an independent exact-source module through the same on-disk key", async () => {
	await owned(async (fixture) => {
		const first = await fixture.module("operation-first");
		const second = await fixture.module("operation-second");
		const { finish } = await fixture.begin(first);
		const before = await lstat(fixture.key, { bigint: true });
		await expect(fixture.begin(second)).rejects.toMatchObject({ code: "EEXIST" });
		expect(same(before, await lstat(fixture.key, { bigint: true }))).toBe(true);
		expect(await readFile(fixture.key)).toEqual(marker);
		await expect(lstat(path.dirname(fixture.cache))).rejects.toMatchObject({ code: "ENOENT" });
		await finish();
		const next = await fixture.begin(second);
		await next.finish();
	});
});

it("retains real child pipes, parent capture fds and key until the original joins", async () => {
	await owned(async (fixture) => {
		const script = path.join(fixture.root, "idle.mjs");
		await fixture.write(
			script,
			Buffer.from(
				[
					'process.stdin.on("error", () => { process.exitCode = 1; process.stdout.end(); process.stderr.end(); });',
					'process.stdin.on("end", () => { process.stdout.end("done\\n"); process.stderr.end("done\\n"); });',
					'process.stdin.resume(); process.stdout.write("ready\\n"); process.stderr.write("ready\\n");',
				].join("\n"),
			),
		);
		const module = await fixture.module("operation");
		const { operation, finish } = await fixture.begin(module);
		await fixture.cacheDirectories();
		const out = fixture.capture(operation, "child.stdout");
		const err = fixture.capture(operation, "child.stderr");
		fixture.admit();
		const child = spawn(process.execPath, [script], {
			cwd: fixture.root,
			shell: false,
			windowsHide: true,
			stdio: ["pipe", "pipe", "pipe"],
			env: process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {},
		});
		const childOriginal: ChildOriginal = { original: child, joined: false };
		fixture.children.push(childOriginal);
		const errors: unknown[] = [];
		let release: Promise<void> | undefined;
		const releaseInput = (): Promise<void> => {
			release ??= new Promise<void>((resolve, reject) => {
				try {
					child.stdin.end((error?: Error | null) => {
						if (error) {
							child.stdin.destroy();
							reject(error);
						} else resolve();
					});
				} catch (error) {
					child.stdin.destroy();
					reject(error);
				}
			});
			return release;
		};
		fixture.resource({
			release: releaseInput,
			async join() {
				if (!childOriginal.completion) throw new Error("owned child physical join is unavailable");
				await childOriginal.completion;
			},
		}); // Actual child and EOF release are owned BEFORE observer setup.
		child.on("error", (error) => errors.push(error));
		child.stdin.on("error", (error) => errors.push(error));
		const native = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
			child.once("close", (code, signal) => resolve({ code, signal })),
		);
		const stdinClose = new Promise<void>((resolve) => child.stdin.once("close", resolve));
		const stdoutClose = new Promise<void>((resolve) => child.stdout.once("close", resolve));
		const stderrClose = new Promise<void>((resolve) => child.stderr.once("close", resolve));
		const joined = Promise.all([native, stdinClose, stdoutClose, stderrClose]).then((ending) => {
			childOriginal.joined = true;
			return ending;
		});
		childOriginal.completion = joined;
		void joined.catch((error) => errors.push(error));
		child.stdout.resume();
		child.stderr.resume(); // Drain even if later capture-observer setup fails.
		const ready = [
			[child.stdout, out],
			[child.stderr, err],
		] as const;
		const readiness = ready.map(
			([stream, capture]) =>
				new Promise<boolean>((resolve) => {
					let received = Buffer.alloc(0);
					stream.on("error", (error) => errors.push(error));
					stream.on("data", (bytes: Buffer) => {
						try {
							if (received.length + bytes.length > 8192)
								throw new Error("owned child output exceeded its bound");
							received = Buffer.concat([received, bytes]);
							for (let offset = 0; offset < bytes.length; ) {
								const count = writeSync(capture.fd, bytes, offset, bytes.length - offset);
								if (count <= 0) throw new Error("owned child capture write failed");
								offset += count;
							}
							if (received.includes(Buffer.from("ready\n"))) resolve(true);
						} catch (error) {
							errors.push(error);
							resolve(false);
						}
					});
					stream.once("close", () => resolve(false));
				}),
		);
		fixture.admit();
		const sutJoin = operation.watchChild(child, [out, err]);
		let sutJoined = false;
		void sutJoin.then(
			() => {
				sutJoined = true;
			},
			(error) => errors.push(error),
		);
		expect(await Promise.all(readiness)).toEqual([true, true]);
		let finished = false;
		const finishing = finish();
		void finishing.then(
			() => {
				finished = true;
			},
			() => {
				finished = true;
			},
		);
		await nextTurn();
		expect(sutJoined || finished || operation.childClosed(child)).toBe(false);
		for (const capture of [out, err]) {
			expect(capture.closeState).toBe("open");
			expect(
				capture.identity && same(capture.identity, fstatSync(capture.fd, { bigint: true })),
			).toBe(true);
		}
		expect(await readFile(fixture.key)).toEqual(marker);
		await releaseInput();
		expect((await joined)[0]).toEqual({ code: 0, signal: null });
		expect(await sutJoin).toEqual({ code: 0, signal: null });
		await finishing;
		expect(operation.childClosed(child)).toBe(true);
		expect([out.closeState, err.closeState]).toEqual(["closed", "closed"]);
		expect(errors).toEqual([]);
		await expect(lstat(fixture.key)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
