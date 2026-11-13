import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { type CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import { AuditChain } from "../../src/audit/chain.ts";
import { Authorizer } from "../../src/authz/authorizer.ts";
import { NativeDraftFreeze, NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { DeviceRegistry } from "../../src/identity/devices.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { PinService } from "../../src/identity/pin.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import {
	expireNativeOutboxPendingForRestoreInTransaction,
	NativeOutboxProposals,
	type NativeProposalRecord,
	ProposalError,
	resetNativeOutboxProposalsForRestoreInTransaction,
} from "../../src/outbox/propose.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";

const NOW = 1_800_000_000_000;
const identifier = (value: number): string => String(value).padStart(26, "0");
const USER = identifier(1);
const ACCOUNT = identifier(2);
type State = NativeProposalRecord["state"];

function bindingFromOwnInstall(): string {
	const resolvePackage = createRequire(import.meta.url);
	const entry = fs.realpathSync.native(resolvePackage.resolve("better-sqlite3-multiple-ciphers"));
	const root = path.dirname(path.dirname(entry));
	const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
	if (
		metadata.name !== "better-sqlite3-multiple-ciphers" ||
		metadata.version !== "13.0.3" ||
		metadata.main !== "lib/index.js" ||
		entry !== path.join(root, "lib", "index.js")
	)
		throw new Error("Own SQLite test package unavailable");
	const selected = path.join(root, "prebuilds", `${process.platform}-${process.arch}.node`);
	const stat = fs.lstatSync(selected);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
		throw new Error("Own SQLite test binding unavailable");
	if (fs.realpathSync.native(selected) !== selected)
		throw new Error("Test binding is not canonical");
	return selected;
}

class Fixture {
	root: string | undefined;
	rootIdentity: fs.BigIntStats | undefined;
	key: MasterKey | undefined;
	outboxKey: Buffer | undefined;
	store!: HubStore;
	audit!: AuditChain;
	identity!: HubIdentity;
	pins!: PinService;
	registry!: DeviceRegistry;
	revisions!: NativeDraftRevisions;
	freeze!: NativeDraftFreeze;
	target!: NativeOutboxProposals;
	wall = NOW;
	onWall: (() => void) | undefined;
	serial = 100;
	uncertain = false;
	closed = false;
	readonly clock = {
		wallMs: (): number => {
			this.onWall?.();
			return this.wall;
		},
		monotonicMs: (): number => 100,
	};

	async initialize(): Promise<void> {
		this.root = fs.realpathSync.native(
			fs.mkdtempSync(path.join(os.tmpdir(), "dy-proposal-reset-")),
		);
		this.rootIdentity = fs.lstatSync(this.root, { bigint: true });
		const seed = randomBytes(32);
		try {
			this.key = new MasterKey(seed);
		} finally {
			seed.fill(0);
		}
		const nativeBinding = bindingFromOwnInstall();
		this.uncertain = true;
		this.store = new HubStore({
			filename: path.join(this.root, "proposals.db"),
			masterKey: this.key,
			nativeBinding,
			create: true,
			migrations: HUB_NAMESPACES,
		});
		this.uncertain = false;
		await migrateHubSchemas(this.store);
		const auditKey = this.key.derive("audit");
		try {
			this.audit = new AuditChain(auditKey);
		} finally {
			auditKey.fill(0);
		}
		this.identity = await HubIdentity.loadOrCreate(this.store, this.key);
		this.pins = new PinService(this.store, this.audit, this.clock);
		this.registry = new DeviceRegistry(this.store, this.audit, this.pins, {
			identity: this.identity,
			clock: this.clock,
		});
		this.revisions = new NativeDraftRevisions(this.store, this.audit, this.key, this.clock);
		this.freeze = new NativeDraftFreeze(this.revisions);
		this.target = new NativeOutboxProposals(
			this.store,
			this.audit,
			this.key,
			this.revisions,
			this.registry,
			new Authorizer(this.registry),
			this.identity,
			this.clock,
		);
		this.outboxKey = this.key.derive("outbox");
		this.store.write((tx) => {
			tx.run("INSERT INTO main.users(id,created_at) VALUES(?,?)", [USER, NOW]);
			tx.run("UPDATE main.device_authority SET owner_user_id=? WHERE singleton=1", [USER]);
		});
	}

	/** Invented backup DATA, authenticated with real revisions, freezes and the original audit. */
	seed(tx: SqlTransaction, state: State): NativeProposalRecord {
		const base = this.serial++ * 10;
		const bound = {
			accountId: ACCOUNT,
			conversationId: identifier(base + 1),
			draftId: identifier(base + 2),
			channel: "chat" as const,
		};
		const outboxId = identifier(base + 3);
		const created = this.revisions.createInTransaction(tx, {
			...bound,
			author: { kind: "owner", id: USER },
			content: {
				channel: "chat",
				threadTs: null,
				broadcast: false,
				body: "Synthetic restored body",
			},
			flags: [],
		});
		const at = NOW + 120_000;
		const snapshot: CurrentSendSnapshotV1 = {
			v: 1,
			hub: this.identity.hid,
			epoch: 0,
			outbox: outboxId,
			account: ACCOUNT,
			conversation: bound.conversationId,
			kind: "chat",
			body: { text: "Synthetic restored body", footer: "" },
			attachments: [],
			chat: {
				channelId: "C-SYNTHETIC",
				channelName: "synthetic",
				channelType: "public",
				external: false,
				shared: false,
				memberCount: 1,
				broadcast: false,
			},
			schedule:
				state === "SCHEDULED"
					? {
							kind: "at",
							notBefore: at,
							zone: "UTC",
							localWallTime: `${new Date(at).toISOString().slice(0, 16)}+00:00`,
							latenessSec: 900,
							holdIfNewInbound: false,
						}
					: { kind: "now" },
			source: { draft: bound.draftId, rev: 1, authors: [{ kind: "owner", id: USER }] },
		};
		this.freeze.freezeInTransaction(tx, bound, 1, snapshot);
		const locked = this.revisions.currentInTransaction(tx, bound);
		if (locked.lockId === null) throw new Error("Original freeze missing");
		const pending = state === "PENDING_APPROVAL";
		const value: NativeProposalRecord = {
			id: outboxId,
			userId: USER,
			accountId: ACCOUNT,
			draftId: bound.draftId,
			dataClass: "slack.content",
			snapshot,
			contentHash: contentHash(snapshot),
			flags: [],
			flagsHash: created.flagsHash,
			requiredApprovals: 1,
			requiredUsers: [USER],
			undoWindowMs: 0,
			expiresAt: NOW + 86_400_000,
			state,
			stateReason: state === "NEEDS_REAPPROVAL" ? "restored" : null,
			binding: bound,
			rev: 1,
			revisionContentHash: locked.revision.contentSha256,
			lockId: locked.lockId,
			notBefore: pending ? null : state === "SCHEDULED" ? at : NOW,
			deliverBy: pending ? null : (state === "SCHEDULED" ? at : NOW) + 900_000,
			createdAt: NOW,
			updatedAt: NOW,
		};
		const receipt = this.revisions.auditOutboxInTransaction(
			tx,
			state === "APPROVED" || state === "SCHEDULED" ? "outbox.approved" : "outbox.proposed",
			outboxId,
		);
		const signed = {
			id: value.id,
			user_id: value.userId,
			account_id: value.accountId,
			draft_id: value.draftId,
			state: value.state,
			schedule_kind: snapshot.schedule.kind,
			payload: canonicalize(value),
			audit_seq: receipt.seq,
		};
		if (!this.outboxKey) throw new Error("Original fixture key missing");
		const mac = createHmac("sha256", this.outboxKey)
			.update("draftyak/outbox-proposal/v1\n")
			.update(canonicalize(signed))
			.digest("hex");
		tx.run(
			"INSERT INTO main.outbox(id,user_id,account_id,draft_id,state,schedule_kind,payload,audit_seq,mac) VALUES(?,?,?,?,?,?,?,?,?)",
			[...Object.values(signed), mac],
		);
		return value;
	}

	snapshot(): unknown {
		return this.store.read((tx) => ({
			outbox: tx.all("SELECT * FROM main.outbox ORDER BY id"),
			drafts: tx.all("SELECT * FROM main.native_drafts ORDER BY id"),
			locks: tx.all("SELECT * FROM main.native_draft_locks ORDER BY id"),
			audit: tx.all("SELECT * FROM main.audit_events ORDER BY seq"),
			head: tx.get("SELECT * FROM main.audit_meta WHERE singleton=1"),
			events: tx.all("SELECT * FROM main.events ORDER BY seq"),
			eventHead: tx.get("SELECT * FROM main.event_meta WHERE singleton=1"),
		}));
	}

	close(): void {
		if (this.closed) return;
		if (this.uncertain) throw new Error("Proposal fixture custody uncertain");
		this.onWall = undefined;
		this.target?.destroy();
		this.revisions?.destroy();
		this.registry?.lock();
		this.pins?.lock();
		this.identity?.lock();
		if (this.store) {
			this.uncertain = true;
			this.store.close();
			this.uncertain = false;
		}
		this.uncertain = true;
		this.audit?.destroy();
		this.outboxKey?.fill(0);
		this.key?.destroy();
		if (this.root) {
			const stat = fs.lstatSync(this.root, { bigint: true });
			if (
				!this.rootIdentity ||
				!stat.isDirectory() ||
				stat.isSymbolicLink() ||
				stat.dev !== this.rootIdentity.dev ||
				stat.ino !== this.rootIdentity.ino ||
				fs.realpathSync.native(this.root) !== this.root
			)
				throw new Error("Proposal fixture root custody uncertain");
			fs.rmSync(this.root, { recursive: true });
		}
		this.uncertain = false;
		this.closed = true;
	}
}

const owners: Fixture[] = [];
const bodies = new Set<Promise<void>>();
async function fixture(): Promise<Fixture> {
	if (owners.some((owner) => owner.uncertain)) throw new Error("Earlier fixture remains uncertain");
	const owner = new Fixture();
	owners.push(owner);
	await owner.initialize();
	return owner;
}
function test(name: string, body: () => Promise<void>): void {
	it(name, () => {
		if (bodies.size) throw new Error("Earlier proposal test body is not joined");
		const original = Promise.resolve().then(body);
		bodies.add(original);
		return original;
	});
}
afterEach(async () => {
	await Promise.allSettled([...bodies]);
	bodies.clear();
	const failures: unknown[] = [];
	for (const owner of owners) {
		try {
			owner.close();
		} catch (error) {
			failures.push(error);
		}
	}
	if (failures.length) throw new AggregateError(failures, "Proposal fixture cleanup incomplete");
	owners.length = 0;
});

describe("proposal restore in the original native write", () => {
	test("reduces approved and scheduled DATA with freeze release and fixed invalidations", async () => {
		const f = await fixture();
		const items = f.store.write((tx) => [f.seed(tx, "APPROVED"), f.seed(tx, "SCHEDULED")]);
		f.wall += 1_000;
		expect(
			f.store.write((tx) => resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)),
		).toBe(2);
		for (const item of items) {
			const saved = f.target.write((tx) => f.target.get(tx, item.id));
			expect(saved).toEqual({
				...item,
				state: "NEEDS_REAPPROVAL",
				stateReason: "restored",
				updatedAt: NOW + 1_000,
			});
			f.store.write((tx) => {
				expect(f.revisions.currentInTransaction(tx, item.binding).lockId).toBeNull();
				expect(() => f.freeze.proofInTransaction(tx, item.binding, item.id)).toThrow();
			});
		}
		f.store.read((tx) => {
			f.audit.verify(tx);
			expect(
				tx.all(
					"SELECT action,refs FROM main.audit_events WHERE action='outbox.restored' ORDER BY seq",
				),
			).toEqual(
				items.map((item) => ({
					action: "outbox.restored",
					refs: canonicalize({ outbox: item.id }),
				})),
			);
			expect(tx.all("SELECT kind,ids,data_class FROM main.events ORDER BY seq")).toEqual(
				items.map((item) => ({
					kind: "outbox.changed",
					ids: JSON.stringify([item.id]),
					data_class: "slack.content",
				})),
			);
		});
		const beforeRepeat = f.snapshot();
		expect(
			f.store.write((tx) => resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)),
		).toBe(0);
		expect(f.snapshot()).toEqual(beforeRepeat);
	});

	test("preserves every nonselected proposal state and its settled history byte for byte", async () => {
		const f = await fixture();
		const states: State[] = [
			"PENDING_APPROVAL",
			"SENDING",
			"RETRY_WAIT",
			"UNKNOWN",
			"SENT",
			"FAILED",
			"NEEDS_REAPPROVAL",
			"CANCELLED",
			"REJECTED",
			"SUPERSEDED",
			"EXPIRED",
		];
		f.store.write((tx) => {
			for (const state of states) f.seed(tx, state);
		});
		const before = f.snapshot();
		expect(
			f.store.write((tx) => resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)),
		).toBe(0);
		expect(f.snapshot()).toEqual(before);
	});

	test("refuses foreign, copied and expired transactions and copied or proxied targets", async () => {
		const f = await fixture();
		const foreign = await fixture();
		f.store.write((tx) => f.seed(tx, "APPROVED"));
		const before = f.snapshot();
		expect(() =>
			foreign.store.write((tx) => resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)),
		).toThrow(ProposalError);
		let expired: SqlTransaction | undefined;
		f.store.write((tx) => {
			expired = tx;
		});
		const old = expired;
		if (!old) throw new Error("Original transaction unavailable");
		expect(() => resetNativeOutboxProposalsForRestoreInTransaction(f.target, old)).toThrow(
			ProposalError,
		);
		for (const target of [Object.create(NativeOutboxProposals.prototype), new Proxy(f.target, {})])
			expect(() =>
				f.store.write((tx) => resetNativeOutboxProposalsForRestoreInTransaction(target, tx)),
			).toThrow(ProposalError);
		expect(() =>
			f.store.write((tx) =>
				resetNativeOutboxProposalsForRestoreInTransaction(f.target, Object.create(tx)),
			),
		).toThrow(ProposalError);
		expect(f.snapshot()).toEqual(before);
	});

	test("authenticates later rows and rolls an earlier genuine reduction back on corruption", async () => {
		const f = await fixture();
		const items = f.store.write((tx) => [f.seed(tx, "APPROVED"), f.seed(tx, "SCHEDULED")]);
		const later = items[1];
		if (!later) throw new Error("Original later proposal row missing");
		f.store.write((tx) =>
			tx.run("UPDATE main.outbox SET mac=? WHERE id=?", ["0".repeat(64), later.id]),
		);
		const before = f.snapshot();
		expect(() =>
			f.store.write((tx) => resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)),
		).toThrow(ProposalError);
		expect(f.snapshot()).toEqual(before);
	});

	test("requires full-prior CAS after the actual clock mutates the loaded row", async () => {
		const f = await fixture();
		const item = f.store.write((tx) => f.seed(tx, "APPROVED"));
		const before = f.snapshot();
		let changed = false;
		expect(() =>
			f.store.write((tx) => {
				f.onWall = () => {
					f.onWall = undefined;
					changed =
						tx.run("UPDATE main.outbox SET payload=payload||' ' WHERE id=?", [item.id]).changes ===
						1;
				};
				return resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx);
			}),
		).toThrow(ProposalError);
		expect(changed).toBe(true);
		expect(f.snapshot()).toEqual(before);
	});

	test("authenticates updated-row readback after the genuine event clock returns", async () => {
		const f = await fixture();
		const item = f.store.write((tx) => f.seed(tx, "APPROVED"));
		const before = f.snapshot();
		let changed = false;
		expect(() =>
			f.store.write((tx) => {
				f.onWall = () => {
					const row = tx.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [
						item.id,
					]);
					if (row?.state !== "NEEDS_REAPPROVAL") return;
					f.onWall = undefined;
					changed =
						tx.run("UPDATE main.outbox SET payload=payload||' ' WHERE id=?", [item.id]).changes ===
						1;
				};
				return resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx);
			}),
		).toThrow(ProposalError);
		expect(changed).toBe(true);
		expect(f.snapshot()).toEqual(before);
	});

	test("refuses a coherent revision append from the genuine event clock and rolls it back", async () => {
		const f = await fixture();
		const item = f.store.write((tx) => f.seed(tx, "APPROVED"));
		const before = f.snapshot();
		const revisionRows = () =>
			f.store.read((tx) =>
				tx.all("SELECT * FROM main.native_draft_revisions WHERE draft_id=? ORDER BY rev", [
					item.draftId,
				]),
			);
		const beforeRevisions = revisionRows();
		let appended = false;
		let failure: unknown;
		try {
			f.store.write((tx) => {
				f.onWall = () => {
					const row = tx.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [
						item.id,
					]);
					if (row?.state !== "NEEDS_REAPPROVAL") return;
					f.onWall = undefined;
					const current = f.revisions.currentInTransaction(tx, item.binding);
					const next = f.revisions.appendInTransaction(tx, {
						...item.binding,
						expectedRev: item.rev,
						author: { kind: "owner", id: USER },
						content: { ...current.revision.content, body: "Changed synthetic restored body" },
						flags: current.revision.flags,
					});
					appended =
						next.revision.rev === item.rev + 1 &&
						next.revision.contentSha256 !== item.revisionContentHash &&
						next.lockId === null;
				};
				return resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx);
			});
		} catch (error) {
			failure = error;
		}
		expect(appended).toBe(true);
		expect(failure instanceof ProposalError).toBe(true);
		expect(f.snapshot()).toEqual(before);
		expect(revisionRows()).toEqual(beforeRevisions);
	});

	test("refuses a genuinely consumed freeze without releasing or rewriting history", async () => {
		const f = await fixture();
		const item = f.store.write((tx) => f.seed(tx, "APPROVED"));
		f.store.write((tx) => {
			const proof = f.freeze.proofInTransaction(tx, item.binding, item.id);
			f.freeze.consumeInTransaction(tx, proof);
		});
		const before = f.snapshot();
		expect(() =>
			f.store.write((tx) => resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)),
		).toThrow(ProposalError);
		expect(f.snapshot()).toEqual(before);
	});

	test("joins outbox, freeze, audit and event changes to a later original rollback", async () => {
		const f = await fixture();
		f.store.write((tx) => f.seed(tx, "SCHEDULED"));
		const before = f.snapshot();
		let reduced = false;
		expect(() =>
			f.store.write((tx) => {
				reduced = resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx) === 1;
				throw new Error("Whole restore rollback witness");
			}),
		).toThrow("Whole restore rollback witness");
		expect(reduced).toBe(true);
		expect(f.snapshot()).toEqual(before);
	});

	test("pages beyond 128 records and preserves monotonic update times on a backwards clock", async () => {
		const f = await fixture();
		f.store.write((tx) => {
			for (let index = 0; index < 129; index++) f.seed(tx, "APPROVED");
		});
		f.wall = NOW - 1_000;
		expect(
			f.store.write((tx) => resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)),
		).toBe(129);
		f.store.read((tx) => {
			expect(tx.all("SELECT DISTINCT state FROM main.outbox")).toEqual([
				{ state: "NEEDS_REAPPROVAL" },
			]);
			const rows = tx.all<{ payload: string }>("SELECT payload FROM main.outbox");
			expect(rows).toHaveLength(129);
			for (const row of rows) expect(JSON.parse(row.payload).updatedAt).toBe(NOW);
			f.audit.verify(tx);
			expect(tx.get<{ count: number }>("SELECT count(*) AS count FROM main.events")?.count).toBe(
				129,
			);
		});
	});

	for (const { label, offset, expected } of [
		{ label: "just before", offset: -1, expected: 0 },
		{ label: "exactly at", offset: 0, expected: 1 },
		{ label: "after", offset: 1, expected: 1 },
	]) {
		test(`expires restored pending proposals ${label} the stored TTL boundary`, async () => {
			const f = await fixture();
			const [pending, approved, scheduled] = f.store.write((tx) => [
				f.seed(tx, "PENDING_APPROVAL"),
				f.seed(tx, "APPROVED"),
				f.seed(tx, "SCHEDULED"),
			]);
			if (!pending || !approved || !scheduled) throw new Error("Original proposal rows missing");
			const before = f.snapshot();
			f.wall = pending.expiresAt + offset;
			expect(
				f.store.write((tx) => expireNativeOutboxPendingForRestoreInTransaction(f.target, tx)),
			).toBe(expected);
			if (expected === 0) {
				expect(f.snapshot()).toEqual(before);
			} else {
				expect(f.target.write((tx) => f.target.get(tx, pending.id))).toEqual({
					...pending,
					state: "EXPIRED",
					stateReason: null,
					updatedAt: f.wall,
				});
				f.store.write((tx) => {
					expect(f.revisions.currentInTransaction(tx, pending.binding).lockId).toBeNull();
					expect(() => f.freeze.proofInTransaction(tx, pending.binding, pending.id)).toThrow();
					f.audit.verify(tx);
					expect(
						tx.all("SELECT action,refs FROM main.audit_events WHERE action='outbox.expired'"),
					).toEqual([{ action: "outbox.expired", refs: canonicalize({ outbox: pending.id }) }]);
					expect(tx.all("SELECT kind,ids,data_class FROM main.events ORDER BY seq")).toEqual([
						{
							kind: "outbox.changed",
							ids: JSON.stringify([pending.id]),
							data_class: "slack.content",
						},
					]);
				});
			}
			for (const item of [approved, scheduled]) {
				expect(f.target.write((tx) => f.target.get(tx, item.id))).toEqual(item);
				f.store.write((tx) => {
					expect(f.freeze.proofInTransaction(tx, item.binding, item.id)).toBeDefined();
				});
			}
			const settled = f.snapshot();
			expect(
				f.store.write((tx) => expireNativeOutboxPendingForRestoreInTransaction(f.target, tx)),
			).toBe(0);
			expect(f.snapshot()).toEqual(settled);
		});
	}

	test("rolls a genuine pending expiry and its freeze, audit and event back on a later write error", async () => {
		const f = await fixture();
		const pending = f.store.write((tx) => f.seed(tx, "PENDING_APPROVAL"));
		const before = f.snapshot();
		f.wall = pending.expiresAt;
		let expired = false;
		expect(() =>
			f.store.write((tx) => {
				expired = expireNativeOutboxPendingForRestoreInTransaction(f.target, tx) === 1;
				throw new Error("Original pending expiry rollback witness");
			}),
		).toThrow("Original pending expiry rollback witness");
		expect(expired).toBe(true);
		expect(f.snapshot()).toEqual(before);
	});

	test("authenticates a later pending row before committing an earlier genuine expiry", async () => {
		const f = await fixture();
		const [first, later] = f.store.write((tx) => [
			f.seed(tx, "PENDING_APPROVAL"),
			f.seed(tx, "PENDING_APPROVAL"),
		]);
		if (!first || !later) throw new Error("Original pending rows missing");
		f.store.write((tx) =>
			tx.run("UPDATE main.outbox SET mac=? WHERE id=?", ["0".repeat(64), later.id]),
		);
		const before = f.snapshot();
		f.wall = first.expiresAt;
		let observed = false;
		let failure: unknown;
		try {
			f.store.write((tx) => {
				f.onWall = () => {
					const row = tx.get<{ state: string }>("SELECT state FROM main.outbox WHERE id=?", [
						first.id,
					]);
					if (row?.state !== "EXPIRED") return;
					observed = true;
					f.onWall = undefined;
				};
				return expireNativeOutboxPendingForRestoreInTransaction(f.target, tx);
			});
		} catch (error) {
			failure = error;
		}
		expect(observed).toBe(true);
		expect(failure instanceof ProposalError).toBe(true);
		expect(f.snapshot()).toEqual(before);
	});

	test("refuses foreign, read, copied and expired expiry inputs before either original clock", async () => {
		const f = await fixture();
		const foreign = await fixture();
		const pending = f.store.write((tx) => f.seed(tx, "PENDING_APPROVAL"));
		const otherPending = foreign.store.write((tx) => foreign.seed(tx, "PENDING_APPROVAL"));
		f.wall = pending.expiresAt;
		foreign.wall = otherPending.expiresAt;
		let retired: SqlTransaction | undefined;
		f.store.write((tx) => {
			retired = tx;
		});
		const expired = retired;
		if (!expired) throw new Error("Original expired transaction missing");
		const before = f.snapshot();
		const foreignBefore = foreign.snapshot();
		let ownClockCalls = 0;
		let foreignClockCalls = 0;
		f.onWall = () => {
			ownClockCalls++;
		};
		foreign.onWall = () => {
			foreignClockCalls++;
		};
		const attempts = [
			() =>
				foreign.store.write((tx) => {
					expireNativeOutboxPendingForRestoreInTransaction(f.target, tx);
				}),
			() =>
				f.store.read((tx) => {
					expireNativeOutboxPendingForRestoreInTransaction(f.target, tx as SqlTransaction);
				}),
			() =>
				f.store.write((tx) => {
					expireNativeOutboxPendingForRestoreInTransaction(f.target, Object.create(tx));
				}),
			() => expireNativeOutboxPendingForRestoreInTransaction(f.target, expired),
			() =>
				f.store.write((tx) => {
					expireNativeOutboxPendingForRestoreInTransaction(
						Object.create(NativeOutboxProposals.prototype),
						tx,
					);
				}),
			() =>
				f.store.write((tx) => {
					expireNativeOutboxPendingForRestoreInTransaction(new Proxy(f.target, {}), tx);
				}),
		];
		for (const attempt of attempts) {
			expect(attempt).toThrow(ProposalError);
			expect(ownClockCalls).toBe(0);
			expect(foreignClockCalls).toBe(0);
			expect(f.snapshot()).toEqual(before);
			expect(foreign.snapshot()).toEqual(foreignBefore);
		}
	});
});
