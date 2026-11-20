import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
	assertNativeBackupExecutionCurrent,
	consumeNativeBackupLease,
	takeNativeBackupLease,
} from "../../src/identity/backup-operations.ts";
import { advanceEpochForRestore } from "../../src/identity/devices.ts";
import {
	BACKUP_ARTIFACT_HEADER_SIZE,
	BackupArtifactError,
	decodeBackupArtifactHeader,
	encodeBackupArtifactHeader,
} from "../../src/recovery/backup-artifact.ts";
import {
	createNativeBackupArtifactsHandle,
	type NativeBackupArtifact,
	openNativeBackupArtifacts,
} from "../../src/recovery/backup-artifact-native.ts";
import {
	createRecoveryBinding,
	verifyRecoveryBinding,
} from "../../src/recovery/backup-bindings.ts";
import {
	type NativeBackupImage,
	NativeBackupImageError,
	openNativeBackupImages,
} from "../../src/recovery/backup-image.ts";
import { openNativeBackupRecovery } from "../../src/recovery/backup-recovery.ts";
import { HubStore } from "../../src/store/store.ts";
import {
	type NativeBackupFixture,
	nativeBackupFixture,
	originalKeyErased,
	originalKeyLength,
} from "../identity/native-backup-fixture.ts";
import { nativeBinding } from "../lifecycle/session-helpers.ts";

