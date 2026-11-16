import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	assertNativeBackupExecutionCurrent,
	consumeNativeBackupLease,
	retireNativeBackupExecution,
	takeNativeBackupLease,
} from "../../src/identity/backup-operations.ts";
import * as dataDirectory from "../../src/kernel/data-directory.ts";
import {
	createNativeBackupImagesHandle,
	type NativeBackupImage,
	NativeBackupImageError,
	openNativeBackupImages,
} from "../../src/recovery/backup-image.ts";
import { HubStore } from "../../src/store/store.ts";
import {
	type NativeBackupFixture,
	nativeBackupFixture,
	originalKeyErased,
	originalKeyLength,
} from "../identity/native-backup-fixture.ts";
import { closeSessionTransport, nativeBinding } from "../lifecycle/session-helpers.ts";

type Gate = ReturnType<typeof gate>;
const actualOpen = fs.open;
const actualStoreClose = HubStore.prototype.close;
const fixtures: NativeBackupFixture[] = [];
const images: NativeBackupImage[] = [];
const iterators: AsyncIterator<Uint8Array>[] = [];
const pending: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const disarms: (() => void)[] = [];
const restores: (() => void)[] = [];
function gate() {
	const entered = Promise.withResolvers<void>();
	const wait = Promise.withResolvers<void>();
	releases.push(wait.resolve);
	return { entered, wait };
}
function track<T>(promise: Promise<T>): Promise<T> {
	pending.push(promise);
	void promise.catch(() => undefined);
	return promise;
}
function settled(promise: Promise<unknown>): () => boolean {
	let done = false;
	const mark = () => {
		done = true;
	};
	void promise.then(mark, mark);
	return () => done;
}
function pauseStat(handle: FileHandle, blocked: Gate | (() => void), after = 1): void {
	const stat = handle.stat;
	let checks = 0;
	handle.stat = (async (...args: unknown[]) => {
		const result = await Reflect.apply(stat, handle, args);
		if (++checks === after) {
			handle.stat = stat;
			if (typeof blocked === "function") blocked();
			else {
				blocked.entered.resolve();
				await blocked.wait.promise;
			}
		}
		return result;
	}) as typeof handle.stat;
	restores.push(() => {
		handle.stat = stat;
	});
}
async function fixture(): Promise<NativeBackupFixture> {
	const value = await nativeBackupFixture();
	fixtures.push(value);
	return value;
}
async function expectCleanupHeld(f: NativeBackupFixture): Promise<void> {
	expect(originalKeyErased(f.key)).toBe(true);
	expect(f.session.store.read((sql) => sql.get<{ ok: number }>("SELECT 1 AS ok"))?.ok).toBe(1);
	await expect(f.storage.open({ clock: f.clock })).rejects.toMatchObject({
		code: "SESSION_ACTIVE",
	});
}
async function execution(f: NativeBackupFixture) {
	const issued = f.issue();
	const accepted = await f.accept(issued.envelope);
	expect(accepted.kind).toBe("admin.v1");
	expect(accepted.id).toBe(issued.review.id);
	const lease = takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id);
	return consumeNativeBackupLease(lease, f.session);
}
async function image(f: NativeBackupFixture): Promise<NativeBackupImage> {
	const owner = openNativeBackupImages(f.session);
	const value = await owner.create(await execution(f), f.owner.device.peer);
	images.push(value);
	return value;
}
function reader(image: NativeBackupImage, peer: unknown): AsyncIterator<Uint8Array> {
	const value = image.bytes(peer)[Symbol.asyncIterator]();
	iterators.push(value);
	return value;
}
async function refused(work: () => unknown): Promise<void> {
	let error: unknown;
	try {
		await work();
	} catch (reason) {
		error = reason;
	}
	expect(error).toBeInstanceOf(NativeBackupImageError);
	expect(error).toMatchObject({
		name: "NativeBackupImageError",
		code: "BACKUP_IMAGE_UNAVAILABLE",
		message: "Backup image unavailable",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}
async function ciphertext(image: NativeBackupImage, peer: unknown): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const chunk of image.bytes(peer)) {
		expect(chunk).toBeInstanceOf(Uint8Array);
		expect(chunk.byteLength).toBeGreaterThan(0);
		expect(chunk.byteLength).toBeLessThanOrEqual(65_536);
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}
function observeRead(options: { gate?: Gate; blockedClose?: () => boolean } = {}) {
	let observed: FileHandle | undefined;
	let gated = false;
	let armed = false;
	vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
		const handle = await actualOpen(...args);
		const selected =
			typeof args[0] === "string" && path.basename(args[0]) === "image.db" && args[1] === "wx+";
		if (observed || !selected) return handle;
		const originalRead = handle.read;
		const originalClose = handle.close;
		observed = handle;
		handle.read = (async (...readArgs: unknown[]) => {
			if (armed && options.gate && !gated) {
				gated = true;
				options.gate.entered.resolve();
				await options.gate.wait.promise;
			}
			return Reflect.apply(originalRead, handle, readArgs);
		}) as typeof handle.read;
		handle.close = async () => {
			if (armed && options.blockedClose?.()) throw new Error("DYTEST image handle close blocked");
			return originalClose.call(handle);
		};
		restores.push(() => {
			handle.read = originalRead;
			handle.close = originalClose;
		});
		return handle;
	});
	syncBuiltinESMExports();
	return Object.assign(() => observed, {
		arm: () => {
			armed = true;
		},
	});
}
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const disarm of disarms.splice(0)) disarm();
	await Promise.allSettled(iterators.splice(0).map((value) => value.return?.()));
	await Promise.allSettled(pending.splice(0));
	const imageCleanup = await Promise.allSettled(images.splice(0).map((value) => value.close()));
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	const closingSessions = fixtures.splice(0).reverse();
	const sessionCleanup = await Promise.allSettled(closingSessions.map((f) => f.close()));
	for (const restore of restores.splice(0)) restore();
	if ([...imageCleanup, ...sessionCleanup].some((result) => result.status === "rejected"))
		throw new Error("DYTEST image fixture cleanup incomplete");
});
it("returns only the original Session cached image facade and refuses counterfeit or closed owners", async () => {
	const f = await fixture();
	const owner = openNativeBackupImages(f.session);
	expect(openNativeBackupImages(f.session)).toBe(owner);
	let traps = 0;
	const proxy = new Proxy(f.session, {
		get() {
			traps++;
			throw new Error("DYTEST Session getter trap");
		},
	});
	for (const fake of [
		null,
		{},
		{ ...f.session },
		Object.create(Object.getPrototypeOf(f.session)),
		proxy,
	])
		await refused(() => openNativeBackupImages(fake));
	expect(traps).toBe(0);
	expect(originalKeyLength(f.key)).toBe(32);
	await f.session.close();
	await refused(() => openNativeBackupImages(f.session));
	await refused(() => owner.create({}, f.owner.device.peer));
	expect(originalKeyErased(f.key)).toBe(true);
	await expect(owner.close()).resolves.toBeUndefined();
});
it("requires an actually consumed same-Session A4 execution and its genuine TLS signer", async () => {
	const f = await fixture();
	const other = await fixture();
	const owner = openNativeBackupImages(f.session);
	const issued = f.issue();
	await f.accept(issued.envelope);
	const lease = takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id);
	await refused(() => owner.create(lease, f.owner.device.peer));
	const consumed = consumeNativeBackupLease(lease, f.session);
	let traps = 0;
	const fake = new Proxy(consumed, {
		get() {
			traps++;
			throw new Error("DYTEST execution getter trap");
		},
	});
	for (const value of [{}, { ...consumed }, Object.create(Object.getPrototypeOf(consumed)), fake])
		await refused(() => owner.create(value, f.owner.device.peer));
	expect(traps).toBe(0);
	const foreign = await execution(other);
	await refused(() => owner.create(foreign, f.owner.device.peer));
	const wrongPeer = await execution(f);
	await refused(() => owner.create(wrongPeer, other.owner.device.peer));
	const value = await image(f);
	expect(value.byteLength).toBeGreaterThan(0);
});
it("produces immutable digest metadata and ciphertext recoverable only by the original Store key", async () => {
	const f = await fixture();
	const value = await image(f);
	const bytes = await ciphertext(value, f.owner.device.peer);
	try {
		expect(Number.isSafeInteger(value.byteLength)).toBe(true);
		expect(value.byteLength).toBe(bytes.byteLength);
		expect(value.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(value.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(Reflect.set(value, "byteLength", 1)).toBe(false);
		expect(Reflect.set(value, "sha256", "0".repeat(64))).toBe(false);
		expect(bytes.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))).toBe(false);
		const filename = path.join(f.storage.scratch(), "image.db");
		writeFileSync(filename, bytes, { mode: 0o600, flag: "wx" });
		const wrongKey = f.storage.otherKey();
		let wrong: HubStore | undefined;
		try {
			expect(() => {
				wrong = new HubStore({ filename, nativeBinding, masterKey: wrongKey });
			}).toThrow();
		} finally {
			try {
				wrong?.close();
			} finally {
				wrongKey.destroy();
			}
		}
		const sameKey = f.storage.key();
		let restored: HubStore | undefined;
		try {
			const opened = new HubStore({ filename, nativeBinding, masterKey: sameKey });
			restored = opened;
			expect(opened.read((db) => db.get<{ ok: number }>("SELECT 1 AS ok"))?.ok).toBe(1);
			expect(() => opened.read((db) => f.session.audit.verify(db))).not.toThrow();
		} finally {
			try {
				restored?.close();
			} finally {
				sameKey.destroy();
			}
		}
		expect(originalKeyLength(f.key)).toBe(32);
		expect(f.session.store.read((db) => db.get<{ ok: number }>("SELECT 1 AS ok"))?.ok).toBe(1);
	} finally {
		bytes.fill(0);
	}
});
it.each([3, 4] as const)(
	"revalidates the signer before chunk delivery after %i microtask handoffs",
	async (deliveryTurns) => {
		const f = await fixture();
		const other = await fixture();
		const foreignRead = await image(f);
		await refused(() => reader(foreignRead, other.owner.device.peer).next());
		await foreignRead.close();
		const observed = observeRead();
		const consumed = await execution(f);
		const value = await openNativeBackupImages(f.session).create(consumed, f.owner.device.peer);
		images.push(value);
		const streaming = reader(value, f.owner.device.peer);
		const first = await streaming.next();
		expect(first.done).toBe(false);
		expect(first.value?.byteLength).toBe(65_536);
		expect(value.byteLength).toBeGreaterThan(first.value?.byteLength ?? 0);
		const handle = observed();
		if (!handle) throw new Error("DYTEST delivery image handle missing");
		expect(() => assertNativeBackupExecutionCurrent(consumed, f.session)).not.toThrow();
		let revocation: unknown = "pending";
		let remaining = deliveryTurns;
		const revoke = () => {
			if (--remaining > 0) return queueMicrotask(revoke);
			try {
				revocation = f.operations.lock();
			} catch (error) {
				revocation = error;
			}
		};
		// Real stat resumes checkHeld and readChunk, then the generator and its yield await.
		pauseStat(handle, () => queueMicrotask(revoke), 2);
		const pulling = track(streaming.next());
		const delivered = await pulling.then(
			(part) => !part.done && (part.value?.byteLength ?? 0) > 0,
			() => false,
		);
		expect(revocation).toBeUndefined();
		expect(() => assertNativeBackupExecutionCurrent(consumed, f.session)).toThrow();
		expect(originalKeyLength(f.key)).toBe(32);
		expect(f.session.store.read((db) => db.get<{ ok: number }>("SELECT 1 AS ok"))?.ok).toBe(1);
		expect(delivered).toBe(false);
		await refused(() => pulling);
		await expect(value.close()).resolves.toBeUndefined();
	},
);
it("rechecks A4 authority before reporting EOF after the last encrypted chunk", async () => {
	const f = await fixture();
	const observed = observeRead();
	const value = await image(f);
	const streaming = reader(value, f.owner.device.peer);
	let bytes = 0;
	while (bytes < value.byteLength) {
		const part = await streaming.next();
		expect(part.done).toBe(false);
		expect(part.value?.byteLength).toBeGreaterThan(0);
		bytes += part.value?.byteLength ?? 0;
	}
	expect(bytes).toBe(value.byteLength);
	const handle = observed();
	if (!handle) throw new Error("DYTEST EOF image handle missing");
	const blocked = gate();
	pauseStat(handle, blocked);
	const ending = track(streaming.next());
	expect(await Promise.race([blocked.entered.promise, ending])).toBeUndefined();
	f.operations.lock();
	blocked.wait.resolve();
	await refused(() => ending);
	await expect(value.close()).resolves.toBeUndefined();
});
it("refuses a retired real execution before creating an image and fences closed image reads", async () => {
	const f = await fixture();
	const consumed = await execution(f);
	expect(() => assertNativeBackupExecutionCurrent(consumed, f.session)).not.toThrow();
	retireNativeBackupExecution(consumed, f.session);
	await refused(() => openNativeBackupImages(f.session).create(consumed, f.owner.device.peer));
	const fresh = await fixture();
	const value = await image(fresh);
	await value.close();
	await refused(() => reader(value, fresh.owner.device.peer).next());
	await expect(value.close()).resolves.toBeUndefined();
	const owner = openNativeBackupImages(fresh.session);
	const next = await execution(fresh);
	await owner.close();
	await refused(() => owner.create(next, fresh.owner.device.peer));
});
it.each(["facade", "Session"] as const)(
	"joins the real pending image read and fences new work during %s close",
	async (scope) => {
		const f = await fixture();
		const blocked = gate();
		const observed = observeRead({ gate: blocked });
		const value = await image(f);
		observed.arm();
		const next = scope === "facade" ? await execution(f) : undefined;
		if (next) expect(() => assertNativeBackupExecutionCurrent(next, f.session)).not.toThrow();
		const owner = openNativeBackupImages(f.session);
		const pulling = track(reader(value, f.owner.device.peer).next());
		await Promise.race([blocked.entered.promise, pulling]);
		expect(observed()).toBeDefined();
		const closing = track(scope === "facade" ? owner.close() : f.session.close());
		const closed = settled(closing);
		if (next) await refused(() => owner.create(next, f.owner.device.peer));
		await refused(() => reader(value, f.owner.device.peer).next());
		expect(closed()).toBe(false);
		expect(originalKeyLength(f.key)).toBe(32);
		expect(f.session.store.read((db) => db.get<{ ok: number }>("SELECT 1 AS ok"))?.ok).toBe(1);
		if (scope === "Session")
			await expect(f.storage.open({ clock: f.clock })).rejects.toMatchObject({
				code: "SESSION_ACTIVE",
			});
		blocked.wait.resolve();
		await refused(() => pulling);
		await closing;
		expect(closed()).toBe(true);
		if (scope === "Session") {
			expect(originalKeyErased(f.key)).toBe(true);
			expect(() => f.session.store.read(() => undefined)).toThrow();
		} else expect(originalKeyLength(f.key)).toBe(32);
		const handle = observed();
		if (!handle) throw new Error("DYTEST closing image read handle missing");
		await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
		if (scope === "facade") await expect(owner.close()).resolves.toBeUndefined();
		else await expect(value.close()).resolves.toBeUndefined();
	},
);
it("retains a real failed-close handle and retries cleanup without erased Session or A4 authority", async () => {
	const f = await fixture();
	let blocked = true;
	disarms.push(() => {
		blocked = false;
	});
	const observed = observeRead({ blockedClose: () => blocked });
	const value = await image(f);
	observed.arm();
	const streaming = reader(value, f.owner.device.peer);
	const first = await streaming.next();
	expect(first.done).toBe(false);
	const handle = observed();
	if (!handle) throw new Error("DYTEST retained image handle missing");
	await refused(() => value.close());
	await expect(handle.stat()).resolves.toMatchObject({ size: value.byteLength });
	await expect(f.session.close()).rejects.toMatchObject({ code: "CLOSE_INCOMPLETE" });
	await expectCleanupHeld(f);
	blocked = false;
	await expect(f.session.close()).resolves.toBeUndefined();
	expect(originalKeyErased(f.key)).toBe(true);
	await expect(handle.stat()).rejects.toMatchObject({ code: "EBADF" });
	expect(() => f.session.store.read(() => undefined)).toThrow();
	await expect(value.close()).resolves.toBeUndefined();
});
it("rejects an uncached image handle even with the original Session Store and master key", async () => {
	const f = await fixture();
	const original = openNativeBackupImages(f.session);
	expect(() => f.session.store.assertMasterKey(f.key)).not.toThrow();
	const shadow = createNativeBackupImagesHandle(
		f.session,
		f.session.store,
		f.key,
		f.session.audit,
		f.storage.folder,
		nativeBinding,
	);
	await refused(() => shadow.get());
	expect(openNativeBackupImages(f.session)).toBe(original);
	expect(originalKeyLength(f.key)).toBe(32);
});
it("never adopts or deletes a foreign image name after the real reserved file is moved outside its stage", async () => {
	const f = await fixture();
	const owner = openNativeBackupImages(f.session);
	const consumed = await execution(f);
	const blocked = gate();
	const born = lstatSync(f.storage.folder, { bigint: true });
	const outside = f.storage.scratch();
	const original = path.join(outside, "original.db");
	const foreign = path.join(outside, "foreign.db");
	const foreignBytes = Buffer.from("DYTEST foreign image DATA");
	let named = "";
	let foreignIdentity: { dev: bigint; ino: bigint } | undefined;
	vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
		const handle = await actualOpen(...args);
		if (typeof args[0] === "string" && path.basename(args[0]) === "image.db" && args[1] === "wx+") {
			named = args[0];
			pauseStat(handle, blocked);
		}
		return handle;
	});
	syncBuiltinESMExports();
	const creating = track(owner.create(consumed, f.owner.device.peer));
	try {
		await Promise.race([blocked.entered.promise, creating]);
		expect(named).not.toBe("");
		expect(path.dirname(path.dirname(named))).toBe(f.storage.folder);
		expect(path.dirname(outside)).toBe(path.dirname(f.storage.folder));
		renameSync(named, original);
		writeFileSync(named, foreignBytes, { flag: "wx", mode: 0o600 });
		foreignIdentity = lstatSync(named, { bigint: true });
		blocked.wait.resolve();
		await refused(() => creating);
		expect(existsSync(named)).toBe(true);
		expect(readFileSync(named).equals(foreignBytes)).toBe(true);
		await expect(f.session.close()).rejects.toMatchObject({ code: "CLOSE_INCOMPLETE" });
		await expectCleanupHeld(f);
	} finally {
		blocked.wait.resolve();
		await Promise.allSettled([creating]);
		if (existsSync(original)) {
			const stage = path.dirname(named);
			const current = lstatSync(f.storage.folder, { bigint: true });
			expect(
				path.dirname(stage) === f.storage.folder &&
					current.dev === born.dev &&
					current.ino === born.ino,
			).toBe(true);
			if (!existsSync(stage)) mkdirSync(stage, { mode: 0o700 });
			if (existsSync(named)) {
				const present = lstatSync(named, { bigint: true });
				expect(present.dev === foreignIdentity?.dev && present.ino === foreignIdentity?.ino).toBe(
					true,
				);
				renameSync(named, foreign);
			}
			renameSync(original, named);
		}
		await f.session.close();
	}
});
it("keeps rejected close uncertainty after fd invalidation and refuses a later no-op close", async () => {
	const admissions = new Map<string, dataDirectory.DataFolder>();
	const admit = dataDirectory.admitDataFolder;
	vi.spyOn(dataDirectory, "admitDataFolder").mockImplementation((folder, options) => {
		const held = admit(folder, options);
		admissions.set(folder, held);
		return held;
	});
	const observed = observeRead();
	const f = await fixture();
	const value = await image(f);
	const handle = observed();
	const admission = admissions.get(f.storage.folder);
	if (!handle || !admission) throw new Error("DYTEST genuine image owner missing");
	const root = path.dirname(f.storage.folder);
	const born = lstatSync(root, { bigint: true });
	const close = handle.close;
	let physicalCloseCompleted = false;
	const code = "CLOSE_INCOMPLETE";
	const closeError = { name: "HubSessionError", code, message: code };
	const cleanup = async (): Promise<void> => {
		handle.close = close;
		fixtures.splice(fixtures.indexOf(f), 1);
		images.splice(images.indexOf(value), 1);
		// Intentional uncertainty is never cleared through production state for test cleanup.
		const removed = await f.close().then(
			() => true,
			() => false,
		);
		if (removed) return;
		const transport = await Promise.allSettled([
			f.owner.client.close(),
			closeSessionTransport(f.native),
		]);
		if (transport.some((result) => result.status === "rejected"))
			throw new Error("DYTEST backup transport cleanup incomplete");
		if (!existsSync(root)) return;
		if (!physicalCloseCompleted) {
			if (handle.fd < 0) throw new Error("DYTEST image close settlement unavailable");
			await close.call(handle);
		}
		actualStoreClose.call(f.session.store);
		admission.release();
		const current = lstatSync(root, { bigint: true });
		if (realpathSync.native(root) !== root || current.dev !== born.dev || current.ino !== born.ino)
			throw new Error("DYTEST backup fixture root ownership changed");
		rmSync(root, { recursive: true });
	};
	try {
		const positive = await ciphertext(value, f.owner.device.peer);
		try {
			expect(positive.byteLength).toBe(value.byteLength);
			expect(positive.byteLength).toBeGreaterThan(0);
		} finally {
			positive.fill(0);
		}
		expect(handle.fd).toBeGreaterThanOrEqual(0);
		// A genuine close settles first; only its API promise is faulted, not the fd getter.
		handle.close = async () => {
			await close.call(handle);
			physicalCloseCompleted = true;
			throw new Error("DYTEST image close API rejection after settlement");
		};
		await expect(f.session.close()).rejects.toMatchObject(closeError);
		expect(physicalCloseCompleted).toBe(true);
		expect(handle.fd).toBe(-1);
		await expectCleanupHeld(f);
		expect(() => admission.assertHeld()).not.toThrow();
		const noop = vi.fn(close.bind(handle));
		handle.close = noop;
		await expect(f.session.close()).rejects.toMatchObject(closeError);
		expect(noop).not.toHaveBeenCalled();
		await expectCleanupHeld(f);
		expect(() => admission.assertHeld()).not.toThrow();
	} finally {
		await cleanup();
	}
});
