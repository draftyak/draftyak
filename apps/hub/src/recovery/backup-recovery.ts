import { MasterKey } from "../kernel/master-key.ts";
import { assertNativeBackupRecoveryOwner, nativeBackupRecovery } from "../lifecycle/session.ts";
import { HubStore, type SqlReader } from "../store/store.ts";
import { createRecoveryBinding, verifyRecoveryBinding } from "./backup-bindings.ts";
import { captureRecoveryCapsule } from "./backup-capsule.ts";
import { RecoveryCapsuleFileWrite, readRecoveryCapsuleFile } from "./backup-file.ts";
import { openRecoveryBytes } from "./recovery-code.ts";

class RecoveryError extends Error {
	readonly code: "RECOVERY_UNAVAILABLE" = "RECOVERY_UNAVAILABLE";
	constructor() {
		super("Recovery unavailable");
	}
}

export interface NativeBackupRecovery {
	enroll(code: unknown): Promise<void>;
	adopt(code: unknown): Promise<void>;
	readCapsule(): Promise<Buffer>;
	lock(): void;
	close(): Promise<void>;
}

/** Internal lifetime handle. Only the original Session's cached instance can publish a facade. */
export interface NativeBackupRecoveryHandle {
	get(): NativeBackupRecovery;
	beginClose(): void;
	close(): Promise<void>;
}

const original = Object.freeze({
	read: HubStore.prototype.read,
	write: HubStore.prototype.write,
	assertKey: HubStore.prototype.assertMasterKey,
	wrap: MasterKey.prototype.wrapRecovery,
	destroy: MasterKey.prototype.destroy,
	writeFile: RecoveryCapsuleFileWrite.prototype.write,
	preserveFile: RecoveryCapsuleFileWrite.prototype.preserve,
	closeFile: RecoveryCapsuleFileWrite.prototype.close,
});
const BINDING =
	"SELECT CASE WHEN typeof(binding)='blob' AND length(binding)=69 THEN binding ELSE NULL END AS binding FROM main.native_backup_recovery WHERE singleton=1";

/** Obtains the original Session's facade, never a caller-constructed service or key proof. */
export function openNativeBackupRecovery(session: unknown): NativeBackupRecovery {
	try {
		return nativeBackupRecovery(session);
	} catch {
		throw new RecoveryError();
	}
}

