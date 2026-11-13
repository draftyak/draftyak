import type { Account } from "@draftyak/protocol/entities/account";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import type { JobLease } from "../../src/jobs/queue.ts";
import type { MetadataAccountRef } from "../../src/sync/apply.ts";
import { requireLoopbackNetworkGuard } from "../helpers/loopback-network.ts";

requireLoopbackNetworkGuard();
const [
	{ NativeAccounts },
	{ NativeMailIngestor },
	{ EventLog },
	{ WorkDatabase },
	{ JobQueue },
	{ newId },
	{ HUB_NAMESPACES },
	{ CONTENT_MIGRATIONS, NativeMetadataStore },
	{ NativeParsedStore },
	{ RAW_CONTENT_MIGRATIONS, NativeRawStore },
	{ createJsonMemberDecoder, writeJsonMember },
	{ bootstrap, closeFixture, fixture: nativeFixture, owner },
] = await Promise.all([
	import("../../src/accounts/records.ts"),
	import("../../src/content/ingest.ts"),
	import("../../src/events/log.ts"),
	import("../../src/jobs/database.ts"),
	import("../../src/jobs/queue.ts"),
	import("../../src/kernel/ids.ts"),
	import("../../src/kernel/namespaces.ts"),
	import("../../src/sync/apply.ts"),
	import("../../src/sync/parsed.ts"),
	import("../../src/sync/raw-store.ts"),
	import("../../src/plugins/broker/blob/index.ts"),
	import("../authz/native-fixture.ts"),
]);

export interface NativeIngestMailbox {
	account: Extract<Account, { channel: "email" }>;
	ref: MetadataAccountRef;
	message: ReturnType<import("../../src/sync/apply.ts").NativeMetadataStore["messages"]>[number];
	lease(refId?: string): JobLease;
	project(bytes: Uint8Array): Promise<BlobRef>;
	ingestor: import("../../src/content/ingest.ts").NativeMailIngestor;
}

export interface NativeIngestFixture extends NativeIngestMailbox {
	native: Awaited<ReturnType<typeof import("../authz/native-fixture.ts").fixture>>;
	time: { wall: number; monotonic: number };
	database: import("../../src/jobs/database.ts").WorkDatabase;
	accounts: import("../../src/accounts/records.ts").NativeAccounts;
	jobs: import("../../src/jobs/queue.ts").JobQueue;
	metadata: import("../../src/sync/apply.ts").NativeMetadataStore;
	raw: import("../../src/sync/raw-store.ts").NativeRawStore;
	parsed: import("../../src/sync/parsed.ts").NativeParsedStore;
	createMailbox(): NativeIngestMailbox;
	cleanup(): ReturnType<typeof import("../authz/native-fixture.ts").closeFixture>;
}

export async function fixture(): Promise<NativeIngestFixture> {
	const native = await nativeFixture({
		...Object.fromEntries(
			Object.entries(HUB_NAMESPACES).filter(
				([name]) => !["audit", "core", "devices"].includes(name),
			),
		),
		content: CONTENT_MIGRATIONS,
		rawcontent: RAW_CONTENT_MIGRATIONS,
	});
	try {
		await bootstrap(native);
		const time = { wall: 1_000_000, monotonic: 50_000.25 };
		const clock = { wallMs: () => time.wall, monotonicMs: () => time.monotonic };
		const database = new WorkDatabase(native.store);
		const events = new EventLog(database, clock.wallMs);
		const accounts = new NativeAccounts(database, events, native.audit, clock.wallMs);
		const jobs = new JobQueue(database, events, clock);
		const metadata = new NativeMetadataStore(
			database,
			accounts,
			native.registry,
			jobs,
			events,
			clock,
		);
		const raw = new NativeRawStore(database, accounts, native.registry, clock);
		const parsed = new NativeParsedStore(database, accounts, native.registry, jobs, metadata, raw);
		const ingestor = new NativeMailIngestor(database, parsed);
		let mailboxIndex = 0;
		const createMailbox = (): NativeIngestMailbox => {
			const index = mailboxIndex++;
			const account: Extract<Account, { channel: "email" }> = {
				channel: "email",
				id: newId(),
				userId: owner(native),
				alias: index === 0 ? "dytest-ingest" : `dytest-ingest-${index}`,
				mode: "full",
				status: "active",
				deletionDeadline: null,
				historyLimitDays: 30,
				disclosureVersion: 1,
				createdAt: 1000,
				pluginInstanceId: newId(),
				address:
					index === 0 ? "dytest-owner@example.invalid" : `dytest-owner-${index}@example.invalid`,
			};
			database.write((scope) => accounts.create(scope, account));
			const ref: MetadataAccountRef = Object.freeze({
				accountId: account.id,
				generation: 1,
				pluginInstanceId: account.pluginInstanceId,
				ownerEpoch: native.store.read((sql) => native.registry.state(sql).epoch),
				mode: account.mode,
			});
			const lease = (refId = newId()): JobLease =>
				database.write((scope) => {
					const id = newId();
					jobs.enqueue(scope, {
						id,
						accountId: account.id,
						ownerId: account.userId,
						kind: "sync",
						refId,
					});
					const claimed = jobs.claim(scope, account.id, id);
					if (!claimed) throw new Error("Synthetic ingest job was not claimed");
					return claimed;
				});
			const pageLease = lease();
			database.write((scope) =>
				metadata.applyPage(scope, pageLease, {
					...ref,
					expectedCursor: null,
					expectedRevision: 0,
					cursor: "DYTEST-ingest-page-1",
					changes: [
						{
							kind: "email.message",
							providerId:
								index === 0 ? "DYTEST-provider-message" : `DYTEST-provider-message-${index}`,
							threadId: index === 0 ? "DYTEST-provider-thread" : `DYTEST-provider-thread-${index}`,
							internalDate: 990_000,
							labelIds: ["INBOX", "SENT"],
						},
					],
				}),
			);
			const message = database.write((scope) => metadata.messages(scope, ref)[0]);
			if (!message) throw new Error("Synthetic metadata was not persisted");
			const project = async (bytes: Uint8Array): Promise<BlobRef> => {
				const writer = database.write((scope) => raw.begin(scope, ref));
				const decoder = createJsonMemberDecoder("raw");
				const document = new TextEncoder().encode(
					JSON.stringify({ raw: Buffer.from(bytes).toString("base64url") }),
				);
				async function* entity() {
					decoder.countCompressed(document.length);
					yield document;
				}
				return writeJsonMember(decoder, entity(), writer, new AbortController().signal);
			};
			return { account, ref, message, lease, project, ingestor };
		};
		const primary = createMailbox();
		return {
			native,
			time,
			database,
			accounts,
			jobs,
			metadata,
			raw,
			parsed,
			...primary,
			createMailbox,
			cleanup: () => closeFixture(native),
		};
	} catch (error) {
		try {
			await closeFixture(native);
		} catch {
			// Preserve the original setup refusal if cleanup also refuses.
		}
		throw error;
	}
}
