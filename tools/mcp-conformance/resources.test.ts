import assert from "node:assert/strict";
import native, { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { type TestContext, test, vi } from "vitest";
import { loadRun, readJson } from "./artifacts.ts";
import { CONFORMANCE_VERSION, ERAS } from "./policy.ts";

function fixture(ctx: TestContext): { directory: string; file: string } {
	const parent = realpathSync.native(tmpdir());
	const directory = mkdtempSync(path.join(parent, "draftyak-conformance-resource-"));
	ctx.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, "small.json");
	writeFileSync(file, "{}");
	writeFileSync(
		path.join(directory, "run.json"),
		JSON.stringify({
			era: ERAS[1],
			conformanceVersion: CONFORMANCE_VERSION,
			exitCode: 0,
			args: [
				"server",
				"--url",
				"http://127.0.0.1:47613/mcp",
				"--suite",
				"all",
				"--spec-version",
				ERAS[1],
				"--output-dir",
				directory,
				"--expected-failures",
				"expected.json",
			],
		}),
	);
	const scenario = path.join(directory, "server-tools-list-2026-10-18T00-00-00-000Z");
	mkdirSync(scenario);
	writeFileSync(path.join(scenario, "checks.json"), "[]");
	return { directory, file };
}
function restore(): void {
	vi.restoreAllMocks();
	syncBuiltinESMExports();
}

test("independent artifact reads do not share an admission latch", async (ctx) => {
	const { file } = fixture(ctx);
	assert.deepEqual(await Promise.all([readJson(file), readJson(file)]), [{}, {}]);
});

test("a rejected file close refuses only its operation and permits a later independent read", async (ctx) => {
	const { file } = fixture(ctx);
	const close = native.closeSync;
	let original: number | undefined;
	let calls = 0;
	vi.spyOn(native, "closeSync").mockImplementation((fd: number) => {
		calls++;
		original = fd;
		throw new Error("Synthetic before-close failure");
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(readJson(file), { message: "Invalid conformance artifact file" });
		assert.equal(calls, 1);
		assert.notEqual(original, undefined);
	} finally {
		restore();
		if (original !== undefined) close(original);
	}
	assert.deepEqual(await readJson(file), {});
});

test("a post-close failure never closes a foreign descriptor or poisons later reads", async (ctx) => {
	const { file } = fixture(ctx);
	const close = native.closeSync;
	let foreign: number | undefined;
	let injected = false;
	vi.spyOn(native, "closeSync").mockImplementation((fd: number) => {
		close(fd);
		if (!injected) {
			injected = true;
			foreign = native.openSync(file, "r");
			throw new Error("Synthetic post-close failure");
		}
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(readJson(file), { message: "Invalid conformance artifact file" });
		assert.notEqual(foreign, undefined);
		assert.deepEqual(await readJson(file), {});
		assert.equal(native.fstatSync(foreign as number).isFile(), true);
		const bytes = Buffer.alloc(2);
		assert.equal(native.readSync(foreign as number, bytes, 0, 2, 0), 2);
		assert.equal(bytes.toString(), "{}");
	} finally {
		restore();
		if (foreign !== undefined) close(foreign);
	}
});

test("directory close failure refuses its load without poisoning later readers", async (ctx) => {
	const { directory, file } = fixture(ctx);
	const opendir = fs.opendir;
	let cleanup: (() => Promise<void>) | undefined;
	let closed = false;
	let calls = 0;
	vi.spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
		const handle = await opendir(...args);
		cleanup = handle.close.bind(handle);
		vi.spyOn(handle, "close").mockImplementation(async () => {
			calls++;
			await cleanup?.();
			closed = true;
			throw new Error("Synthetic directory post-close failure");
		});
		return handle;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(loadRun(directory, ERAS[1]), {
			message: "Invalid conformance artifact directory",
		});
		assert.equal(calls, 1);
	} finally {
		restore();
		if (!closed) await cleanup?.();
	}
	assert.deepEqual(await readJson(file), {});
	assert.equal((await loadRun(directory, ERAS[1])).era, ERAS[1]);
});

test("a directory load awaits its own asynchronous close before completing", async (ctx) => {
	const { directory } = fixture(ctx);
	const opendir = fs.opendir;
	const lstat = fs.lstat;
	// Keep the final directory check in the microtask queue, independent of disk scheduling.
	vi.spyOn(fs, "lstat").mockImplementation((...args: Parameters<typeof fs.lstat>) =>
		args[0] === directory
			? Promise.resolve(native.lstatSync(directory, { bigint: true }))
			: lstat(...args),
	);
	let entered: (() => void) | undefined;
	const closing = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	let cleanup: (() => Promise<void>) | undefined;
	let closed = false;
	let closingWork: Promise<void> | undefined;
	vi.spyOn(fs, "opendir").mockImplementation(async (...args: Parameters<typeof fs.opendir>) => {
		const handle = await opendir(...args);
		cleanup = handle.close.bind(handle);
		vi.spyOn(handle, "close").mockImplementation(() => {
			entered?.();
			closingWork = gate.then(async () => {
				await cleanup?.();
				closed = true;
			});
			return closingWork;
		});
		return handle;
	});
	syncBuiltinESMExports();
	let completed = false;
	const pending = loadRun(directory, ERAS[1]).then((run) => {
		completed = true;
		return run;
	});
	try {
		await closing;
		await setImmediate();
		assert.equal(completed, false);
		release?.();
		assert.equal((await pending).era, ERAS[1]);
		assert.equal(closed, true);
	} finally {
		release?.();
		await pending.catch(() => undefined);
		await closingWork?.catch(() => undefined);
		restore();
		if (!closed) await cleanup?.();
	}
});

test("the selected native file URL is captured before filesystem awaits", async (ctx) => {
	const { directory, file } = fixture(ctx);
	const target = pathToFileURL(file);
	const pending = readJson(target);
	target.pathname = pathToFileURL(path.join(directory, "missing.json")).pathname;
	assert.deepEqual(await pending, {});
});
