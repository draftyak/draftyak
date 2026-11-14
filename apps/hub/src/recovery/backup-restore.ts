import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import { AuditChain } from "../audit/chain.ts";
import { advanceEpochForRestore, DeviceRegistry } from "../identity/devices.ts";
import { HubIdentity } from "../identity/hub-key.ts";
import { installPinForRestore, type PinInitialization, PinService } from "../identity/pin.ts";
import { fields } from "../jobs/values.ts";
import { admitDataFolder, type DataFolder } from "../kernel/data-directory.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { HUB_NAMESPACES } from "../kernel/namespaces.ts";
import { flushDirectory } from "../store/durable-file.ts";
import { captureMigrationPlan, migrationTables } from "../store/migrator.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../store/store.ts";
import {
	BACKUP_ARTIFACT_HEADER_SIZE,
	type BackupArtifactHeader,
	decodeBackupArtifactHeader,
} from "./backup-artifact.ts";
import { captureRecoveryBinding, verifyRecoveryBinding } from "./backup-bindings.ts";
import { RECOVERY_CAPSULE_V1 } from "./backup-capsule.ts";
import { openRecoveryBytes } from "./recovery-code.ts";

export interface NativeBackupPreparationInput {
	readonly artifactFile: string;
	readonly destination: string;
	readonly recoveryCode: Uint8Array;
	/** The fixed native launch configuration, never a connection or opener. */
	readonly nativeBinding: string;
}

declare const preparationBrand: unique symbol;
/** A private validated image lifetime; it exposes no key, Store, file or admission. */
export interface NativeBackupPreparation {
	readonly [preparationBrand]: true;
}

export class NativeBackupRestoreError extends Error {
	override name = "NativeBackupRestoreError";
	readonly code = "BACKUP_RESTORE_UNAVAILABLE";
	constructor() {
		super("Backup restore unavailable");
	}
}

const CHUNK_BYTES = 65_536;
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const copyBytes = Uint8Array.prototype.set;
const destroyMasterKey = MasterKey.prototype.destroy;
const deriveMasterKey = MasterKey.prototype.derive;
const readStore = HubStore.prototype.read;
const writeStore = HubStore.prototype.write;
const checkpointStore = HubStore.prototype.checkpoint;
const closeStore = HubStore.prototype.close;
const verifyAudit = AuditChain.prototype.verify;
const destroyAudit = AuditChain.prototype.destroy;
const loadExistingIdentity = HubIdentity.loadExisting;
const lockIdentity = HubIdentity.prototype.lock;
const preparePin = PinService.prototype.prepareInitialization;
const discardPin = PinService.prototype.discard;
const lockPins = PinService.prototype.lock;
const registryState = DeviceRegistry.prototype.state;
const lockRegistry = DeviceRegistry.prototype.lock;
const invokeOriginal = Reflect.apply;
interface CapturedPreparation {
	readonly artifactFile: string;
	readonly destination: string;
	readonly code: Buffer;
	readonly nativeBinding: string;
}
interface OwnedFile {
	readonly path: string;
	readonly handle: FileHandle;
	identity: BigIntStats | undefined;
	closed: boolean;
	closeUncertain: boolean;
	closeAttempt: Promise<boolean> | undefined;
	retryDescriptor: number | undefined;
}
interface RestoreOwner {
	readonly destination: string;
	root: BigIntStats | undefined;
	active: boolean;
	closing: Promise<void> | undefined;
	admissionUncertain: boolean;
	stageUncertain: boolean;
	folder: DataFolder | undefined;
	folderReleased: boolean;
	run: BigIntStats | undefined;
	lock: BigIntStats | undefined;
	stagePath: string | undefined;
	stage: BigIntStats | undefined;
	source: OwnedFile | undefined;
	image: OwnedFile | undefined;
	key: MasterKey | undefined;
	store: HubStore | undefined;
	storeUncertain: boolean;
	rootDirectoryDirty?: boolean;
}

