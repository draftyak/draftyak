import type {
	Accepted,
	Challenge,
	OperationReview,
	SignedEnvelope,
} from "@draftyak/protocol/device-api";
import { canonicalize } from "@draftyak/protocol/jcs";
import { toBase64Url } from "@draftyak/protocol/scalars";
import { signStatement } from "@draftyak/protocol/sign";
import { AdminStatement } from "@draftyak/protocol/statements/admin";
import { NativeAccounts } from "../../src/accounts/records.ts";
import type { NativeDevicePeer } from "../../src/authz/native-peer.ts";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { EventLog } from "../../src/events/log.ts";
import { NativeBackupOperations } from "../../src/identity/backup-operations.ts";
import { ChallengeService } from "../../src/identity/challenges.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { systemClock, type TimerClock } from "../../src/kernel/clock.ts";
import { newId } from "../../src/kernel/ids.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import type { HubSession } from "../../src/lifecycle/session.ts";
import { NativeOutboxProposals } from "../../src/outbox/propose.ts";
import { SendApprovalVerifier } from "../../src/outbox/verifier.ts";
import * as native from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import {
	closeSessionTransport,
	type SessionFixture,
	sessionFixture,
	sessionTransport,
} from "../lifecycle/session-helpers.ts";
import { connectFakeDevice, type FakeDeviceConnection } from "../support/fake-device/harness.ts";
import type { FakeDevice, FakeDeviceIdentity } from "../support/fake-device/index.ts";

requireLoopbackNetworkGuard();

export type BackupReview = Extract<OperationReview, { kind: "data.backup" }>;
export interface IssuedBackup {
	readonly review: BackupReview;
	readonly challenge: Challenge;
	readonly envelope: SignedEnvelope;
}
export interface BackupEvidence {
	readonly accountMode: string;
	readonly accountGeneration: number;
	readonly accountEvents: number;
	readonly accountAudit: number;
	readonly opened: number;
	readonly applied: number;
	readonly pendingOperations: number;
	readonly appliedOperations: number;
	readonly challenges: number;
	readonly consumed: number;
	readonly burned: number;
	readonly pinVerified: number;
	readonly pinFailed: number;
}
export interface NativeBackupFixture {
	readonly storage: SessionFixture;
	readonly session: HubSession;
	readonly key: MasterKey;
	readonly native: native.NativeFixture;
	readonly owner: FakeDeviceConnection;
	readonly operations: NativeBackupOperations;
	readonly service: ChallengeService;
	readonly clock: TimerClock;
	readonly pin: string;
	advance(wallDelta: number, monoDelta?: number): void;
	connect(identity?: FakeDeviceIdentity): Promise<FakeDeviceConnection>;
	open(): BackupReview;
	issue(review?: BackupReview): IssuedBackup;
	accept(raw: unknown, peer?: NativeDevicePeer): Promise<Accepted>;
	evidence(): BackupEvidence;
	operation(id: string): { readonly state: string; readonly version: number };
	auditFor(id: string): { readonly applied: number; readonly exactRefs: boolean };
	close(): Promise<void>;
}