const actualOpen = fs.open;
const fixtures: NativeBackupFixture[] = [];
const artifacts: NativeBackupArtifact[] = [];
const images: NativeBackupImage[] = [];
const iterators: AsyncIterator<Uint8Array>[] = [];
const pending: Promise<unknown>[] = [];
const releases: (() => void)[] = [];
const disarms: (() => void)[] = [];
const restores: (() => void)[] = [];
const buffers: Buffer[] = [];
type Gate = ReturnType<typeof gate>;
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
async function fixture(enroll = true): Promise<NativeBackupFixture> {
	const f = await nativeBackupFixture();
	fixtures.push(f);
	if (enroll) {
		const code = randomBytes(20);
		try {
			await openNativeBackupRecovery(f.session).enroll(code);
		} finally {
			code.fill(0);
		}
	}
	return f;
}
async function execution(f: NativeBackupFixture) {
	const issued = f.issue();
	const accepted = await f.accept(issued.envelope);
	expect(accepted).toMatchObject({ kind: "admin.v1", id: issued.review.id });
	return consumeNativeBackupLease(
		takeNativeBackupLease(f.operations, f.owner.device.peer, issued.review.id),
		f.session,
	);
}
async function artifact(f: NativeBackupFixture): Promise<NativeBackupArtifact> {
	const value = await openNativeBackupArtifacts(f.session).create(
		await execution(f),
		f.owner.device.peer,
	);
	artifacts.push(value);
	return value;
}
function reader(value: NativeBackupArtifact, peer: unknown): AsyncIterator<Uint8Array> {
	const result = value.bytes(peer)[Symbol.asyncIterator]();
	iterators.push(result);
	return result;
}
async function refused(work: () => unknown, imageError = false): Promise<void> {
	let error: unknown;
	try {
		await work();
	} catch (reason) {
		error = reason;
	}
	expect(error).toBeInstanceOf(imageError ? NativeBackupImageError : BackupArtifactError);
	expect(error).toMatchObject(
		imageError
			? {
					name: "NativeBackupImageError",
					code: "BACKUP_IMAGE_UNAVAILABLE",
					message: "Backup image unavailable",
				}
			: {
					name: "BackupArtifactError",
					code: "BACKUP_ARTIFACT_UNAVAILABLE",
					message: "Backup artifact unavailable",
				},
	);
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}
async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
	const chunks: Buffer[] = [];
	try {
		for await (const chunk of source) {
			expect(chunk).toBeInstanceOf(Uint8Array);
			expect(chunk.byteLength).toBeGreaterThan(0);
			expect(chunk.byteLength).toBeLessThanOrEqual(65_536);
			chunks.push(Buffer.from(chunk));
		}
		return Buffer.concat(chunks);
	} finally {
		for (const chunk of chunks) chunk.fill(0);
	}
}
function alive(f: NativeBackupFixture): void {
	expect(originalKeyLength(f.key)).toBe(32);
	expect(f.session.store.read((db) => db.get<{ ok: number }>("SELECT 1 AS ok"))?.ok).toBe(1);
}
function owned(value: Buffer): Buffer {
	buffers.push(value);
	return value;
}
async function framedImage(f: NativeBackupFixture) {
	const image = await openNativeBackupImages(f.session).create(
		await execution(f),
		f.owner.device.peer,
	);
	images.push(image);
	const capsule = owned(await openNativeBackupRecovery(f.session).readCapsule());
	const header = owned(
		encodeBackupArtifactHeader(capsule, image.recoveryBinding, image.byteLength, image.sha256),
	);
	return { image, capsule, header };
}
function alternate(f: NativeBackupFixture): { capsule: Buffer; binding: Buffer } {
	const code = randomBytes(20);
	try {
		const capsule = f.key.wrapRecovery(code);
		return { capsule, binding: createRecoveryBinding(f.key, capsule) };
	} finally {
		code.fill(0);
	}
}
function replaceBinding(f: NativeBackupFixture, binding: Buffer): void {
	f.session.store.write((tx) => {
		tx.run("UPDATE main.native_backup_recovery SET binding=? WHERE singleton=1", [binding]);
	});
	const actual = f.session.store.read((db) =>
		db.get<{ binding: Buffer }>(
			"SELECT binding FROM main.native_backup_recovery WHERE singleton=1",
		),
	)?.binding;
	try {
		expect(actual?.equals(binding)).toBe(true);
	} finally {
		actual?.fill(0);
	}
}
function pauseStat(handle: FileHandle, blocked: Gate): void {
	const stat = handle.stat;
	let armed = true;
	handle.stat = (async (...args: unknown[]) => {
		const result = await Reflect.apply(stat, handle, args);
		if (armed) {
			armed = false;
			blocked.entered.resolve();
			await blocked.wait.promise;
		}
		return result;
	}) as typeof handle.stat;
	restores.push(() => {
		handle.stat = stat;
	});
}
function observeImage(
	options: {
		reservation?: Gate;
		read?: Gate;
		readPass?: number;
		close?: Gate;
		failClose?: () => boolean;
	} = {},
) {
	let observed: FileHandle | undefined;
	let originalRead: FileHandle["read"] | undefined;
	let originalWrite: FileHandle["write"] | undefined;
	let pass = 0;
	let readBlocked = false;
	let closeArmed = false;
	vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
		const handle = await actualOpen(...args);
		if (
			observed ||
			typeof args[0] !== "string" ||
			path.basename(args[0]) !== "image.db" ||
			args[1] !== "wx+"
		)
			return handle;
		observed = handle;
		const read = handle.read;
		const close = handle.close;
		originalRead = read;
		originalWrite = handle.write;
		if (options.reservation) pauseStat(handle, options.reservation);
		handle.read = (async (...readArgs: unknown[]) => {
			if (readArgs[3] === 0) pass++;
			const result = await Reflect.apply(read, handle, readArgs);
			if (!readBlocked && options.read && pass === options.readPass) {
				readBlocked = true;
				options.read.entered.resolve();
				await options.read.wait.promise;
			}
			return result;
		}) as typeof handle.read;
		handle.close = async () => {
			if (closeArmed && options.failClose?.())
				throw new Error("DYTEST actual image close withheld");
			await close.call(handle);
			if (closeArmed && options.close) {
				options.close.entered.resolve();
				await options.close.wait.promise;
			}
		};
		restores.push(() => {
			handle.read = read;
			handle.close = close;
		});
		return handle;
	});
	syncBuiltinESMExports();
	return {
		handle(): FileHandle {
			if (!observed) throw new Error("DYTEST real image handle missing");
			return observed;
		},
		passes: () => pass,
		armClose: () => {
			closeArmed = true;
		},
		async byte(): Promise<Buffer> {
			const value = Buffer.alloc(1);
			if (!observed || !originalRead) throw new Error("DYTEST image read missing");
			const result = await Reflect.apply(originalRead, observed, [value, 0, 1, 0]);
			expect(result.bytesRead).toBe(1);
			return value;
		},
		async writeByte(value: Buffer): Promise<void> {
			if (!observed || !originalWrite) throw new Error("DYTEST image write missing");
			const result = await Reflect.apply(originalWrite, observed, [value, 0, 1, 0]);
			expect(result.bytesWritten).toBe(1);
		},
	};
}
afterEach(async () => {
	for (const release of releases.splice(0)) release();
	for (const disarm of disarms.splice(0)) disarm();
	for (const restore of restores.splice(0).reverse()) restore();
	vi.restoreAllMocks();
	syncBuiltinESMExports();
	const returning = await Promise.allSettled(iterators.splice(0).map((value) => value.return?.()));
	await Promise.allSettled(pending.splice(0));
	const directImages = images.splice(0);
	const closing = await Promise.allSettled([
		...artifacts.splice(0).map((value) => value.close()),
		...directImages.map((value) => value.close()),
	]);
	for (const image of directImages) image.recoveryBinding?.fill(0);
	const sessions = await Promise.allSettled(
		fixtures
			.splice(0)
			.reverse()
			.map((f) => f.close()),
	);
	for (const buffer of buffers.splice(0)) buffer.fill(0);
	if ([...returning, ...closing, ...sessions].some((result) => result.status === "rejected"))
		throw new Error("DYTEST artifact fixture cleanup incomplete");
});

