import { Account } from "@draftyak/protocol/entities/account";
import { afterEach, describe, expect, it } from "vitest";
import {
	NativeAccounts,
	restrictNativeAccountsForRestoreInTransaction,
} from "../../src/accounts/records.ts";
import { newId } from "../../src/kernel/ids.ts";
import { type NativeProposalProviders, ProposalError } from "../../src/outbox/propose.ts";
import type { SqlTransaction } from "../../src/store/store.ts";
import {
	type Candidate,
	type CandidateOptions,
	type Fixture,
	fixture,
	native,
} from "./propose-fixture.ts";

const fixtures: Fixture[] = [];
async function setup() {
	const f = await fixture();
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.close();
});

function stored(f: Fixture) {
	return f.native.store.read((tx) => ({
		accounts: tx.all("SELECT * FROM main.accounts ORDER BY id"),
		headers: tx.all("SELECT * FROM main.native_drafts ORDER BY id"),
		revisions: tx.all("SELECT * FROM main.native_draft_revisions ORDER BY draft_id,rev"),
		locks: tx.all("SELECT * FROM main.native_draft_locks ORDER BY id"),
		outbox: tx.all("SELECT * FROM main.outbox ORDER BY id"),
		jobs: tx.all("SELECT * FROM main.jobs ORDER BY seq"),
		audit: tx.all("SELECT * FROM main.audit_events ORDER BY seq"),
		auditMeta: tx.all("SELECT * FROM main.audit_meta ORDER BY singleton"),
		events: tx.all("SELECT * FROM main.events ORDER BY seq"),
		eventMeta: tx.all("SELECT * FROM main.event_meta ORDER BY singleton"),
	}));
}
function attempt(work: () => unknown) {
	let result: unknown;
	let failure: unknown;
	try {
		result = work();
	} catch (error) {
		failure = error;
	}
	return { result, failure };
}
function policyRefusal(value: ReturnType<typeof attempt>) {
	expect(value.result).toBeUndefined();
	expect(value.failure).toBeInstanceOf(ProposalError);
	expect(value.failure).toMatchObject({
		name: "ProposalError",
		code: "POLICY_DENIED",
		message: "Native outbox unavailable",
	});
}
function reviewed(f: Fixture, p: Candidate) {
	return f.target.write((tx) => f.target.item(tx, p.id));
}
function marker(tx: SqlTransaction, f: Fixture, p: Candidate) {
	const id = newId(f.time.wall);
	tx.run(
		"INSERT INTO main.jobs(id,account_id,owner_id,kind,ref_id,state,attempts,max_attempts,created_at,next_at,lease_until,token) VALUES(?,?,?,?,?,'PENDING',0,1,?,?,NULL,NULL)",
		[
			id,
			p.binding.accountId,
			native.owner(f.native),
			"draft",
			p.binding.draftId,
			f.time.wall,
			f.time.wall,
		],
	);
	return id;
}
function otherChannel(value: Account): Account {
	const changed: Record<string, unknown> = { ...value };
	if (value.channel === "email") {
		Reflect.deleteProperty(changed, "address");
		Object.assign(changed, {
			channel: "chat",
			teamId: "DYTEST-other-team",
			selfUserId: "DYTEST-user",
		});
	} else {
		Reflect.deleteProperty(changed, "teamId");
		Reflect.deleteProperty(changed, "selfUserId");
		Object.assign(changed, { channel: "email", address: "dytest-owner@example.invalid" });
	}
	return Account.parse(changed);
}
const unavailable: ReadonlyArray<readonly [string, CandidateOptions["account"]]> = [
	["missing", null],
	["read-only", (account) => ({ ...account, mode: "read_only" })],
	["paused", (account) => ({ ...account, status: "paused" })],
	["disconnecting", (account) => ({ ...account, status: "disconnecting" })],
	[
		"credential-lost",
		(account) => ({
			...account,
			status: "credential_lost",
			deletionDeadline: account.createdAt + 86_400_000,
		}),
	],
	["another owner", (account) => ({ ...account, userId: newId(account.createdAt) })],
	["another channel", otherChannel],
	[
		"another sender",
		(account) =>
			account.channel === "email"
				? { ...account, address: "dytest-other@example.invalid" }
				: account,
	],
];

