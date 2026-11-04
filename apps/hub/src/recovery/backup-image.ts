import { createHash } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import path from "node:path";
import { types } from "node:util";
import Database from "better-sqlite3-multiple-ciphers";
import { AuditChain } from "../audit/chain.ts";
import type { NativeDevicePeer } from "../authz/native-peer.ts";
import {
	assertNativeBackupExecutionCurrent,
	assertNativeBackupExecutionSigner,
} from "../identity/backup-operations.ts";
import { MasterKey } from "../kernel/master-key.ts";
import { HUB_NAMESPACES } from "../kernel/namespaces.ts";
import { assertNativeBackupImagesOwner, nativeBackupImages } from "../lifecycle/session.ts";
import { DATABASE_FILE_SUFFIXES, flushDirectory } from "../store/durable-file.ts";
import { captureMigrationPlan, migrate } from "../store/migrator.ts";
import { assertSettings, type SqliteDatabase } from "../store/open.ts";
import { HubStore, type SqlReader } from "../store/store.ts";
import { copyBackupImageRows } from "./backup-image-copy.ts";
export const NATIVE_BACKUP_IMAGE_CHUNK_BYTES = 65_536;
export class NativeBackupImageError extends Error {
	readonly code = "BACKUP_IMAGE_UNAVAILABLE";
	constructor() {
		super("Backup image unavailable");
		this.name = "NativeBackupImageError";
	}
}
export interface NativeBackupImage {
	readonly byteLength: number;
	readonly sha256: string;
	bytes(peer: unknown): AsyncIterable<Uint8Array>;
	close(): Promise<void>;
}
export interface NativeBackupImages {
	create(execution: unknown, peer: unknown): Promise<NativeBackupImage>;
	close(): Promise<void>;
}
export interface NativeBackupImagesHandle {
	get(): NativeBackupImages;
	beginClose(): void;
	close(): Promise<void>;
}
const original = Object.freeze({
	write: HubStore.prototype.write,
	assertKey: HubStore.prototype.assertMasterKey,
	derive: MasterKey.prototype.derive,
	verify: AuditChain.prototype.verify,
	close: Database.prototype.close,
});
const bases = ["template.db", "image.db"];
const names = new Set(
	bases.flatMap((name) => DATABASE_FILE_SUFFIXES.map((suffix) => name + suffix)),
);
function unavailable(): never {
	throw new NativeBackupImageError();
}
function same(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.ino > 0n;
}
function privateFile(stat: BigIntStats): void {
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		stat.ino <= 0n ||
		stat.nlink !== 1n ||
		(process.platform !== "win32" &&
			((stat.mode & 0o777n) !== 0o600n || stat.uid !== BigInt(process.geteuid?.() ?? -1)))
	)
		unavailable();
}
function reader(db: SqliteDatabase): SqlReader {
	return {
		get: <T>(sql: string, bindings: readonly import("../store/store.ts").SqlValue[] = []) =>
			db.prepare(sql).get(...bindings) as T | undefined,
		all: <T>(sql: string, bindings: readonly import("../store/store.ts").SqlValue[] = []) =>
			db.prepare(sql).all(...bindings) as T[],
	};
}
/** A new private destination only; its connection is retained before any configuration can fail. */
class ImageFiles {
	directory = "";
	born?: BigIntStats;
	readonly files = new Map<string, BigIntStats>();
	readonly reservations = new Map<string, FileHandle>();
	readonly databases = new Set<SqliteDatabase>();
	held?: FileHandle;
	closing?: Promise<void>;
	closed = false;
	directoryRemoved = false;
	readonly folder: string;
	readonly assertHeld: () => void;
	readonly assertActive: () => void;
	constructor(folder: string, assertHeld: () => void, assertActive: () => void) {
		this.folder = folder;
		this.assertHeld = assertHeld;
		this.assertActive = assertActive;
	}
	initialize(): void {
		this.assertActive();
		this.directory = mkdtempSync(path.join(this.folder, ".backup-image-"));
		this.born = lstatSync(this.directory, { bigint: true });
		if (process.platform !== "win32") chmodSync(this.directory, 0o700);
		this.check();
		flushDirectory(this.folder);
	}
	check(): void {
		this.assertHeld();
		const stat = lstatSync(this.directory, { bigint: true });
		if (
			!this.born ||
			!stat.isDirectory() ||
			stat.isSymbolicLink() ||
			!same(stat, this.born) ||
			path.dirname(this.directory) !== this.folder ||
			realpathSync.native(this.directory) !== this.directory ||
			(process.platform !== "win32" &&
				((stat.mode & 0o777n) !== 0o700n || stat.uid !== BigInt(process.geteuid?.() ?? -1)))
		)
			unavailable();
	}
	capture(): void {
		this.check();
		for (const name of readdirSync(this.directory)) {
			if (!names.has(name)) unavailable();
			const stat = lstatSync(path.join(this.directory, name), { bigint: true });
			privateFile(stat);
			const previous = this.files.get(name);
			if (previous && !same(previous, stat)) unavailable();
			this.files.set(name, stat);
		}
	}
	/** The only key is the original Session capture, never a caller or a restored copy. */
	async create(
		name: "template.db" | "image.db",
		key: MasterKey,
		nativeBinding: string,
	): Promise<SqliteDatabase> {
		this.assertActive();
		this.check();
		const filename = path.join(this.directory, name);
		const reservation = await open(filename, "wx+", 0o600);
		this.reservations.set(name, reservation);
		const identity = await reservation.stat({ bigint: true });
		// Bind ownership from the retained descriptor before a closing fence can refuse work.
		this.files.set(name, identity);
		privateFile(identity);
		const stat = lstatSync(filename, { bigint: true });
		if (!same(stat, identity)) unavailable();
		this.assertActive();
		if (name === "image.db") this.held = reservation;
		const bytes = original.derive.call(key, "db");
		try {
			const db = new Database(filename, { nativeBinding, fileMustExist: true });
			this.databases.add(db);
			db.pragma("cipher = 'chacha20'");
			db.key(bytes);
			db.prepare("SELECT count(*) FROM sqlite_schema").get();
			db.exec(
				"PRAGMA fullfsync = ON; PRAGMA checkpoint_fullfsync = ON; PRAGMA temp_store = MEMORY; PRAGMA auto_vacuum = INCREMENTAL; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON; PRAGMA recursive_triggers = ON; PRAGMA secure_delete = ON; PRAGMA trusted_schema = OFF;",
			);
			assertSettings(db);
			this.capture();
			this.assertActive();
			return db;
		} finally {
			bytes.fill(0);
		}
	}
	closeDatabase(db: SqliteDatabase): void {
		try {
			if (db.open !== false) original.close.call(db);
		} catch {
			/* State below decides after-effect errors. */
		}
		if (db.open !== false) unavailable();
		this.databases.delete(db);
	}
	async checkHeld(): Promise<void> {
		this.capture();
		const stat = await this.held?.stat({ bigint: true });
		const named = this.files.get("image.db");
		if (!stat || !named || !same(stat, named)) unavailable();
		privateFile(stat);
		if (!same(lstatSync(path.join(this.directory, "image.db"), { bigint: true }), stat))
			unavailable();
	}
	close(): Promise<void> {
		if (this.closed) return Promise.resolve();
		if (this.closing) return this.closing;
		const task = (async () => {
			for (const db of [...this.databases]) this.closeDatabase(db);
			for (const [name, file] of this.reservations) {
				// A retained invalid descriptor has no observed successful close.
				if (file.fd === -1) unavailable();
				if (!this.files.has(name)) {
					const owned = await file.stat({ bigint: true });
					if (!owned.isFile() || owned.ino <= 0n) unavailable();
					this.files.set(name, owned);
				}
				await file.close();
				if (file.fd !== -1) unavailable();
				this.reservations.delete(name);
				if (this.held === file) this.held = undefined;
			}
			if (this.directoryRemoved) {
				this.assertHeld();
				flushDirectory(this.folder);
			}
			if (!this.directory || this.directoryRemoved) {
				this.closed = true;
				return;
			}
			this.capture();
			for (const [name, expected] of this.files) {
				const filename = path.join(this.directory, name);
				let stat: BigIntStats;
				try {
					stat = lstatSync(filename, { bigint: true });
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") {
						this.files.delete(name);
						continue;
					}
					throw error;
				}
				privateFile(stat);
				if (!same(stat, expected)) unavailable();
				unlinkSync(filename);
				this.files.delete(name);
			}
			this.check();
			flushDirectory(this.directory);
			rmdirSync(this.directory);
			this.directoryRemoved = true;
			flushDirectory(this.folder);
			this.closed = true;
		})();
		this.closing = task;
		void task.catch(() => {
			if (this.closing === task) this.closing = undefined;
		});
		return task;
	}
}
type Stream = () => Promise<void>;
export function openNativeBackupImages(session: unknown): NativeBackupImages {
	try {
		return nativeBackupImages(session);
	} catch {
		return unavailable();
	}
}
/** Inert captures. The original Session must cache this exact handle before get can succeed. */
export function createNativeBackupImagesHandle(
	session: unknown,
	store: HubStore,
	masterKey: MasterKey,
	audit: AuditChain,
	folder: string,
	nativeBinding: string,
): NativeBackupImagesHandle {
	let phase: "open" | "closing" | "closed" = "open";
	let handle: NativeBackupImagesHandle;
	let closing: Promise<void> | undefined;
	const pending = new Set<Promise<unknown>>();
	const resources = new Set<ImageFiles>();
	const streams = new Set<Stream>();
	const used = new WeakSet<object>();
	const held = (): void => {
		assertNativeBackupImagesOwner(session, handle, "held");
	};
	const active = (): void => {
		try {
			if (phase !== "open") unavailable();
			assertNativeBackupImagesOwner(session, handle, "open");
			original.assertKey.call(store, masterKey);
		} catch {
			unavailable();
		}
	};
	const signer = (execution: unknown, peer: unknown): void => {
		active();
		if (!peer || typeof peer !== "object" || types.isProxy(peer)) unavailable();
		assertNativeBackupExecutionCurrent(execution, session);
		assertNativeBackupExecutionSigner(execution, session, peer as NativeDevicePeer);
		active();
	};
	const closeFiles = async (files: ImageFiles): Promise<void> => {
		await files.close();
		resources.delete(files);
	};
	const materialize = async (execution: unknown, peer: unknown): Promise<NativeBackupImage> => {
		let files: ImageFiles | undefined;
		try {
			signer(execution, peer);
			if (
				!execution ||
				typeof execution !== "object" ||
				types.isProxy(execution) ||
				used.has(execution)
			)
				unavailable();
			used.add(execution);
			files = new ImageFiles(folder, held, () => signer(execution, peer));
			resources.add(files);
			files.initialize();
			const template = await files.create("template.db", masterKey, nativeBinding);
			signer(execution, peer);
			for (const [namespace, directory] of Object.entries(HUB_NAMESPACES)) {
				await migrate(template, namespace, captureMigrationPlan(directory));
				files.capture();
				signer(execution, peer);
			}
			const destination = await files.create("image.db", masterKey, nativeBinding);
			signer(execution, peer);
			original.write.call(store, (source) => {
				original.verify.call(audit, source);
				copyBackupImageRows(source, destination, reader(template));
			});
			signer(execution, peer);
			original.verify.call(audit, reader(destination));
			assertSettings(destination);
			if (
				(destination.pragma("quick_check", { simple: true }) as string) !== "ok" ||
				(destination.pragma("foreign_key_check") as unknown[]).length !== 0
			)
				unavailable();
			for (const db of [template, destination]) {
				const result = db.pragma("wal_checkpoint(TRUNCATE)") as { busy: number }[];
				if (result[0]?.busy !== 0) unavailable();
				files.closeDatabase(db);
			}
			files.capture();
			await files.checkHeld();
			signer(execution, peer);
			const imageFile = files.held;
			if (!imageFile) unavailable();
			const owned = files;
			await imageFile.sync();
			await files.checkHeld();
			flushDirectory(files.directory);
			const info = await imageFile.stat({ bigint: true });
			const byteLength = Number(info.size);
			if (!Number.isSafeInteger(byteLength) || byteLength <= 0) unavailable();
			const hash = createHash("sha256");
			let stopped = false;
			const check = (currentPeer: unknown): void => {
				if (stopped) unavailable();
				signer(execution, currentPeer);
				if (stopped) unavailable();
			};
			const readChunk = async (
				buffer: Buffer,
				offset: number,
				currentPeer: unknown,
			): Promise<number> => {
				check(currentPeer);
				await owned.checkHeld();
				check(currentPeer);
				const length = Math.min(buffer.length, byteLength - offset);
				const { bytesRead } = await imageFile.read(buffer, 0, length, offset);
				await owned.checkHeld();
				check(currentPeer);
				if (bytesRead <= 0) unavailable();
				return bytesRead;
			};
			const buffer = Buffer.alloc(NATIVE_BACKUP_IMAGE_CHUNK_BYTES);
			try {
				for (let offset = 0; offset < byteLength; ) {
					const bytesRead = await readChunk(buffer, offset, peer);
					hash.update(buffer.subarray(0, bytesRead));
					offset += bytesRead;
				}
			} finally {
				buffer.fill(0);
			}
			const sha256 = hash.digest("hex");
			if ((await imageFile.stat({ bigint: true })).size !== info.size) unavailable();
			signer(execution, peer);
			let started = false;
			const ownedStreams = new Set<Stream>();
			const closeImage = (): Promise<void> => {
				stopped = true;
				return Promise.allSettled([...ownedStreams].map((stop) => stop()))
					.then((results) => {
						if (results.some((result) => result.status === "rejected")) unavailable();
						return closeFiles(owned);
					})
					.catch(unavailable);
			};
			return Object.freeze({
				byteLength,
				sha256,
				bytes(finalPeer: unknown): AsyncIterable<Uint8Array> {
					try {
						if (stopped || started) unavailable();
						signer(execution, finalPeer);
						started = true;
						const deliveries = new Set<Promise<void>>();
						let finished = false;
						const forget = (): void => {
							if (finished && deliveries.size === 0) {
								streams.delete(stream);
								ownedStreams.delete(stream);
							}
						};
						const iterator = (async function* () {
							const buffer = Buffer.alloc(NATIVE_BACKUP_IMAGE_CHUNK_BYTES);
							const digest = createHash("sha256");
							try {
								for (let offset = 0; offset < byteLength; ) {
									const bytesRead = await readChunk(buffer, offset, finalPeer);
									check(finalPeer);
									digest.update(buffer.subarray(0, bytesRead));
									offset += bytesRead;
									yield Buffer.from(buffer.subarray(0, bytesRead));
								}
								const finalSize = (await imageFile.stat({ bigint: true })).size;
								check(finalPeer);
								if (digest.digest("hex") !== sha256 || finalSize !== info.size) unavailable();
							} catch {
								throw new NativeBackupImageError();
							} finally {
								buffer.fill(0);
								finished = true;
								forget();
							}
						})();
						const stream: Stream = async () => {
							stopped = true;
							try {
								await iterator.return();
								finished = true;
							} finally {
								await Promise.allSettled([...deliveries]);
								forget();
							}
						};
						streams.add(stream);
						ownedStreams.add(stream);
						const delivery: AsyncIterator<Uint8Array, void> = Object.freeze({
							async next(): Promise<IteratorResult<Uint8Array, void>> {
								const joined = Promise.withResolvers<void>();
								deliveries.add(joined.promise);
								try {
									check(finalPeer);
									const result = await iterator.next();
									check(finalPeer);
									return result;
								} catch {
									await iterator.return().catch(() => {});
									throw new NativeBackupImageError();
								} finally {
									joined.resolve();
									deliveries.delete(joined.promise);
									forget();
								}
							},
							async return(): Promise<IteratorResult<Uint8Array, void>> {
								await stream();
								return { done: true, value: undefined };
							},
						});
						return { [Symbol.asyncIterator]: () => delivery };
					} catch {
						return unavailable();
					}
				},
				close: closeImage,
			});
		} catch {
			if (files) await closeFiles(files).catch(() => unavailable());
			throw new NativeBackupImageError();
		}
	};
	const beginClose = (): void => {
		if (phase === "open") phase = "closing";
	};
	const close = (): Promise<void> => {
		beginClose();
		if (phase === "closed") return Promise.resolve();
		if (closing) return closing;
		const task = (async () => {
			await Promise.allSettled([...pending]);
			const results = await Promise.allSettled([...streams].map((stop) => stop()));
			results.push(...(await Promise.allSettled([...resources].map(closeFiles))));
			if (results.some((result) => result.status === "rejected")) unavailable();
			phase = "closed";
		})();
		closing = task;
		void task.catch(() => {
			if (closing === task) closing = undefined;
		});
		return task;
	};
	const facade: NativeBackupImages = Object.freeze({
		async create(execution: unknown, peer: unknown): Promise<NativeBackupImage> {
			active();
			const task = Promise.resolve().then(() => materialize(execution, peer));
			pending.add(task);
			void task.finally(() => pending.delete(task)).catch(() => {});
			return task;
		},
		close,
	});
	handle = Object.freeze({
		get() {
			active();
			return facade;
		},
		beginClose,
		close,
	});
	return handle;
}