/** Inert capture only; get() requires this exact handle in the original private Session record. */
export function createNativeBackupRecoveryHandle(
	session: unknown,
	store: HubStore,
	masterKey: MasterKey,
	folder: string,
): NativeBackupRecoveryHandle {
	const pending = new Set<Promise<unknown>>();
	const writers = new Set<RecoveryCapsuleFileWrite>();
	const fileClosings = new Set<Promise<void>>();
	let phase: "open" | "closing" | "closed" = "open";
	let busy = false;
	let cleanupBlocked = false;
	let closing: Promise<void> | undefined;
	let handle: NativeBackupRecoveryHandle;

	const active = (): void => {
		try {
			if (phase !== "open" || cleanupBlocked) throw new RecoveryError();
			assertNativeBackupRecoveryOwner(session, handle);
		} catch {
			throw new RecoveryError();
		}
	};
	const row = (db: SqlReader): { binding: unknown } | undefined =>
		db.get<{ binding: unknown }>(BINDING);
	const readRow = (): { binding: unknown } | undefined =>
		original.read.call(store, row) as { binding: unknown } | undefined;
	const absent = (): void => {
		if (readRow() !== undefined) throw new RecoveryError();
	};
	const exactFile = (expected: Buffer): void => {
		const actual = readRecoveryCapsuleFile(folder);
		try {
			if (!actual.equals(expected)) throw new RecoveryError();
		} finally {
			actual.fill(0);
		}
	};
	const verified = (): Buffer => {
		active();
		const capsule = readRecoveryCapsuleFile(folder);
		try {
			const current = readRow();
			if (!current || !verifyRecoveryBinding(masterKey, capsule, current.binding))
				throw new RecoveryError();
			active();
			return capsule;
		} catch {
			capsule.fill(0);
			throw new RecoveryError();
		}
	};
	const closeFile = (writer: RecoveryCapsuleFileWrite): Promise<void> => {
		let close: Promise<void>;
		try {
			close = original.closeFile.call(writer);
		} catch {
			close = Promise.reject(new RecoveryError());
		}
		const joined = close.then(() => {
			writers.delete(writer);
		});
		fileClosings.add(joined);
		void joined.then(
			() => {
				fileClosings.delete(joined);
			},
			() => {
				fileClosings.delete(joined);
			},
		);
		return joined;
	};

	// Register the whole promise before invoking work, which captures code synchronously at entry.
	const operation = <T>(work: () => Promise<T>): Promise<T> => {
		if (phase !== "open" || cleanupBlocked || busy) return Promise.reject(new RecoveryError());
		const settled = Promise.withResolvers<T>();
		pending.add(settled.promise);
		busy = true;
		let running: Promise<T>;
		try {
			active();
			running = work();
		} catch {
			running = Promise.reject(new RecoveryError());
		}
		void (async () => {
			let result: T | undefined;
			try {
				const completed = await running;
				result = completed;
				active();
				settled.resolve(completed);
			} catch {
				if (Buffer.isBuffer(result)) result.fill(0);
				settled.reject(new RecoveryError());
			} finally {
				busy = false;
				pending.delete(settled.promise);
			}
		})();
		return settled.promise;
	};
	const insert = (capsule: Buffer, binding: Buffer, writer?: RecoveryCapsuleFileWrite): void => {
		active();
		original.write.call(store, (tx) => {
			active();
			if (row(tx) !== undefined) throw new RecoveryError();
			exactFile(capsule);
			// From here a commit can be uncertain: this writer must never unlink the capsule later.
			if (writer) original.preserveFile.call(writer);
			tx.run("INSERT INTO main.native_backup_recovery(singleton,binding) VALUES(1,?)", [binding]);
			active();
		});
		const checked = verified();
		try {
			if (!checked.equals(capsule)) throw new RecoveryError();
		} finally {
			checked.fill(0);
		}
	};
	const enroll = (code: unknown): Promise<void> =>
		operation(async () => {
			let capsule: Buffer | undefined, binding: Buffer | undefined;
			let writer: RecoveryCapsuleFileWrite | undefined;
			let failed = false;
			try {
				absent();
				const wrapped = original.wrap.call(masterKey, code);
				try {
					capsule = captureRecoveryCapsule(wrapped);
				} finally {
					wrapped.fill(0);
				}
				binding = createRecoveryBinding(masterKey, capsule);
				active();
				writer = new RecoveryCapsuleFileWrite(folder, capsule);
				writers.add(writer);
				await original.writeFile.call(writer);
				active();
				insert(capsule, binding, writer);
			} catch {
				failed = true;
			} finally {
				try {
					if (writer) await closeFile(writer);
				} catch {
					cleanupBlocked = true;
					failed = true;
				} finally {
					capsule?.fill(0);
					binding?.fill(0);
				}
			}
			if (failed) throw new RecoveryError();
		});
	const adopt = (code: unknown): Promise<void> =>
		operation(async () => {
			let capsule: Buffer | undefined,
				binding: Buffer | undefined,
				recovered: MasterKey | undefined;
			try {
				absent();
				capsule = readRecoveryCapsuleFile(folder);
				recovered = openRecoveryBytes(capsule, code);
				original.assertKey.call(store, recovered);
				active();
				binding = createRecoveryBinding(masterKey, capsule);
				insert(capsule, binding);
			} finally {
				try {
					if (recovered) original.destroy.call(recovered);
				} finally {
					capsule?.fill(0);
					binding?.fill(0);
				}
			}
		});
	const beginClose = (): void => {
		if (phase === "closed") return;
		phase = "closing";
		for (const writer of writers) void closeFile(writer);
	};
	const close = (): Promise<void> => {
		if (closing) return closing;
		if (phase === "closed") return Promise.resolve();
		const settled = Promise.withResolvers<void>();
		closing = settled.promise;
		beginClose();
		void (async () => {
			try {
				await Promise.allSettled([...pending]);
				const results = await Promise.allSettled([...writers].map(closeFile));
				await Promise.allSettled([...fileClosings]);
				if (writers.size || results.some((result) => result.status === "rejected"))
					throw new RecoveryError();
				phase = "closed";
				settled.resolve();
			} catch {
				closing = undefined;
				settled.reject(new RecoveryError());
			}
		})();
		return settled.promise;
	};
	const facade: NativeBackupRecovery = Object.freeze({
		enroll,
		adopt,
		readCapsule: (): Promise<Buffer> => operation(async () => verified()),
		lock: beginClose,
		close,
	});
	handle = Object.freeze({
		get: (): NativeBackupRecovery => {
			active();
			return facade;
		},
		beginClose,
		close,
	});
	return handle;
}