describe("current native proposal account", () => {
	it.each(unavailable)(
		"refuses a %s account before exposing native proposal DATA",
		async (_label, account) => {
			const f = await setup(),
				p = f.candidate({ account });
			const original = f.providers;
			if (!original) throw new Error("DYTEST native DATA providers required");
			let facts = 0,
				flags = 0;
			f.replaceTarget({
				facts: (...args) => {
					facts++;
					return original.facts(...args);
				},
				flags: (...args) => {
					flags++;
					return original.flags(...args);
				},
			});
			const before = stored(f);
			const result = attempt(() => f.target.propose(f.device.peer, p.input));
			policyRefusal(result);
			expect({ facts, flags }).toEqual({ facts: 0, flags: 0 });
			expect(stored(f)).toEqual(before);
			expect(f.revisions.current(p.binding).lockId).toBeNull();
		},
	);

	it.each(["email", "chat"] as const)(
		"uses the genuine active full %s account",
		async (channel) => {
			const f = await setup(),
				p = f.proposal({ channel });
			expect(f.readAccount(p.binding.accountId)).toMatchObject({
				generation: 1,
				account: p.account,
			});
			expect(reviewed(f, p)).toMatchObject({
				id: p.id,
				accountId: p.account.id,
				state: "PENDING_APPROVAL",
			});
			expect(f.revisions.current(p.binding).lockId).not.toBeNull();
			f.native.store.read((tx) => f.native.audit.verify(tx));
		},
	);

	it("refuses a read-only chat account independently of its native chat facts", async () => {
		const f = await setup(),
			p = f.candidate({
				channel: "chat",
				account: (account) => ({ ...account, mode: "read_only" }),
			});
		const before = stored(f);
		policyRefusal(attempt(() => f.target.propose(f.device.peer, p.input)));
		expect(stored(f)).toEqual(before);
	});

	it("does not substitute an account from a different real store", async () => {
		const f = await setup(),
			other = await setup(),
			p = f.candidate({ account: null });
		other.seedAccount(p.account);
		expect(other.readAccount(p.account.id, p.account.userId)?.account).toEqual(p.account);
		expect(f.readAccount(p.account.id)).toBeUndefined();
		const before = stored(f),
			foreignBefore = stored(other);
		policyRefusal(attempt(() => f.target.propose(f.device.peer, p.input)));
		expect(stored(f)).toEqual(before);
		expect(stored(other)).toEqual(foreignBefore);
		other.target.write((tx) => {
			expect(() => f.accounts.getInTransaction(tx, p.account.userId, p.account.id)).toThrow();
		});
		f.seedAccount(p.account);
		expect(f.target.propose(f.device.peer, p.input).id).toBe(p.id);
	});

	it("keeps a valid local account usable despite conflicting foreign account DATA", async () => {
		const f = await setup(),
			other = await setup(),
			p = f.candidate();
		other.seedAccount({ ...p.account, mode: "read_only" });
		expect(f.target.propose(f.device.peer, p.input).id).toBe(p.id);
		expect(reviewed(f, p)?.accountId).toBe(p.account.id);
		expect(other.readAccount(p.account.id, p.account.userId)?.account.mode).toBe("read_only");
	});

	it("rejects malformed current native account bytes without returning stored diagnostics", async () => {
		const f = await setup(),
			p = f.candidate();
		f.native.store.write((tx) =>
			tx.run("UPDATE main.accounts SET account_json=? WHERE id=?", ["{{", p.account.id]),
		);
		const before = stored(f),
			result = attempt(() => f.target.propose(f.device.peer, p.input));
		expect(result.result).toBeUndefined();
		expect(result.failure).toMatchObject({
			name: "ProposalError",
			code: "PROPOSAL_STALE",
			message: "Native outbox unavailable",
		});
		expect(stored(f)).toEqual(before);
	});

	it.each(["data", "getter"] as const)(
		"ignores an own %s call field on the captured account reader",
		async (kind) => {
			const f = await setup(),
				p = f.candidate(),
				missing = f.candidate({ account: null });
			const target = NativeAccounts.prototype.getInTransaction;
			const previous = Object.getOwnPropertyDescriptor(target, "call");
			let observations = 0;
			const effect = () => {
				observations++;
				throw new Error("DYTEST mutable call field");
			};
			Object.defineProperty(
				target,
				"call",
				kind === "data"
					? { configurable: true, value: effect }
					: { configurable: true, get: effect },
			);
			try {
				expect(f.target.propose(f.device.peer, p.input).id).toBe(p.id);
				expect(reviewed(f, p)?.id).toBe(p.id);
				const before = stored(f);
				policyRefusal(attempt(() => f.target.propose(f.device.peer, missing.input)));
				expect(stored(f)).toEqual(before);
				expect(observations).toBe(0);
			} finally {
				if (previous) Object.defineProperty(target, "call", previous);
				else Reflect.deleteProperty(target, "call");
			}
		},
	);
});