/** A genuine original Session and real TLS owner; synthetic account DATA confers no authority. */
export async function nativeBackupFixture(): Promise<NativeBackupFixture> {
	const storage = sessionFixture("draftyak-native-backup-");
	const key = storage.key();
	let wall = Date.now(),
		mono = 1_000;
	const clock: TimerClock = Object.freeze({
		wallMs: () => wall,
		monotonicMs: () => mono,
		after: systemClock.after,
	});
	const clients: FakeDevice[] = [];
	const accepting = new Set<Promise<Accepted>>();
	let session: HubSession | undefined;
	let transport: native.NativeFixture | undefined;
	let revisions: NativeDraftRevisions | undefined;
	let target: NativeOutboxProposals | undefined;
	let send: SendApprovalVerifier | undefined;
	let operations: NativeBackupOperations | undefined;
	let service: ChallengeService | undefined;
	let closing = false;
	let closePromise: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing = true;
		if (closePromise) return closePromise;
		closePromise = (async () => {
			let failed = false;
			for (const stop of [
				() => service?.lock(),
				() => operations?.lock(),
				() => send?.lock(),
				() => target?.destroy(),
				() => revisions?.destroy(),
			]) {
				try {
					stop();
				} catch {
					failed = true;
				}
			}
			await Promise.allSettled([...accepting]);
			const sockets = await Promise.allSettled(clients.map((client) => client.close()));
			if (sockets.some((result) => result.status === "rejected")) failed = true;
			try {
				if (transport) await closeSessionTransport(transport);
			} catch {
				failed = true;
			}
			try {
				await session?.close();
			} catch {
				failed = true;
			}
			if (failed) throw new Error("DYTEST backup fixture cleanup incomplete");
			await storage.remove();
		})().catch(() => {
			closePromise = undefined;
			throw new Error("DYTEST backup fixture cleanup incomplete");
		});
		return closePromise;
	};
	try {
		session = await storage.open({ masterKey: key, clock });
		const original = session;
		transport = await sessionTransport(original, key, storage.folder);
		const connected = transport;
		const connect = async (identity?: FakeDeviceIdentity): Promise<FakeDeviceConnection> => {
			const connection = await connectFakeDevice(connected, identity);
			clients.push(connection.client);
			return connection;
		};
		const owner = await connect();
		await native.bootstrap(connected, owner.device);
		const authorizer = connected.authorizer;
		revisions = new NativeDraftRevisions(original.store, original.audit, key, clock);
		target = new NativeOutboxProposals(
			original.store,
			original.audit,
			key,
			revisions,
			original.devices,
			authorizer,
			original.identity,
			clock,
		);
		send = new SendApprovalVerifier(original.store, original.audit, original.devices, authorizer, {
			identity: original.identity,
			target,
			masterKey: key,
			clock,
		});
		operations = new NativeBackupOperations(original, key, clock);
		const issuer = operations;
		service = new ChallengeService(
			original.store,
			original.audit,
			original.pins,
			original.devices,
			authorizer,
			{ identity: original.identity, send, backup: issuer, clock },
		);
		const challenges = service;
		const database = new WorkDatabase(original.store);
		const accounts = new NativeAccounts(
			database,
			new EventLog(database, clock.wallMs),
			original.audit,
			clock.wallMs,
		);
		const account = database.write((scope) =>
			accounts.create(scope, {
				id: newId(wall),
				userId: native.owner(connected),
				pluginInstanceId: newId(wall),
				channel: "email",
				alias: "dytest-backup",
				mode: "read_only",
				status: "active",
				deletionDeadline: null,
				historyLimitDays: 30,
				disclosureVersion: 1,
				createdAt: wall,
				address: "dytest-backup@example.invalid",
			}),
		);
		const open = (): BackupReview => {
			const review = issuer.open(owner.device.peer, { kind: "data.backup", ids: [] });
			if (review.kind !== "data.backup") throw new Error("DYTEST backup review kind refused");
			return review;
		};
		return {
			storage,
			session: original,
			key,
			native: connected,
			owner,
			operations: issuer,
			service: challenges,
			clock,
			pin: native.PIN,
			connect,
			open,
			close,
			advance(wallDelta, monoDelta = wallDelta): void {
				if (!Number.isSafeInteger(wallDelta) || !Number.isSafeInteger(monoDelta))
					throw new Error("DYTEST clock delta refused");
				wall += wallDelta;
				mono += monoDelta;
			},
			issue(review = open()): IssuedBackup {
				const challenge = challenges.issue(owner.device.peer, { kind: "admin.v1", id: review.id });
				const envelope = owner.client.envelope({
					challenge,
					review,
					request: { kind: "admin.v1", id: review.id },
					device: native.idOf(owner.device),
					pin: native.PIN,
				});
				return { review, challenge, envelope };
			},
			accept(raw, peer = owner.device.peer): Promise<Accepted> {
				if (closing) throw new Error("DYTEST backup fixture is closing");
				const promise = challenges.accept(peer, "admin.v1", raw);
				accepting.add(promise);
				void promise.then(
					() => accepting.delete(promise),
					() => accepting.delete(promise),
				);
				return promise;
			},
			evidence(): BackupEvidence {
				const current = database.write((scope) =>
					accounts.get(scope, account.account.userId, account.account.id),
				);
				if (!current) throw new Error("DYTEST backup account missing");
				return original.store.read((sql) => {
					original.audit.verify(sql);
					const count = (query: string): number => sql.get<{ n: number }>(query)?.n ?? 0;
					return {
						accountMode: current.account.mode,
						accountGeneration: current.generation,
						accountEvents: count(
							"SELECT count(*) AS n FROM main.events WHERE kind='accounts.changed'",
						),
						accountAudit: count(
							"SELECT count(*) AS n FROM main.audit_events WHERE action='account.changed'",
						),
						opened: count(
							"SELECT count(*) AS n FROM main.audit_events WHERE action='admin.data_backup.opened'",
						),
						applied: count(
							"SELECT count(*) AS n FROM main.audit_events WHERE action='admin.data_backup.applied'",
						),
						pendingOperations: count(
							"SELECT count(*) AS n FROM main.native_backup_operations WHERE state='pending'",
						),
						appliedOperations: count(
							"SELECT count(*) AS n FROM main.native_backup_operations WHERE state='applied'",
						),
						challenges: count("SELECT count(*) AS n FROM main.native_backup_challenges"),
						consumed: count(
							"SELECT count(*) AS n FROM main.native_backup_challenges WHERE consumed_at IS NOT NULL",
						),
						burned: count(
							"SELECT count(*) AS n FROM main.native_backup_challenges WHERE burned_at IS NOT NULL",
						),
						pinVerified: count(
							"SELECT count(*) AS n FROM main.audit_events WHERE action='pin.verified'",
						),
						pinFailed: count(
							"SELECT count(*) AS n FROM main.audit_events WHERE action='pin.failed'",
						),
					};
				});
			},
			operation(id): { readonly state: string; readonly version: number } {
				const row = original.store.read((sql) =>
					sql.get<{ state: string; version: number }>(
						"SELECT state,audit_seq AS version FROM main.native_backup_operations WHERE id=?",
						[id],
					),
				);
				if (!row) throw new Error("DYTEST backup operation missing");
				return row;
			},
			auditFor(id): { readonly applied: number; readonly exactRefs: boolean } {
				return original.store.read((sql) => {
					const rows = original.audit
						.exportVerifiedJsonl(sql, { afterSeq: 0, limit: 1000 })
						.jsonl.split("\n")
						.filter(Boolean)
						.map(
							(line) =>
								JSON.parse(line) as {
									action: string;
									refs: Record<string, unknown>;
								},
						)
						.filter((row) => row.action === "admin.data_backup.applied");
					return {
						applied: rows.length,
						exactRefs: rows.every(
							(row) => Object.keys(row.refs).length === 1 && row.refs.operation === id,
						),
					};
				});
			},
		};
	} catch (error) {
		await close();
		throw error;
	}
}

/** Re-sign mutated public statement DATA with the genuine test owner's original ES256 key. */
export function resignBackup(
	f: NativeBackupFixture,
	issued: IssuedBackup,
	changes: Partial<AdminStatement>,
): SignedEnvelope {
	const bytes = Buffer.from(issued.challenge.statement, "base64url");
	const statement = AdminStatement.parse({ ...JSON.parse(bytes.toString("utf8")), ...changes });
	return {
		statement: toBase64Url(Buffer.from(canonicalize(statement))),
		signature: signStatement("admin.v1", statement, f.owner.client.privateKey),
		pin: f.pin,
	};
}

export function originalKeyLength(key: MasterKey): number {
	const derived = key.derive("db");
	try {
		return derived.byteLength;
	} finally {
		derived.fill(0);
	}
}

export function originalKeyErased(key: MasterKey): boolean {
	let derived: Buffer | undefined;
	try {
		derived = key.derive("db");
		return false;
	} catch (error) {
		return error instanceof Error && error.message === "Hub is locked";
	} finally {
		derived?.fill(0);
	}
}
