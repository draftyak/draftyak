import assert from "node:assert/strict";
import native, { type Dir, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { type TestContext, test } from "node:test";
import { pathToFileURL } from "node:url";
import { readJson } from "./artifacts.ts";
import { CONFORMANCE_VERSION, ERAS } from "./policy.ts";

const failure = { message: "Invalid conformance artifact file" };
function fixture(ctx: TestContext): { directory: string; file: string } {
	const parent = path.resolve(tmpdir());
	const directory = mkdtempSync(path.join(parent, "draftyak-conformance-resource-"));
	ctx.after(() => {
		assert.equal(path.dirname(path.resolve(directory)), parent);
		assert.ok(path.basename(directory).startsWith("draftyak-conformance-resource-"));
		rmSync(directory, { recursive: true, force: true });
	});
	const file = path.join(directory, "small.json");
	writeFileSync(file, "{}");
	writeFileSync(
		path.join(directory, "run.json"),
		JSON.stringify({
			era: ERAS[1],
			conformanceVersion: CONFORMANCE_VERSION,
			args: [],
			exitCode: 0,
		}),
	);
	return { directory, file };
}
function restore(ctx: TestContext): void {
	ctx.mock.restoreAll();
	syncBuiltinESMExports();
}
async function retryReaders(file: string): Promise<void> {
	try {
		await readJson(file);
	} catch {
		// Preserve the test failure; each fixture retains its originals for final native cleanup.
	}
}

test("a refused real file close blocks fresh allocations until the original is closed", async (ctx) => {
	const { file } = fixture(ctx);
	const open = fs.open;
	const oldOpen = native.openSync;
	const oldClose = native.closeSync;
	let first: FileHandle | undefined;
	let legacy: number | undefined;
	let realClose: (() => Promise<void>) | undefined;
	let opens = 0;
	let heal = false;
	// The legacy hooks also make this regression fail against the former synchronous loader.
	ctx.mock.method(native, "openSync", (...args: Parameters<typeof native.openSync>) => {
		const fd = oldOpen(...args);
		if (args[0] === file) {
			opens++;
			legacy ??= fd;
		}
		return fd;
	});
	ctx.mock.method(native, "closeSync", (fd: number) => {
		if (fd === legacy && !heal) throw new Error("Injected close refusal");
		return oldClose(fd);
	});
	ctx.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		if (args[0] === file) {
			opens++;
			if (!first) {
				first = handle;
				realClose = handle.close.bind(handle);
				ctx.mock.method(handle, "close", async () => {
					if (!heal) throw new Error("Injected close refusal");
					await realClose?.();
				});
			}
		}
		return handle;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(async () => readJson(file));
		assert.ok(first ? (await first.stat()).isFile() : native.fstatSync(legacy as number).isFile());
		await assert.rejects(async () => readJson(file));
		assert.equal(opens, 1);
		heal = true;
		assert.deepEqual(await readJson(file), {});
		if (first) assert.equal(first.fd, -1);
	} finally {
		heal = true;
		await retryReaders(file);
		restore(ctx);
		if (realClose && first?.fd !== -1) await realClose();
		if (legacy !== undefined) {
			try {
				native.fstatSync(legacy);
				oldClose(legacy);
			} catch (error) {
				assert.equal((error as NodeJS.ErrnoException).code, "EBADF");
			}
		}
	}
});

test("a resolved false-success file close retains admission and the native object", async (ctx) => {
	const { file } = fixture(ctx);
	const open = fs.open;
	let first: FileHandle | undefined;
	let close: (() => Promise<void>) | undefined;
	let opens = 0;
	let heal = false;
	ctx.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		opens++;
		if (!first) {
			first = handle;
			close = handle.close.bind(handle);
			ctx.mock.method(handle, "close", async () => {
				if (heal) await close?.();
			});
		}
		return handle;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(readJson(file), failure);
		assert.ok(first && (await first.stat()).isFile());
		await assert.rejects(readJson(file), failure);
		assert.equal(opens, 1);
		heal = true;
		assert.deepEqual(await readJson(file), {});
		assert.equal(first?.fd, -1);
	} finally {
		heal = true;
		await retryReaders(file);
		restore(ctx);
		if (first?.fd !== -1) await close?.();
	}
});

test("an after-effect close failure never closes an independently reopened native handle", async (ctx) => {
	const { file } = fixture(ctx);
	const { readJson: isolatedReadJson } = (await import(
		new URL("./artifacts.ts?after-effect-close", import.meta.url).href
	)) as typeof import("./artifacts.ts");
	const open = fs.open;
	let first: FileHandle | undefined;
	let foreign: FileHandle | undefined;
	let attempts = 0;
	let originalFd = -1;
	ctx.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		if (!first) {
			first = handle;
			originalFd = handle.fd;
			const close = handle.close.bind(handle);
			ctx.mock.method(handle, "close", async () => {
				attempts++;
				await close();
				foreign = await open(file, "r");
				throw new Error("Injected after-effect failure");
			});
		}
		return handle;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(isolatedReadJson(file), failure);
		assert.equal(first?.fd, -1);
		assert.ok(foreign && (await foreign.stat()).isFile());
		ctx.diagnostic(`Actual native descriptor reuse observed: ${foreign.fd === originalFd}`);
		await assert.rejects(isolatedReadJson(file), failure);
		assert.equal(attempts, 1);
		assert.ok((await foreign.stat()).isFile());
	} finally {
		restore(ctx);
		await foreign?.close();
	}
});