describe("account currentness while reviewing a proposal", () => {
	it.each(["read_only", "paused", "disconnecting", "credential_lost"] as const)(
		"refuses a stored proposal after its account becomes %s",
		async (state) => {
			const f = await setup(),
				p = f.proposal();
			f.replaceAccount(p.account.id, (account) =>
				state === "read_only"
					? { ...account, mode: state }
					: {
							...account,
							status: state,
							deletionDeadline: state === "credential_lost" ? f.time.wall + 86_400_000 : null,
						},
			);
			const before = stored(f);
			policyRefusal(attempt(() => reviewed(f, p)));
			expect(stored(f)).toEqual(before);
			expect(f.target.write((tx) => f.target.get(tx, p.id))?.state).toBe("PENDING_APPROVAL");
		},
	);

	it("refuses a real retired account tombstone without releasing its stored proposal lock", async () => {
		const f = await setup(),
			p = f.proposal();
		const disconnecting = f.replaceAccount(p.account.id, (account) => ({
			...account,
			status: "disconnecting",
		}));
		f.accountDatabase.write((scope) =>
			f.accounts.retire(scope, p.account.userId, p.account.id, disconnecting.generation),
		);
		const before = stored(f),
			lock = f.revisions.current(p.binding).lockId;
		expect(f.readAccount(p.account.id)).toBeUndefined();
		policyRefusal(attempt(() => reviewed(f, p)));
		expect(stored(f)).toEqual(before);
		expect(f.revisions.current(p.binding).lockId).toBe(lock);
	});

	it("accepts harmless generation and alias changes before creation and later review", async () => {
		const f = await setup(),
			p = f.candidate();
		const second = f.replaceAccount(p.account.id, (account) => ({
			...account,
			alias: "dytest-renamed-before-proposal",
		}));
		expect(second.generation).toBe(2);
		const proposed = f.target.propose(f.device.peer, p.input);
		const third = f.replaceAccount(p.account.id, (account) => ({
			...account,
			alias: "dytest-renamed-before-review",
		}));
		expect(third.generation).toBe(3);
		expect(reviewed(f, p)).toEqual(proposed);
	});
});