// A failed cleanup retains its original handles and destination fence. It never authorizes
// deletion by a new path lookup, nor another restore while a physical resource is uncertain.
const owners = new Map<string, RestoreOwner>();
interface PreparedImage {
	readonly dev: bigint;
	readonly ino: bigint;
	readonly size: bigint;
	readonly mtimeNs: bigint;
	readonly ctimeNs: bigint;
}
interface PreparedRestore {
	readonly owner: RestoreOwner;
	readonly header: BackupArtifactHeader;
	image: PreparedImage;
	state: "READY" | "RESETTING" | "AUTHORITY_RESET" | "FAILED" | "CLOSING" | "CLOSED";
	operation: Promise<void> | undefined;
	closing: Promise<void> | undefined;
}
const preparations = new WeakMap<NativeBackupPreparation, PreparedRestore>();
function preparation(raw: unknown): PreparedRestore {
	if (raw === null || typeof raw !== "object" || types.isProxy(raw)) refuse();
	return preparations.get(raw as NativeBackupPreparation) ?? refuse();
}

function refuse(): never {
	throw new NativeBackupRestoreError();
}
function inputPath(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > 32_768 ||
		value.includes("\0") ||
		!path.isAbsolute(value)
	)
		refuse();
	return value;
}
function capturePreparation(raw: unknown): CapturedPreparation {
	let code: Buffer | undefined;
	try {
		const value = fields(raw, ["artifactFile", "destination", "recoveryCode", "nativeBinding"]);
		const offered = value.recoveryCode;
		if (
			types.isProxy(offered) ||
			!types.isUint8Array(offered) ||
			lengthOf?.call(offered) !== RECOVERY_CAPSULE_V1.codeBytes ||
			!types.isArrayBuffer(bufferOf?.call(offered)) ||
			types.isSharedArrayBuffer(bufferOf?.call(offered))
		)
			refuse();
		code = Buffer.alloc(RECOVERY_CAPSULE_V1.codeBytes);
		copyBytes.call(code, offered);
		const result: CapturedPreparation = {
			artifactFile: inputPath(value.artifactFile),
			destination: inputPath(value.destination),
			code,
			nativeBinding: inputPath(value.nativeBinding),
		};
		if (path.extname(result.nativeBinding) !== ".node") refuse();
		// Match native folder admission before the first destination filesystem lookup.
		if (
			process.platform === "win32" &&
			(!/^[A-Za-z]:\\/.test(result.destination) || /[. ](?:\\|$)/.test(result.destination))
		)
			refuse();
		return Object.freeze(result);
	} catch {
		code?.fill(0);
		return refuse();
	}
}
function same(left: BigIntStats, right: BigIntStats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.ino > 0n;
}
function regular(value: BigIntStats): boolean {
	return value.isFile() && !value.isSymbolicLink() && value.nlink === 1n && value.ino > 0n;
}
function privateImage(value: BigIntStats): boolean {
	return (
		regular(value) &&
		(process.platform === "win32" ||
			((value.mode & 0o777n) === 0o600n && value.uid === BigInt(process.geteuid?.() ?? -1)))
	);
}
async function directoryIdentity(name: string): Promise<BigIntStats> {
	if ((await fs.realpath(name)) !== name) refuse();
	const stat = await fs.lstat(name, { bigint: true });
	if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino <= 0n) refuse();
	return stat;
}
async function assertRoot(owner: RestoreOwner): Promise<void> {
	if (!owner.root || !same(owner.root, await directoryIdentity(owner.destination))) refuse();
	if (!owner.folderReleased) owner.folder?.assertHeld();
}
async function assertStage(owner: RestoreOwner): Promise<void> {
	await assertRoot(owner);
	if (
		!owner.stagePath ||
		!owner.stage ||
		!same(owner.stage, await directoryIdentity(owner.stagePath))
	)
		refuse();
	const stage = await fs.lstat(owner.stagePath, { bigint: true });
	if (
		!same(owner.stage, stage) ||
		(process.platform !== "win32" &&
			((stage.mode & 0o777n) !== 0o700n || stage.uid !== BigInt(process.geteuid?.() ?? -1)))
	)
		refuse();
	if (!owner.folderReleased) owner.folder?.assertHeld();
}
async function assertImage(owner: RestoreOwner): Promise<void> {
	await assertStage(owner);
	const image = owner.image;
	if (!image?.identity || image.closed || image.closeUncertain || image.closeAttempt) refuse();
	const current = await image.handle.stat({ bigint: true });
	const named = await fs.lstat(image.path, { bigint: true });
	if (
		!privateImage(current) ||
		!privateImage(named) ||
		!same(image.identity, current) ||
		!same(image.identity, named)
	)
		refuse();
	await assertStage(owner);
}
function matchesPreparedImage(expected: PreparedImage, current: BigIntStats): boolean {
	return (
		privateImage(current) &&
		expected.dev === current.dev &&
		expected.ino === current.ino &&
		expected.size === current.size &&
		expected.mtimeNs === current.mtimeNs &&
		expected.ctimeNs === current.ctimeNs
	);
}
async function capturePreparedImage(owner: RestoreOwner): Promise<PreparedImage> {
	await assertImage(owner);
	const image = owner.image ?? refuse();
	const current = await image.handle.stat({ bigint: true });
	const named = await fs.lstat(image.path, { bigint: true });
	if (
		!image.identity ||
		!privateImage(current) ||
		!same(image.identity, current) ||
		current.size <= 0n ||
		current.size > BigInt(Number.MAX_SAFE_INTEGER)
	)
		refuse();
	const expected = Object.freeze({
		dev: current.dev,
		ino: current.ino,
		size: current.size,
		mtimeNs: current.mtimeNs,
		ctimeNs: current.ctimeNs,
	});
	if (!matchesPreparedImage(expected, named)) refuse();
	return expected;
}
async function assertSource(source: OwnedFile): Promise<void> {
	const captured = source.identity;
	if (!captured || source.closed || source.closeUncertain || source.closeAttempt) refuse();
	const current = await source.handle.stat({ bigint: true });
	const named = await fs.lstat(source.path, { bigint: true });
	if (
		!regular(current) ||
		!regular(named) ||
		!same(captured, current) ||
		!same(captured, named) ||
		captured.size !== current.size ||
		captured.size !== named.size ||
		captured.mtimeNs !== current.mtimeNs ||
		captured.mtimeNs !== named.mtimeNs ||
		captured.ctimeNs !== current.ctimeNs ||
		captured.ctimeNs !== named.ctimeNs
	)
		refuse();
}
async function readExactly(file: FileHandle, bytes: Buffer, position: number): Promise<void> {
	let read = 0;
	while (read < bytes.length) {
		const result = await file.read(bytes, read, bytes.length - read, position + read);
		if (
			!Number.isSafeInteger(result.bytesRead) ||
			result.bytesRead <= 0 ||
			result.bytesRead > bytes.length - read
		)
			refuse();
		read += result.bytesRead;
	}
}
async function body(
	source: OwnedFile,
	header: BackupArtifactHeader,
	owner?: RestoreOwner,
): Promise<void> {
	const chunk = Buffer.alloc(CHUNK_BYTES);
	const hash = createHash("sha256");
	let copied = 0;
	try {
		while (copied < header.byteLength) {
			await assertSource(source);
			if (owner) await assertImage(owner);
			const length = Math.min(chunk.length, header.byteLength - copied);
			await readExactly(
				source.handle,
				chunk.subarray(0, length),
				BACKUP_ARTIFACT_HEADER_SIZE + copied,
			);
			hash.update(chunk.subarray(0, length));
			if (owner) {
				const image = owner.image;
				if (!image || image.closed) refuse();
				let written = 0;
				while (written < length) {
					await assertImage(owner);
					const result = await image.handle.write(
						chunk,
						written,
						length - written,
						copied + written,
					);
					if (
						!Number.isSafeInteger(result.bytesWritten) ||
						result.bytesWritten <= 0 ||
						result.bytesWritten > length - written
					)
						refuse();
					written += result.bytesWritten;
					await assertImage(owner);
				}
			}
			copied += length;
			chunk.fill(0);
		}
		await assertSource(source);
		if (owner) await assertImage(owner);
		if (copied !== header.byteLength || hash.digest("hex") !== header.sha256) refuse();
	} finally {
		chunk.fill(0);
	}
}
function closeFile(file: OwnedFile | undefined): Promise<boolean> {
	if (!file || file.closed) return Promise.resolve(true);
	if (file.closeAttempt) return file.closeAttempt;
	if (file.closeUncertain) return Promise.resolve(false);
	// Reserve the join before calling the actual original handle. A rejected attempt can
	// admit another close only after its rejection and same-handle inspection both settle.
	const attempt = Promise.resolve().then(async () => {
		try {
			const descriptor = file.handle.fd;
			if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
				file.closeUncertain = true;
				return false;
			}
			if (file.retryDescriptor !== undefined) {
				const current = await file.handle.stat({ bigint: true });
				if (
					descriptor !== file.retryDescriptor ||
					file.handle.fd !== descriptor ||
					!file.identity ||
					!regular(current) ||
					!same(file.identity, current)
				) {
					file.closeUncertain = true;
					return false;
				}
			}
			try {
				await file.handle.close();
			} catch {
				// An invalidated descriptor can still have an unjoined close effect. It is
				// never reopened or promoted to success by a subsequent no-op close.
				if (file.handle.fd !== descriptor) {
					file.closeUncertain = true;
					return false;
				}
				const current = await file.handle.stat({ bigint: true });
				if (
					file.handle.fd !== descriptor ||
					!file.identity ||
					!regular(current) ||
					!same(file.identity, current)
				) {
					file.closeUncertain = true;
					return false;
				}
				file.retryDescriptor = descriptor;
				return false;
			}
			if (file.handle.fd !== -1) {
				file.closeUncertain = true;
				return false;
			}
			file.closed = true;
			return true;
		} catch {
			file.closeUncertain = true;
			return false;
		}
	});
	file.closeAttempt = attempt;
	void attempt.then(() => {
		if (!file.closed && !file.closeUncertain && file.closeAttempt === attempt)
			file.closeAttempt = undefined;
	});
	return attempt;
}
async function removeFile(file: OwnedFile): Promise<void> {
	if (!file.closed || !file.identity) refuse();
	const current = await fs.lstat(file.path, { bigint: true });
	if (!privateImage(current) || !same(current, file.identity)) refuse();
	await fs.unlink(file.path);
}
function closeOwnedStore(owner: RestoreOwner): boolean {
	if (owner.storeUncertain) return false;
	const store = owner.store;
	if (!store) return true;
	try {
		// Original close returns only after its retained native connection is proved closed.
		closeStore.call(store);
		owner.store = undefined;
		return true;
	} catch {
		return false;
	}
}
function validateStore(owner: RestoreOwner, header: BackupArtifactHeader): void {
	const store = owner.store;
	const key = owner.key;
	if (!store || !key || owner.storeUncertain) refuse();
	let auditKey: Buffer | undefined;
	let audit: AuditChain | undefined;
	let enrolled: Buffer | undefined;
	try {
		auditKey = deriveMasterKey.call(key, "audit");
		audit = new AuditChain(auditKey);
		auditKey.fill(0);
		const chain = audit;
		readStore.call(store, (db: SqlReader) => {
			// StoreSchema has already checked canonical SQL and index/table integrity. Require
			// every current native migration, rather than accepting an older recognized prefix.
			const tables = Object.keys(HUB_NAMESPACES)
				.flatMap((namespace) => {
					const names = migrationTables(namespace);
					return [names.table, names.lock];
				})
				.toSorted();
			const present = db.all<{ name: string }>(
				"SELECT name FROM main.sqlite_schema WHERE type='table' AND name GLOB '_migrations_*' ORDER BY name",
			);
			if (
				present.length !== tables.length ||
				present.some((row, index) => row.name !== tables[index])
			)
				refuse();
			for (const [namespace, directory] of Object.entries(HUB_NAMESPACES)) {
				const plan = captureMigrationPlan(directory);
				const table = migrationTables(namespace).table;
				const applied = db.all<{ name: string }>(`SELECT name FROM main."${table}" ORDER BY name`);
				if (
					applied.length !== plan.length ||
					applied.some((row, index) => row.name !== plan[index]?.name)
				)
					refuse();
			}
			verifyAudit.call(chain, db);
			const recovery = db.get<{ binding: unknown }>(
				"SELECT binding FROM main.native_backup_recovery WHERE singleton=1",
			);
			enrolled = captureRecoveryBinding(recovery?.binding);
			if (
				!timingSafeEqual(enrolled, header.binding) ||
				!verifyRecoveryBinding(key, header.capsule, enrolled)
			)
				refuse();
		});
	} finally {
		enrolled?.fill(0);
		auditKey?.fill(0);
		if (audit) destroyAudit.call(audit);
	}
}
async function cleanupOwned(owner: RestoreOwner): Promise<void> {
	const storeClosed = closeOwnedStore(owner);
	const sourceClosed = await closeFile(owner.source);
	const imageClosed = await closeFile(owner.image);
	if (
		!storeClosed ||
		!sourceClosed ||
		!imageClosed ||
		owner.key ||
		owner.admissionUncertain ||
		owner.stageUncertain
	)
		refuse();
	if (!owner.root) {
		// The reservation precedes the first filesystem operation; no producer ran in this path.
		if (owner.source || owner.image || owner.folder || owner.key || owner.stagePath) refuse();
		if (owners.get(owner.destination) !== owner) refuse();
		owners.delete(owner.destination);
		return;
	}
	await assertRoot(owner);
	if (owner.stagePath) await assertStage(owner);
	if (owner.stagePath) {
		const names = await fs.readdir(owner.stagePath);
		// Never adopt or remove a sidecar merely because its name appeared during native open.
		if (names.length !== (owner.image ? 1 : 0) || (owner.image && names[0] !== "image.db"))
			refuse();
	}
	if (owner.image) {
		await removeFile(owner.image);
		owner.image = undefined;
	}
	if (owner.stagePath) {
		if (!owner.stage || !same(owner.stage, await directoryIdentity(owner.stagePath))) refuse();
		if ((await fs.readdir(owner.stagePath)).length !== 0) refuse();
		await fs.rmdir(owner.stagePath);
		owner.stagePath = undefined;
		owner.stage = undefined;
		owner.rootDirectoryDirty = true;
	}
	if (owner.rootDirectoryDirty) {
		await assertRoot(owner);
		flushDirectory(owner.destination);
		owner.rootDirectoryDirty = false;
	}
	if (owner.folder) {
		const folder = owner.folder;
		// Verify the owned scaffold while the ORIGINAL lock is still held. After release,
		// another genuine opener may reuse this same inode, so no path deletion is safe.
		const lockPath = path.join(folder.runPath, "hub.lock");
		if (
			owner.folderReleased ||
			!owner.run ||
			!owner.lock ||
			!same(owner.run, await directoryIdentity(folder.runPath))
		)
			refuse();
		folder.assertHeld();
		const names = await fs.readdir(folder.runPath);
		if (names.length !== 1 || names[0] !== "hub.lock") refuse();
		const lock = await fs.lstat(lockPath, { bigint: true });
		if (!regular(lock) || !same(lock, owner.lock) || lock.size !== 0n) refuse();
		folder.assertHeld();
		folder.release();
		owner.folderReleased = true;
		owner.folder = undefined;
		// Keep run/hub.lock exactly as the original DataFolder release contract does.
		// There is no await, unlink, rmdir or durability call after this release.
	}
	if (owners.get(owner.destination) !== owner) refuse();
	owners.delete(owner.destination);
}
function cleanup(owner: RestoreOwner): Promise<void> {
	if (owner.closing) return owner.closing;
	// Reserve the shared join before any actual FileHandle/native close can run or re-enter.
	const task = Promise.resolve().then(() => cleanupOwned(owner));
	owner.closing = task;
	void task.catch(() => {
		if (owner.closing === task) owner.closing = undefined;
	});
	return task;
}

