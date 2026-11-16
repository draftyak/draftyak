import type { Account } from "@draftyak/protocol/entities/account";
import type { BlobRef, EmailMessageChange } from "@draftyak/protocol/normalized-change";
import type { JobLease } from "../../src/jobs/queue.ts";
import type { MetadataAccountRef } from "../../src/sync/apply.ts";
import type { NativeParsedSource } from "../../src/sync/parsed.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ NativeAccounts },
	{ EventLog },
	{ WorkDatabase },
	{ JobQueue },
	{ newId },
	{ HUB_NAMESPACES },
	{ CONTENT_MIGRATIONS, NativeMetadataStore },
	{ RAW_CONTENT_MIGRATIONS, NativeRawStore },
	{ NativeParsedStore },
	{ createJsonMemberDecoder, writeJsonMember },
	{ bootstrap, closeFixture, fixture: nativeFixture, owner },
	{ default: Database },
	{ captureConnections },
] = await Promise.all([
	import("../../src/accounts/records.ts"),
	import("../../src/events/log.ts"),
	import("../../src/jobs/database.ts"),
	import("../../src/jobs/queue.ts"),
	import("../../src/kernel/ids.ts"),
	import("../../src/kernel/namespaces.ts"),
	import("../../src/sync/apply.ts"),
	import("../../src/sync/raw-store.ts"),
	import("../../src/sync/parsed.ts"),
	import("../../src/plugins/broker/blob/index.ts"),
	import("../authz/native-fixture.ts"),
	import("better-sqlite3-multiple-ciphers"),
	import("../extensions/helpers.ts"),
]);

const executeNative = Database.prototype.exec;
const PARSED_SCHEMA_DROPS: Readonly<{
	"parsed page index": "DROP INDEX main.content_parsed_page";
	"cleaned-body FTS table": "DROP TABLE main.content_parsed_fts";
}> = Object.freeze({
	"parsed page index": "DROP INDEX main.content_parsed_page",
	"cleaned-body FTS table": "DROP TABLE main.content_parsed_fts",
});

type EmailAccount = Extract<Account, { channel: "email" }>;

export interface NativeParsedFixture {
	native: Awaited<ReturnType<typeof import("../authz/native-fixture.ts").fixture>>;
	store: NativeParsedFixture["native"]["store"];
	database: import("../../src/jobs/database.ts").WorkDatabase;
	accounts: import("../../src/accounts/records.ts").NativeAccounts;
	jobs: import("../../src/jobs/queue.ts").JobQueue;
	metadata: import("../../src/sync/apply.ts").NativeMetadataStore;
	raw: import("../../src/sync/raw-store.ts").NativeRawStore;
	model: import("../../src/sync/parsed.ts").NativeParsedStore;
	account: EmailAccount;
	clock: { wall: number; monotonic: number };
	ref(overrides?: Partial<MetadataAccountRef>): MetadataAccountRef;
	lease(messageId: string, kind?: "sync" | "retention"): JobLease;
	apply(changes: readonly EmailMessageChange[]): void;
	project(bytes: Uint8Array): Promise<BlobRef>;
	capture(messageId: string, blob: BlobRef): NativeParsedSource;
	scan(source: NativeParsedSource, maxBytes?: number): Uint8Array;
	breakParsedSchema(kind: keyof typeof PARSED_SCHEMA_DROPS): void;
	cleanup(): ReturnType<typeof import("../authz/native-fixture.ts").closeFixture>;
}

