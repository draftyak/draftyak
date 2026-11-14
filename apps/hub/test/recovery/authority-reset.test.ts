import type { BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { CredentialVault } from "../../src/credentials/vault.ts";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { PinService } from "../../src/identity/pin.ts";
import { NativeOutboxProposals } from "../../src/outbox/propose.ts";
import { ApprovalRestoreError, NativeApprovalRestore } from "../../src/outbox/restore-approvals.ts";
import { SendTicketStorage } from "../../src/outbox/ticket-storage.ts";
import { HubStore, type SqlReader, type SqlTransaction } from "../../src/store/store.ts";
import {
	APPROVED_PROPOSAL,
	ARCHIVED_SEND_STATES,
	type AuthorityArchiveOptions,
	AuthorityResetFixture,
	CONSUMED_STORED_APPROVAL,
	EXPIRED_PENDING_PROPOSAL,
	FRESH_PENDING_PROPOSAL,
	FULL_CHAT_ACCOUNT,
	FULL_EMAIL_ACCOUNT,
	IN_FLIGHT_PROPOSALS,
	LIVE_STORED_APPROVAL,
	NEW_PIN,
	OLD_PIN,
	OWNER,
	READ_ONLY_ACCOUNT,
	requiredAuthorityResetBinding,
	SCHEDULED_PROPOSAL,
	VOIDED_STORED_APPROVAL,
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
const originalProposalDestroy = NativeOutboxProposals.prototype.destroy;
const originalRevisionDestroy = NativeDraftRevisions.prototype.destroy;
const originalApprovalStorageDestroy = NativeApprovalRestore.prototype.destroy;
const originalTicketStorageDestroy = SendTicketStorage.prototype.destroy;
const originalVaultDrain = CredentialVault.prototype.drain;
const originalAuditDestroy = AuditChain.prototype.destroy;
let beforeRealWrite: ((store: HubStore) => void) | undefined;
let afterRealWrite: ((store: HubStore, tx: SqlTransaction) => void) | undefined;
let afterRealWriteFailure: ((tx: SqlTransaction, error: unknown) => void) | undefined;
let afterRealVerify: ((db: SqlReader) => void) | undefined;
let beforeRealClose: ((store: HubStore) => void) | undefined;
let restoreWriteObserver: (() => void) | undefined;
let restoreAuditObserver: (() => void) | undefined;
let restoreCloseObserver: (() => void) | undefined;
let beforeProposalDestroy: ((target: NativeOutboxProposals) => void) | undefined;
let afterProposalDestroy: (() => void) | undefined;
let afterRevisionDestroy: (() => void) | undefined;
let restoreProposalObserver: (() => void) | undefined;
let restoreRevisionObserver: (() => void) | undefined;
let afterApprovalStorageDestroy: (() => void) | undefined;
let beforeApprovalStorageDestroy: ((target: NativeApprovalRestore) => void) | undefined;
let restoreApprovalStorageObserver: (() => void) | undefined;
let beforeVaultDrain: ((target: CredentialVault) => void) | undefined;
let afterVaultDrain:
	| ((target: CredentialVault, original: Promise<void>) => Promise<void>)
	| undefined;
let beforeAuditDestroy: (() => void) | undefined;
let restoreVaultObserver: (() => void) | undefined;
let restoreTicketObserver: (() => void) | undefined;
let restoreAuditDestroyObserver: (() => void) | undefined;

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
function fixedRefusal(promise: Promise<unknown>): Promise<void> {
	const assertion = (async () => {
		await expect(promise).rejects.toMatchObject({
			name: "NativeBackupRestoreError",
			code: "BACKUP_RESTORE_UNAVAILABLE",
			message: "Backup restore unavailable",
		});
	})();
	void assertion.catch(() => undefined);
	return assertion;
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
				let result: T;
				try {
					result = work(tx);
				} catch (error) {
					try {
						afterRealWriteFailure?.(tx, error);
					} catch {
						// An observer cannot replace the original transaction refusal.
					}
					throw error;
				}
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
	const proposalObserver = vi
		.spyOn(NativeOutboxProposals.prototype, "destroy")
		.mockImplementation(function (this: NativeOutboxProposals): void {
			// Only the explicit interruption case can refuse dispatch before the actual method.
			beforeProposalDestroy?.(this);
			apply(originalProposalDestroy, this, []);
			afterProposalDestroy?.();
		});
	restoreProposalObserver = () => {
		proposalObserver.mockRestore();
	};
	const revisionObserver = vi
		.spyOn(NativeDraftRevisions.prototype, "destroy")
		.mockImplementation(function (this: NativeDraftRevisions): void {
			apply(originalRevisionDestroy, this, []);
			afterRevisionDestroy?.();
		});
	restoreRevisionObserver = () => {
		revisionObserver.mockRestore();
	};
	const approvalObserver = vi
		.spyOn(NativeApprovalRestore.prototype, "destroy")
		.mockImplementation(function (this: NativeApprovalRestore): void {
			beforeApprovalStorageDestroy?.(this);
			apply(originalApprovalStorageDestroy, this, []);
			afterApprovalStorageDestroy?.();
		});
	restoreApprovalStorageObserver = () => {
		approvalObserver.mockRestore();
	};
	const ticketObserver = vi
		.spyOn(SendTicketStorage.prototype, "destroy")
		.mockImplementation(function (this: SendTicketStorage): void {
			apply(originalTicketStorageDestroy, this, []);
		});
	restoreTicketObserver = () => {
		ticketObserver.mockRestore();
	};
	const vaultObserver = vi.spyOn(CredentialVault.prototype, "drain").mockImplementation(function (
		this: CredentialVault,
	): Promise<void> {
		beforeVaultDrain?.(this);
		const original = apply(originalVaultDrain, this, []) as Promise<void>;
		return afterVaultDrain ? afterVaultDrain(this, original) : original;
	});
	restoreVaultObserver = () => {
		vaultObserver.mockRestore();
	};
	const destroyAuditObserver = vi
		.spyOn(AuditChain.prototype, "destroy")
		.mockImplementation(function (this: AuditChain): void {
			beforeAuditDestroy?.();
			apply(originalAuditDestroy, this, []);
		});
	restoreAuditDestroyObserver = () => {
		destroyAuditObserver.mockRestore();
	};
	api = await import("../../src/recovery/backup-restore.ts");
});
afterEach(async () => {
	await joinBodiesBeforeFixtureClose();
	afterRealWrite = undefined;
	afterRealWriteFailure = undefined;
	afterRealVerify = undefined;
	beforeRealWrite = undefined;
	beforeRealClose = undefined;
	beforeProposalDestroy = undefined;
	afterProposalDestroy = undefined;
	afterRevisionDestroy = undefined;
	afterApprovalStorageDestroy = undefined;
	beforeApprovalStorageDestroy = undefined;
	beforeVaultDrain = undefined;
	afterVaultDrain = undefined;
	beforeAuditDestroy = undefined;
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
		restoreAuditDestroyObserver?.();
		restoreVaultObserver?.();
		restoreTicketObserver?.();
		restoreApprovalStorageObserver?.();
		restoreRevisionObserver?.();
		restoreProposalObserver?.();
		restoreCloseObserver?.();
		restoreAuditObserver?.();
		restoreWriteObserver?.();
	}
});