/** Producer work has returned before the key is erased; cleanup retains uncertain owners. */
async function retireOwner(owner: RestoreOwner): Promise<void> {
	let failed = false;
	try {
		closeOwnedStore(owner);
		if (owner.key) {
			destroyMasterKey.call(owner.key);
			owner.key = undefined;
		}
	} catch {
		failed = true;
	}
	owner.active = false;
	try {
		await cleanup(owner);
	} catch {
		failed = true;
	}
	if (failed) throw new NativeBackupRestoreError();
}
function closePrepared(item: PreparedRestore): Promise<void> {
	if (item.closing) return item.closing;
	const closing = Promise.resolve().then(async () => {
		// The original producer may still own PIN KDF work, a transaction or an image sync.
		// Its failure does not prevent cleanup, but its settlement must precede erasure.
		try {
			await item.operation;
		} catch {
			// Only cleanup is admitted after a failed operation.
		}
		item.header.capsule.fill(0);
		item.header.binding.fill(0);
		await retireOwner(item.owner);
		item.state = "CLOSED";
	});
	item.closing = closing;
	void closing.catch(() => {
		if (item.closing === closing) item.closing = undefined;
	});
	return closing;
}

/** Retires the preparation before erasure. A rejected close permits resource cleanup only. */
export async function closeNativeBackupPreparation(raw: unknown): Promise<void> {
	try {
		const item = preparation(raw);
		if (item.state === "CLOSED") return;
		item.state = "CLOSING";
		await closePrepared(item);
	} catch {
		throw new NativeBackupRestoreError();
	}
}