test("a native close rejection cannot retire a still-open descriptor through fd === -1", async (ctx) => {
	const { file } = fixture(ctx);
	const { readJson: isolatedReadJson } = (await import(
		new URL("./artifacts.ts?native-close-rejection", import.meta.url).href
	)) as typeof import("./artifacts.ts");
	const open = fs.open;
	let first: FileHandle | undefined;
	let originalFd = -1;
	let nativeObject: object | undefined;
	let nativeClose: (() => Promise<void>) | undefined;
	let closeDescriptor: PropertyDescriptor | undefined;
	let opens = 0;
	let closeAttempts = 0;
	ctx.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		opens++;
		if (!first) {
			first = handle;
			originalFd = handle.fd;
			const symbol = Object.getOwnPropertySymbols(handle).find(
				(value) => value.description === "kHandle",
			);
			assert.ok(symbol, "the pinned runtime must expose its original native handle");
			nativeObject = Reflect.get(handle, symbol) as object;
			nativeClose = Reflect.get(nativeObject, "close") as () => Promise<void>;
			closeDescriptor = Object.getOwnPropertyDescriptor(nativeObject, "close");
			Object.defineProperty(nativeObject, "close", {
				configurable: true,
				value: async () => {
					closeAttempts++;
					throw new Error("Injected native before-effect close rejection");
				},
			});
		}
		return handle;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(isolatedReadJson(file), failure);
		assert.equal(first?.fd, -1);
		// Observe the descriptor only; cleanup always uses the captured original object.
		assert.ok(native.fstatSync(originalFd).isFile());
		for (let attempt = 0; attempt < 3; attempt++) {
			await assert.rejects(isolatedReadJson(file), failure);
		}
		assert.equal(opens, 1);
		assert.equal(closeAttempts, 1);
		assert.ok(native.fstatSync(originalFd).isFile());
	} finally {
		restore(ctx);
		if (nativeObject && nativeClose) {
			if (closeDescriptor) Object.defineProperty(nativeObject, "close", closeDescriptor);
			else Reflect.deleteProperty(nativeObject, "close");
			await Reflect.apply(nativeClose, nativeObject, []);
		} else if (first && first.fd !== -1) {
			await first.close();
		}
	}
});

for (const mode of ["before", "false-success", "after", "initial-marker"] as const) {
	test(`native directory ${mode} close requires original-object closure proof`, async (ctx) => {
		const { directory, file } = fixture(ctx);
		const { loadRun: isolatedLoadRun, readJson: isolatedReadJson } = (await import(
			new URL(`./artifacts.ts?directory-close-${mode}`, import.meta.url).href
		)) as typeof import("./artifacts.ts");
		const opendir = fs.opendir;
		const open = fs.open;
		let first: Dir | undefined;
		let close: (() => Promise<void>) | undefined;
		let opens = 0;
		let fileOpens = 0;
		let heal = false;
		ctx.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
			fileOpens++;
			return open(...args);
		});
		ctx.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
			const handle = await opendir(...args);
			opens++;
			if (!first) {
				first = handle;
				const nativeClose = handle.close.bind(handle);
				close = () => nativeClose();
				ctx.mock.method(handle, "close", async () => {
					if (heal) return close?.();
					if (mode === "after") await close?.();
					if (mode === "initial-marker")
						throw Object.assign(new Error("Injected initial directory marker"), {
							code: "ERR_DIR_CLOSED",
						});
					if (mode !== "false-success") throw new Error("Injected directory close refusal");
				});
			}
			return handle;
		});
		syncBuiltinESMExports();
		try {
			await assert.rejects(isolatedLoadRun(directory, ERAS[1]), {
				message: "Invalid conformance artifact directory",
			});
			if (mode !== "after") {
				assert.ok(first);
				await assert.doesNotReject(first.read());
			}
			const before = fileOpens;
			await assert.rejects(isolatedReadJson(file), failure);
			assert.equal(opens, 1);
			assert.equal(fileOpens, before);
			heal = true;
			if (mode === "false-success") {
				assert.deepEqual(await isolatedReadJson(file), {});
				assert.ok(first);
				await assert.rejects(first.read(), { code: "ERR_DIR_CLOSED" });
			} else {
				for (let attempt = 0; attempt < 3; attempt++)
					await assert.rejects(isolatedReadJson(file), failure);
				assert.equal(fileOpens, before);
				assert.equal(opens, 1);
			}
		} finally {
			heal = true;
			restore(ctx);
			try {
				await close?.();
			} catch (error) {
				assert.equal((error as NodeJS.ErrnoException).code, "ERR_DIR_CLOSED");
			}
		}
	});
}