it("frames ciphertext bound to its image snapshot and the original key", async () => {
	const f = await fixture();
	const enrolled = await openNativeBackupRecovery(f.session).readCapsule();
	const value = await artifact(f);
	const bytes = await collect(value.bytes(f.owner.device.peer));
	const decoded = decodeBackupArtifactHeader(bytes.subarray(0, BACKUP_ARTIFACT_HEADER_SIZE));
	try {
		expect(value.byteLength).toBe(bytes.length);
		expect(Number.isSafeInteger(value.byteLength)).toBe(true);
		expect(value.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(Reflect.set(value, "sha256", "0".repeat(64))).toBe(false);
		expect(Reflect.set(value, "byteLength", 1)).toBe(false);
		expect(decoded.capsule.equals(enrolled)).toBe(true);
		expect(verifyRecoveryBinding(f.key, decoded.capsule, decoded.binding)).toBe(true);
		const body = bytes.subarray(BACKUP_ARTIFACT_HEADER_SIZE);
		expect(decoded.byteLength).toBe(body.length);
		expect(decoded.sha256).toBe(createHash("sha256").update(body).digest("hex"));
		expect(bytes.length).toBe(body.length + 208);
		expect(body.subarray(0, 16).equals(Buffer.from("SQLite format 3\0"))).toBe(false);
		const filename = path.join(f.storage.scratch(), "artifact-image.db");
		writeFileSync(filename, body, { flag: "wx", mode: 0o600 });
		for (const correct of [false, true]) {
			const key = correct ? f.storage.key() : f.storage.otherKey();
			let restored: HubStore | undefined;
			try {
				if (!correct)
					expect(() => {
						restored = new HubStore({ filename, nativeBinding, masterKey: key });
					}).toThrow();
				else {
					restored = new HubStore({ filename, nativeBinding, masterKey: key });
					expect(restored.read((db) => db.get<{ ok: number }>("SELECT 1 AS ok"))?.ok).toBe(1);
					expect(() => restored?.read((db) => f.session.audit.verify(db))).not.toThrow();
					const binding = restored.read((db) =>
						db.get<{ binding: Buffer }>(
							"SELECT binding FROM main.native_backup_recovery WHERE singleton=1",
						),
					)?.binding;
					expect(binding?.equals(decoded.binding)).toBe(true);
					binding?.fill(0);
				}
			} finally {
				try {
					restored?.close();
				} finally {
					key.destroy();
				}
			}
		}
		alive(f);
	} finally {
		decoded.capsule.fill(0);
		decoded.binding.fill(0);
		enrolled.fill(0);
		bytes.fill(0);
	}
});

it("rejects counterfeit, proxy, foreign and uncached owners without invoking getters", async () => {
	const f = await fixture();
	const other = await fixture();
	const owner = openNativeBackupArtifacts(f.session);
	expect(openNativeBackupArtifacts(f.session)).toBe(owner);
	let traps = 0;
	const trapped = new Proxy(f.session, {
		get() {
			traps++;
			throw new Error("DYTEST owner trap");
		},
	});
	for (const fake of [
		null,
		{},
		{ ...f.session },
		Object.create(Object.getPrototypeOf(f.session)),
		trapped,
	])
		await refused(() => openNativeBackupArtifacts(fake));
	const shadow = createNativeBackupArtifactsHandle(f.session, f.key);
	expect(() => f.session.store.assertMasterKey(f.key)).not.toThrow();
	await refused(() => shadow.get());
	const consumed = await execution(f);
	for (const fake of [
		{},
		{ ...consumed },
		new Proxy(consumed, {
			get() {
				traps++;
			},
		}),
	])
		await refused(() => owner.create(fake, f.owner.device.peer));
	const foreign = await execution(other);
	await refused(() => owner.create(foreign, f.owner.device.peer));
	await refused(() => owner.create(consumed, other.owner.device.peer));
	expect(traps).toBe(0);
	alive(f);
	await f.session.close();
	await refused(() => openNativeBackupArtifacts(f.session));
	await refused(() => owner.create(consumed, f.owner.device.peer));
	await expect(owner.close()).resolves.toBeUndefined();
});

it("requires existing enrollment and does not create an image on capsule refusal", async () => {
	const f = await fixture(false);
	const observed = observeImage();
	const consumed = await execution(f);
	await refused(() => openNativeBackupArtifacts(f.session).create(consumed, f.owner.device.peer));
	expect(() => observed.handle()).toThrow("DYTEST real image handle missing");
	alive(f);
});

it("keeps artifact and image delivery single-use and joins early header return", async () => {
	const f = await fixture();
	const other = await fixture();
	const observed = observeImage();
	const owner = openNativeBackupArtifacts(f.session);
	const consumed = await execution(f);
	const value = await owner.create(consumed, f.owner.device.peer);
	artifacts.push(value);
	await refused(() => owner.create(consumed, f.owner.device.peer));
	let traps = 0;
	const peer = new Proxy(f.owner.device.peer, {
		get() {
			traps++;
		},
	});
	for (const offered of [{}, other.owner.device.peer, peer])
		await refused(() => value.bytes(offered));
	expect(traps).toBe(0);
	const stream = value.bytes(f.owner.device.peer);
	const first = stream[Symbol.asyncIterator]();
	iterators.push(first);
	await refused(() => stream[Symbol.asyncIterator]());
	await refused(() => value.bytes(f.owner.device.peer));
	const header = await first.next();
	expect(header.done).toBe(false);
	expect(header.value?.byteLength).toBe(208);
	header.value?.fill(0);
	await expect(first.return?.()).resolves.toMatchObject({ done: true });
	await expect(observed.handle().stat()).rejects.toMatchObject({ code: "EBADF" });
	await refused(() => first.next());
	await expect(value.close()).resolves.toBeUndefined();
	alive(f);
});

it("matches the capsule to the image transaction after enrolled DATA changes", async () => {
	const f = await fixture();
	const next = alternate(f);
	const blocked = gate();
	observeImage({ reservation: blocked });
	const creating = track(
		openNativeBackupArtifacts(f.session).create(await execution(f), f.owner.device.peer),
	);
	try {
		expect(await Promise.race([blocked.entered.promise, creating])).toBeUndefined();
		expect(verifyRecoveryBinding(f.key, next.capsule, next.binding)).toBe(true);
		replaceBinding(f, next.binding);
		blocked.wait.resolve();
		await refused(() => creating);
		alive(f);
	} finally {
		blocked.wait.resolve();
		next.capsule.fill(0);
		next.binding.fill(0);
	}
});

it("hashes the complete prefix and held image without consuming its one delivery", async () => {
	const f = await fixture();
	const observed = observeImage();
	const { image, header } = await framedImage(f);
	expect(observed.passes()).toBe(1);
	const digest = await image.digestArtifact(header, f.owner.device.peer);
	expect(observed.passes()).toBe(2);
	const body = owned(await collect(image.bytes(f.owner.device.peer)));
	expect(observed.passes()).toBe(3);
	expect(body.length).toBe(image.byteLength);
	expect(createHash("sha256").update(body).digest("hex")).toBe(image.sha256);
	expect(digest.byteLength).toBe(208 + body.length);
	expect(digest.sha256).toBe(createHash("sha256").update(header).update(body).digest("hex"));
	await refused(() => image.bytes(f.owner.device.peer), true);
	await refused(() => image.digestArtifact(header, f.owner.device.peer), true);
});

it("keeps the private image binding distinct from its mutable outward DATA copy", async () => {
	const f = await fixture();
	const { image } = await framedImage(f);
	const different = alternate(f);
	try {
		expect(verifyRecoveryBinding(f.key, different.capsule, different.binding)).toBe(true);
		expect(image.recoveryBinding?.equals(different.binding)).toBe(false);
		image.recoveryBinding?.set(different.binding);
		const header = owned(
			encodeBackupArtifactHeader(
				different.capsule,
				different.binding,
				image.byteLength,
				image.sha256,
			),
		);
		await refused(() => image.digestArtifact(header, f.owner.device.peer), true);
		const body = owned(await collect(image.bytes(f.owner.device.peer)));
		expect(createHash("sha256").update(body).digest("hex")).toBe(image.sha256);
		alive(f);
	} finally {
		different.capsule.fill(0);
		different.binding.fill(0);
	}
});

it("authenticates a grammar-valid image binding under the actual original MasterKey", async () => {
	const f = await fixture();
	const capsule = owned(await openNativeBackupRecovery(f.session).readCapsule());
	const malformed = owned(createRecoveryBinding(f.key, capsule));
	malformed[malformed.length - 1] = (malformed[malformed.length - 1] ?? 0) ^ 1;
	expect(verifyRecoveryBinding(f.key, capsule, malformed)).toBe(false);
	// This changes enrolled DATA, never a challenge, execution, PIN proof or device grant.
	replaceBinding(f, malformed);
	const image = await openNativeBackupImages(f.session).create(
		await execution(f),
		f.owner.device.peer,
	);
	images.push(image);
	expect(image.recoveryBinding?.equals(malformed)).toBe(true);
	const header = owned(
		encodeBackupArtifactHeader(capsule, malformed, image.byteLength, image.sha256),
	);
	await refused(() => image.digestArtifact(header, f.owner.device.peer), true);
	alive(f);
});

it.each(["length", "digest", "shared", "proxy"] as const)(
	"refuses a %s prefix before allowing metadata to describe the image",
	async (kind) => {
		const f = await fixture();
		const { image, header } = await framedImage(f);
		let offered: unknown = header;
		let traps = 0;
		if (kind === "length") header.writeBigUInt64BE(BigInt(image.byteLength + 1), 5);
		if (kind === "digest") header[13] = (header[13] ?? 0) ^ 1;
		if (kind === "shared") {
			const shared = new Uint8Array(new SharedArrayBuffer(208));
			shared.set(header);
			offered = shared;
		}
		if (kind === "proxy")
			offered = new Proxy(header, {
				get() {
					traps++;
				},
			});
		await refused(() => image.digestArtifact(offered, f.owner.device.peer), true);
		expect(traps).toBe(0);
		const body = owned(await collect(image.bytes(f.owner.device.peer)));
		expect(body.length).toBe(image.byteLength);
		expect(createHash("sha256").update(body).digest("hex")).toBe(image.sha256);
	},
);

it("detects changed ciphertext in the prefix scan without consuming delivery", async () => {
	const f = await fixture();
	const observed = observeImage();
	const { image, header } = await framedImage(f);
	const original = owned(await observed.byte());
	const changed = owned(Buffer.from(original));
	changed[0] = (changed[0] ?? 0) ^ 1;
	try {
		await observed.writeByte(changed);
		await refused(() => image.digestArtifact(header, f.owner.device.peer), true);
	} finally {
		await observed.writeByte(original);
	}
	const body = owned(await collect(image.bytes(f.owner.device.peer)));
	expect(body.length).toBe(image.byteLength);
	expect(createHash("sha256").update(body).digest("hex")).toBe(image.sha256);
});

it.each([
	["header", "lock"],
	["header", "epoch"],
	["chunk", "lock"],
	["chunk", "epoch"],
	["EOF", "lock"],
	["EOF", "epoch"],
] as const)("rechecks actual %s delivery after genuine %s revocation", async (stage, mode) => {
	const f = await fixture();
	const blocked = gate();
	const observed = observeImage(stage === "chunk" ? { read: blocked, readPass: 3 } : {});
	const consumed = await execution(f);
	const value = await openNativeBackupArtifacts(f.session).create(consumed, f.owner.device.peer);
	artifacts.push(value);
	const streaming = reader(value, f.owner.device.peer);
	if (stage !== "header") {
		const header = await streaming.next();
		expect(header.done).toBe(false);
		expect(header.value?.byteLength).toBe(208);
		header.value?.fill(0);
	}
	if (stage === "EOF") {
		let length = 208;
		while (length < value.byteLength) {
			const chunk = await streaming.next();
			expect(chunk.done).toBe(false);
			expect(chunk.value?.byteLength).toBeGreaterThan(0);
			length += chunk.value?.byteLength ?? 0;
			chunk.value?.fill(0);
		}
		expect(length).toBe(value.byteLength);
		pauseStat(observed.handle(), blocked);
	}
	const previousEpoch = f.session.devices.currentState().epoch;
	let mutation: unknown = "not reached";
	const revoke = () => {
		try {
			mutation =
				mode === "lock"
					? f.operations.lock()
					: f.session.store.write((tx) => advanceEpochForRestore(f.session.devices, tx));
		} catch (error) {
			mutation = error;
		}
	};
	const pulling = track(streaming.next());
	if (stage === "header") queueMicrotask(revoke);
	else {
		expect(await Promise.race([blocked.entered.promise, pulling])).toBeUndefined();
		revoke();
		blocked.wait.resolve();
	}
	const delivered = await pulling.then(
		(part) =>
			stage === "EOF" ? part.done === true : !part.done && (part.value?.byteLength ?? 0) > 0,
		() => false,
	);
	expect(mutation).toBe(mode === "lock" ? undefined : previousEpoch + 1);
	expect(() => assertNativeBackupExecutionCurrent(consumed, f.session)).toThrow();
	alive(f);
	expect(delivered).toBe(false);
	await refused(() => pulling);
	await expect(value.close()).resolves.toBeUndefined();
});

it("joins a concurrent return and the real outstanding body read", async () => {
	const f = await fixture();
	const blocked = gate();
	const observed = observeImage({ read: blocked, readPass: 3 });
	const value = await artifact(f);
	const streaming = reader(value, f.owner.device.peer);
	const header = await streaming.next();
	expect(header.value?.byteLength).toBe(208);
	header.value?.fill(0);
	const pulling = track(streaming.next());
	expect(await Promise.race([blocked.entered.promise, pulling])).toBeUndefined();
	const returning = track(
		streaming.return?.() ?? Promise.reject(new Error("DYTEST return missing")),
	);
	const returned = settled(returning);
	await refused(() => value.bytes(f.owner.device.peer));
	expect(returned()).toBe(false);
	alive(f);
	blocked.wait.resolve();
	await refused(() => pulling);
	await expect(returning).resolves.toMatchObject({ done: true });
	expect(returned()).toBe(true);
	await expect(observed.handle().stat()).rejects.toMatchObject({ code: "EBADF" });
});

it("joins a direct image close with its actual outstanding prefix scan", async () => {
	const f = await fixture();
	const blocked = gate();
	const observed = observeImage({ read: blocked, readPass: 2 });
	const { image, header } = await framedImage(f);
	const scanning = track(image.digestArtifact(header, f.owner.device.peer));
	expect(await Promise.race([blocked.entered.promise, scanning])).toBeUndefined();
	const closing = track(image.close());
	const closed = settled(closing);
	await refused(() => image.bytes(f.owner.device.peer), true);
	await expect(observed.handle().stat()).resolves.toMatchObject({ size: image.byteLength });
	expect(closed()).toBe(false);
	alive(f);
	blocked.wait.resolve();
	await refused(() => scanning, true);
	await expect(closing).resolves.toBeUndefined();
	expect(closed()).toBe(true);
	await expect(observed.handle().stat()).rejects.toMatchObject({ code: "EBADF" });
});

it.each(["reservation", "prefix"] as const)(
	"fences pending %s creation and physically joins it before Session teardown",
	async (stage) => {
		const f = await fixture();
		const blocked = gate();
		const observed = observeImage(
			stage === "reservation" ? { reservation: blocked } : { read: blocked, readPass: 2 },
		);
		const owner = openNativeBackupArtifacts(f.session);
		const consumed = await execution(f);
		const creating = track(owner.create(consumed, f.owner.device.peer));
		expect(await Promise.race([blocked.entered.promise, creating])).toBeUndefined();
		const closing = track(f.session.close());
		const closed = settled(closing);
		await refused(() => owner.create(consumed, f.owner.device.peer));
		await refused(() => openNativeBackupArtifacts(f.session));
		expect(closed()).toBe(false);
		alive(f);
		await expect(f.storage.open({ clock: f.clock })).rejects.toMatchObject({
			code: "SESSION_ACTIVE",
		});
		blocked.wait.resolve();
		await refused(() => creating);
		await expect(closing).resolves.toBeUndefined();
		expect(closed()).toBe(true);
		expect(originalKeyErased(f.key)).toBe(true);
		expect(() => f.session.store.read(() => undefined)).toThrow();
		await expect(observed.handle().stat()).rejects.toMatchObject({ code: "EBADF" });
	},
);

it("holds the key and Store until the actual FileHandle close promise settles", async () => {
	const f = await fixture();
	const blocked = gate();
	const observed = observeImage({ close: blocked });
	const value = await artifact(f);
	observed.armClose();
	const closing = track(f.session.close());
	expect(await Promise.race([blocked.entered.promise, closing])).toBeUndefined();
	const closed = settled(closing);
	expect(observed.handle().fd).toBe(-1);
	await expect(observed.handle().stat()).rejects.toMatchObject({ code: "EBADF" });
	await refused(() => value.bytes(f.owner.device.peer));
	expect(closed()).toBe(false);
	alive(f);
	await expect(f.storage.open({ clock: f.clock })).rejects.toMatchObject({
		code: "SESSION_ACTIVE",
	});
	blocked.wait.resolve();
	await expect(closing).resolves.toBeUndefined();
	expect(originalKeyErased(f.key)).toBe(true);
	expect(() => f.session.store.read(() => undefined)).toThrow();
});

it("retries physical cleanup with the original key and A4 authority erased", async () => {
	const f = await fixture();
	let blocked = true;
	disarms.push(() => {
		blocked = false;
	});
	const observed = observeImage({ failClose: () => blocked });
	const consumed = await execution(f);
	const value = await openNativeBackupArtifacts(f.session).create(consumed, f.owner.device.peer);
	artifacts.push(value);
	observed.armClose();
	await refused(() => value.close());
	await expect(observed.handle().stat()).resolves.toMatchObject({ size: value.byteLength - 208 });
	await expect(f.session.close()).rejects.toMatchObject({ code: "CLOSE_INCOMPLETE" });
	expect(originalKeyErased(f.key)).toBe(true);
	expect(f.session.store.read((db) => db.get<{ ok: number }>("SELECT 1 AS ok"))?.ok).toBe(1);
	await expect(f.storage.open({ clock: f.clock })).rejects.toMatchObject({
		code: "SESSION_ACTIVE",
	});
	f.operations.lock();
	expect(() => assertNativeBackupExecutionCurrent(consumed, f.session)).toThrow();
	blocked = false;
	await expect(value.close()).resolves.toBeUndefined();
	await expect(f.session.close()).resolves.toBeUndefined();
	expect(originalKeyErased(f.key)).toBe(true);
	await expect(observed.handle().stat()).rejects.toMatchObject({ code: "EBADF" });
	expect(() => f.session.store.read(() => undefined)).toThrow();
	await refused(() => value.bytes(f.owner.device.peer));
});