describe("account changes inside dependent callbacks", () => {
	for (const operation of ["propose", "review"] as const) {
		it.each(["facts", "flags"] as const)(
			`refuses ${operation} after its %s callback restricts the real account`,
			async (stage) => {
				const f = await setup(),
					p = operation === "review" ? f.proposal() : f.candidate();
				const original = f.providers;
				if (!original) throw new Error("DYTEST native DATA providers required");
				let reached = false,
					changed = 0,
					flagsCalls = 0,
					observedMode: string | undefined;
				const restrict = (tx: SqlTransaction) => {
					reached = true;
					changed = restrictNativeAccountsForRestoreInTransaction(f.accounts, tx);
					observedMode = f.accounts.getInTransaction(tx, p.account.userId, p.account.id)?.account
						.mode;
				};
				f.replaceTarget({
					facts: (...args) => {
						const value = original.facts(...args);
						if (stage === "facts") restrict(args[0]);
						return value;
					},
					flags: (...args) => {
						flagsCalls++;
						const value = original.flags(...args);
						if (stage === "flags") restrict(args[0]);
						return value;
					},
				});
				const before = stored(f);
				const result = attempt(() =>
					operation === "propose" ? f.target.propose(f.device.peer, p.input) : reviewed(f, p),
				);
				expect({ reached, changed, observedMode }).toEqual({
					reached: true,
					changed: 1,
					observedMode: "read_only",
				});
				expect(flagsCalls).toBe(stage === "facts" ? 0 : 1);
				policyRefusal(result);
				expect(stored(f)).toEqual(before);
				expect(f.readAccount(p.account.id)?.account.mode).toBe("full");
				f.replaceTarget(original);
				expect(
					operation === "propose"
						? f.target.propose(f.device.peer, p.input).id
						: reviewed(f, p)?.id,
				).toBe(p.id);
			},
		);

		it(`poisons a caught ${operation} account refusal and rolls back the outer real job write`, async () => {
			const f = await setup(),
				p = operation === "review" ? f.proposal() : f.candidate();
			f.replaceAccount(p.account.id, (account) => ({ ...account, mode: "read_only" }));
			const before = stored(f);
			let inner: ReturnType<typeof attempt> | undefined,
				markerSeen = false;
			const outer = attempt(() =>
				f.target.write((tx, scope) => {
					const id = marker(tx, f, p);
					inner = attempt(() =>
						operation === "propose"
							? f.target.proposeInTransaction(scope, f.device.peer, p.input)
							: f.target.item(tx, p.id),
					);
					markerSeen = tx.get("SELECT 1 FROM main.jobs WHERE id=?", [id]) !== undefined;
				}),
			);
			expect(markerSeen).toBe(true);
			expect(inner).toBeDefined();
			policyRefusal(inner as ReturnType<typeof attempt>);
			expect(outer.failure).toBeDefined();
			expect(outer.result).toBeUndefined();
			expect(stored(f)).toEqual(before);
		});
	}

	it("rechecks the account after a clock callback during the actual freeze write", async () => {
		const f = await setup(),
			p = f.candidate(),
			original = f.providers;
		if (!original) throw new Error("DYTEST native DATA providers required");
		let active: SqlTransaction | undefined,
			armed = false,
			reached = false;
		const wallMs = f.clock.wallMs;
		f.clock.wallMs = () => {
			if (armed && active) {
				armed = false;
				reached = restrictNativeAccountsForRestoreInTransaction(f.accounts, active) === 1;
			}
			return wallMs();
		};
		f.replaceTarget({
			facts: (...args) => {
				active = args[0];
				return original.facts(...args);
			},
			flags: (...args) => {
				const value = original.flags(...args);
				armed = true;
				return value;
			},
		});
		const before = stored(f);
		try {
			const result = attempt(() => f.target.propose(f.device.peer, p.input));
			expect(reached).toBe(true);
			policyRefusal(result);
			expect(stored(f)).toEqual(before);
			expect(f.revisions.current(p.binding).lockId).toBeNull();
		} finally {
			f.clock.wallMs = wallMs;
		}
	});

	it("accepts a harmless alias change in the facts callback without pinning its generation", async () => {
		const f = await setup(),
			p = f.candidate(),
			original = f.providers;
		if (!original) throw new Error("DYTEST native DATA providers required");
		let reached = false;
		const providers: NativeProposalProviders = {
			facts: (...args) => {
				const value = original.facts(...args);
				const account = { ...p.account, alias: "dytest-callback-rename" };
				reached =
					args[0].run(
						"UPDATE main.accounts SET generation=generation+1,account_json=? WHERE id=?",
						[JSON.stringify(account), account.id],
					).changes === 1;
				return value;
			},
			flags: original.flags,
		};
		f.replaceTarget(providers);
		expect(f.target.propose(f.device.peer, p.input).id).toBe(p.id);
		expect(reached).toBe(true);
		expect(f.readAccount(p.account.id)).toMatchObject({
			generation: 2,
			account: { alias: "dytest-callback-rename", mode: "full", status: "active" },
		});
		f.replaceTarget(original);
		expect(reviewed(f, p)?.id).toBe(p.id);
	});
});
