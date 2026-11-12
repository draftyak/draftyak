import type { Account } from "@draftyak/protocol/entities/account";
import type { EmailMessageChange, NormalizedChange } from "@draftyak/protocol/normalized-change";
import type { JobLease } from "../../src/jobs/queue.ts";
import type { NativeFixture } from "../authz/native-fixture.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ NativeAccounts },
	{ Authorizer },
	{ NativeDeviceTls },
	{ DeviceRegistry },
	{ HubIdentity },
	{ PinService },
	{ EventLog },
	{ WorkDatabase },
	{ JobQueue },
	{ newId },
	{ HUB_NAMESPACES },
	{ HubStore },
	{ CONTENT_MIGRATIONS, NativeMetadataStore },
	{ bootstrap, closeFixture, fixture: nativeFixture, owner },
	{ nativeBinding },
] = await Promise.all([
	import("../../src/accounts/records.ts"),
	import("../../src/authz/authorizer.ts"),
	import("../../src/authz/native-peer.ts"),
	import("../../src/identity/devices.ts"),
	import("../../src/identity/hub-key.ts"),
	import("../../src/identity/pin.ts"),
	import("../../src/events/log.ts"),
	import("../../src/jobs/database.ts"),
	import("../../src/jobs/queue.ts"),
	import("../../src/kernel/ids.ts"),
	import("../../src/kernel/namespaces.ts"),
	import("../../src/store/store.ts"),
	import("../../src/sync/apply.ts"),
	import("../authz/native-fixture.ts"),
	import("../store/helpers.ts"),
]);

type EmailAccount = Extract<Account, { channel: "email" }>;
type Ref = import("../../src/sync/apply.ts").MetadataAccountRef;
type Page = import("../../src/sync/apply.ts").ApplyMetadataPage;

interface NativeServices {
	store: NativeFixture["store"];
	database: import("../../src/jobs/database.ts").WorkDatabase;
	accounts: import("../../src/accounts/records.ts").NativeAccounts;
	devices: NativeFixture["registry"];
	jobs: import("../../src/jobs/queue.ts").JobQueue;
	events: import("../../src/events/log.ts").EventLog;
	model: import("../../src/sync/apply.ts").NativeMetadataStore;
}

export function emailMessage(
	providerId = "DYTEST-message-1",
	overrides: Partial<EmailMessageChange> = {},
): EmailMessageChange {
	return {
		kind: "email.message",
		providerId,
		threadId: "DYTEST-thread-1",
		internalDate: 990_000,
		labelIds: ["INBOX", "UNREAD"],
		sizeBytes: 123,
		...overrides,
	};
}

function services(
	native: NativeFixture,
	clock: { wall: number; monotonic: number },
): NativeServices {
	const database = new WorkDatabase(native.store);
	const clockApi = { wallMs: () => clock.wall, monotonicMs: () => clock.monotonic };
	const events = new EventLog(database, clockApi.wallMs);
	const accounts = new NativeAccounts(database, events, native.audit, clockApi.wallMs);
	const jobs = new JobQueue(database, events, clockApi);
	return {
		store: native.store,
		database,
		accounts,
		devices: native.registry,
		jobs,
		events,
		model: new NativeMetadataStore(database, accounts, native.registry, jobs, events, clockApi),
	};
}

export type NativeApplyFixture = NativeServices & {
	native: NativeFixture;
	clock: { wall: number; monotonic: number };
	account: EmailAccount;
	generation: number;
	email(overrides?: Partial<EmailAccount>): EmailAccount;
	ref(overrides?: Partial<Ref>): Ref;
	page(changes?: readonly NormalizedChange[], overrides?: Partial<Page>): Page;
	lease(kind?: "sync" | "retention", accountId?: string, ownerId?: string): JobLease;
	reopen(registerContent?: boolean): Promise<void>;
	cleanup(): Promise<void>;
};

export async function fixture(): Promise<NativeApplyFixture> {
	const extraMigrations = {
		...Object.fromEntries(
			Object.entries(HUB_NAMESPACES).filter(
				([name]) => !["audit", "core", "devices"].includes(name),
			),
		),
		content: CONTENT_MIGRATIONS,
	};
	const native = await nativeFixture(extraMigrations);
	try {
		await bootstrap(native);
		const clock = { wall: 1_000_000, monotonic: 50_000 };
		const initial = services(native, clock);
		const ownerEpoch = native.store.read((sql) => native.registry.state(sql).epoch);
		const email = (overrides: Partial<EmailAccount> = {}): EmailAccount => ({
			channel: "email",
			id: newId(),
			userId: owner(native),
			alias: "dytest-sync-mailbox",
			mode: "full",
			status: "active",
			deletionDeadline: null,
			historyLimitDays: 30,
			disclosureVersion: 1,
			createdAt: 1000,
			pluginInstanceId: newId(),
			address: "dytest-sync@example.invalid",
			...overrides,
		});
		const account = email();
		initial.database.write((scope) => initial.accounts.create(scope, account));
		const f: NativeApplyFixture = {
			native,
			...initial,
			clock,
			account,
			generation: 1,
			email,
			ref(overrides: Partial<Ref> = {}): Ref {
				return {
					accountId: f.account.id,
					generation: f.generation,
					pluginInstanceId: f.account.pluginInstanceId,
					mode: f.account.mode,
					ownerEpoch,
					...overrides,
				};
			},
			page(changes: readonly NormalizedChange[] = [], overrides: Partial<Page> = {}): Page {
				return {
					...f.ref(),
					expectedCursor: null,
					expectedRevision: 0,
					cursor: "DYTEST-cursor-1",
					changes,
					...overrides,
				};
			},
			lease(
				kind: "sync" | "retention" = "sync",
				accountId: string = f.account.id,
				ownerId: string = f.account.userId,
			): JobLease {
				return f.database.write((scope) => {
					const id = newId();
					f.jobs.enqueue(scope, { id, accountId, ownerId, kind, refId: newId() });
					const lease = f.jobs.claim(scope, accountId, id);
					if (!lease) throw new Error("Synthetic native job was not claimed");
					return lease;
				});
			},
			async reopen(registerContent = true): Promise<void> {
				for (const device of native.devices) device.socket.destroy();
				await native.tls.close();
				native.registry.lock();
				native.pins.lock();
				native.identity.lock();
				native.store.close();
				native.store = new HubStore({
					filename: native.filename,
					nativeBinding,
					masterKey: native.key,
					migrations: registerContent
						? { ...HUB_NAMESPACES, content: CONTENT_MIGRATIONS }
						: HUB_NAMESPACES,
				});
				native.identity = await HubIdentity.loadOrCreate(native.store, native.key);
				native.pins = new PinService(native.store, native.audit);
				native.registry = new DeviceRegistry(native.store, native.audit, native.pins, {
					identity: native.identity,
				});
				native.authorizer = new Authorizer(native.registry);
				native.nextPeers.splice(0);
				native.tls = new NativeDeviceTls(native.registry, native.identity, (peer) => {
					native.nextPeers.push(peer);
				});
				native.port = await native.tls.listen();
				Object.assign(f, services(native, clock));
			},
			cleanup: () => closeFixture(native),
		};
		return f;
	} catch (error) {
		await closeFixture(native);
		throw error;
	}
}
