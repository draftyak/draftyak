import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { PinService } from "../../src/identity/pin.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../../src/store/store.ts";
import {
	AuthorityResetFixture,
	NEW_PIN,
	OLD_PIN,
	OWNER,
	requiredAuthorityResetBinding,
} from "./authority-reset-fixture.ts";

type RestoreApi = typeof import("../../src/recovery/backup-restore.ts");
let api: RestoreApi;
const fixtures: AuthorityResetFixture[] = [];
const wholeBodies = new Set<Promise<void>>();
const gateReleases = new Set<() => void>();
const apply = Reflect.apply;
const originalWrite = HubStore.prototype.write;
const originalVerify = AuditChain.prototype.verify;
const originalClose = HubStore.prototype.close;
let beforeRealWrite: ((store: HubStore) => void) | undefined;
let afterRealWrite: ((store: HubStore, tx: SqlTransaction) => void) | undefined;
let afterRealVerify: ((db: SqlReader) => void) | undefined;
let beforeRealClose: ((store: HubStore) => void) | undefined;
let restoreWriteObserver: (() => void) | undefined;
let restoreAuditObserver: (() => void) | undefined;
let restoreCloseObserver: (() => void) | undefined;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function retained<Arguments extends unknown[]>(body: (...arguments_: Arguments) => Promise<void>) {
	return (...arguments_: Arguments): Promise<void> => {
		// Reserve the WHOLE original body before any fixture, producer or finally can run.
		const promise = Promise.resolve().then(() => body(...arguments_));
		wholeBodies.add(promise);
		void promise.then(
			() => wholeBodies.delete(promise),
			() => wholeBodies.delete(promise),
		);
		return promise;
	};
}
async function joinBodiesBeforeFixtureClose(): Promise<void> {
	for (const release of [...gateReleases]) release();
	// A timeout does not cancel an async callback. Its original finally must settle first.
	while (wholeBodies.size) await Promise.allSettled([...wholeBodies]);
}
async function fixedRefusal(promise: Promise<unknown>): Promise<void> {
	await expect(promise).rejects.toMatchObject({
		name: "NativeBackupRestoreError",
		code: "BACKUP_RESTORE_UNAVAILABLE",
		message: "Backup restore unavailable",
	});
}

