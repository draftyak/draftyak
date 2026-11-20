import { randomBytes } from "node:crypto";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { NativeDevicePeer } from "../../src/authz/native-peer.ts";
import type { WorkScope } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import { MasterKey } from "../../src/kernel/master-key.ts";
import {
	assertNativeOutboxScope,
	assertNativeOutboxTarget,
	NativeOutboxProposals,
	type NativeProposalInput,
	type NativeProposalProviders,
	ProposalError,
	readNativeOutboxTarget,
} from "../../src/outbox/propose.ts";
import type { SqlReader } from "../../src/store/store.ts";
import { type Fixture, fixture, native } from "./propose-fixture.ts";

const fixtures: Fixture[] = [];
async function setup(options: Parameters<typeof fixture>[0] = {}) {
	const f = await fixture(options);
	fixtures.push(f);
	return f;
}
afterEach(async () => {
	for (const f of fixtures.splice(0)) await f.close();
});
const code = (value: string) => expect.objectContaining({ name: "ProposalError", code: value });
function counts(f: Fixture) {
	return f.native.store.read((tx) => ({
		outbox: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.outbox")?.n,
		locks: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.native_draft_locks")?.n,
		audit: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.audit_events")?.n,
		events: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.events")?.n,
	}));
}
function stored(f: Fixture, id: string) {
	return f.target.write((tx) => f.target.get(tx, id));
}

it("takes the real draft lock at propose and persists exact immutable data with ID-only audit/events", async () => {
	const f = await setup(),
		p = f.proposal({ flags: [{ code: "EXTERNAL_LINK", severity: "ack" }] });
	const row = stored(f, p.id);
	expect(row).toMatchObject({
		state: "PENDING_APPROVAL",
		rev: 1,
		notBefore: null,
		deliverBy: null,
		requiredUsers: [native.owner(f.native)],
		revisionContentHash: p.current.revision.contentSha256,
	});
	expect(row?.lockId).toBe(f.revisions.current(p.binding).lockId);
	expect(row?.lockId).not.toBeNull();
	expect(Object.isFrozen(row?.snapshot.body)).toBe(true);
	expect(f.target.write((tx) => readNativeOutboxTarget(f.target, tx, p.id))).toMatchObject({
		targetVersion: expect.any(Number),
	});
	const metadata = f.native.store.read((tx) => ({
		audit: tx.all<{ refs: string }>(
			"SELECT refs FROM main.audit_events WHERE action='outbox.proposed'",
		),
		events: tx.all<{ ids: string }>("SELECT ids FROM main.events WHERE kind='outbox.changed'"),
	}));
	expect(metadata.audit.map((item) => JSON.parse(item.refs))).toEqual([{ outbox: p.id }]);
	expect(metadata.events.map((item) => JSON.parse(item.ids))).toEqual([[p.id]]);
	expect(JSON.stringify(metadata)).not.toContain(p.current.revision.content.body);
	expect(() =>
		f.native.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...p.binding,
				expectedRev: 1,
				content: p.current.revision.content,
				flags: [],
				author: { kind: "owner", id: native.owner(f.native) },
			}),
		),
	).toThrow();
});

it("requires the actual current TLS peer for proposals and edits", async () => {
	const f = await setup(),
		p = f.candidate(),
		stranger = await native.device(f.native),
		before = counts(f);
	for (const peer of [Object.freeze({}) as NativeDevicePeer, stranger.peer]) {
		expect(() => f.target.propose(peer, p.input)).toThrow();
		expect(() =>
			f.target.appendRevision(peer, {
				...p.binding,
				expectedRev: 1,
				content: p.current.revision.content,
				flags: [],
				author: { kind: "owner", id: native.owner(f.native) },
			}),
		).toThrow();
	}
	expect(counts(f)).toEqual(before);
	expect(f.revisions.current(p.binding).lockId).toBeNull();
});

it("releases and supersedes pending data before one native owner edit and fresh proposal", async () => {
	const f = await setup(),
		p = f.proposal();
	const next = f.target.appendRevision(f.device.peer, {
		...p.binding,
		expectedRev: 1,
		content: { ...p.current.revision.content, body: "DYTEST owner edit" },
		flags: [],
		author: { kind: "plugin", id: newId(f.time.wall) },
	});
	expect(next.revision.author).toEqual({ kind: "owner", id: native.owner(f.native) });
	expect(next.lockId).toBeNull();
	expect(stored(f, p.id)?.state).toBe("SUPERSEDED");
	const input: NativeProposalInput = {
		...p.input,
		expectedRev: next.revision.rev,
		snapshot: {
			...p.input.snapshot,
			outbox: newId(f.time.wall),
			body: { ...p.input.snapshot.body, text: next.revision.content.body },
			source: { draft: p.binding.draftId, rev: next.revision.rev, authors: next.authors },
		},
	};
	expect(f.target.propose(f.device.peer, input).state).toBe("PENDING_APPROVAL");
	expect(f.revisions.current(p.binding).lockId).not.toBeNull();
});

