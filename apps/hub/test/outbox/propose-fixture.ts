import path from "node:path";
import type { Account } from "@draftyak/protocol/entities/account";
import type { DraftContent } from "@draftyak/protocol/entities/draft";
import type { Flag } from "@draftyak/protocol/flags";
import type { CurrentSendSnapshotV1, Schedule } from "@draftyak/protocol/snapshot";
import { type AccountRecord, NativeAccounts } from "../../src/accounts/records.ts";
import {
	type DraftBinding,
	NativeDraftRevisions,
	type NativeRevision,
} from "../../src/drafts/revisions.ts";
import { EVENT_MIGRATIONS, EventLog } from "../../src/events/log.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { JOB_MIGRATIONS } from "../../src/jobs/queue.ts";
import type { TimerClock } from "../../src/kernel/clock.ts";
import { newId } from "../../src/kernel/ids.ts";
import {
	NativeOutboxProposals,
	type NativeOutboxSettings,
	type NativeProposalFacts,
	type NativeProposalInput,
	type NativeProposalProviders,
	OUTBOX_MIGRATIONS,
} from "../../src/outbox/propose.ts";
import type { SendTargetRecord } from "../../src/outbox/verifier-types.ts";
import * as native from "../authz/native-fixture.ts";

export { native };
export interface Candidate {
	readonly id: string;
	readonly account: Account;
	readonly binding: DraftBinding;
	readonly current: NativeRevision;
	readonly input: NativeProposalInput;
}
export interface ProposalCandidate extends Candidate {
	readonly record: SendTargetRecord;
}
export interface Fixture {
	readonly native: native.NativeFixture;
	readonly device: native.TestDevice;
	readonly time: { wall: number; mono: number };
	readonly clock: TimerClock;
	readonly revisions: NativeDraftRevisions;
	readonly providers: NativeProposalProviders | undefined;
	readonly target: NativeOutboxProposals;
	readonly accounts: NativeAccounts;
	readonly accountDatabase: WorkDatabase;
	readAccount(accountId: string, userId?: string): AccountRecord | undefined;
	seedAccount(value: Account): AccountRecord;
	replaceAccount(
		accountId: string,
		change: (value: Account) => Account,
		userId?: string,
	): AccountRecord;
	candidate(input?: CandidateOptions): Candidate;
	proposal(input?: CandidateOptions): ProposalCandidate;
	replaceTarget(dataProviders?: NativeProposalProviders | null): NativeOutboxProposals;
	close(): Promise<void>;
}
export interface ProposalFixtureOptions {
	readonly settings?: NativeOutboxSettings;
	readonly extraMigrations?: Readonly<Record<string, string>>;
	/** Null composes the real production default: unavailable facts and flagger. */
	readonly providers?: NativeProposalProviders | null;
}
export interface CandidateOptions {
	/** A real account seed transform; null leaves this candidate's account absent. */
	readonly account?: ((value: Account) => Account) | null;
	readonly flags?: readonly Flag[];
	readonly channel?: "email" | "chat";
	readonly schedule?: Schedule;
	readonly requiredApprovals?: number;
	readonly requiredUsers?: readonly string[];
	readonly undoWindowMs?: number;
	readonly expiresAt?: number;
	readonly dataClass?: string;
}