beforeAll(async () => {
	// Preserve the actual original Store/transaction. Only a post-work fault is injected.
	const writeObserver = vi.spyOn(HubStore.prototype, "write").mockImplementation(function <T>(
		this: HubStore,
		work: (tx: SqlTransaction) => T,
	): T {
		beforeRealWrite?.(this);
		return apply(originalWrite, this, [
			(tx: SqlTransaction) => {
				const result = work(tx);
				afterRealWrite?.(this, tx);
				return result;
			},
		]) as T;
	});
	restoreWriteObserver = () => {
		writeObserver.mockRestore();
	};
	const auditObserver = vi.spyOn(AuditChain.prototype, "verify").mockImplementation(function (
		this: AuditChain,
		db: SqlReader,
	): ReturnType<typeof originalVerify> {
		const result = apply(originalVerify, this, [db]) as ReturnType<typeof originalVerify>;
		afterRealVerify?.(db);
		return result;
	});
	restoreAuditObserver = () => {
		auditObserver.mockRestore();
	};
	const closeObserver = vi.spyOn(HubStore.prototype, "close").mockImplementation(function (
		this: HubStore,
	): void {
		try {
			beforeRealClose?.(this);
		} finally {
			apply(originalClose, this, []);
		}
	});
	restoreCloseObserver = () => {
		closeObserver.mockRestore();
	};
	api = await import("../../src/recovery/backup-restore.ts");
});
afterEach(async () => {
	await joinBodiesBeforeFixtureClose();
	afterRealWrite = undefined;
	afterRealVerify = undefined;
	beforeRealWrite = undefined;
	beforeRealClose = undefined;
	const results = await Promise.allSettled(fixtures.map((fixture) => fixture.close()));
	const failed = results.find((result) => result.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	fixtures.length = 0;
});
afterAll(async () => {
	try {
		await joinBodiesBeforeFixtureClose();
		const results = await Promise.allSettled(fixtures.map((fixture) => fixture.close()));
		const failed = results.find((result) => result.status === "rejected");
		if (failed?.status === "rejected") throw failed.reason;
	} finally {
		restoreCloseObserver?.();
		restoreAuditObserver?.();
		restoreWriteObserver?.();
	}
});

async function prepared() {
	if (fixtures.length) throw new Error("Previous fixture cleanup remains incomplete");
	const fixture = await AuthorityResetFixture.create(requiredAuthorityResetBinding(), fixtures);
	const originalOpen = fs.open;
	const observer = vi
		.spyOn(fs, "open")
		.mockImplementation(async (...arguments_: Parameters<typeof fs.open>) => {
			const handle = (await apply(originalOpen, fs, arguments_)) as FileHandle;
			const filename = arguments_[0];
			if (
				typeof filename === "string" &&
				path.basename(filename) === "image.db" &&
				path.dirname(path.dirname(filename)) === fixture.destination
			) {
				fixture.imageHandle = handle;
				fixture.imagePath = filename;
			}
			return handle;
		});
	try {
		const token = await api.prepareNativeBackup({
			artifactFile: fixture.artifactFile,
			destination: fixture.destination,
			recoveryCode: fixture.recoveryCode,
			nativeBinding: fixture.nativeBinding,
		});
		fixture.registerPreparation(() => api.closeNativeBackupPreparation(token));
		if (!fixture.imageHandle || !fixture.imagePath)
			throw new Error("Original image handle was not observed");
		return { fixture, token, image: fixture.imageHandle };
	} finally {
		observer.mockRestore();
	}
}

describe("prepared native backup authority reset", () => {
	it(
		"resets epoch, bootstrap and PIN while preserving identity and device history",
		retained(async () => {
			const { fixture, token } = await prepared();
			const before = fixture.before!;
			const destinationNames = await fs.readdir(fixture.destination);
			await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
			expect(pinAccepted).toBe(true);
			expect(state.epoch).toBe(before.epoch + 1);
			expect(state.bootstrap).toBe(0);
			expect(state.owner).toBe(OWNER);
			expect(state.pinVersion).toBe(before.pinVersion + 1);
			expect(state.failures).toBe(0);
			expect(state.lockedUntil).toBe(0);
			expect(state.pinDigest === before.pinDigest).toBe(false);
			expect(state.identityDigest).toBe(before.identityDigest);
			expect(state.devices).toEqual(before.devices);
			expect(state.devices.every((row) => row.confirmed_epoch !== state.epoch)).toBe(true);
			expect(state.auditSequence).toBeGreaterThan(before.auditSequence);
			expect((await fixture.readCopy(OLD_PIN)).pinAccepted).toBe(false);
			expect(await fs.readdir(fixture.destination)).toEqual(destinationNames);
		}),
	);

	it(
		"consumes a successful preparation once without a second PIN or epoch change",
		retained(async () => {
			const { fixture, token } = await prepared();
			await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const beforeReplay = (await fixture.readCopy()).state;
			await fixedRefusal(api.resetNativeBackupAuthority(token, "16180339"));
			expect((await fixture.readCopy()).state).toEqual(beforeReplay);
		}),
	);

	it(
		"refuses a concurrent second consumer without poisoning the genuine first job",
		retained(async () => {
			const { fixture, token } = await prepared();
			const first = fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const second = api.resetNativeBackupAuthority(token, "16180339");
			await fixedRefusal(second);
			await first;
			const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
			expect(pinAccepted).toBe(true);
			expect(state.epoch).toBe(fixture.before!.epoch + 1);
			expect(state.pinVersion).toBe(fixture.before!.pinVersion + 1);
		}),
	);

	it.each([
		["null", (): unknown => null],
		["plain object", (): unknown => ({})],
		["null prototype", (): unknown => Object.create(null)],
		["clone", (): unknown => Object.freeze({})],
		["proxy", (): unknown => new Proxy({}, {})],
	] as const)(
		"refuses foreign preparation DATA: %s",
		retained(async (_label: string, make: () => unknown) => {
			await fixedRefusal(api.resetNativeBackupAuthority(make(), NEW_PIN));
		}),
	);

	it(
		"joins the actual held image sync before close can erase or release resources",
		retained(async () => {
			const { fixture, token, image } = await prepared();
			let resetStore: HubStore | undefined,
				originalStoreCloses = 0;
			beforeRealWrite = (store) => {
				resetStore = store;
				beforeRealWrite = undefined;
			};
			beforeRealClose = (store) => {
				if (store === resetStore) originalStoreCloses++;
			};
			const entered = deferred<void>(),
				release = deferred<void>(),
				teardown = deferred<void>();
			const releaseGate = () => {
				release.resolve();
				teardown.resolve();
			};
			gateReleases.add(releaseGate);
			const originalSync = image.sync;
			const observer = vi.spyOn(image, "sync").mockImplementationOnce(async () => {
				entered.resolve();
				await release.promise;
				return apply(originalSync, image, []);
			});
			const reset = fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const resetOutcome = reset.then(
				() => true,
				() => false,
			);
			let close: Promise<void> | undefined,
				closed = false;
			try {
				await Promise.race([
					entered.promise,
					resetOutcome.then(() => {
						throw new Error("Original reset settled before image sync entry");
					}),
					teardown.promise.then(() => {
						throw new Error("Test teardown released image sync gate");
					}),
				]);
				close = fixture.track(api.closeNativeBackupPreparation(token));
				void close.then(
					() => {
						closed = true;
					},
					() => {},
				);
				await new Promise<void>((resolve) => {
					setImmediate(resolve);
				});
				expect(originalStoreCloses).toBe(0);
				expect(closed).toBe(false);
				expect(image.fd >= 0).toBe(true);
				expect((await image.stat()).isFile()).toBe(true);
			} finally {
				release.resolve();
				await Promise.allSettled([reset, ...(close ? [close] : [])]);
				observer.mockRestore();
				gateReleases.delete(releaseGate);
			}
			expect(await resetOutcome).toBe(false);
			await close;
			expect(originalStoreCloses).toBe(1);
			expect(image.fd).toBe(-1);
			expect(
				(await fs.readdir(fixture.destination)).some((name) =>
					name.startsWith(".backup-image-restore-"),
				),
			).toBe(false);
		}),
	);

	it(
		"refuses an actual image metadata change before starting the reset write",
		retained(async () => {
			const { fixture, token, image } = await prepared();
			const before = await image.stat({ bigint: true });
			await fs.utimes(fixture.imagePath!, new Date(Number(before.atimeMs)), new Date(0));
			const changed = await image.stat({ bigint: true });
			expect(changed.dev === before.dev && changed.ino === before.ino).toBe(true);
			expect(changed.mtimeNs !== before.mtimeNs || changed.ctimeNs !== before.ctimeNs).toBe(true);
			let writes = 0;
			afterRealWrite = () => {
				writes++;
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(writes).toBe(0);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
		}),
	);

	if (process.platform === "win32") {
		it(
			"Windows preserves the held image after rename denial and still resets its authority",
			retained(async () => {
				const { fixture, token, image } = await prepared();
				const filename = fixture.imagePath!,
					stage = path.dirname(filename),
					heldName = `${filename}.windows-denial`;
				const originalStage = await fs.lstat(stage, { bigint: true });
				const originalImage = await image.stat({ bigint: true });
				let renamed = false;
				let denial: unknown;
				try {
					await fs.rename(filename, heldName);
					renamed = true;
				} catch (error) {
					denial = error;
				}
				if (renamed) {
					// An unexpected success is restored by exact identity, then FAILS this case.
					const parent = await fs.lstat(stage, { bigint: true });
					const held = await fs.lstat(heldName, { bigint: true });
					if (
						!parent.isDirectory() ||
						parent.isSymbolicLink() ||
						parent.dev !== originalStage.dev ||
						parent.ino !== originalStage.ino ||
						!held.isFile() ||
						held.isSymbolicLink() ||
						held.dev !== originalImage.dev ||
						held.ino !== originalImage.ino
					)
						throw new Error("Unexpected Windows rename ownership changed");
					let absent = false;
					try {
						await fs.lstat(filename);
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") absent = true;
						else throw error;
					}
					if (!absent) throw new Error("Original image name remains occupied");
					await fs.rename(heldName, filename);
					const restored = await fs.lstat(filename, { bigint: true });
					if (restored.dev !== originalImage.dev || restored.ino !== originalImage.ino)
						throw new Error("Unexpected Windows rename restoration incomplete");
					throw new Error("Windows unexpectedly allowed the open-image rename");
				}
				const code = (denial as NodeJS.ErrnoException | undefined)?.code;
				expect(code === "EBUSY" || code === "EPERM").toBe(true);
				const currentStage = await fs.lstat(stage, { bigint: true });
				const named = await fs.lstat(filename, { bigint: true });
				const actual = await image.stat({ bigint: true });
				expect(currentStage.dev).toBe(originalStage.dev);
				expect(currentStage.ino).toBe(originalStage.ino);
				expect(named.dev === originalImage.dev && named.ino === originalImage.ino).toBe(true);
				expect(actual.dev === originalImage.dev && actual.ino === originalImage.ino).toBe(true);
				expect(image.fd >= 0).toBe(true);
				let heldNameAbsent = false;
				try {
					await fs.lstat(heldName);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ENOENT") heldNameAbsent = true;
					else throw error;
				}
				expect(heldNameAbsent).toBe(true);
				await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
				const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
				expect(pinAccepted).toBe(true);
				expect(state.epoch).toBe(fixture.before!.epoch + 1);
				expect(state.pinVersion).toBe(fixture.before!.pinVersion + 1);
				expect(state.bootstrap).toBe(0);
				console.info(JSON.stringify({ observation: "windows-open-image-filesystem-denial", code }));
			}),
		);
	} else {
		it(
			"refuses an actual image pathname replacement before starting the reset write",
			retained(async () => {
				const { fixture, token, image } = await prepared();
				const filename = fixture.imagePath!,
					stage = path.dirname(filename),
					heldStage = `${stage}.held-original`;
				const originalStage = await fs.lstat(stage, { bigint: true });
				const originalImage = await image.stat({ bigint: true });
				let stageMoved = false,
					replacementStage = false,
					replacementImage = false,
					bodyFailed = false;
				let bodyFailure: unknown;
				let replacementStageIdentity: BigIntStats | undefined;
				let replacementImageIdentity: BigIntStats | undefined;
				let writes = 0;
				afterRealWrite = () => {
					writes++;
				};
				try {
					// Keep the native database and original image FD alive; replace their namespace.
					await fs.rename(stage, heldStage);
					stageMoved = true;
					await fs.mkdir(stage, { mode: 0o700 });
					replacementStage = true;
					replacementStageIdentity = await fs.lstat(stage, { bigint: true });
					await fs.writeFile(filename, Buffer.from("synthetic replacement"), {
						flag: "wx",
						mode: 0o600,
					});
					replacementImage = true;
					replacementImageIdentity = await fs.lstat(filename, { bigint: true });
					const held = await fs.lstat(heldStage, { bigint: true });
					const named = await fs.lstat(stage, { bigint: true });
					const namedImage = await fs.lstat(filename, { bigint: true });
					const actual = await image.stat({ bigint: true });
					expect(held.dev === originalStage.dev && held.ino === originalStage.ino).toBe(true);
					expect(named.dev !== originalStage.dev || named.ino !== originalStage.ino).toBe(true);
					expect(namedImage.dev !== originalImage.dev || namedImage.ino !== originalImage.ino).toBe(
						true,
					);
					expect(actual.dev === originalImage.dev && actual.ino === originalImage.ino).toBe(true);
					expect(image.fd >= 0).toBe(true);
					await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
					expect(writes).toBe(0);
				} catch (error) {
					bodyFailed = true;
					bodyFailure = error;
				}
				const restorationFailures: unknown[] = [];
				let namespaceParked = false;
				try {
					if (replacementImage) {
						const parent = await fs.lstat(stage, { bigint: true });
						const named = await fs.lstat(filename, { bigint: true });
						if (
							!replacementStageIdentity ||
							!parent.isDirectory() ||
							parent.isSymbolicLink() ||
							parent.dev !== replacementStageIdentity.dev ||
							parent.ino !== replacementStageIdentity.ino ||
							!replacementImageIdentity ||
							!named.isFile() ||
							named.isSymbolicLink() ||
							named.dev !== replacementImageIdentity.dev ||
							named.ino !== replacementImageIdentity.ino
						)
							throw new Error("Replacement fixture image ownership changed");
						await fs.unlink(filename);
					}
				} catch (error) {
					restorationFailures.push(error);
					namespaceParked = true;
				}
				try {
					if (replacementStage && !namespaceParked) {
						const named = await fs.lstat(stage, { bigint: true });
						if (
							!replacementStageIdentity ||
							!named.isDirectory() ||
							named.isSymbolicLink() ||
							named.dev !== replacementStageIdentity.dev ||
							named.ino !== replacementStageIdentity.ino
						)
							throw new Error("Replacement fixture stage ownership changed");
						await fs.rmdir(stage);
					}
				} catch (error) {
					restorationFailures.push(error);
					namespaceParked = true;
				}
				if (stageMoved && !namespaceParked) {
					try {
						const held = await fs.lstat(heldStage, { bigint: true });
						if (
							!held.isDirectory() ||
							held.isSymbolicLink() ||
							held.dev !== originalStage.dev ||
							held.ino !== originalStage.ino
						)
							throw new Error("Original fixture stage identity changed");
						let absent = false;
						try {
							await fs.lstat(stage);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "ENOENT") absent = true;
							else throw error;
						}
						if (!absent) throw new Error("Original fixture stage name remains occupied");
						await fs.rename(heldStage, stage);
						const restored = await fs.lstat(stage, { bigint: true });
						const restoredImage = await fs.lstat(filename, { bigint: true });
						if (
							restored.dev !== originalStage.dev ||
							restored.ino !== originalStage.ino ||
							restoredImage.dev !== originalImage.dev ||
							restoredImage.ino !== originalImage.ino
						)
							throw new Error("Original fixture namespace restoration incomplete");
					} catch (error) {
						restorationFailures.push(error);
					}
				}
				afterRealWrite = undefined;
				if (restorationFailures.length)
					throw new AggregateError(
						bodyFailed ? [bodyFailure, ...restorationFailures] : restorationFailures,
						"Fixture namespace restoration failed",
					);
				if (bodyFailed) throw bodyFailure;
				await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
			}),
		);
	}

	it(
		"rolls back real epoch and PIN writes on a late transaction error and never retries",
		retained(async () => {
			const { fixture, token } = await prepared();
			let actualStore: HubStore | undefined;
			let changedInsideTransaction = false,
				writes = 0;
			afterRealWrite = (store, tx) => {
				actualStore = store;
				writes++;
				const epoch = tx.get<{ epoch: number }>(
					"SELECT epoch FROM main.device_authority WHERE singleton=1",
				);
				const pin = tx.get<{ version: number }>(
					"SELECT version FROM main.approval_pins WHERE user_id=?",
					[OWNER],
				);
				changedInsideTransaction =
					epoch?.epoch === fixture.before!.epoch + 1 &&
					pin?.version === fixture.before!.pinVersion + 1;
				throw new Error("Synthetic late transaction failure");
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(changedInsideTransaction).toBe(true);
			afterRealWrite = undefined;
			if (!actualStore) throw new Error("Original write was not observed");
			actualStore.checkpoint();
			const rolledBack = (await fixture.readCopy(OLD_PIN)).state;
			expect(rolledBack).toEqual(fixture.before);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
			expect(writes).toBe(1);
		}),
	);

	it(
		"rolls back when the original final audit verification reenters close",
		retained(async () => {
			const { fixture, token, image } = await prepared();
			let close: Promise<void> | undefined;
			let sawBothActualWrites = false;
			let resetStore: HubStore | undefined;
			let beforeNativeClose: { epoch: number | undefined; version: number | undefined } | undefined;
			beforeRealWrite = (store) => {
				resetStore = store;
				beforeRealWrite = undefined;
			};
			beforeRealClose = (store) => {
				if (store !== resetStore) return;
				beforeNativeClose = store.read((db) => ({
					epoch: db.get<{ epoch: number }>(
						"SELECT epoch FROM main.device_authority WHERE singleton=1",
					)?.epoch,
					version: db.get<{ version: number }>(
						"SELECT version FROM main.approval_pins WHERE user_id=?",
						[OWNER],
					)?.version,
				}));
			};
			afterRealVerify = (db) => {
				const authority = db.get<{ epoch: number }>(
					"SELECT epoch FROM main.device_authority WHERE singleton=1",
				);
				const pin = db.get<{ version: number }>(
					"SELECT version FROM main.approval_pins WHERE user_id=?",
					[OWNER],
				);
				if (
					authority?.epoch === fixture.before!.epoch + 1 &&
					pin?.version === fixture.before!.pinVersion + 1
				) {
					afterRealVerify = undefined;
					sawBothActualWrites = true;
					close = fixture.track(api.closeNativeBackupPreparation(token));
				}
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(sawBothActualWrites).toBe(true);
			if (!close) throw new Error("Original close was not invoked");
			await close;
			expect(beforeNativeClose).toEqual({
				epoch: fixture.before!.epoch,
				version: fixture.before!.pinVersion,
			});
			expect(image.fd).toBe(-1);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
		}),
	);

	it(
		"allows cleanup but not reset retry after the original PIN producer rejects",
		retained(async () => {
			const { fixture, token, image } = await prepared();
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, "not-a-pin")));
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
			await api.closeNativeBackupPreparation(token);
			expect(image.fd).toBe(-1);
			await api.closeNativeBackupPreparation(token);
		}),
	);

	it(
		"uses original reset operations even when their function call properties are shadowed",
		retained(async () => {
			const { fixture, token } = await prepared();
			const targets = [
				HubIdentity.loadExisting,
				PinService.prototype.prepareInitialization,
				HubStore.prototype.checkpoint,
				HubIdentity.prototype.lock,
				PinService.prototype.lock,
			];
			const saved = targets.map((target) => Object.getOwnPropertyDescriptor(target, "call"));
			let shadowCalls = 0;
			try {
				for (const target of targets)
					Object.defineProperty(target, "call", {
						configurable: true,
						value: () => {
							shadowCalls++;
							throw new Error("Synthetic call shadow");
						},
					});
				await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
				expect(shadowCalls).toBe(0);
			} finally {
				for (const [index, target] of targets.entries()) {
					const descriptor = saved[index];
					if (descriptor) Object.defineProperty(target, "call", descriptor);
					else Reflect.deleteProperty(target, "call");
				}
			}
			const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
			expect(pinAccepted).toBe(true);
			expect(state.epoch).toBe(fixture.before!.epoch + 1);
		}),
	);
});