it("re-proposes a pending draft under a new id and atomically retires its old lock/version", async () => {
	const f = await setup(),
		p = f.proposal(),
		old = p.record.targetVersion;
	const next = f.target.propose(f.device.peer, {
		...p.input,
		snapshot: { ...p.input.snapshot, outbox: newId(f.time.wall) },
	});
	expect(stored(f, p.id)?.state).toBe("SUPERSEDED");
	expect(next.targetVersion).not.toBe(old);
	expect(f.revisions.current(p.binding).lockId).toBe(stored(f, next.id)?.lockId);
	expect(() => f.target.write((tx) => readNativeOutboxTarget(f.target, tx, p.id))).toThrow();
});

it("rolls back lock, record, audit and event even when a consumer catches an insert failure", async () => {
	const f = await setup({
			extraMigrations: { faults: path.resolve(import.meta.dirname, "fixtures/proposal-faults") },
		}),
		seed = f.proposal(),
		seedLock = f.revisions.current(seed.binding).lockId;
	const p = f.candidate();
	const before = counts(f);
	let reached:
		| { locks: number | undefined; audit: number | undefined; outbox: number | undefined }
		| undefined;
	expect(() =>
		f.target.write((tx, scope) => {
			try {
				f.target.proposeInTransaction(scope, f.device.peer, p.input);
			} catch {
				// SQLite's statement failure leaves these earlier writes visible inside the still-live
				// transaction. The poisoned WorkScope must roll them back even though this caller catches.
				reached = {
					locks: tx.get<{ n: number }>(
						"SELECT count(*) AS n FROM main.native_draft_locks WHERE draft_id=?",
						[p.binding.draftId],
					)?.n,
					audit: tx.get<{ n: number }>(
						"SELECT count(*) AS n FROM main.audit_events WHERE action='outbox.proposed' AND json_extract(refs,'$.outbox')=?",
						[p.id],
					)?.n,
					outbox: tx.get<{ n: number }>("SELECT count(*) AS n FROM main.outbox WHERE id=?", [p.id])
						?.n,
				};
			}
		}),
	).toThrow();
	expect(reached).toEqual({ locks: 1, audit: 1, outbox: 0 });
	expect(counts(f)).toEqual(before);
	expect(f.revisions.current(p.binding).lockId).toBeNull();
	expect(stored(f, seed.id)?.state).toBe("PENDING_APPROVAL");
	expect(f.revisions.current(seed.binding).lockId).toBe(seedLock);
});

it("keeps uncomposed production facts closed, including a reopened test-created pending row", async () => {
	const f = await setup(),
		p = f.proposal(),
		before = counts(f);
	f.replaceTarget(null);
	expect(() => f.target.write((tx) => readNativeOutboxTarget(f.target, tx, p.id))).toThrow(
		code("NATIVE_FACTS_UNAVAILABLE"),
	);
	const fresh = f.candidate(),
		afterCandidate = counts(f);
	expect(() => f.target.propose(f.device.peer, fresh.input)).toThrow(
		code("NATIVE_FACTS_UNAVAILABLE"),
	);
	expect(counts(f)).toEqual(afterCandidate);
	expect(stored(f, p.id)?.state).toBe("PENDING_APPROVAL");
	expect(afterCandidate.outbox).toBe(before.outbox);
});

it.each(["facts", "flags"] as const)(
	"requires independently recomputed native %s DATA",
	async (mode) => {
		const f = await setup(),
			p = f.candidate(),
			original = f.providers;
		if (!original) throw new Error("DYTEST providers missing");
		const providers: NativeProposalProviders =
			mode === "facts"
				? {
						facts: (tx, binding, current) => {
							const value = original.facts(tx, binding, current);
							return value && { ...value, footer: "DYTEST wrong native footer" };
						},
						flags: original.flags,
					}
				: { facts: original.facts, flags: () => [{ code: "EXTERNAL_LINK", severity: "ack" }] };
		f.replaceTarget(providers);
		const before = counts(f);
		expect(() => f.target.propose(f.device.peer, p.input)).toThrow();
		expect(counts(f)).toEqual(before);
		expect(f.revisions.current(p.binding).lockId).toBeNull();
	},
);