/** Real native authority/storage; the explicitly labelled providers below supply synthetic DATA only. */
export async function fixture(options: ProposalFixtureOptions = {}): Promise<Fixture> {
	const migrations: Record<string, string> = {
		jobs: JOB_MIGRATIONS,
		events: EVENT_MIGRATIONS,
		revisions: path.resolve(import.meta.dirname, "../../src/drafts/migrations"),
		outbox: OUTBOX_MIGRATIONS,
		accounts: path.resolve(import.meta.dirname, "../../src/accounts/migrations"),
	};
	for (const [key, directory] of Object.entries(options.extraMigrations ?? {}))
		if (Object.hasOwn(migrations, key) && migrations[key] !== directory)
			throw new Error("DYTEST migration collision");
	const f = await native.fixture({ ...migrations, ...options.extraMigrations });
	const time = { wall: Date.now(), mono: 0 };
	const clock: TimerClock = {
		wallMs: () => time.wall,
		monotonicMs: () => time.mono,
		after: (ms, signal) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, ms);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("DYTEST aborted"));
					},
					{ once: true },
				);
			}),
	};
	let revisions: NativeDraftRevisions | undefined;
	let target: NativeOutboxProposals | undefined;
	try {
		const device = await native.bootstrap(f);
		const accountDatabase = new WorkDatabase(f.store),
			accountEvents = new EventLog(accountDatabase, () => time.wall),
			accounts = new NativeAccounts(accountDatabase, accountEvents, f.audit, () => time.wall);
		const readAccount = (accountId: string, userId = native.owner(f)) =>
			accountDatabase.write((scope) => accounts.get(scope, userId, accountId));
		const seedAccount = (value: Account) =>
			accountDatabase.write((scope) => accounts.create(scope, value));
		const replaceAccount = (
			accountId: string,
			change: (value: Account) => Account,
			userId = native.owner(f),
		) =>
			accountDatabase.write((scope) => {
				const previous = accounts.get(scope, userId, accountId);
				if (!previous) throw new Error("DYTEST current account required");
				return accounts.replace(scope, change(previous.account), previous.generation);
			});
		revisions = new NativeDraftRevisions(f.store, f.audit, f.key, clock);
		const storedRevisions = revisions;
		const TEST_ONLY_NATIVE_FACTS = new Map<string, NativeProposalFacts>();
		const TEST_ONLY_NATIVE_PROPOSAL_PROVIDERS = Object.freeze<NativeProposalProviders>({
			facts: (_tx, binding) => TEST_ONLY_NATIVE_FACTS.get(binding.draftId),
			flags: (_tx, _binding, current) => current.revision.flags,
		});
		const providers =
			options.providers === null
				? undefined
				: (options.providers ?? TEST_ONLY_NATIVE_PROPOSAL_PROVIDERS);
		const makeTarget = (dataProviders: NativeProposalProviders | undefined) =>
			new NativeOutboxProposals(
				f.store,
				f.audit,
				f.key,
				storedRevisions,
				f.registry,
				f.authorizer,
				f.identity,
				clock,
				options.settings,
				dataProviders,
			);
		target = makeTarget(providers);
		let currentTarget = target,
			closed = false;
		const candidate = (input: CandidateOptions = {}): Candidate => {
			const channel = input.channel ?? "email",
				accountId = newId(time.wall),
				dataClass = input.dataClass ?? (channel === "email" ? "gmail.content" : "slack.content"),
				binding: DraftBinding = {
					draftId: newId(time.wall),
					accountId,
					conversationId: channel === "email" ? null : newId(time.wall),
					channel,
				};
			const common = {
				id: accountId,
				userId: native.owner(f),
				alias: "dytest-account",
				mode: "full" as const,
				status: "active" as const,
				deletionDeadline: null,
				historyLimitDays: 30,
				disclosureVersion: 1,
				createdAt: time.wall,
				pluginInstanceId: newId(time.wall),
			};
			const defaultAccount: Account =
				channel === "email"
					? { ...common, channel, address: "dytest-owner@example.invalid" }
					: { ...common, channel, teamId: "DYTEST-team", selfUserId: "DYTEST-owner" };
			const account = input.account?.(defaultAccount) ?? defaultAccount;
			if (input.account !== null) seedAccount(account);
			const content: DraftContent =
				channel === "email"
					? {
							channel,
							to: ["dytest-recipient@example.invalid"],
							cc: [],
							bcc: [],
							subject: "DYTEST subject",
							body: "DYTEST draft body",
							attachments: [],
						}
					: { channel, body: "DYTEST draft body", threadTs: null, broadcast: false };
			const current = f.store.write((tx) =>
				storedRevisions.createInTransaction(tx, {
					...binding,
					content,
					flags: input.flags ?? [],
					author: { kind: "owner", id: native.owner(f) },
				}),
			);
			const id = newId(time.wall),
				base = {
					v: 1 as const,
					hub: f.identity.hid,
					epoch: f.store.read((db) => f.registry.state(db).epoch),
					outbox: id,
					account: accountId,
					conversation: binding.conversationId,
					body: { text: content.body, footer: "DYTEST native footer" },
					attachments: [],
					schedule: input.schedule ?? { kind: "now" as const },
					source: { draft: binding.draftId, rev: current.revision.rev, authors: current.authors },
				};
			let snapshot: CurrentSendSnapshotV1;
			if (content.channel === "email") {
				const email = {
					from: "dytest-owner@example.invalid",
					to: content.to,
					cc: content.cc,
					bcc: content.bcc,
					subject: content.subject,
					references: [],
				};
				snapshot = { ...base, kind: "email", email };
				TEST_ONLY_NATIVE_FACTS.set(binding.draftId, {
					kind: "email",
					accountId,
					conversationId: binding.conversationId,
					dataClass,
					footer: base.body.footer,
					email: { from: email.from, references: [] },
				});
			} else {
				const chat = {
					channelId: "DYTEST-channel",
					channelName: "DYTEST room",
					channelType: "public" as const,
					external: false,
					shared: false,
					memberCount: 2,
					broadcast: false,
				};
				snapshot = { ...base, conversation: binding.conversationId as string, kind: "chat", chat };
				TEST_ONLY_NATIVE_FACTS.set(binding.draftId, {
					kind: "chat",
					accountId,
					conversationId: binding.conversationId,
					dataClass,
					footer: base.body.footer,
					chat,
				});
			}
			return {
				id,
				account,
				binding,
				current,
				input: {
					binding,
					expectedRev: current.revision.rev,
					snapshot,
					dataClass,
					requiredApprovals: input.requiredApprovals ?? 1,
					requiredUsers: input.requiredUsers ?? [native.owner(f)],
					undoWindowMs: input.undoWindowMs ?? 10_000,
					expiresAt: input.expiresAt ?? time.wall + 86_400_000,
				},
			};
		};
		return {
			native: f,
			device,
			time,
			clock,
			revisions: storedRevisions,
			providers,
			accounts,
			accountDatabase,
			readAccount,
			seedAccount,
			replaceAccount,
			get target() {
				return currentTarget;
			},
			candidate,
			proposal(input: CandidateOptions = {}) {
				const p = candidate(input);
				return { ...p, record: currentTarget.propose(device.peer, p.input) };
			},
			replaceTarget(dataProviders: NativeProposalProviders | null = null) {
				currentTarget.destroy();
				currentTarget = makeTarget(dataProviders ?? undefined);
				return currentTarget;
			},
			async close() {
				if (closed) return;
				closed = true;
				currentTarget.destroy();
				storedRevisions.destroy();
				await native.closeFixture(f);
			},
		};
	} catch (error) {
		target?.destroy();
		revisions?.destroy();
		await native.closeFixture(f);
		throw error;
	}
}
