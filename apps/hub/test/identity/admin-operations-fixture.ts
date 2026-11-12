import path from "node:path";
import { Account } from "@draftyak/protocol/entities/account";
import { type AccountRecord, NativeAccounts } from "../../src/accounts/records.ts";
import { EventLog } from "../../src/events/log.ts";
import {
	ADMIN_OPERATION_MIGRATIONS,
	NativeAccountModeOperations,
} from "../../src/identity/admin-operations.ts";
import { CHALLENGE_MIGRATIONS } from "../../src/identity/challenges.ts";
import { ADMIN_CHALLENGE_MIGRATIONS } from "../../src/identity/challenges-admin.ts";
import { WorkDatabase } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import { APPROVAL_MIGRATIONS, SendApprovalVerifier } from "../../src/outbox/verifier.ts";
import {
	native,
	type Fixture as ProposalFixture,
	fixture as proposalFixture,
} from "../outbox/propose-fixture.ts";

export { native };
export interface AdminFixtureOptions {
	readonly extraMigrations?: Readonly<Record<string, string>>;
}
export interface Fixture extends ProposalFixture {
	readonly operations: NativeAccountModeOperations;
	readonly send: SendApprovalVerifier;
	readonly database: WorkDatabase;
	readonly accounts: NativeAccounts;
	readonly account: AccountRecord;
	current(accountId?: string): AccountRecord;
	createAccount(changes?: Partial<Account>): AccountRecord;
}

/** Real native authority and storage; account identity below is labelled synthetic DATA only. */
export async function fixture(options: AdminFixtureOptions = {}): Promise<Fixture> {
	const migrations = {
		accounts: path.resolve(import.meta.dirname, "../../src/accounts/migrations"),
		admin: ADMIN_OPERATION_MIGRATIONS,
		challenges: CHALLENGE_MIGRATIONS,
		verifier: APPROVAL_MIGRATIONS,
		adminchallenges: ADMIN_CHALLENGE_MIGRATIONS,
		adminfaults: path.resolve(import.meta.dirname, "fixtures/admin-faults"),
	};
	for (const key of Object.keys(options.extraMigrations ?? {}))
		if (Object.hasOwn(migrations, key)) throw new Error("DYTEST migration collision");
	const base = await proposalFixture({
		extraMigrations: { ...migrations, ...options.extraMigrations },
	});
	let operations: NativeAccountModeOperations | undefined;
	let send: SendApprovalVerifier | undefined;
	try {
		const f = base.native,
			database = new WorkDatabase(f.store),
			accounts = new NativeAccounts(
				database,
				new EventLog(database, () => base.time.wall),
				f.audit,
				() => base.time.wall,
			);
		const createAccount = (changes: Partial<Account> = {}): AccountRecord => {
			const common = {
				id: newId(base.time.wall),
				userId: native.owner(f),
				alias: newId(base.time.wall).toLowerCase(),
				mode: "read_only",
				status: "active",
				deletionDeadline: null,
				historyLimitDays: 30,
				disclosureVersion: 1,
				createdAt: base.time.wall,
				pluginInstanceId: newId(base.time.wall),
			};
			const TEST_ONLY_ACCOUNT_DATA = Account.parse(
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
			return database.write((scope) => accounts.create(scope, TEST_ONLY_ACCOUNT_DATA));
		};
		const account = createAccount();
		operations = new NativeAccountModeOperations(
			f.store,
			f.audit,
			f.key,
			f.registry,
			f.authorizer,
			f.identity,
			base.clock,
		);
		send = new SendApprovalVerifier(f.store, f.audit, f.registry, f.authorizer, {
			identity: f.identity,
			target: base.target,
			masterKey: f.key,
			clock: base.clock,
		});
		const issuer = operations,
			verifier = send;
		let closed = false;
		return {
			...base,
			get target() {
				return base.target;
			},
			operations: issuer,
			send: verifier,
			database,
			accounts,
			account,
			createAccount,
			current(accountId: string = account.account.id): AccountRecord {
				const value = database.write((scope) => accounts.get(scope, native.owner(f), accountId));
				if (!value) throw new Error("DYTEST account missing");
				return value;
			},
			async close(): Promise<void> {
				if (closed) return;
				closed = true;
				issuer.lock();
				verifier.lock();
				await base.close();
			},
		};
	} catch (error) {
		operations?.lock();
		send?.lock();
		await base.close();
		throw error;
	}
}