test("registration precedes first stat and concurrent readers cannot allocate", async (ctx) => {
	const { file } = fixture(ctx);
	const open = fs.open;
	let release: (() => void) | undefined;
	const wait = new Promise<void>((resolve) => {
		release = resolve;
	});
	let entered: (() => void) | undefined;
	const ready = new Promise<void>((resolve) => {
		entered = resolve;
	});
	let opens = 0;
	let first: FileHandle | undefined;
	let heal = false;
	ctx.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		opens++;
		if (!first) {
			first = handle;
			const stat = handle.stat.bind(handle);
			const close = handle.close.bind(handle);
			ctx.mock.method(handle, "stat", async () => {
				entered?.();
				await wait;
				if (!heal) throw new Error("Injected initial stat refusal");
				return stat({ bigint: true });
			});
			ctx.mock.method(handle, "close", async () => {
				if (!heal) throw new Error("Injected close refusal");
				await close();
			});
		}
		return handle;
	});
	syncBuiltinESMExports();
	const running = readJson(file);
	try {
		await ready;
		await assert.rejects(readJson(file), failure);
		assert.equal(opens, 1);
		release?.();
		await assert.rejects(running, failure);
		await assert.rejects(readJson(file), failure);
		assert.equal(opens, 1);
		heal = true;
		assert.deepEqual(await readJson(file), {});
		assert.equal(first?.fd, -1);
	} finally {
		release?.();
		heal = true;
		await running.catch(() => undefined);
		await retryReaders(file);
		restore(ctx);
	}
});

test("a nested check failure retains both originals within the two-resource bound", async (ctx) => {
	const { directory, file } = fixture(ctx);
	const { loadRun: isolatedLoadRun, readJson: isolatedReadJson } = (await import(
		new URL("./artifacts.ts?nested-directory-close", import.meta.url).href
	)) as typeof import("./artifacts.ts");
	const target = path.join(directory, "server-tools-list-2026-10-18T00-00-00-000Z");
	mkdirSync(target);
	const checks = path.join(target, "checks.json");
	writeFileSync(checks, "[]");
	const open = fs.open;
	const opendir = fs.opendir;
	let heldFile: FileHandle | undefined;
	let heldDirectory: Dir | undefined;
	let closeFile: (() => Promise<void>) | undefined;
	let closeDirectory: (() => Promise<void>) | undefined;
	let allocations = 0;
	let heal = false;
	ctx.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await open(...args);
		allocations++;
		if (args[0] === checks) {
			heldFile = handle;
			const close = handle.close.bind(handle);
			closeFile = close;
			ctx.mock.method(handle, "close", async () => {
				if (!heal) throw new Error("Injected nested file refusal");
				await close();
			});
		}
		return handle;
	});
	ctx.mock.method(fs, "opendir", async (...args: Parameters<typeof fs.opendir>) => {
		const handle = await opendir(...args);
		allocations++;
		heldDirectory = handle;
		const close = handle.close.bind(handle);
		closeDirectory = close;
		ctx.mock.method(handle, "close", async () => {
			if (!heal) throw new Error("Injected nested directory refusal");
			await close();
		});
		return handle;
	});
	syncBuiltinESMExports();
	try {
		await assert.rejects(isolatedLoadRun(directory, ERAS[1]));
		assert.ok(heldFile && (await heldFile.stat()).isFile());
		assert.ok(heldDirectory);
		await assert.doesNotReject(heldDirectory.read());
		const before = allocations;
		await assert.rejects(isolatedReadJson(file), failure);
		assert.equal(allocations, before);
		assert.equal(before, 3); // closed receipt, retained directory, retained checks file
		heal = true;
		await assert.rejects(isolatedReadJson(file), failure);
		assert.equal(heldFile.fd, -1);
		await assert.doesNotReject(heldDirectory.read());
		assert.equal(allocations, before);
	} finally {
		heal = true;
		await isolatedReadJson(file).catch(() => undefined);
		restore(ctx);
		if (heldFile?.fd !== -1) await closeFile?.();
		try {
			await closeDirectory?.();
		} catch (error) {
			assert.equal((error as NodeJS.ErrnoException).code, "ERR_DIR_CLOSED");
		}
	}
});

test("the selected native file URL is captured before cleanup or filesystem awaits", async (ctx) => {
	const { directory, file } = fixture(ctx);
	const other = path.join(directory, "other.json");
	writeFileSync(other, '{"other":true}');
	const selected = pathToFileURL(file);
	const running = readJson(selected);
	selected.href = pathToFileURL(other).href;
	assert.deepEqual(await running, {});
});