interface AuthorityResetSnapshot {
	readonly ownerUserId: string;
	readonly epoch: number;
	readonly pinVersion: number;
}

function authoritySnapshot(db: SqlReader, devices: DeviceRegistry): AuthorityResetSnapshot {
	const state = invokeOriginal(registryState, devices, [db]) as ReturnType<typeof registryState>;
	if (
		typeof state.ownerUserId !== "string" ||
		!Number.isSafeInteger(state.epoch) ||
		state.epoch < 1
	)
		refuse();
	const row = db.get<{ version: unknown }>(
		"SELECT version FROM main.approval_pins WHERE user_id=?",
		[state.ownerUserId],
	);
	if (typeof row?.version !== "number" || !Number.isSafeInteger(row.version) || row.version < 1)
		refuse();
	return { ownerUserId: state.ownerUserId, epoch: state.epoch, pinVersion: row.version };
}

function assertResetting(item: PreparedRestore): void {
	if (
		item.state !== "RESETTING" ||
		!item.owner.active ||
		item.owner.closing ||
		item.owner.storeUncertain ||
		!item.owner.store ||
		!item.owner.key
	)
		refuse();
}

async function assertPreparedImage(item: PreparedRestore): Promise<void> {
	assertResetting(item);
	await assertImage(item.owner);
	const image = item.owner.image ?? refuse();
	const current = await image.handle.stat({ bigint: true });
	const named = await fs.lstat(image.path, { bigint: true });
	if (!matchesPreparedImage(item.image, current) || !matchesPreparedImage(item.image, named))
		refuse();
	assertResetting(item);
}

