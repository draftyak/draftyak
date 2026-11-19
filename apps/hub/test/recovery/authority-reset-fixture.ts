import { createHash, createHmac, generateKeyPairSync, randomBytes } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { exportSpki } from "@draftyak/protocol/sign";
import { type CurrentSendSnapshotV1, contentHash } from "@draftyak/protocol/snapshot";
import { NativeAccounts } from "../../src/accounts/records.ts";
import { AuditChain } from "../../src/audit/chain.ts";
import { CredentialVault } from "../../src/credentials/vault.ts";
import { NativeDraftFreeze, NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { EventLog } from "../../src/events/log.ts";
import { HubIdentity } from "../../src/identity/hub-key.ts";
import { PinError, PinService } from "../../src/identity/pin.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import { HUB_NAMESPACES, migrateHubSchemas } from "../../src/kernel/namespaces.ts";
import type { NativeProposalRecord } from "../../src/outbox/propose.ts";
import { SendTicketStorage } from "../../src/outbox/ticket-storage.ts";
import { encodeBackupArtifactHeader } from "../../src/recovery/backup-artifact.ts";
import { createRecoveryBinding } from "../../src/recovery/backup-bindings.ts";
import { generateRecoveryCode } from "../../src/recovery/recovery-code.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";

export const OWNER = "00000000000000000000000001";
export const OLD_PIN = "31415926";
export const NEW_PIN = "27182818";
export const FULL_EMAIL_ACCOUNT = "00000000000000000000000010";
export const FULL_CHAT_ACCOUNT = "00000000000000000000000011";
export const READ_ONLY_ACCOUNT = "00000000000000000000000012";
export const EXPIRED_PENDING_PROPOSAL = "00000000000000000000000040";
export const FRESH_PENDING_PROPOSAL = "00000000000000000000000041";
export const APPROVED_PROPOSAL = "00000000000000000000000042";
export const SCHEDULED_PROPOSAL = "00000000000000000000000043";
export const IN_FLIGHT_PROPOSALS = [
	["00000000000000000000000044", "SENDING"],
	["00000000000000000000000045", "RETRY_WAIT"],
	["00000000000000000000000046", "UNKNOWN"],
] as const;
export const LIVE_STORED_APPROVAL = "00000000000000000000000050";
export const CONSUMED_STORED_APPROVAL = "00000000000000000000000051";
export const VOIDED_STORED_APPROVAL = "00000000000000000000000052";
export const ARCHIVED_SEND_STATES = [
	"ISSUED",
	"REDEEMED",
	"SENDING",
	"SENT",
	"FAILED",
	"UNKNOWN",
	"NEEDS_REAPPROVAL",
	"EXPIRED",
] as const;
const AT = 1_800_000_000_000;
// Historical ticket time precedes the genuine current restore wall clock.
const TICKET_AT = 1_000;
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export interface AuthorityArchiveOptions {
	readonly inFlightProposals?: boolean;
	readonly invalidLiveApprovalMac?: boolean;
}

export interface AuthorityImageState {
	epoch: number;
	bootstrap: number;
	owner: string;
	pinVersion: number;
	failures: number;
	lockedUntil: number;
	pinDigest: string;
	identityDigest: string;
	devices: readonly Record<string, unknown>[];
	auditSequence: number;
	accounts: readonly {
		id: string;
		user_id: string;
		plugin_instance_id: string;
		generation: number;
		account_json: string | null;
	}[];
	events: readonly {
		seq: number;
		user_id: string;
		account_id: string | null;
		data_class: string;
		kind: string;
		ids: string;
		at: number;
	}[];
	outbox: readonly Record<string, unknown>[];
	drafts: readonly Record<string, unknown>[];
	draftRevisions: readonly Record<string, unknown>[];
	draftLocks: readonly Record<string, unknown>[];
	auditEvents: readonly Record<string, unknown>[];
	approvals: readonly Record<string, unknown>[];
	approvalChallenges: readonly Record<string, unknown>[];
	sendAttempts: readonly Record<string, unknown>[];
}

interface CopyOwner {
	store: HubStore | undefined;
	key: MasterKey;
	audit: AuditChain | undefined;
	pins: PinService | undefined;
	closed: boolean;
	openUncertain: boolean;
}

/** Ordinary own locked test dependency only; no installed-App authentication claim. */
export function requiredAuthorityResetBinding(): string {
	try {
		const require = createRequire(import.meta.url);
		const entry = realpathSync(require.resolve("better-sqlite3-multiple-ciphers"));
		const packageRoot = path.dirname(path.dirname(entry));
		const metadata: unknown = JSON.parse(
			readFileSync(path.join(packageRoot, "package.json"), "utf8"),
		);
		if (metadata === null || typeof metadata !== "object") throw new Error();
		const technical = metadata as { name?: unknown; version?: unknown; main?: unknown };
		if (
			technical.name !== "better-sqlite3-multiple-ciphers" ||
			technical.version !== "13.0.3" ||
			technical.main !== "lib/index.js" ||
			entry !== realpathSync(path.join(packageRoot, "lib", "index.js"))
		)
			throw new Error();
		const binding = realpathSync(
			path.join(packageRoot, "prebuilds", `${process.platform}-${process.arch}.node`),
		);
		const file = lstatSync(binding);
		if (
			!path.isAbsolute(binding) ||
			path.extname(binding) !== ".node" ||
			!file.isFile() ||
			file.isSymbolicLink()
		)
			throw new Error();
		return binding;
	} catch {
		throw new Error("Authority reset test dependency unavailable");
	}
}

function seedRows(tx: SqlTransaction, binding: Buffer): void {
	tx.run("INSERT INTO main.users(id,created_at) VALUES(?,?)", [OWNER, AT]);
	tx.run(
		"UPDATE main.device_authority SET epoch=1,bootstrap_done=0,owner_user_id=? WHERE singleton=1",
		[OWNER],
	);
	tx.run("UPDATE main.device_authority SET bootstrap_done=1 WHERE singleton=1");
	for (const [index, revoked] of [false, true].entries()) {
		const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey;
		const spki = exportSpki(publicKey);
		const id = `0000000000000000000000000${index + 2}`;
		// These are invented persisted ROW DATA, never an accepted peer, grant or Session.
		tx.run(
			"INSERT INTO main.devices(id,user_id,role,name,spki_sha256,approval_key,key_class,claim_window,paired_epoch,paired_at,capabilities,confirmed_epoch,confirmed_via,confirmed_preset,confirmed_by,confirmed_at,revoked_at) VALUES(?,?,'device',?,?,?,'dev','sidecar',1,?,31,1,'bootstrap','desktop',NULL,?,?)",
			[
				id,
				OWNER,
				`fixture-${index}`,
				digest(Buffer.from(spki, "base64url")),
				spki,
				AT,
				AT,
				revoked ? AT + 1 : null,
			],
		);
	}
	tx.run("INSERT INTO main.native_backup_recovery(singleton,binding) VALUES(1,?)", [binding]);
}

/** Genuine account producer with synthetic metadata only; no credential or send permission. */
function seedAccounts(store: HubStore, audit: AuditChain): void {
	const database = new WorkDatabase(store);
	const events = new EventLog(database, () => AT);
	const accounts = new NativeAccounts(database, events, audit, () => AT);
	const common = {
		userId: OWNER,
		status: "active" as const,
		deletionDeadline: null,
		historyLimitDays: 30,
		disclosureVersion: 1,
		createdAt: AT,
	};
	database.write((scope) => {
		accounts.create(scope, {
			...common,
			id: FULL_EMAIL_ACCOUNT,
			pluginInstanceId: "00000000000000000000000020",
			alias: "synthetic-email",
			mode: "full",
			channel: "email",
			address: "restore-fixture@example.test",
		});
		accounts.create(scope, {
			...common,
			id: FULL_CHAT_ACCOUNT,
			pluginInstanceId: "00000000000000000000000021",
			alias: "synthetic-chat",
			mode: "full",
			channel: "chat",
			teamId: "T-SYNTHETIC",
			selfUserId: "U-SYNTHETIC",
		});
		accounts.create(scope, {
			...common,
			id: READ_ONLY_ACCOUNT,
			pluginInstanceId: "00000000000000000000000022",
			alias: "synthetic-read-only",
			mode: "read_only",
			channel: "email",
			address: "readonly-fixture@example.test",
		});
	});
}

/** Authenticated synthetic archive DATA; no approval, peer, grant or send is produced. */
function seedProposals(
	store: HubStore,
	_audit: AuditChain,
	key: MasterKey,
	identity: HubIdentity,
	revisions: NativeDraftRevisions,
	withInFlight: boolean,
): void {
	const freeze = new NativeDraftFreeze(revisions);
	const outboxKey = key.derive("outbox");
	try {
		store.write((tx) => {
			const rows: Array<readonly [string, NativeProposalRecord["state"], number]> = [
				[EXPIRED_PENDING_PROPOSAL, "PENDING_APPROVAL", 2_000],
				[FRESH_PENDING_PROPOSAL, "PENDING_APPROVAL", 8_000_000_000_000_000],
				[APPROVED_PROPOSAL, "APPROVED", 8_000_000_000_000_000],
				[SCHEDULED_PROPOSAL, "SCHEDULED", 8_000_000_000_000_000],
			];
			if (withInFlight)
				for (const [outboxId, state] of IN_FLIGHT_PROPOSALS)
					rows.push([outboxId, state, 8_000_000_000_000_000]);
			for (const [index, [outboxId, state, expiresAt]] of rows.entries()) {
				const binding = {
					accountId: FULL_CHAT_ACCOUNT,
					conversationId: String(100 + index * 2).padStart(26, "0"),
					draftId: String(101 + index * 2).padStart(26, "0"),
					channel: "chat" as const,
				};
				const created = revisions.createInTransaction(tx, {
					...binding,
					author: { kind: "owner", id: OWNER },
					content: {
						channel: "chat",
						threadTs: null,
						broadcast: false,
						body: "Synthetic archive body",
					},
					flags: [],
				});
				const scheduled = state === "SCHEDULED";
				const pending = state === "PENDING_APPROVAL";
				const snapshot: CurrentSendSnapshotV1 = {
					v: 1,
					hub: identity.hid,
					epoch: 1,
					outbox: outboxId,
					account: FULL_CHAT_ACCOUNT,
					conversation: binding.conversationId,
					kind: "chat",
					body: { text: "Synthetic archive body", footer: "" },
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
					schedule: scheduled
						? {
								kind: "at",
								notBefore: AT + 120_000,
								zone: "UTC",
								localWallTime: `${new Date(AT + 120_000).toISOString().slice(0, 16)}+00:00`,
								latenessSec: 900,
								holdIfNewInbound: false,
							}
						: { kind: "now" },
					source: { draft: binding.draftId, rev: 1, authors: [{ kind: "owner", id: OWNER }] },
				};
				freeze.freezeInTransaction(tx, binding, 1, snapshot);
				const locked = revisions.currentInTransaction(tx, binding);
				if (locked.lockId === null) throw new Error("Synthetic archive freeze missing");
				const value: NativeProposalRecord = {
					id: outboxId,
					userId: OWNER,
					accountId: FULL_CHAT_ACCOUNT,
					draftId: binding.draftId,
					dataClass: "slack.content",
					snapshot,
					contentHash: contentHash(snapshot),
					flags: [],
					flagsHash: created.flagsHash,
					requiredApprovals: 1,
					requiredUsers: [OWNER],
					undoWindowMs: 0,
					expiresAt,
					state,
					stateReason: null,
					binding,
					rev: 1,
					revisionContentHash: locked.revision.contentSha256,
					lockId: locked.lockId,
					notBefore: pending ? null : scheduled ? AT + 120_000 : AT,
					deliverBy: pending ? null : (scheduled ? AT + 120_000 : AT) + 900_000,
					createdAt: 1_000,
					updatedAt: 1_000,
				};
				const receipt = revisions.auditOutboxInTransaction(
					tx,
					pending ? "outbox.proposed" : "outbox.approved",
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
				const mac = createHmac("sha256", outboxKey)
					.update("draftyak/outbox-proposal/v1\n")
					.update(canonicalize(signed))
					.digest("hex");
				tx.run(
					"INSERT INTO main.outbox(id,user_id,account_id,draft_id,state,schedule_kind,payload,audit_seq,mac) VALUES(?,?,?,?,?,?,?,?,?)",
					[...Object.values(signed), mac],
				);
			}
		});
	} finally {
		outboxKey.fill(0);
	}
}

/** Authentic archive row MACs and audit only; no accepting verifier, peer or grant is created. */
function seedStoredApprovals(
	store: HubStore,
	audit: AuditChain,
	key: MasterKey,
	invalidLiveMac: boolean,
): void {
	const device = "00000000000000000000000002";
	const macKey = key.derive("approvals");
	try {
		store.write((tx) => {
			for (const [index, [approval, outbox, state]] of (
				[
					[LIVE_STORED_APPROVAL, APPROVED_PROPOSAL, "live"],
					[CONSUMED_STORED_APPROVAL, SCHEDULED_PROPOSAL, "consumed"],
					[VOIDED_STORED_APPROVAL, FRESH_PENDING_PROPOSAL, "voided"],
				] as const
			).entries()) {
				const challenge = String(60 + index).padStart(26, "0");
				tx.run(
					`INSERT INTO main.approval_challenges(id,nonce,kind,target_id,device_id,user_id,
 data_class,epoch,target_version,statement,issued_at,expires_at)
 VALUES(?,?,'approval.send.v1',?,?,?,'slack.content',1,1,?,?,?)`,
					[
						challenge,
						randomBytes(16).toString("base64url"),
						outbox,
						device,
						OWNER,
						Buffer.from("Synthetic archived approval challenge DATA"),
						AT,
						AT + 120_000,
					],
				);
				audit.append(tx, {
					id: newId(AT),
					at: AT,
					action: state === "voided" ? "approval.lapsed" : "approval.accepted",
					actor: { kind: "device", id: device },
					refs: { approval, outbox },
				});
				const head = tx.get<{ audit_seq: number; audit_mac: string }>(
					"SELECT audit_seq,audit_head AS audit_mac FROM main.audit_meta WHERE singleton=1",
				);
				if (!head) throw new Error("Original archive approval audit missing");
				const facts = {
					id: approval,
					outbox_id: outbox,
					account_id: FULL_CHAT_ACCOUNT,
					data_class: "slack.content",
					challenge_id: challenge,
					device_id: device,
					user_id: OWNER,
					content_hash: "1".repeat(64),
					flags_hash: "2".repeat(64),
					epoch: 1,
					target_version: 1,
					iat: AT,
					not_before: null,
					deliver_by: AT + 60_000,
					accepted_at: AT,
					consumed_at: state === "consumed" ? AT + 1 : null,
					voided_at: state === "voided" ? AT + 1 : null,
					void_reason: state === "voided" ? "policy" : null,
					...head,
				};
				const mac = createHmac("sha256", macKey)
					.update("draftyak/native-approval/v1\n")
					.update(canonicalize(facts))
					.digest("hex");
				const names = Object.keys(facts);
				// Corruption is negative archive DATA, never an accepted verifier result.
				const storedMac =
					invalidLiveMac && state === "live" ? (mac[0] === "0" ? "1" : "0") + mac.slice(1) : mac;
				tx.run(
					`INSERT INTO main.approvals(${names.join(",")},mac) VALUES(${names.map(() => "?").join(",")},?)`,
					[...Object.values(facts), storedMac],
				);
			}
		});
	} finally {
		macKey.fill(0);
	}
}

/** Genuine DATA-kernel history only; no dispatch or accepted approval is produced. */
function seedSendAttempts(
	store: HubStore,
	vault: CredentialVault,
	tickets: SendTicketStorage,
): void {
	const body = Buffer.from("Synthetic archived request DATA");
	const headers = [["content-type", "application/json"]] as const;
	const paths = {
		ISSUED: [],
		REDEEMED: ["REDEEMED"],
		SENDING: ["REDEEMED", "SENDING"],
		SENT: ["REDEEMED", "SENDING", "SENT"],
		FAILED: ["REDEEMED", "SENDING", "FAILED"],
		UNKNOWN: ["REDEEMED", "SENDING", "UNKNOWN"],
		NEEDS_REAPPROVAL: ["NEEDS_REAPPROVAL"],
		EXPIRED: ["EXPIRED"],
	} as const;
	store.write((tx) => {
		const reference = vault.createInTransaction(
			tx,
			{ ownerKind: "account", ownerId: FULL_CHAT_ACCOUNT, kind: "slack-token" },
			{ kind: "slack-token", accessToken: "synthetic-archive-token", expiresAt: null },
			{ kind: "hub", id: null },
		);
		for (const [index, state] of ARCHIVED_SEND_STATES.entries()) {
			const ticket = tickets.insertInTransaction(tx, {
				accountId: FULL_CHAT_ACCOUNT,
				credentialReference: reference,
				credentialGeneration: 1,
				credentialKind: "slack-token",
				epoch: 1,
				contentHash: "1".repeat(64),
				flagsHash: "2".repeat(64),
				notBefore: null,
				deliverBy: TICKET_AT + 900_000,
				outboxId: String(70 + index).padStart(26, "0"),
				instanceId: "00000000000000000000000021",
				method: "POST",
				url: "https://archive.example.test/send",
				contentType: "application/json",
				headers,
				body,
				approvedHeadersSha256: headersSha256(headers),
				approvedBodySha256: sha256Hex(body),
			});
			let row = tickets.find(tx, "ticket_id", ticket.id);
			if (!row) throw new Error("Original archived attempt was not produced");
			for (const next of paths[state]) row = tickets.transition(tx, row, next);
		}
	});
}

function snapshot(store: HubStore): AuthorityImageState {
	return store.read((db) => {
		const authority = db.get<{ epoch: number; bootstrap_done: number; owner_user_id: string }>(
			"SELECT epoch,bootstrap_done,owner_user_id FROM main.device_authority WHERE singleton=1",
		);
		const pin = db.get<{
			version: number;
			failures: number;
			locked_until: number;
			salt: Uint8Array;
			hash: Uint8Array;
		}>("SELECT version,failures,locked_until,salt,hash FROM main.approval_pins WHERE user_id=?", [
			OWNER,
		]);
		const identity = db.get<{
			identity_wrapped: Uint8Array;
			statement_wrapped: Uint8Array;
			identity_cert: string;
		}>(
			"SELECT identity_wrapped,statement_wrapped,identity_cert FROM main.hub_meta WHERE singleton=1",
		);
		const audit = db.get<{ audit_seq: number }>(
			"SELECT audit_seq FROM main.audit_meta WHERE singleton=1",
		);
		if (!authority || !pin || !identity || !audit) throw new Error("Fixture state unavailable");
		return {
			epoch: authority.epoch,
			bootstrap: authority.bootstrap_done,
			owner: authority.owner_user_id,
			pinVersion: pin.version,
			failures: pin.failures,
			lockedUntil: pin.locked_until,
			pinDigest: digest(Buffer.concat([pin.salt, pin.hash])),
			identityDigest: digest(
				Buffer.concat([
					identity.identity_wrapped,
					identity.statement_wrapped,
					Buffer.from(identity.identity_cert),
				]),
			),
			devices: db.all<Record<string, unknown>>("SELECT * FROM main.devices ORDER BY id"),
			auditSequence: audit.audit_seq,
			accounts: db.all<AuthorityImageState["accounts"][number]>(
				"SELECT * FROM main.accounts ORDER BY id",
			),
			events: db.all<AuthorityImageState["events"][number]>(
				"SELECT * FROM main.events ORDER BY seq",
			),
			outbox: db.all<Record<string, unknown>>("SELECT * FROM main.outbox ORDER BY id"),
			drafts: db.all<Record<string, unknown>>("SELECT * FROM main.native_drafts ORDER BY id"),
			draftRevisions: db.all<Record<string, unknown>>(
				"SELECT * FROM main.native_draft_revisions ORDER BY draft_id,rev",
			),
			draftLocks: db.all<Record<string, unknown>>(
				"SELECT * FROM main.native_draft_locks ORDER BY id",
			),
			auditEvents: db.all<Record<string, unknown>>("SELECT * FROM main.audit_events ORDER BY seq"),
			approvals: db.all<Record<string, unknown>>("SELECT * FROM main.approvals ORDER BY id"),
			approvalChallenges: db.all<Record<string, unknown>>(
				"SELECT * FROM main.approval_challenges ORDER BY id",
			),
			sendAttempts: db.all<Record<string, unknown>>(
				"SELECT * FROM main.native_send_attempts ORDER BY outbox_id",
			),
		};
	});
}

export class AuthorityResetFixture {
	readonly root: string;
	readonly destination: string;
	readonly artifactFile: string;
	readonly recoveryCode: Buffer = generateRecoveryCode();
	readonly nativeBinding: string;
	readonly #rawKey = randomBytes(32);
	readonly #key = new MasterKey(this.#rawKey);
	readonly #copies: CopyOwner[] = [];
	readonly #pending = new Set<Promise<unknown>>();
	#source: HubStore | undefined;
	#sourceIdentity: HubIdentity | undefined;
	#sourcePins: PinService | undefined;
	#sourceAudit: AuditChain | undefined;
	#sourceRevisions: NativeDraftRevisions | undefined;
	#sourceVault: CredentialVault | undefined;
	#sourceTickets: SendTicketStorage | undefined;
	#sourceClosed = false;
	#sourceUncertain = false;
	#fileCloseUncertain = false;
	readonly #files = new Set<FileHandle>();
	#closePreparation: (() => Promise<void>) | undefined;
	#closing: Promise<void> | undefined;
	#closed = false;
	#copyNumber = 0;
	#initializationStage = "source-store";
	#rootIdentity: Awaited<ReturnType<typeof fs.lstat>> | undefined;
	imageHandle: FileHandle | undefined;
	imagePath: string | undefined;
	before: AuthorityImageState | undefined;

	private constructor(root: string, nativeBinding: string) {
		this.root = root;
		this.nativeBinding = nativeBinding;
		this.destination = path.join(root, "destination");
		this.artifactFile = path.join(root, "backup.dyk");
	}
	static async create(
		nativeBinding: string,
		owned: AuthorityResetFixture[],
		withProposals = false,
		withApprovals = false,
		withTickets = false,
		archive: AuthorityArchiveOptions = {},
	): Promise<AuthorityResetFixture> {
		const parent = await fs.realpath(os.tmpdir());
		const root = await fs.mkdtemp(path.join(parent, "draftyak-authority-reset-"));
		const fixture = new AuthorityResetFixture(root, nativeBinding);
		// Retain the original owner before initialization or cleanup can reject.
		owned.push(fixture);
		fixture.#rootIdentity = await fs.lstat(root);
		try {
			await fixture.#initialize(withProposals, withApprovals, withTickets, archive);
			return fixture;
		} catch (initialError) {
			const failure = new Error(
				`Fixture initialization failed at ${fixture.#initializationStage}`,
				{ cause: initialError },
			);
			try {
				await fixture.close();
			} catch (cleanupError) {
				throw new AggregateError(
					[failure, cleanupError],
					"Fixture initialization and cleanup failed",
					{ cause: initialError },
				);
			}
			throw failure;
		}
	}
	async #initialize(
		withProposals: boolean,
		withApprovals: boolean,
		withTickets: boolean,
		archive: AuthorityArchiveOptions,
	): Promise<void> {
		if (withApprovals && !withProposals)
			throw new Error("Archive approvals require original outbox DATA");
		if (archive.inFlightProposals && !withProposals)
			throw new Error("In-flight archive DATA requires proposals");
		if (archive.invalidLiveApprovalMac && !withApprovals)
			throw new Error("Invalid approval archive DATA requires stored approvals");
		await fs.mkdir(this.destination, { mode: 0o700 });
		const filename = path.join(this.root, "source.db");
		this.#sourceUncertain = true;
		const store = new HubStore({
			filename,
			create: true,
			nativeBinding: this.nativeBinding,
			masterKey: this.#key,
			migrations: HUB_NAMESPACES,
		});
		this.#source = store;
		this.#sourceUncertain = false;
		this.#initializationStage = "source-migrations";
		await migrateHubSchemas(store);
		this.#initializationStage = "source-identity";
		const identity = await HubIdentity.loadOrCreate(store, this.#key);
		this.#sourceIdentity = identity;
		const auditKey = this.#key.derive("audit");
		let audit: AuditChain;
		try {
			audit = new AuditChain(auditKey);
		} finally {
			auditKey.fill(0);
		}
		this.#sourceAudit = audit;
		this.#initializationStage = "source-pin-service";
		const pins = new PinService(store, audit);
		this.#sourcePins = pins;
		const capsule = this.#key.wrapRecovery(this.recoveryCode);
		const binding = createRecoveryBinding(this.#key, capsule);
		let encrypted: Buffer | undefined;
		let header: Buffer | undefined;
		try {
			this.#initializationStage = "synthetic-row-seed";
			store.write((tx) => seedRows(tx, binding));
			this.#initializationStage = "synthetic-account-producer";
			seedAccounts(store, audit);
			if (withProposals) {
				this.#initializationStage = "synthetic-proposal-data";
				this.#sourceRevisions = new NativeDraftRevisions(store, audit, this.#key);
				seedProposals(
					store,
					audit,
					this.#key,
					identity,
					this.#sourceRevisions,
					archive.inFlightProposals === true,
				);
				this.#sourceRevisions.destroy();
				this.#sourceRevisions = undefined;
			}
			if (withApprovals) {
				this.#initializationStage = "synthetic-approval-data";
				seedStoredApprovals(store, audit, this.#key, archive.invalidLiveApprovalMac === true);
			}
			if (withTickets) {
				this.#initializationStage = "synthetic-ticket-data";
				const vault = new CredentialVault(store, audit, this.#key);
				this.#sourceVault = vault;
				const tickets = new SendTicketStorage(store, audit, vault, this.#key, {
					wallMs: () => TICKET_AT,
					monotonicMs: () => 0,
				});
				this.#sourceTickets = tickets;
				seedSendAttempts(store, vault, tickets);
				tickets.destroy();
				this.#sourceTickets = undefined;
				await vault.drain();
				this.#sourceVault = undefined;
			}
			this.#initializationStage = "source-pin-initialization";
			await pins.initialize(OWNER, OLD_PIN);
			store.write((tx) =>
				tx.run("UPDATE main.approval_pins SET failures=2,locked_until=1 WHERE user_id=?", [OWNER]),
			);
			this.before = snapshot(store);
			store.read((db) => audit.verify(db));
			pins.lock();
			identity.lock();
			this.#initializationStage = "source-checkpoint-close";
			store.checkpoint();
			store.close();
			this.#sourceClosed = true;
			this.#initializationStage = "artifact-framing";
			encrypted = await fs.readFile(filename);
			header = encodeBackupArtifactHeader(
				capsule,
				binding,
				encrypted.byteLength,
				digest(encrypted),
			);
			const file = await fs.open(this.artifactFile, "wx", 0o600);
			this.#files.add(file);
			const writeOrCloseFailures: unknown[] = [];
			try {
				await file.writeFile(Buffer.concat([header, encrypted]));
				await file.sync();
			} catch (error) {
				writeOrCloseFailures.push(error);
			}
			try {
				await file.close();
				if (file.fd !== -1) {
					this.#fileCloseUncertain = true;
					writeOrCloseFailures.push(new Error("Fixture descriptor closure incomplete"));
				} else {
					this.#files.delete(file);
				}
			} catch (error) {
				this.#fileCloseUncertain = true;
				writeOrCloseFailures.push(error);
			}
			if (writeOrCloseFailures.length)
				throw new AggregateError(writeOrCloseFailures, "Fixture artifact write or close failed");
			this.#initializationStage = "initialized";
		} finally {
			pins.lock();
			identity.lock();
			if (!this.#sourceVault && !this.#sourceTickets) audit.destroy();
			capsule.fill(0);
			binding.fill(0);
			encrypted?.fill(0);
			header?.fill(0);
		}
	}
	registerPreparation(close: () => Promise<void>): void {
		if (this.#closePreparation) throw new Error("Fixture preparation already registered");
		this.#closePreparation = close;
	}
	track<T>(promise: Promise<T>): Promise<T> {
		this.#pending.add(promise);
		void promise.then(
			() => this.#pending.delete(promise),
			() => this.#pending.delete(promise),
		);
		return promise;
	}
	/** Reads a separate genuine Store only after the production checkpoint. */
	async readCopy(pin?: string): Promise<{ state: AuthorityImageState; pinAccepted?: boolean }> {
		if (!this.imagePath) throw new Error("Fixture image unavailable");
		const filename = path.join(this.root, `readback-${++this.#copyNumber}.db`);
		await fs.copyFile(this.imagePath, filename, constants.COPYFILE_EXCL);
		const key = new MasterKey(this.#rawKey);
		const owner: CopyOwner = {
			store: undefined,
			key,
			audit: undefined,
			pins: undefined,
			closed: false,
			openUncertain: true,
		};
		this.#copies.push(owner);
		try {
			const store = new HubStore({
				filename,
				nativeBinding: this.nativeBinding,
				masterKey: key,
				migrations: HUB_NAMESPACES,
			});
			owner.store = store;
			owner.openUncertain = false;
			const auditKey = key.derive("audit");
			let audit: AuditChain;
			try {
				audit = new AuditChain(auditKey);
			} finally {
				auditKey.fill(0);
			}
			owner.audit = audit;
			const pins = new PinService(store, audit);
			owner.pins = pins;
			store.read((db) => audit.verify(db));
			const state = snapshot(store);
			let pinAccepted: boolean | undefined;
			if (pin !== undefined) {
				try {
					await pins.verify(OWNER, pin, "restore.test");
					pinAccepted = true;
				} catch (error) {
					if (!(error instanceof PinError)) throw error;
					pinAccepted = false;
				}
			}
			return { state, pinAccepted };
		} finally {
			owner.pins?.lock();
			owner.audit?.destroy();
			if (owner.store) {
				owner.store.close();
				owner.closed = true;
				key.destroy();
			}
		}
	}
	close(): Promise<void> {
		if (this.#closing) return this.#closing;
		const attempt = this.#close();
		this.#closing = attempt;
		void attempt.catch(() => {
			if (this.#closing === attempt) this.#closing = undefined;
		});
		return attempt;
	}
	async #close(): Promise<void> {
		if (this.#closed) return;
		await Promise.allSettled([...this.#pending]);
		let failed = this.#sourceUncertain || this.#fileCloseUncertain;
		try {
			await this.#closePreparation?.();
		} catch {
			failed = true;
		}
		for (const owner of this.#copies) {
			try {
				if (owner.openUncertain || !owner.store) throw new Error("Fixture native open uncertain");
				owner.pins?.lock();
				if (!owner.closed) {
					owner.store.close();
					owner.closed = true;
				}
				owner.audit?.destroy();
				owner.key.destroy();
			} catch {
				failed = true;
			}
		}
		try {
			this.#sourceTickets?.destroy();
			this.#sourceTickets = undefined;
		} catch {
			failed = true;
		}
		try {
			if (this.#sourceVault) {
				await this.#sourceVault.drain();
				this.#sourceVault = undefined;
			}
		} catch {
			failed = true;
		}
		try {
			this.#sourceRevisions?.destroy();
			this.#sourceRevisions = undefined;
			this.#sourcePins?.lock();
			this.#sourceIdentity?.lock();
			if (this.#sourceVault || this.#sourceTickets)
				throw new Error("Original ticket fixture cleanup remains incomplete");
			if (this.#source && !this.#sourceClosed) {
				this.#source.close();
				this.#sourceClosed = true;
			}
			this.#sourceAudit?.destroy();
		} catch {
			failed = true;
		}
		if (this.#files.size || (this.imageHandle && this.imageHandle.fd !== -1)) failed = true;
		if (failed) throw new Error("Fixture physical cleanup incomplete");
		this.#key.destroy();
		this.#rawKey.fill(0);
		this.recoveryCode.fill(0);
		const current = await fs.lstat(this.root);
		if (
			!current.isDirectory() ||
			current.isSymbolicLink() ||
			!this.#rootIdentity ||
			current.dev !== this.#rootIdentity.dev ||
			current.ino !== this.#rootIdentity.ino ||
			(await fs.realpath(this.root)) !== this.root
		)
			throw new Error("Fixture directory identity changed");
		await fs.rm(this.root, { recursive: true });
		this.#closed = true;
	}
}