/** Uses the original native services. The content 0002 migration must be owner-delivered first. */
export async function fixture(): Promise<NativeParsedFixture> {
	const observed = captureConnections();
	let native: NativeParsedFixture["native"];
	try {
		native = await nativeFixture({
			...Object.fromEntries(
				Object.entries(HUB_NAMESPACES).filter(
					([name]) => !["audit", "core", "devices"].includes(name),
				),
			),
			content: CONTENT_MIGRATIONS,
			rawcontent: RAW_CONTENT_MIGRATIONS,
		});
	} finally {
		observed.restore();
	}
	try {
		const matching = [
			...new Set(
				observed.connections.filter(
					(connection) => connection.open && connection.name === native.filename,
				),
			),
		];
		const connection = matching[0];
		if (matching.length !== 1 || !connection)
			throw new Error("Synthetic parsed native connection unavailable");
		await bootstrap(native);
		const clock = { wall: 1_000_000, monotonic: 50_000 };
		const clockApi = { wallMs: () => clock.wall, monotonicMs: () => clock.monotonic };
		const database = new WorkDatabase(native.store);
		const events = new EventLog(database, clockApi.wallMs);
		const accounts = new NativeAccounts(database, events, native.audit, clockApi.wallMs);
		const jobs = new JobQueue(database, events, clockApi);
		const metadata = new NativeMetadataStore(
			database,
			accounts,
			native.registry,
			jobs,
			events,
			clockApi,
		);
		const raw = new NativeRawStore(database, accounts, native.registry, clockApi);
		const model = new NativeParsedStore(database, accounts, native.registry, jobs, metadata, raw);
		const account: EmailAccount = {
			channel: "email",
			id: newId(),
			userId: owner(native),
			alias: "dytest-parsed-mailbox",
			mode: "full",
			status: "active",
			deletionDeadline: null,
			historyLimitDays: 30,
			disclosureVersion: 1,
			createdAt: 1000,
			pluginInstanceId: newId(),
			address: "dytest-parsed@example.invalid",
		};
		database.write((scope) => accounts.create(scope, account));
		const ownerEpoch = native.store.read((sql) => native.registry.state(sql).epoch);
		const ref = (overrides: Partial<MetadataAccountRef> = {}): MetadataAccountRef => ({
			accountId: account.id,
			generation: 1,
			pluginInstanceId: account.pluginInstanceId,
			ownerEpoch,
			mode: account.mode,
			...overrides,
		});
		const lease = (messageId: string, kind: "sync" | "retention" = "sync"): JobLease =>
			database.write((scope) => {
				const id = newId();
				jobs.enqueue(scope, {
					id,
					accountId: account.id,
					ownerId: account.userId,
					kind,
					refId: messageId,
				});
				const claimed = jobs.claim(scope, account.id, id);
				if (!claimed) throw new Error("Synthetic parse job was not claimed");
				return claimed;
			});
		const apply = (changes: readonly EmailMessageChange[]): void => {
			const current = database.write((scope) => metadata.checkpoint(scope, ref()));
			const handle = lease(newId());
			database.write((scope) =>
				metadata.applyPage(scope, handle, {
					...ref(),
					expectedCursor: current.cursor,
					expectedRevision: current.revision,
					cursor: `DYTEST-parsed-cursor-${current.revision + 1}`,
					changes,
				}),
			);
		};
		const project = async (bytes: Uint8Array): Promise<BlobRef> => {
			const writer = database.write((scope) => raw.begin(scope, ref()));
			const decoder = createJsonMemberDecoder("raw");
			const document = new TextEncoder().encode(
				JSON.stringify({ raw: Buffer.from(bytes).toString("base64url") }),
			);
			async function* entity(): AsyncGenerator<Uint8Array> {
				for (let offset = 0; offset < document.length; offset += 4096) {
					const chunk = document.subarray(offset, offset + 4096);
					decoder.countCompressed(chunk.byteLength);
					yield chunk;
				}
			}
			try {
				return await writeJsonMember(decoder, entity(), writer, new AbortController().signal);
			} finally {
				document.fill(0);
			}
		};
		const capture = (messageId: string, blob: BlobRef): NativeParsedSource => {
			const handle = lease(messageId);
			return database.write((scope) => model.capture(scope, handle, ref(), messageId, blob));
		};
		const scan = (source: NativeParsedSource, maxBytes = 65_536): Uint8Array => {
			const chunks: Uint8Array[] = [];
			let offset = 0;
			try {
				for (;;) {
					let owned: import("../../src/sync/raw-store.ts").RawContentSlice | undefined;
					try {
						const slice = database.write((scope) => {
							owned = model.readSource(scope, source, offset, maxBytes);
							return owned;
						});
						chunks.push(slice.bytes);
						if (slice.nextOffset === null) break;
						offset = slice.nextOffset;
					} catch (error) {
						owned?.bytes.fill(0);
						throw error;
					}
				}
				return Buffer.concat(chunks);
			} finally {
				for (const chunk of chunks) chunk.fill(0);
			}
		};
		return {
			native,
			store: native.store,
			database,
			accounts,
			jobs,
			metadata,
			raw,
			model,
			account,
			clock,
			ref,
			lease,
			apply,
			project,
			capture,
			scan,
			breakParsedSchema(kind) {
				if (!Object.hasOwn(PARSED_SCHEMA_DROPS, kind))
					throw new Error("Synthetic parsed dependency unavailable");
				database.write((scope) => {
					database.sql(scope);
					if (!connection.open || connection.name !== native.filename || !connection.inTransaction)
						throw new Error("Synthetic parsed native transaction unavailable");
					executeNative.call(connection, PARSED_SCHEMA_DROPS[kind]);
				});
			},
			cleanup: () => closeFixture(native),
		};
	} catch (error) {
		await closeFixture(native);
		throw error;
	}
}

export function emailMessage(providerId = "DYTEST-parsed-message"): EmailMessageChange {
	return {
		kind: "email.message",
		providerId,
		threadId: "DYTEST-parsed-thread",
		internalDate: 990_000,
		labelIds: ["INBOX"],
		sizeBytes: 123,
	};
}
