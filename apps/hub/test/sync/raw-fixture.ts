import type { Account } from "@draftyak/protocol/entities/account";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import type { MetadataAccountRef } from "../../src/sync/apply.ts";
import type { RawWriteLimits } from "../../src/sync/raw-store.ts";
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
	{ newId },
	{ HUB_NAMESPACES },
	{ HubStore },
	{ RAW_CONTENT_MIGRATIONS, NativeRawStore },
	{ createJsonMemberDecoder, writeJsonMember },
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
	import("../../src/kernel/ids.ts"),
	import("../../src/kernel/namespaces.ts"),
	import("../../src/store/store.ts"),
	import("../../src/sync/raw-store.ts"),
	import("../../src/plugins/broker/blob/index.ts"),
	import("../authz/native-fixture.ts"),
	import("../store/helpers.ts"),
]);

type EmailAccount = Extract<Account, { channel: "email" }>;

type RawServices = {
	store: import("../../src/store/store.ts").HubStore;
	database: import("../../src/jobs/database.ts").WorkDatabase;
	accounts: import("../../src/accounts/records.ts").NativeAccounts;
	devices: import("../../src/identity/devices.ts").DeviceRegistry;
	events: import("../../src/events/log.ts").EventLog;
	model: import("../../src/sync/raw-store.ts").NativeRawStore;
};

function services(native: NativeFixture, clock: { wall: number; monotonic: number }): RawServices {
	const database = new WorkDatabase(native.store);
	const clockApi = { wallMs: () => clock.wall, monotonicMs: () => clock.monotonic };
	const events = new EventLog(database, clockApi.wallMs);
	const accounts = new NativeAccounts(database, events, native.audit, clockApi.wallMs);
	return {
		store: native.store,
		database,
		accounts,
		devices: native.registry,
		events,
		model: new NativeRawStore(database, accounts, native.registry, clockApi),
	};
}

export type NativeRawFixture = ReturnType<typeof services> & {
	native: NativeFixture;
	clock: { wall: number; monotonic: number };
	account: EmailAccount;
	generation: number;
	email(overrides?: Partial<EmailAccount>): EmailAccount;
	ref(overrides?: Partial<MetadataAccountRef>): MetadataAccountRef;
	reopen(registerRaw?: boolean): Promise<void>;
	cleanup(): Promise<void>;
};

export async function fixture(): Promise<NativeRawFixture> {
	const extraMigrations = {
		...Object.fromEntries(
			Object.entries(HUB_NAMESPACES).filter(
				([name]) => !["audit", "core", "devices"].includes(name),
			),
		),
		rawcontent: RAW_CONTENT_MIGRATIONS,
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
			alias: "dytest-raw-mailbox",
			mode: "full",
			status: "active",
			deletionDeadline: null,
			historyLimitDays: 30,
			disclosureVersion: 1,
			createdAt: 1000,
			pluginInstanceId: newId(),
			address: "dytest-raw@example.invalid",
			...overrides,
		});
		const account = email();
		initial.database.write((scope) => initial.accounts.create(scope, account));
		const f: NativeRawFixture = {
			native,
			...initial,
			clock,
			account,
			generation: 1,
			email,
			ref(overrides: Partial<MetadataAccountRef> = {}): MetadataAccountRef {
				return {
					accountId: f.account.id,
					generation: f.generation,
					pluginInstanceId: f.account.pluginInstanceId,
					mode: f.account.mode,
					ownerEpoch,
					...overrides,
				};
			},
			async reopen(registerRaw = true): Promise<void> {
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
					migrations: registerRaw
						? { ...HUB_NAMESPACES, rawcontent: RAW_CONTENT_MIGRATIONS }
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

export async function project(
	f: NativeRawFixture,
	bytes: Uint8Array,
	member: "raw" | "data" = "raw",
	entityChunkBytes = 4096,
	limits?: RawWriteLimits,
): Promise<BlobRef> {
	if (!Number.isSafeInteger(entityChunkBytes) || entityChunkBytes < 1)
		throw new Error("Synthetic entity chunk size invalid");
	const writer = f.database.write((scope) => f.model.begin(scope, f.ref(), limits));
	const decoder = createJsonMemberDecoder(member);
	const document = new TextEncoder().encode(
		JSON.stringify({ [member]: Buffer.from(bytes).toString("base64url") }),
	);
	async function* entity(): AsyncGenerator<Uint8Array> {
		for (let offset = 0; offset < document.length; offset += entityChunkBytes) {
			const chunk = document.subarray(offset, offset + entityChunkBytes);
			decoder.countCompressed(chunk.byteLength);
			yield chunk;
		}
	}
	return writeJsonMember(decoder, entity(), writer, new AbortController().signal);
}

export function readAll(
	f: NativeRawFixture,
	blob: BlobRef,
	maxBytes = 65_536,
	ref: MetadataAccountRef = f.ref(),
): Uint8Array {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let total = -1;
	let digest: string | undefined;
	for (;;) {
		const slice = f.database.write((scope) => f.model.read(scope, ref, blob, offset, maxBytes));
		if (total === -1) {
			total = slice.totalBytes;
			digest = slice.sha256;
		}
		if (slice.totalBytes !== total || slice.sha256 !== digest || slice.bytes.length > maxBytes)
			throw new Error("Synthetic read metadata changed");
		chunks.push(slice.bytes);
		if (slice.nextOffset === null) break;
		if (slice.nextOffset <= offset || slice.nextOffset !== offset + slice.bytes.length)
			throw new Error("Synthetic read did not advance");
		offset = slice.nextOffset;
	}
	const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let at = 0;
	for (const chunk of chunks) {
		result.set(chunk, at);
		at += chunk.length;
	}
	if (result.length !== total) throw new Error("Synthetic read length changed");
	return result;
}