it("requires exact live target scopes and rejects fake, readonly and retired readers", async () => {
	const f = await setup(),
		p = f.proposal();
	expect(() => assertNativeOutboxTarget({ ...f.target }, f.native.store)).toThrow();
	expect(() =>
		readNativeOutboxTarget(f.target, { get: () => p.record, all: () => [] } as SqlReader, p.id),
	).toThrow();
	expect(() => f.native.store.read((db) => readNativeOutboxTarget(f.target, db, p.id))).toThrow();
	expect(() => f.native.store.write((tx) => readNativeOutboxTarget(f.target, tx, p.id))).toThrow();
	let retired: SqlReader | undefined;
	f.target.write((tx, scope) => {
		assertNativeOutboxScope(f.target, tx, scope);
		retired = tx;
	});
	expect(() => readNativeOutboxTarget(f.target, retired as SqlReader, p.id)).toThrow();
	expect(() =>
		f.target.write((tx, _scope) => {
			try {
				assertNativeOutboxScope(f.target, tx, { sql: tx } as WorkScope);
			} catch {
				/* Must poison the real current scope. */
			}
		}),
	).toThrow();
});

it("uses original captured target helpers after mutable prototype replacement", async () => {
	const f = await setup(),
		p = f.proposal(),
		original = NativeOutboxProposals.prototype.item;
	try {
		NativeOutboxProposals.prototype.item = () => {
			throw new Error("DYTEST mutable prototype");
		};
		expect(f.target.write((tx) => readNativeOutboxTarget(f.target, tx, p.id))?.id).toBe(p.id);
	} finally {
		NativeOutboxProposals.prototype.item = original;
	}
});

it("authenticates the proposal MAC and scopes its latest audit binding to its own actions", async () => {
	const f = await setup(),
		p = f.proposal();
	f.native.store.write((tx) =>
		f.native.audit.append(tx, {
			id: newId(f.time.wall),
			at: f.time.wall,
			action: "fixture.foreign_event",
			actor: { kind: "hub", id: null },
			refs: { outbox: p.id },
		}),
	);
	expect(f.target.write((tx) => readNativeOutboxTarget(f.target, tx, p.id))?.targetVersion).toBe(
		p.record.targetVersion,
	);
	f.native.store.write((tx) =>
		tx.run("UPDATE main.outbox SET mac=? WHERE id=?", ["0".repeat(64), p.id]),
	);
	expect(() => f.target.write((tx) => readNativeOutboxTarget(f.target, tx, p.id))).toThrow();
});

it("refuses SMS, agent proposals and fractional schedule minutes without mutation", async () => {
	const f = await setup(),
		p = f.candidate(),
		before = counts(f);
	expect(() =>
		f.target.propose(f.device.peer, {
			...p.input,
			snapshot: { ...p.input.snapshot, kind: "sms" },
		} as unknown as NativeProposalInput),
	).toThrow(code("SMS_UNAVAILABLE"));
	expect(() => f.target.proposeAgent()).toThrow(code("AGENT_PROPOSAL_UNAVAILABLE"));
	const instant = Math.ceil((f.time.wall + 120_000) / 60_000) * 60_000 + 1;
	expect(() =>
		f.target.propose(f.device.peer, {
			...p.input,
			snapshot: {
				...p.input.snapshot,
				schedule: {
					kind: "at",
					notBefore: instant,
					zone: "UTC",
					localWallTime: "2027-01-01T00:00+00:00",
					latenessSec: 900,
					holdIfNewInbound: true,
				},
			},
		}),
	).toThrow();
	expect(counts(f)).toEqual(before);
});

it("admits a native chat snapshot and refuses native settings floors or an absent owner", async () => {
	const f = await setup(),
		p = f.proposal({ channel: "chat" });
	expect(p.record.snapshot.kind).toBe("chat");
	const other = f.candidate();
	expect(() => f.target.propose(f.device.peer, { ...other.input, undoWindowMs: 0 })).toThrow(
		code("POLICY_DENIED"),
	);
	expect(() =>
		f.target.propose(f.device.peer, { ...other.input, requiredUsers: [newId(f.time.wall)] }),
	).toThrow();
});

it("rejects a foreign master key before deriving a proposal service", async () => {
	const f = await setup(),
		bytes = randomBytes(32),
		other = new MasterKey(bytes);
	bytes.fill(0);
	try {
		expect(
			() =>
				new NativeOutboxProposals(
					f.native.store,
					f.native.audit,
					other,
					f.revisions,
					f.native.registry,
					f.native.authorizer,
					f.native.identity,
					f.clock,
				),
		).toThrow(ProposalError);
	} finally {
		other.destroy();
	}
});
