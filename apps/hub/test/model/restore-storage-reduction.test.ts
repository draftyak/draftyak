import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { canonicalize } from "@draftyak/protocol/jcs";
import { exportSpki } from "@draftyak/protocol/sign";
import { type CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
import fc from "fast-check";
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
	resetNativeOutboxProposalsForRestoreInTransaction,
} from "../../src/outbox/propose.ts";
import {
	ApprovalRestoreError,
	NativeApprovalRestore,
	resetNativeApprovalStorageForRestoreInTransaction,
} from "../../src/outbox/restore-approvals.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";

const NOW = 1_800_000_000_000;
const identifier = (value: number): string => String(value).padStart(26, "0");
const USER = identifier(1);
const ACCOUNT = identifier(2);
const DEVICE = identifier(3);
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
	if (!stat.isFile() || stat.isSymbolicLink())
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
	approvals!: NativeApprovalRestore;
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
			fs.mkdtempSync(path.join(os.tmpdir(), "dy-restore-storage-model-")),
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
		this.approvals = new NativeApprovalRestore(this.store, this.audit, this.key, this.clock);
		const spki = exportSpki(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey);
		this.store.write((tx) => {
			tx.run("INSERT INTO main.users(id,created_at) VALUES(?,?)", [USER, NOW]);
			tx.run("UPDATE main.device_authority SET owner_user_id=? WHERE singleton=1", [USER]);
			tx.run(
				`INSERT INTO main.devices(id,user_id,role,name,spki_sha256,approval_key,key_class,
 claim_window,paired_epoch,paired_at) VALUES(?,?,'device','synthetic archive',?,?,'dev','pairing',0,?)`,
				[
					DEVICE,
					USER,
					createHash("sha256").update(Buffer.from(spki, "base64url")).digest("hex"),
					spki,
					NOW,
				],
			);
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

	seedApproval(
		tx: SqlTransaction,
		state: "live" | "consumed" | "voided" = "live",
		notBefore: number | null = null,
		corrupt = false,
	) {
		if (!this.key || !this.audit) throw new Error("Original fixture services unavailable");
		const serial = ++this.serial,
			approval = identifier(100_000 + serial),
			outbox = identifier(200_000 + serial),
			challenge = identifier(300_000 + serial);
		tx.run(
			`INSERT INTO main.approval_challenges(id,nonce,kind,target_id,device_id,user_id,data_class,
 epoch,target_version,statement,issued_at,expires_at) VALUES(?,?,'approval.send.v1',?,?,?,'slack.content',1,1,?,?,?)`,
			[
				challenge,
				randomBytes(16).toString("base64url"),
				outbox,
				DEVICE,
				USER,
				Buffer.from("Synthetic archived challenge DATA"),
				NOW,
				NOW + 120_000,
			],
		);
		this.audit.append(tx, {
			id: identifier(400_000 + serial),
			at: NOW,
			action: state === "voided" ? "approval.lapsed" : "approval.accepted",
			actor: { kind: "device", id: DEVICE },
			refs: { approval, outbox },
		});
		const head = tx.get<{ audit_seq: number; audit_mac: string }>(
			"SELECT audit_seq,audit_head AS audit_mac FROM main.audit_meta WHERE singleton=1",
		);
		if (!head) throw new Error("Original audit head missing");
		const facts = {
			id: approval,
			outbox_id: outbox,
			account_id: ACCOUNT,
			data_class: "slack.content",
			challenge_id: challenge,
			device_id: DEVICE,
			user_id: USER,
			content_hash: "1".repeat(64),
			flags_hash: "2".repeat(64),
			epoch: 1,
			target_version: 1,
			iat: NOW,
			not_before: notBefore,
			deliver_by: NOW + 60_000,
			accepted_at: NOW,
			consumed_at: state === "consumed" ? NOW + 1 : null,
			voided_at: state === "voided" ? NOW + 1 : null,
			void_reason: state === "voided" ? "policy" : null,
			...head,
		};
		const key = this.key.derive("approvals");
		let mac: string;
		try {
			mac = createHmac("sha256", key)
				.update("draftyak/native-approval/v1\n")
				.update(canonicalize(facts))
				.digest("hex");
		} finally {
			key.fill(0);
		}
		if (corrupt) mac = "0".repeat(64);
		const names = Object.keys(facts);
		tx.run(
			`INSERT INTO main.approvals(${names.join(",")},mac) VALUES(${names.map(() => "?").join(",")},?)`,
			[...Object.values(facts), mac],
		);
		return { ...facts, mac };
	}

	snapshot() {
		return this.store.read((tx) => ({
			outbox: tx.all<Record<string, unknown>>("SELECT * FROM main.outbox ORDER BY id"),
			approvals: tx.all<Record<string, unknown>>("SELECT * FROM main.approvals ORDER BY id"),
			challenges: tx.all("SELECT * FROM main.approval_challenges ORDER BY id"),
			drafts: tx.all("SELECT * FROM main.native_drafts ORDER BY id"),
			revisions: tx.all("SELECT * FROM main.native_draft_revisions ORDER BY draft_id,rev"),
			locks: tx.all("SELECT * FROM main.native_draft_locks ORDER BY id"),
			audit: tx.all<Record<string, unknown>>("SELECT * FROM main.audit_events ORDER BY seq"),
			auditHead: tx.get("SELECT * FROM main.audit_meta WHERE singleton=1"),
			events: tx.all<Record<string, unknown>>("SELECT * FROM main.events ORDER BY seq"),
			eventHead: tx.get("SELECT * FROM main.event_meta WHERE singleton=1"),
		}));
	}
	close(): void {
		if (this.closed) return;
		if (this.uncertain) throw new Error("Proposal fixture custody uncertain");
		this.onWall = undefined;
		this.target?.destroy();
		this.approvals?.destroy();
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

const owners = new Set<Fixture>();
const bodies = new Set<Promise<void>>();

async function withFixture(body: (f: Fixture) => void): Promise<void> {
	if (owners.size) throw new Error("Earlier native fixture is not retired");
	const f = new Fixture();
	owners.add(f);
	try {
		await f.initialize();
		body(f);
	} finally {
		// A case cannot yield to the next generated acquisition until its original close returns.
		f.close();
		owners.delete(f);
	}
}

afterEach(async () => {
	await Promise.allSettled([...bodies]);
	bodies.clear();
	// Failed cleanup is retained; it must not be retried or hidden by fast-check shrinking.
	if (owners.size) throw new Error("Storage model fixture cleanup incomplete");
});

const proposalStates: State[] = [
	"PENDING_APPROVAL",
	"APPROVED",
	"SCHEDULED",
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
const caseArbitrary = fc.record({
	selected: fc.constantFrom<State>("APPROVED", "SCHEDULED"),
	extra: fc.array(fc.constantFrom(...proposalStates), { maxLength: 2 }),
	archivedApproval: fc.constantFrom("live" as const, "consumed" as const, "voided" as const),
	scheduled: fc.boolean(),
	fault: fc.constantFrom("late" as const, "corrupt" as const),
	commands: fc.array(
		fc.record({
			operation: fc.constantFrom("expire" as const, "restore" as const),
			offset: fc.constantFrom(-1_000, 0, 1_000, 86_399_999, 86_400_000, 86_400_001),
		}),
		{ minLength: 1, maxLength: 3 },
	),
});
type GeneratedCase = typeof caseArbitrary extends fc.Arbitrary<infer Value> ? Value : never;
type Approval = ReturnType<Fixture["seedApproval"]>;

function stableApproval(row: Record<string, unknown>): Record<string, unknown> {
	const { mac: _mac, audit_seq: _seq, audit_mac: _head, ...facts } = row;
	return facts;
}

function exercise(f: Fixture, generated: GeneratedCase): void {
	const seeded = f.store.write((tx) => ({
		proposals: [generated.selected, "PENDING_APPROVAL" as const, ...generated.extra].map((state) =>
			f.seed(tx, state),
		),
		approvals: [
			f.seedApproval(tx, "live", generated.scheduled ? NOW + 30_000 : null),
			f.seedApproval(tx, generated.archivedApproval, null),
		],
	}));
	const proposals = new Map(seeded.proposals.map((row) => [row.id, { ...row }]));
	const approvals = new Map<string, Approval>(seeded.approvals.map((row) => [row.id, { ...row }]));
	const released = new Set<string>();
	const initial = f.snapshot();

	// The first reducer really changes proposal/freeze/audit/event state before either refusal.
	// Catch outside the original write so both reducers and both chained heads must roll back.
	const late = new Error("Synthetic composed restore abort");
	let observedProposalChanges = 0;
	let observedApprovalChanges = 0;
	let observedProposalWrite = false;
	let thrown: unknown;
	try {
		f.store.write((tx) => {
			observedProposalChanges = resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx);
			expect(observedProposalChanges).toBeGreaterThan(0);
			const selected = seeded.proposals[0];
			if (!selected) throw new Error("Generated selected proposal absent");
			const changed = tx.get<{ payload: string }>("SELECT payload FROM main.outbox WHERE id=?", [
				selected.id,
			]);
			expect(JSON.parse(changed?.payload ?? "null").state).toBe("NEEDS_REAPPROVAL");
			expect(f.revisions.currentInTransaction(tx, selected.binding).lockId).toBeNull();
			observedProposalWrite = true;
			if (generated.fault === "corrupt") {
				// Authentication must also reject consumed and already-voided archived DATA.
				// Insert inside this write: settled rows correctly prohibit later SQL modification.
				f.seedApproval(tx, generated.archivedApproval, null, true);
			}
			observedApprovalChanges = resetNativeApprovalStorageForRestoreInTransaction(f.approvals, tx);
			expect(observedApprovalChanges).toBeGreaterThan(0);
			throw late;
		});
	} catch (error) {
		thrown = error;
	}
	expect(observedProposalChanges).toBeGreaterThan(0);
	expect(observedProposalWrite).toBe(true);
	if (generated.fault === "late") {
		expect(observedApprovalChanges).toBeGreaterThan(0);
		expect(thrown).toBe(late);
	} else {
		expect(thrown).toBeInstanceOf(ApprovalRestoreError);
	}
	expect(f.snapshot()).toEqual(initial);

	const checkModel = (): void => {
		const saved = f.snapshot();
		expect(saved.outbox.map((row) => row.id)).toEqual([...proposals.keys()].sort());
		expect(saved.approvals.map((row) => row.id)).toEqual([...approvals.keys()].sort());
		expect(saved.revisions).toEqual(initial.revisions);
		expect(saved.challenges).toEqual(initial.challenges);
		for (const row of saved.outbox) {
			expect(JSON.parse(String(row.payload))).toEqual(proposals.get(String(row.id)));
			if (!released.has(String(row.id))) {
				expect(row).toEqual(initial.outbox.find((original) => original.id === row.id));
			}
		}
		for (const row of saved.approvals) {
			const model = approvals.get(String(row.id));
			if (!model) throw new Error("Unmodeled approval");
			expect(stableApproval(row)).toEqual(stableApproval(model));
			if (model.void_reason !== "restored") expect(row).toEqual(model);
		}
		f.store.write((tx) => {
			for (const original of seeded.proposals) {
				const current = f.revisions.currentInTransaction(tx, original.binding);
				expect(current.lockId).toBe(released.has(original.id) ? null : original.lockId);
			}
		});
		f.store.read((tx) => f.audit.verify(tx));
	};

	const command = (operation: "expire" | "restore", offset: number): void => {
		f.wall = NOW + offset;
		let proposalCount = 0;
		let approvalCount = 0;
		for (const [id, row] of proposals) {
			const selected =
				operation === "restore"
					? row.state === "APPROVED" || row.state === "SCHEDULED"
					: row.state === "PENDING_APPROVAL" && f.wall >= row.expiresAt;
			if (selected) {
				proposals.set(id, {
					...row,
					state: operation === "restore" ? "NEEDS_REAPPROVAL" : "EXPIRED",
					stateReason: operation === "restore" ? "restored" : null,
					updatedAt: Math.max(f.wall, row.updatedAt),
				});
				released.add(id);
				proposalCount++;
			}
		}
		if (operation === "restore") {
			for (const [id, row] of approvals) {
				if (row.consumed_at === null && row.voided_at === null) {
					approvals.set(id, {
						...row,
						voided_at: Math.max(f.wall, row.accepted_at),
						void_reason: "restored",
					});
					approvalCount++;
				}
			}
		}
		const before = f.snapshot();
		const counts = f.store.write((tx) => ({
			proposals:
				operation === "restore"
					? resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)
					: expireNativeOutboxPendingForRestoreInTransaction(f.target, tx),
			approvals:
				operation === "restore"
					? resetNativeApprovalStorageForRestoreInTransaction(f.approvals, tx)
					: 0,
		}));
		expect(counts).toEqual({ proposals: proposalCount, approvals: approvalCount });
		const after = f.snapshot();
		expect(after.audit.slice(0, before.audit.length)).toEqual(before.audit);
		expect(after.events.slice(0, before.events.length)).toEqual(before.events);
		const newAudit = after.audit.slice(before.audit.length);
		expect(
			newAudit.filter(
				(row) => row.action === (operation === "restore" ? "outbox.restored" : "outbox.expired"),
			),
		).toHaveLength(proposalCount);
		expect(newAudit.filter((row) => row.action === "approval.lapsed")).toHaveLength(approvalCount);
		expect(
			after.events.slice(before.events.length).filter((row) => row.kind === "outbox.changed"),
		).toHaveLength(proposalCount + approvalCount);
		if (proposalCount + approvalCount === 0) expect(after).toEqual(before);
		checkModel();
		// Repeating this exact command cannot append a new event or audit receipt.
		expect(
			f.store.write((tx) => ({
				proposals:
					operation === "restore"
						? resetNativeOutboxProposalsForRestoreInTransaction(f.target, tx)
						: expireNativeOutboxPendingForRestoreInTransaction(f.target, tx),
				approvals:
					operation === "restore"
						? resetNativeApprovalStorageForRestoreInTransaction(f.approvals, tx)
						: 0,
			})),
		).toEqual({ proposals: 0, approvals: 0 });
		expect(f.snapshot()).toEqual(after);
	};
	checkModel();
	for (const action of generated.commands) command(action.operation, action.offset);
	command("restore", -1_000);
	command("expire", 86_400_000);
}

describe("composed stored restore reductions", () => {
	// Ten bounded batches preserve the default test timeout while exercising 500 real cases.
	for (let batch = 0; batch < 10; batch++) {
		it(`matches the storage model and atomic rollback (batch ${batch + 1}/10)`, () => {
			if (bodies.size) throw new Error("Earlier property body is not joined");
			const original = Promise.resolve().then(() =>
				fc.assert(
					fc.asyncProperty(caseArbitrary, (generated) =>
						withFixture((f) => exercise(f, generated)),
					),
					{ numRuns: 50 },
				),
			);
			bodies.add(original);
			return original;
		});
	}
});
