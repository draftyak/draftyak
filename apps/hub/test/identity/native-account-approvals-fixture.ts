import type { Challenge, OperationReview, SignedEnvelope } from "@draftyak/protocol/device-api";
import type { Account } from "@draftyak/protocol/entities/account";
import type { AccountRecord, NativeAccounts as Accounts } from "../../src/accounts/records.ts";
import type { NativeAccountApprovals } from "../../src/identity/native-account-approvals.ts";
import type { WorkDatabase as Database } from "../../src/jobs/database.ts";
import type { MasterKey } from "../../src/kernel/master-key.ts";
import type { HubSession } from "../../src/lifecycle/session.ts";
import type { NativeFixture } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";
import type { SessionFixture } from "../lifecycle/session-helpers.ts";
import type { FakeDeviceConnection } from "../support/fake-device/harness.ts";
import type { FakeDevice, FakeDeviceIdentity } from "../support/fake-device/index.ts";

requireLoopbackNetworkGuard();
const [
	{ Account: AccountSchema },
	{ NativeAccounts },
	{ EventLog },
	{ WorkDatabase },
	{ newId },
	{ sessionFixture, sessionTransport, closeSessionTransport },
	native,
	{ connectFakeDevice },
] = await Promise.all([
	import("@draftyak/protocol/entities/account"),
	import("../../src/accounts/records.ts"),
	import("../../src/events/log.ts"),
	import("../../src/jobs/database.ts"),
	import("../../src/kernel/ids.ts"),
	import("../lifecycle/session-helpers.ts"),
	import("../authz/native-fixture.ts"),
	import("../support/fake-device/harness.ts"),
]);

export interface NativeAccountApprovalsFixture {
	readonly storage: SessionFixture;
	readonly session: HubSession;
	/** The exact test-generated key originally passed into this session. */
	readonly key: MasterKey;
	/** Mechanical adapter over the original session's services and real TLS callbacks. */
	readonly native: NativeFixture;
	readonly owner: FakeDeviceConnection;
	readonly approvals: NativeAccountApprovals;
	readonly database: Database;
	readonly accounts: Accounts;
	readonly account: AccountRecord;
	readonly pin: string;
	current(accountId?: string): AccountRecord;
	createAccount(changes?: Partial<Account>): AccountRecord;
	connect(reuseIdentity?: FakeDeviceIdentity): Promise<FakeDeviceConnection>;
	close(): Promise<void>;
}

export interface AccountApprovalEvidence {
	readonly accountAudit: number;
	readonly accountEvents: number;
	readonly adminApplied: number;
	readonly pinVerified: number;
	readonly pinFailures: number;
}

/** Original-session construction, genuine first-owner pairing and synthetic account DATA. */
export async function nativeAccountApprovalsFixture(): Promise<NativeAccountApprovalsFixture> {
	const storage = sessionFixture("draftyak-native-account-approvals-");
	const key = storage.key();
	const clients: FakeDevice[] = [];
	let session: HubSession | undefined;
	let transport: NativeFixture | undefined;
	try {
		session = await storage.open({ masterKey: key });
		transport = await sessionTransport(session, key, storage.folder);
		const originalSession = session;
		const originalTransport = transport;
		const connect = async (reuseIdentity?: FakeDeviceIdentity): Promise<FakeDeviceConnection> => {
			const connection = await connectFakeDevice(originalTransport, reuseIdentity);
			clients.push(connection.client);
			return connection;
		};
		const owner = await connect();
		await native.bootstrap(originalTransport, owner.device);
		const database = new WorkDatabase(originalSession.store);
		const accounts = new NativeAccounts(
			database,
			new EventLog(database, () => Date.now()),
			originalSession.audit,
			() => Date.now(),
		);
		const createAccount = (changes: Partial<Account> = {}): AccountRecord => {
			const now = Date.now();
			const common = {
				id: newId(now),
				userId: native.owner(originalTransport),
				alias: newId(now).toLowerCase(),
				mode: "read_only",
				status: "active",
				deletionDeadline: null,
				historyLimitDays: 30,
				disclosureVersion: 1,
				createdAt: now,
				pluginInstanceId: newId(now),
			};
			const data = AccountSchema.parse(
				changes.channel === "chat"
					? {
							...common,
							channel: "chat",
							teamId: "DYTEST-team",
							selfUserId: "DYTEST-user",
							...changes,
						}
					: { ...common, channel: "email", address: "dytest-owner@example.invalid", ...changes },
			);
			return database.write((scope) => accounts.create(scope, data));
		};
		const account = createAccount();
		const approvals = originalSession.accountApprovals();
		let closePromise: Promise<void> | undefined;
		return {
			storage,
			session: originalSession,
			key,
			native: originalTransport,
			owner,
			approvals,
			database,
			accounts,
			account,
			pin: native.PIN,
			createAccount,
			connect,
			current(accountId = account.account.id): AccountRecord {
				const value = database.write((scope) =>
					accounts.get(scope, native.owner(originalTransport), accountId),
				);
				if (!value) throw new Error("DYTEST account missing");
				return value;
			},
			close(): Promise<void> {
				if (!closePromise)
					closePromise = (async () => {
						await Promise.all(clients.map((client) => client.close()));
						await closeSessionTransport(originalTransport);
						await originalSession.close();
						await storage.remove();
					})();
				return closePromise;
			},
		};
	} catch (error) {
		await Promise.all(clients.map((client) => client.close()));
		if (transport) await closeSessionTransport(transport);
		await session?.close();
		await storage.remove();
		throw error;
	}
}

export function accountApprovalEvidence(f: {
	readonly session: HubSession;
}): AccountApprovalEvidence {
	const owner = f.session.devices.currentState().ownerUserId;
	return f.session.store.read((tx) => ({
		accountAudit:
			tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE action='account.changed'",
			)?.n ?? 0,
		accountEvents:
			tx.get<{ n: number }>("SELECT count(*) AS n FROM main.events WHERE kind='accounts.changed'")
				?.n ?? 0,
		adminApplied:
			tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE action='admin.account_mode.applied'",
			)?.n ?? 0,
		pinVerified:
			tx.get<{ n: number }>(
				"SELECT count(*) AS n FROM main.audit_events WHERE action='pin.verified'",
			)?.n ?? 0,
		pinFailures:
			tx.get<{ failures: number }>("SELECT failures FROM main.approval_pins WHERE user_id=?", [
				owner,
			])?.failures ?? 0,
	}));
}

export function issueAccountApproval(f: NativeAccountApprovalsFixture): {
	readonly review: Extract<OperationReview, { kind: "account.mode-full" }>;
	readonly challenge: Challenge;
	readonly envelope: SignedEnvelope;
} {
	const review = f.approvals.open(f.owner.device.peer, {
		kind: "account.mode-full",
		ids: [f.account.account.id],
	});
	if (review.kind !== "account.mode-full") throw new Error("DYTEST account review refused");
	const challenge = f.approvals.issue(f.owner.device.peer, review.id);
	const envelope = f.owner.client.envelope({
		challenge,
		request: { kind: "admin.v1", id: review.id },
		review,
		device: native.idOf(f.owner.device),
		pin: f.pin,
	});
	return { review, challenge, envelope };
}