async function prepared(
	withProposals = false,
	withApprovals = false,
	withTickets = false,
	archive: AuthorityArchiveOptions = {},
) {
	if (fixtures.length) throw new Error("Previous fixture cleanup remains incomplete");
	const fixture = await AuthorityResetFixture.create(
		requiredAuthorityResetBinding(),
		fixtures,
		withProposals,
		withApprovals,
		withTickets,
		archive,
	);
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
		"restricts full restored accounts to read only with original generations and invalidations",
		retained(async () => {
			const { fixture, token } = await prepared();
			const before = fixture.before!;
			expect(before.accounts.map((row) => row.id)).toEqual([
				FULL_EMAIL_ACCOUNT,
				FULL_CHAT_ACCOUNT,
				READ_ONLY_ACCOUNT,
			]);
			const original = before.accounts.map((row) => {
				if (row.account_json === null) throw new Error("Original account metadata missing");
				return JSON.parse(row.account_json);
			});
			expect(original.map((account) => account.mode)).toEqual(["full", "full", "read_only"]);
			await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
			expect(pinAccepted).toBe(true);
			expect(state.accounts).toHaveLength(3);
			for (const [index, row] of state.accounts.entries()) {
				const previous = before.accounts[index];
				if (!previous) throw new Error("Original account row missing");
				expect(row).toEqual({
					...previous,
					generation: previous.generation + (index < 2 ? 1 : 0),
					account_json: JSON.stringify({ ...original[index], mode: "read_only" }),
				});
			}
			const added = state.events.slice(before.events.length);
			expect(
				added.map(({ user_id, account_id, kind, ids, data_class }) => ({
					user_id,
					account_id,
					kind,
					ids,
					data_class,
				})),
			).toEqual([
				{
					user_id: OWNER,
					account_id: FULL_EMAIL_ACCOUNT,
					kind: "accounts.changed",
					ids: JSON.stringify([FULL_EMAIL_ACCOUNT]),
					data_class: "gmail.metadata",
				},
				{
					user_id: OWNER,
					account_id: FULL_CHAT_ACCOUNT,
					kind: "accounts.changed",
					ids: JSON.stringify([FULL_CHAT_ACCOUNT]),
					data_class: "slack.metadata",
				},
			]);
			expect(state.epoch).toBe(before.epoch + 1);
			expect(state.pinVersion).toBe(before.pinVersion + 1);
			expect(state.devices).toEqual(before.devices);
		}),
	);

	it(
		"reduces genuine archived proposals in the same held-image authority reset",
		retained(async () => {
			const { fixture, token } = await prepared(true);
			const before = fixture.before!;
			const oldRows = new Map(before.outbox.map((row) => [row.id, row]));
			const oldFresh = oldRows.get(FRESH_PENDING_PROPOSAL);
			if (!oldFresh) throw new Error("Original pending archive row missing");
			expect(oldRows.get(EXPIRED_PENDING_PROPOSAL)?.state).toBe("PENDING_APPROVAL");
			expect(oldRows.get(APPROVED_PROPOSAL)?.state).toBe("APPROVED");
			expect(oldRows.get(SCHEDULED_PROPOSAL)?.state).toBe("SCHEDULED");
			await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
			expect(pinAccepted).toBe(true);
			expect(state.epoch).toBe(before.epoch + 1);
			expect(state.pinVersion).toBe(before.pinVersion + 1);
			expect(state.bootstrap).toBe(0);
			const rows = new Map(state.outbox.map((row) => [row.id, row]));
			expect(rows.get(FRESH_PENDING_PROPOSAL)).toEqual(oldFresh);
			for (const [id, next, reason] of [
				[EXPIRED_PENDING_PROPOSAL, "EXPIRED", null],
				[APPROVED_PROPOSAL, "NEEDS_REAPPROVAL", "restored"],
				[SCHEDULED_PROPOSAL, "NEEDS_REAPPROVAL", "restored"],
			] as const) {
				const original = oldRows.get(id),
					saved = rows.get(id);
				if (!original || !saved) throw new Error("Original archive row unavailable");
				const previous = JSON.parse(String(original.payload));
				const value = JSON.parse(String(saved.payload));
				expect(saved.state).toBe(next);
				expect(value).toEqual({
					...previous,
					state: next,
					stateReason: reason,
					updatedAt: value.updatedAt,
				});
				expect(value.updatedAt >= previous.updatedAt).toBe(true);
				const draft = state.drafts.find((row) => row.id === previous.draftId);
				if (!draft) throw new Error("Original archived draft missing");
				expect(JSON.parse(String(draft.payload)).lockId).toBeNull();
			}
			const pending = JSON.parse(String(oldFresh.payload));
			expect(state.drafts.find((row) => row.id === pending.draftId)).toEqual(
				before.drafts.find((row) => row.id === pending.draftId),
			);
			expect(state.draftRevisions).toEqual(before.draftRevisions);
			const events = state.events.slice(before.events.length);
			expect(events.map(({ kind, ids }) => ({ kind, ids }))).toEqual([
				{ kind: "accounts.changed", ids: JSON.stringify([FULL_EMAIL_ACCOUNT]) },
				{ kind: "accounts.changed", ids: JSON.stringify([FULL_CHAT_ACCOUNT]) },
				...[EXPIRED_PENDING_PROPOSAL, APPROVED_PROPOSAL, SCHEDULED_PROPOSAL].map((id) => ({
					kind: "outbox.changed",
					ids: JSON.stringify([id]),
				})),
			]);
			expect(state.auditEvents.filter((row) => row.action === "outbox.expired")).toHaveLength(1);
			expect(state.auditEvents.filter((row) => row.action === "outbox.restored")).toHaveLength(2);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
		}),
	);

	it(
		"rolls authority, account and archived proposal changes back on one late original write error",
		retained(async () => {
			const { fixture, token } = await prepared(true);
			let actualStore: HubStore | undefined;
			let changed = false;
			afterRealWrite = (store, tx) => {
				actualStore = store;
				const selected = tx.all<{ id: string; state: string }>(
					"SELECT id,state FROM main.outbox ORDER BY id",
				);
				const accounts = tx.all<{ generation: number; account_json: string }>(
					"SELECT generation,account_json FROM main.accounts ORDER BY id",
				);
				changed =
					selected.find((row) => row.id === EXPIRED_PENDING_PROPOSAL)?.state === "EXPIRED" &&
					selected.find((row) => row.id === APPROVED_PROPOSAL)?.state === "NEEDS_REAPPROVAL" &&
					selected.find((row) => row.id === SCHEDULED_PROPOSAL)?.state === "NEEDS_REAPPROVAL" &&
					accounts.length === 3 &&
					accounts[0]?.generation === 2 &&
					accounts[1]?.generation === 2 &&
					accounts.every((row) => JSON.parse(row.account_json).mode === "read_only") &&
					tx.get<{ version: number }>("SELECT version FROM main.approval_pins WHERE user_id=?", [
						OWNER,
					])?.version ===
						fixture.before!.pinVersion + 1 &&
					tx.get<{ epoch: number }>("SELECT epoch FROM main.device_authority WHERE singleton=1")
						?.epoch ===
						fixture.before!.epoch + 1;
				throw new Error("Explicit late whole-composition rollback fault");
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(changed).toBe(true);
			afterRealWrite = undefined;
			if (!actualStore) throw new Error("Original composed write not observed");
			actualStore.checkpoint();
			expect((await fixture.readCopy(OLD_PIN)).state).toEqual(fixture.before);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
		}),
	);

	it(
		"retains new key owners when test instrumentation interrupts cleanup dispatch before the original destroy",
		retained(async () => {
			const { fixture, token, image } = await prepared(true);
			let resetStore: HubStore | undefined;
			let dispatches = 0,
				proposalDestroys = 0,
				revisionDestroys = 0,
				storeCloses = 0;
			let held: NativeOutboxProposals | undefined;
			beforeRealWrite = (store) => {
				resetStore = store;
				beforeRealWrite = undefined;
			};
			beforeRealClose = (store) => {
				if (store === resetStore) storeCloses++;
			};
			beforeProposalDestroy = (target) => {
				if (held && held !== target) throw new Error("Derived owner unexpectedly replaced");
				held = target;
				dispatches++;
				if (dispatches < 3)
					throw new Error("Injected BEFORE-original cleanup dispatch interruption");
			};
			afterProposalDestroy = () => {
				proposalDestroys++;
			};
			afterRevisionDestroy = () => {
				revisionDestroys++;
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(dispatches).toBe(1);
			expect(proposalDestroys).toBe(0);
			expect(revisionDestroys).toBe(1);
			expect(storeCloses).toBe(0);
			expect(image.fd >= 0).toBe(true);
			await fixedRefusal(fixture.track(api.closeNativeBackupPreparation(token)));
			expect(dispatches).toBe(2);
			expect(proposalDestroys).toBe(0);
			expect(revisionDestroys).toBe(1);
			expect(storeCloses).toBe(0);
			expect(image.fd >= 0).toBe(true);
			await fixture.track(api.closeNativeBackupPreparation(token));
			expect(dispatches).toBe(3);
			expect(proposalDestroys).toBe(1);
			expect(revisionDestroys).toBe(1);
			expect(storeCloses).toBe(1);
			expect(image.fd).toBe(-1);
		}),
	);

	it(
		"rolls account restrictions and invalidations back with the original authority transaction",
		retained(async () => {
			const { fixture, token } = await prepared();
			let actualStore: HubStore | undefined;
			let observed = false;
			afterRealWrite = (store, tx) => {
				actualStore = store;
				const rows = tx.all<{ id: string; generation: number; account_json: string }>(
					"SELECT id,generation,account_json FROM main.accounts ORDER BY id",
				);
				const newEvents = tx.all<{ account_id: string }>(
					"SELECT account_id FROM main.events WHERE seq>? ORDER BY seq",
					[fixture.before!.events.at(-1)!.seq],
				);
				observed =
					rows.length === 3 &&
					rows[0]?.generation === 2 &&
					rows[1]?.generation === 2 &&
					rows[2]?.generation === 1 &&
					rows.every((row) => JSON.parse(row.account_json).mode === "read_only") &&
					newEvents.length === 2 &&
					newEvents[0]?.account_id === FULL_EMAIL_ACCOUNT &&
					newEvents[1]?.account_id === FULL_CHAT_ACCOUNT;
				throw new Error("Synthetic account composition rollback");
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(observed).toBe(true);
			afterRealWrite = undefined;
			if (!actualStore) throw new Error("Original account reduction transaction missing");
			actualStore.checkpoint();
			expect((await fixture.readCopy(OLD_PIN)).state).toEqual(fixture.before);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
		}),
	);

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

	it(
		"invalidates real archived live approval storage and retires its owner before closing the image",
		retained(async () => {
			const { fixture, token, image } = await prepared(true, true);
			const before = fixture.before!;
			const live = before.approvals.find((row) => row.id === LIVE_STORED_APPROVAL);
			if (!live) throw new Error("Original archived live approval missing");
			expect(live.consumed_at).toBeNull();
			expect(live.voided_at).toBeNull();
			let actualStore: HubStore | undefined;
			const cleanupOrder: string[] = [];
			beforeRealWrite = (store) => {
				actualStore = store;
				beforeRealWrite = undefined;
			};
			afterApprovalStorageDestroy = () => {
				cleanupOrder.push("approval-storage");
			};
			afterProposalDestroy = () => {
				cleanupOrder.push("proposals");
			};
			afterRevisionDestroy = () => {
				cleanupOrder.push("revisions");
			};
			beforeRealClose = (store) => {
				if (store === actualStore) cleanupOrder.push("original-store");
			};
			await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			expect(cleanupOrder).toEqual(["approval-storage", "proposals", "revisions"]);
			const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
			expect(pinAccepted).toBe(true);
			expect(state.epoch).toBe(before.epoch + 1);
			expect(state.pinVersion).toBe(before.pinVersion + 1);
			const changed = state.approvals.find((row) => row.id === LIVE_STORED_APPROVAL);
			if (!changed) throw new Error("Stored approval readback missing");
			expect(changed).toEqual({
				...live,
				voided_at: changed.voided_at,
				void_reason: "restored",
				audit_seq: changed.audit_seq,
				audit_mac: changed.audit_mac,
				mac: changed.mac,
			});
			expect(Number(changed.voided_at) >= Number(live.accepted_at)).toBe(true);
			expect(changed.audit_seq).not.toBe(live.audit_seq);
			for (const id of [CONSUMED_STORED_APPROVAL, VOIDED_STORED_APPROVAL])
				expect(state.approvals.find((row) => row.id === id)).toEqual(
					before.approvals.find((row) => row.id === id),
				);
			expect(state.approvalChallenges).toEqual(before.approvalChallenges);
			expect(
				state.approvals.every((row) => row.consumed_at !== null || row.voided_at !== null),
			).toBe(true);
			const added = state.events.slice(before.events.length);
			expect(added).toHaveLength(6);
			expect(added.at(-1)).toMatchObject({
				user_id: OWNER,
				account_id: FULL_CHAT_ACCOUNT,
				kind: "outbox.changed",
				ids: JSON.stringify([APPROVED_PROPOSAL]),
				data_class: "slack.content",
			});
			expect(
				state.auditEvents.filter(
					(row) => row.action === "approval.lapsed" && row.actor_kind === "hub",
				),
			).toMatchObject([{ actor_id: null }]);
			await fixture.track(api.closeNativeBackupPreparation(token));
			expect(cleanupOrder).toEqual([
				"approval-storage",
				"proposals",
				"revisions",
				"original-store",
			]);
			expect(image.fd).toBe(-1);
		}),
	);

	it(
		"rolls archived approval invalidation back with every earlier reset change on a late original error",
		retained(async () => {
			const { fixture, token } = await prepared(true, true);
			let actualStore: HubStore | undefined;
			let changedInside = false;
			afterRealWrite = (store, tx) => {
				actualStore = store;
				const live = tx.get<{ void_reason: string | null; voided_at: number | null }>(
					"SELECT void_reason,voided_at FROM main.approvals WHERE id=?",
					[LIVE_STORED_APPROVAL],
				);
				const proposal = tx.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [
					APPROVED_PROPOSAL,
				]);
				const accounts = tx.all<{ generation: number; account_json: string }>(
					"SELECT generation,account_json FROM main.accounts ORDER BY id",
				);
				changedInside =
					live?.void_reason === "restored" &&
					live.voided_at !== null &&
					proposal?.state === "NEEDS_REAPPROVAL" &&
					accounts.length === 3 &&
					accounts[0]?.generation === 2 &&
					accounts[1]?.generation === 2 &&
					accounts.every((row) => JSON.parse(row.account_json).mode === "read_only") &&
					tx.get<{ epoch: number }>("SELECT epoch FROM main.device_authority WHERE singleton=1")
						?.epoch ===
						fixture.before!.epoch + 1 &&
					tx.get<{ version: number }>("SELECT version FROM main.approval_pins WHERE user_id=?", [
						OWNER,
					])?.version ===
						fixture.before!.pinVersion + 1;
				throw new Error("Explicit late whole approval-composition rollback fault");
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(changedInside).toBe(true);
			afterRealWrite = undefined;
			if (!actualStore) throw new Error("Original combined write was not observed");
			actualStore.checkpoint();
			expect((await fixture.readCopy(OLD_PIN)).state).toEqual(fixture.before);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
		}),
	);

	it(
		"retains the approval wrapper when test instrumentation interrupts dispatch before its original destroy",
		retained(async () => {
			const { fixture, token, image } = await prepared(true, true);
			let actualStore: HubStore | undefined, held: NativeApprovalRestore | undefined;
			let dispatches = 0,
				approvalDestroys = 0,
				proposalDestroys = 0,
				revisionDestroys = 0,
				storeCloses = 0;
			beforeRealWrite = (store) => {
				actualStore = store;
				beforeRealWrite = undefined;
			};
			beforeRealClose = (store) => {
				if (store === actualStore) storeCloses++;
			};
			beforeApprovalStorageDestroy = (target) => {
				if (held && held !== target) throw new Error("Original approval wrapper was replaced");
				held = target;
				dispatches++;
				if (dispatches < 3)
					throw new Error("Injected BEFORE-original approval wrapper dispatch interruption");
			};
			afterApprovalStorageDestroy = () => {
				approvalDestroys++;
			};
			afterProposalDestroy = () => {
				proposalDestroys++;
			};
			afterRevisionDestroy = () => {
				revisionDestroys++;
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect([
				dispatches,
				approvalDestroys,
				proposalDestroys,
				revisionDestroys,
				storeCloses,
			]).toEqual([1, 0, 1, 1, 0]);
			expect(image.fd >= 0).toBe(true);
			await fixedRefusal(fixture.track(api.closeNativeBackupPreparation(token)));
			expect([
				dispatches,
				approvalDestroys,
				proposalDestroys,
				revisionDestroys,
				storeCloses,
			]).toEqual([2, 0, 1, 1, 0]);
			expect(image.fd >= 0).toBe(true);
			await fixture.track(api.closeNativeBackupPreparation(token));
			expect([
				dispatches,
				approvalDestroys,
				proposalDestroys,
				revisionDestroys,
				storeCloses,
			]).toEqual([3, 1, 1, 1, 1]);
			expect(image.fd).toBe(-1);
		}),
	);

	it(
		"reduces genuine archived send-ticket storage before final approval invalidation",
		retained(async () => {
			const { fixture, token } = await prepared(true, true, true);
			const before = fixture.before!;
			expect(before.sendAttempts.map((row) => row.state)).toEqual(ARCHIVED_SEND_STATES);
			await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
			expect(pinAccepted).toBe(true);
			expect(state.epoch).toBe(before.epoch + 1);
			expect(state.sendAttempts).toHaveLength(8);
			for (const prior of before.sendAttempts) {
				const saved = state.sendAttempts.find((row) => row.id === prior.id);
				if (!saved) throw new Error("Original archived send attempt missing");
				const expected = prior.state === "SENDING" ? "UNKNOWN" : "NEEDS_REAPPROVAL";
				if (["ISSUED", "REDEEMED", "SENDING"].includes(String(prior.state))) {
					expect(saved).toEqual({
						...prior,
						state: expected,
						updated_at: saved.updated_at,
						audit_seq: saved.audit_seq,
						mac: saved.mac,
					});
					expect(Number(saved.updated_at) >= Number(prior.updated_at)).toBe(true);
					expect(saved.audit_seq).not.toBe(prior.audit_seq);
					const event = state.auditEvents.find((row) => row.seq === saved.audit_seq);
					expect(event).toMatchObject({
						action: "send." + expected.toLowerCase(),
						actor_kind: "hub",
						actor_id: null,
					});
				} else expect(saved).toEqual(prior);
			}
			expect(state.approvals.find((row) => row.id === LIVE_STORED_APPROVAL)?.void_reason).toBe(
				"restored",
			);
		}),
	);

	it(
		"rolls restored send-ticket changes back with the whole original authority write",
		retained(async () => {
			const { fixture, token } = await prepared(true, true, true);
			let actualStore: HubStore | undefined;
			let changedInside = false;
			afterRealWrite = (store, tx) => {
				actualStore = store;
				const rows = tx.all<{ state: string }>(
					"SELECT state FROM main.native_send_attempts ORDER BY outbox_id",
				);
				changedInside =
					JSON.stringify(rows.map((row) => row.state)) ===
						JSON.stringify([
							"NEEDS_REAPPROVAL",
							"NEEDS_REAPPROVAL",
							"UNKNOWN",
							"SENT",
							"FAILED",
							"UNKNOWN",
							"NEEDS_REAPPROVAL",
							"EXPIRED",
						]) &&
					tx.get<{ void_reason: string }>("SELECT void_reason FROM main.approvals WHERE id=?", [
						LIVE_STORED_APPROVAL,
					])?.void_reason === "restored" &&
					tx.get<{ epoch: number }>("SELECT epoch FROM main.device_authority WHERE singleton=1")
						?.epoch ===
						fixture.before!.epoch + 1;
				throw new Error("Explicit late whole ticket-composition rollback fault");
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(changedInside).toBe(true);
			afterRealWrite = undefined;
			if (!actualStore) throw new Error("Original ticket-composition write was not observed");
			actualStore.checkpoint();
			expect((await fixture.readCopy(OLD_PIN)).state).toEqual(fixture.before);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
		}),
	);

	it(
		"retains the original vault and audit through an observed drain barrier and explicit retry interruptions",
		retained(async () => {
			const { fixture, token, image } = await prepared(true, true, true);
			const entered = deferred<void>(),
				release = deferred<void>();
			const unblock = () => {
				release.resolve();
				entered.resolve();
			};
			gateReleases.add(unblock);
			let originalStore: HubStore | undefined, originalVault: CredentialVault | undefined;
			let attempts = 0,
				originalDrains = 0,
				auditDestroys = 0,
				storeCloses = 0;
			beforeRealWrite = (store) => {
				originalStore = store;
				beforeRealWrite = undefined;
			};
			beforeRealClose = (store) => {
				if (store === originalStore) storeCloses++;
			};
			beforeAuditDestroy = () => {
				auditDestroys++;
			};
			beforeVaultDrain = (vault) => {
				if (originalVault && originalVault !== vault)
					throw new Error("Original vault was replaced");
				originalVault = vault;
				attempts++;
				if (attempts === 2)
					throw new Error("Injected BEFORE-original drain retry dispatch interruption");
			};
			afterVaultDrain = (_vault, original) => {
				originalDrains++;
				if (attempts !== 1) return original;
				return fixture.track(
					original.then(async () => {
						entered.resolve();
						await release.promise;
						throw new Error("Injected AFTER-original drain completion interruption");
					}),
				);
			};
			const reset = fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const resetRefused = fixedRefusal(reset);
			let closing: Promise<void> | undefined;
			try {
				await Promise.race([
					entered.promise,
					reset.then(
						() => {
							expect.fail("Reset completed before the drain barrier");
						},
						() => {
							expect.fail("Reset failed before the drain barrier");
						},
					),
				]);
				closing = fixture.track(api.closeNativeBackupPreparation(token));
				const closeRefused = fixedRefusal(closing);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect([attempts, originalDrains, auditDestroys, storeCloses]).toEqual([1, 1, 0, 0]);
				expect(image.fd >= 0).toBe(true);
				release.resolve();
				await resetRefused;
				await closeRefused;
				expect([attempts, originalDrains, auditDestroys, storeCloses]).toEqual([2, 1, 0, 0]);
				expect(image.fd >= 0).toBe(true);
				await fixture.track(api.closeNativeBackupPreparation(token));
				expect([attempts, originalDrains, auditDestroys, storeCloses]).toEqual([3, 2, 1, 1]);
				expect(image.fd).toBe(-1);
			} finally {
				unblock();
				gateReleases.delete(unblock);
				await Promise.allSettled([resetRefused, ...(closing ? [closing] : [])]);
			}
		}),
	);

	it(
		"preserves in-flight proposals while invalidating only stored live approvals",
		retained(async () => {
			const { fixture, token } = await prepared(true, true, true, { inFlightProposals: true });
			const before = fixture.before!;
			for (const [id, expectedState] of IN_FLIGHT_PROPOSALS) {
				const prior = before.outbox.find((row) => row.id === id);
				expect(prior?.state).toBe(expectedState);
				expect(before.draftLocks.filter((row) => row.draft_id === prior?.draft_id)).toHaveLength(1);
			}
			await fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN));
			const { state, pinAccepted } = await fixture.readCopy(NEW_PIN);
			expect(pinAccepted).toBe(true);
			for (const [id] of IN_FLIGHT_PROPOSALS) {
				const prior = before.outbox.find((row) => row.id === id);
				if (!prior) throw new Error("Original in-flight proposal missing");
				expect(state.outbox.find((row) => row.id === id)).toEqual(prior);
				expect(state.draftLocks.filter((row) => row.draft_id === prior.draft_id)).toEqual(
					before.draftLocks.filter((row) => row.draft_id === prior.draft_id),
				);
				expect(
					state.events
						.slice(before.events.length)
						.filter((row) => row.kind === "outbox.changed" && JSON.parse(row.ids).includes(id)),
				).toEqual([]);
			}
			expect(state.outbox.find((row) => row.id === EXPIRED_PENDING_PROPOSAL)?.state).toBe(
				"EXPIRED",
			);
			expect(state.outbox.find((row) => row.id === FRESH_PENDING_PROPOSAL)).toEqual(
				before.outbox.find((row) => row.id === FRESH_PENDING_PROPOSAL),
			);
			for (const id of [APPROVED_PROPOSAL, SCHEDULED_PROPOSAL])
				expect(state.outbox.find((row) => row.id === id)?.state).toBe("NEEDS_REAPPROVAL");
			// Completion of this storage predicate coexists with unresolved in-flight DATA.
			expect(
				state.approvals.every((row) => row.consumed_at !== null || row.voided_at !== null),
			).toBe(true);
		}),
	);

	it(
		"propagates a stored-approval authentication refusal through the whole original authority write",
		retained(async () => {
			const { fixture, token } = await prepared(true, true, true, { invalidLiveApprovalMac: true });
			const before = fixture.before!;
			let actualStore: HubStore | undefined;
			let originalWorkFailure: unknown;
			let writes = 0,
				completedWrites = 0,
				observedEarlierReductions = false;
			beforeRealWrite = (store) => {
				actualStore = store;
				writes++;
			};
			afterRealWrite = () => {
				completedWrites++;
			};
			afterRealWriteFailure = (db, error) => {
				originalWorkFailure = error;
				const authority = db.get<{ epoch: number }>(
					"SELECT epoch FROM main.device_authority WHERE singleton=1",
				);
				const pin = db.get<{ version: number }>(
					"SELECT version FROM main.approval_pins WHERE user_id=?",
					[OWNER],
				);
				const proposals = db.all<{ id: string; state: string }>(
					"SELECT id,state FROM main.outbox ORDER BY id",
				);
				const tickets = db.all<{ outbox_id: string; state: string }>(
					"SELECT outbox_id,state FROM main.native_send_attempts ORDER BY outbox_id",
				);
				if (
					authority?.epoch === before.epoch + 1 &&
					pin?.version === before.pinVersion + 1 &&
					proposals.find((row) => row.id === EXPIRED_PENDING_PROPOSAL)?.state === "EXPIRED" &&
					[APPROVED_PROPOSAL, SCHEDULED_PROPOSAL].every(
						(id) => proposals.find((row) => row.id === id)?.state === "NEEDS_REAPPROVAL",
					) &&
					[
						["00000000000000000000000070", "NEEDS_REAPPROVAL"],
						["00000000000000000000000071", "NEEDS_REAPPROVAL"],
						["00000000000000000000000072", "UNKNOWN"],
					].every(([id, state]) => tickets.find((row) => row.outbox_id === id)?.state === state)
				)
					observedEarlierReductions = true;
			};
			await fixedRefusal(fixture.track(api.resetNativeBackupAuthority(token, NEW_PIN)));
			expect(originalWorkFailure).toBeInstanceOf(ApprovalRestoreError);
			expect(originalWorkFailure).toMatchObject({ code: "APPROVAL_RESTORE_UNAVAILABLE" });
			expect(observedEarlierReductions).toBe(true);
			expect([writes, completedWrites]).toEqual([1, 0]);
			beforeRealWrite = undefined;
			afterRealWrite = undefined;
			afterRealWriteFailure = undefined;
			if (!actualStore) throw new Error("Original refused authority write was not observed");
			actualStore.checkpoint();
			const restored = await fixture.readCopy(OLD_PIN);
			expect(restored.pinAccepted).toBe(true);
			expect(restored.state).toEqual(before);
			await fixedRefusal(api.resetNativeBackupAuthority(token, NEW_PIN));
		}),
	);
});