function releaseResetServices(
	devices: DeviceRegistry | undefined,
	pins: PinService | undefined,
	prepared: PinInitialization | undefined,
	identity: HubIdentity | undefined,
	audit: AuditChain | undefined,
	auditKey: Buffer | undefined,
): void {
	let failed = false;
	for (const release of [
		() => {
			if (devices) invokeOriginal(lockRegistry, devices, []);
		},
		() => {
			if (pins && prepared) invokeOriginal(discardPin, pins, [prepared]);
		},
		() => {
			if (pins) invokeOriginal(lockPins, pins, []);
		},
		() => {
			if (identity) invokeOriginal(lockIdentity, identity, []);
		},
		() => {
			if (audit) invokeOriginal(destroyAudit, audit, []);
		},
		() => {
			auditKey?.fill(0);
		},
	]) {
		try {
			release();
		} catch {
			failed = true;
		}
	}
	if (failed) refuse();
}

async function resetPreparedAuthority(item: PreparedRestore, pin: string): Promise<void> {
	const owner = item.owner;
	let auditKey: Buffer | undefined;
	let audit: AuditChain | undefined;
	let identity: HubIdentity | undefined;
	let pins: PinService | undefined;
	let devices: DeviceRegistry | undefined;
	let prepared: PinInitialization | undefined;
	let updated: PreparedImage | undefined;
	try {
		await assertPreparedImage(item);
		const store = owner.store ?? refuse();
		const key = owner.key ?? refuse();
		auditKey = invokeOriginal(deriveMasterKey, key, ["audit"]) as Buffer;
		audit = new AuditChain(auditKey);
		auditKey.fill(0);
		identity = (await invokeOriginal(loadExistingIdentity, HubIdentity, [
			store,
			key,
		])) as HubIdentity;
		await assertPreparedImage(item);
		pins = new PinService(store, audit);
		devices = new DeviceRegistry(store, audit, pins, { identity });
		const chain = audit;
		const registry = devices;
		const service = pins;
		const before = invokeOriginal(readStore, store, [
			(db: SqlReader) => {
				invokeOriginal(verifyAudit, chain, [db]);
				return authoritySnapshot(db, registry);
			},
		]) as AuthorityResetSnapshot;
		if (before.epoch >= Number.MAX_SAFE_INTEGER || before.pinVersion >= Number.MAX_SAFE_INTEGER)
			refuse();
		const initialization = (await invokeOriginal(preparePin, service, [
			before.ownerUserId,
			pin,
		])) as PinInitialization;
		prepared = initialization;
		await assertPreparedImage(item);
		invokeOriginal(writeStore, store, [
			(tx: SqlTransaction) => {
				assertResetting(item);
				invokeOriginal(verifyAudit, chain, [tx]);
				const current = authoritySnapshot(tx, registry);
				if (
					current.ownerUserId !== before.ownerUserId ||
					current.epoch !== before.epoch ||
					current.pinVersion !== before.pinVersion
				)
					refuse();
				if (advanceEpochForRestore(registry, tx) !== before.epoch + 1) refuse();
				installPinForRestore(service, tx, initialization, before.ownerUserId);
				const after = authoritySnapshot(tx, registry);
				const pinRow = tx.get<{
					failures: unknown;
					locked_until: unknown;
					salt_bytes: unknown;
					hash_bytes: unknown;
					binary: unknown;
				}>(
					"SELECT failures,locked_until,length(salt) AS salt_bytes,length(hash) AS hash_bytes,typeof(salt)='blob' AND typeof(hash)='blob' AS binary FROM main.approval_pins WHERE user_id=?",
					[before.ownerUserId],
				);
				if (
					after.ownerUserId !== before.ownerUserId ||
					after.epoch !== before.epoch + 1 ||
					after.pinVersion !== before.pinVersion + 1 ||
					(invokeOriginal(registryState, registry, [tx]) as ReturnType<typeof registryState>)
						.bootstrapDone ||
					pinRow?.failures !== 0 ||
					pinRow.locked_until !== 0 ||
					pinRow.salt_bytes !== 16 ||
					pinRow.hash_bytes !== 32 ||
					pinRow.binary !== 1
				)
					refuse();
				invokeOriginal(verifyAudit, chain, [tx]);
				assertResetting(item);
			},
		]);
		assertResetting(item);
		invokeOriginal(checkpointStore, store, []);
		await assertImage(owner);
		const image = owner.image ?? refuse();
		await image.handle.sync();
		assertResetting(item);
		updated = await capturePreparedImage(owner);
	} finally {
		releaseResetServices(devices, pins, prepared, identity, audit, auditKey);
	}
	assertResetting(item);
	item.image = updated ?? refuse();
	// Other restore reductions, installation and native key delivery are still required.
	// This private phase never denotes an installable or send-authorized image.
	item.state = "AUTHORITY_RESET";
}

/** Resets epoch/bootstrap and PIN once on the held image; it does not publish a restored hub. */
export async function resetNativeBackupAuthority(raw: unknown, pin: unknown): Promise<void> {
	let item: PreparedRestore | undefined;
	let operation: Promise<void> | undefined;
	try {
		item = preparation(raw);
		if (item.state !== "READY" || item.operation || typeof pin !== "string") refuse();
		item.state = "RESETTING";
		const current = item;
		// Reserve the whole original job before an asynchronous producer can run or re-enter.
		operation = Promise.resolve().then(() => resetPreparedAuthority(current, pin));
		item.operation = operation;
		await operation;
	} catch {
		if (item?.state === "RESETTING" && operation && item.operation === operation)
			item.state = "FAILED";
		throw new NativeBackupRestoreError();
	}
}

async function prepareCaptured(input: CapturedPreparation): Promise<NativeBackupPreparation> {
	let owner: RestoreOwner | undefined;
	let header: BackupArtifactHeader | undefined;
	let encoded: Buffer | undefined;
	let retained = false;
	try {
		const previous = owners.get(input.destination);
		if (previous) {
			if (previous.active) refuse();
			await cleanup(previous);
		}
		if (owners.size !== 0) refuse();
		owner = {
			destination: input.destination,
			root: undefined,
			active: true,
			closing: undefined,
			admissionUncertain: false,
			stageUncertain: false,
			folder: undefined,
			folderReleased: false,
			run: undefined,
			lock: undefined,
			stagePath: undefined,
			stage: undefined,
			source: undefined,
			image: undefined,
			key: undefined,
			store: undefined,
			storeUncertain: false,
		};
		owners.set(owner.destination, owner);
		owner.root = await directoryIdentity(input.destination);
		if ((await fs.readdir(input.destination)).length !== 0) refuse();
		if ((await fs.realpath(input.artifactFile)) !== input.artifactFile) refuse();
		const before = await fs.lstat(input.artifactFile, { bigint: true });
		if (
			!regular(before) ||
			before.size <= BigInt(BACKUP_ARTIFACT_HEADER_SIZE) ||
			before.size > BigInt(Number.MAX_SAFE_INTEGER)
		)
			refuse();
		const sourceHandle = await fs.open(
			input.artifactFile,
			constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
		);
		owner.source = {
			path: input.artifactFile,
			handle: sourceHandle,
			identity: before,
			closed: false,
			closeUncertain: false,
			closeAttempt: undefined,
			retryDescriptor: undefined,
		};
		await assertSource(owner.source);
		encoded = Buffer.alloc(BACKUP_ARTIFACT_HEADER_SIZE);
		await readExactly(sourceHandle, encoded, 0);
		header = decodeBackupArtifactHeader(encoded);
		if (BigInt(header.byteLength) + BigInt(BACKUP_ARTIFACT_HEADER_SIZE) !== before.size) refuse();
		owner.key = openRecoveryBytes(header.capsule, input.code);
		if (!verifyRecoveryBinding(owner.key, header.capsule, header.binding)) refuse();
		// Fully validate ciphertext framing/digest before destination admission writes run/lock.
		await body(owner.source, header);
		await assertRoot(owner);
		if ((await fs.readdir(owner.destination)).length !== 0) refuse();
		owner.admissionUncertain = true;
		owner.folder = admitDataFolder(owner.destination, { nativeBinding: input.nativeBinding });
		owner.run = await directoryIdentity(owner.folder.runPath);
		owner.lock = await fs.lstat(path.join(owner.folder.runPath, "hub.lock"), { bigint: true });
		if (!regular(owner.lock) || owner.lock.size !== 0n) refuse();
		owner.admissionUncertain = false;
		await assertRoot(owner);
		const names = await fs.readdir(owner.destination);
		if (names.length !== 1 || names[0] !== "run") refuse();
		owner.stagePath = path.join(owner.destination, `.backup-image-restore-${randomUUID()}`);
		owner.stageUncertain = true;
		await fs.mkdir(owner.stagePath, { mode: 0o700 });
		owner.stage = await directoryIdentity(owner.stagePath);
		await assertStage(owner);
		const imagePath = path.join(owner.stagePath, "image.db");
		const imageHandle = await fs.open(imagePath, "wx+", 0o600);
		owner.image = {
			path: imagePath,
			handle: imageHandle,
			identity: undefined,
			closed: false,
			closeUncertain: false,
			closeAttempt: undefined,
			retryDescriptor: undefined,
		};
		owner.image.identity = await imageHandle.stat({ bigint: true });
		if (!regular(owner.image.identity) || owner.image.identity.size !== 0n) refuse();
		owner.stageUncertain = false;
		await assertImage(owner);
		await body(owner.source, header, owner);
		await assertImage(owner);
		await imageHandle.sync();
		await assertImage(owner);
		if ((await imageHandle.stat({ bigint: true })).size !== BigInt(header.byteLength)) refuse();
		const staged = await fs.readdir(owner.stagePath);
		if (staged.length !== 1 || staged[0] !== "image.db") refuse();
		await assertImage(owner);
		// A rejecting constructor may retain original native initialization internally. Reserve
		// that uncertainty before it starts; no rejected promise/error proves physical closure.
		owner.storeUncertain = true;
		const image = owner.image;
		const key = owner.key;
		if (!image || !key) refuse();
		owner.store = new HubStore({
			filename: image.path,
			nativeBinding: input.nativeBinding,
			masterKey: key,
			migrations: HUB_NAMESPACES,
		});
		owner.storeUncertain = false;
		await assertImage(owner);
		validateStore(owner, header);
		await assertImage(owner);
		const readyImage = await capturePreparedImage(owner);
		const token = Object.freeze({}) as NativeBackupPreparation;
		preparations.set(token, {
			owner,
			header,
			image: readyImage,
			state: "READY",
			operation: undefined,
			closing: undefined,
		});
		retained = true;
		return token;
	} catch {
		throw new NativeBackupRestoreError();
	} finally {
		encoded?.fill(0);
		input.code.fill(0);
		if (!retained) {
			header?.capsule.fill(0);
			header?.binding.fill(0);
			if (owner) await retireOwner(owner);
		}
	}
}

/** Validates and holds one private encrypted image without resetting or publishing it. */
export async function prepareNativeBackup(raw: unknown): Promise<NativeBackupPreparation> {
	return prepareCaptured(capturePreparation(raw));
}
