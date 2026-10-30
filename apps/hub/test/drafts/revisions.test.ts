import { existsSync, readFileSync, rmSync } from "node:fs";
import { flagsHash } from "@draftyak/protocol/flags";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { afterEach, describe, expect, it } from "vitest";
import { NativeDraftRevisions } from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { HubStore, type SqlTransaction } from "../../src/store/store.ts";
import { revisionFixture } from "./revision-fixture.ts";

const fixtures: Awaited<ReturnType<typeof revisionFixture>>[] = [];
async function fixture() {
	const f = await revisionFixture();
	fixtures.push(f);
	return f;
}
afterEach(() => {
	for (const f of fixtures.splice(0)) {
		for (const service of f.services) service.destroy();
		for (const store of f.stores) store.close();
		f.audit.destroy();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
});
describe("encrypted immutable native revision storage", () => {
	it("normalizes before shared hashing and persists immutable history across encrypted reopen", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input),
			one = f.create(input);
		expect(one.revision.content.body).toBe(`${f.canary}\nCafé`);
		expect(one.revision.contentSha256).toBe(jcsSha256(one.revision.content));
		expect(one.flagsHash).toBe(flagsHash(one.revision.flags));
		const two = f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...one.revision.content, body: "second" },
			}),
		);
		expect(two.draft.rev).toBe(2);
		expect(f.revisions.history(bound).map((item) => item.content.body)).toEqual([
			`${f.canary}\nCafé`,
			"second",
		]);
		for (const suffix of ["", "-wal", "-shm"]) {
			if (existsSync(f.filename + suffix))
				expect(readFileSync(f.filename + suffix).includes(Buffer.from(f.canary))).toBe(false);
		}
		const next = f.reopen();
		expect(next.revisions.current(bound)).toEqual(two);
		expect(next.revisions.history(bound, 0, 1)).toEqual([one.revision]);
	});
	it("uses expectedRev CAS so concurrent append callers retain exactly one next revision", async () => {
		const f = await fixture(),
			input = f.make(),
			bound = f.bind(input);
		f.create(input);
		// A second real connection reads rev 1 while the first one's append is still uncommitted.
		const store = new HubStore(f.options),
			other = new NativeDraftRevisions(store, f.audit, f.key, f.clock);
		f.stores.push(store);
		f.services.push(other);
		const edit = (body: string) => ({
			...input,
			expectedRev: 1,
			content: { ...input.content, body },
		});
		const seen = f.store.write((tx) => {
			f.revisions.appendInTransaction(tx, edit("one"));
			return other.current(bound).draft.rev;
		});
		expect(seen).toBe(1);
		expect(() => store.write((tx) => other.appendInTransaction(tx, edit("two")))).toThrow(
			"Draft revision unavailable",
		);
		expect(other.history(bound).map((item) => item.content.body)).toEqual([
			`${f.canary}\nCafé`,
			"one",
		]);
	});
	it.each(["accountId", "conversationId", "channel"] as const)(
		"refuses changed %s binding",
		async (field) => {
			const f = await fixture(),
				input = f.make();
			f.create(input);
			const bad = { ...input, [field]: field === "channel" ? "chat" : newId() };
			expect(() => f.revisions.current(f.bind(bad))).toThrow("Draft revision unavailable");
			expect(() =>
				f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...bad, expectedRev: 1 })),
			).toThrow("Draft revision unavailable");
			expect(f.revisions.current(f.bind(input)).draft.rev).toBe(1);
		},
	);
	it("model append can change only body and keeps all envelope fields", async () => {
		const f = await fixture(),
			input = f.make(),
			one = f.create(input),
			bound = f.bind(input),
			author = { kind: "ai" as const, id: newId() };
		const two = f.store.write((tx) =>
			f.revisions.appendModelBodyInTransaction(tx, {
				...bound,
				expectedRev: 1,
				author,
				body: "Model\rbody",
				flags: [],
			}),
		);
		expect(two.revision.content).toEqual({ ...one.revision.content, body: "Model\nbody" });
		expect(two.revision.flags).toEqual([]);
		expect(() =>
			f.store.write((tx) =>
				f.revisions.appendModelBodyInTransaction(tx, {
					...bound,
					expectedRev: 2,
					author,
					body: "another",
					flags: [],
					to: ["changed@example.test"],
				} as never),
			),
		).toThrow("Draft revision unavailable");
		expect(f.revisions.current(bound).draft.rev).toBe(2);
	});
	it("model chat append preserves thread identity and broadcast", async () => {
		const f = await fixture(),
			input = f.make("chat"),
			one = f.create(input);
		const two = f.store.write((tx) =>
			f.revisions.appendModelBodyInTransaction(tx, {
				...f.bind(input),
				expectedRev: 1,
				author: { kind: "ai", id: newId() },
				body: "changed",
				flags: [],
			}),
		);
		expect(two.revision.content).toEqual({ ...one.revision.content, body: "changed" });
	});
	it("model rewrite carries only the flags computed for its own content", async () => {
		const f = await fixture(),
			base = f.make(),
			link = { code: "EXTERNAL_LINK", severity: "ack", detail: "offers.example.test" } as const,
			recipient = {
				code: "NEW_RECIPIENT",
				severity: "ack",
				detail: "recipient@example.test",
			} as const,
			lookup = { code: "TOOL_DATA_IN_BODY", severity: "ack" } as const,
			input = {
				...base,
				content: { ...base.content, body: "Details at https://offers.example.test/spring" },
				flags: [link, recipient],
			},
			bound = f.bind(input);
		f.create(input);
		// The rewrite drops the link, keeps the unchanged recipient and adds a looked-up number.
		const two = f.store.write((tx) =>
			f.revisions.appendModelBodyInTransaction(tx, {
				...bound,
				expectedRev: 1,
				author: { kind: "ai", id: newId() },
				body: "Please call 555 010 0199 on Monday.",
				flags: [recipient, lookup],
			}),
		);
		expect(two.revision.flags).toEqual([recipient, lookup]);
		expect(two.flagsHash).toBe(flagsHash([recipient, lookup]));
		expect(f.revisions.history(bound).map((item) => item.flags)).toEqual([
			[link, recipient],
			[recipient, lookup],
		]);
		expect(f.reopen().revisions.current(bound).revision.flags).toEqual([recipient, lookup]);
	});
	it("does not execute hostile input accessors or proxy traps", async () => {
		const f = await fixture(),
			input = f.make();
		let calls = 0;
		Object.defineProperty(input, "author", {
			get() {
				calls++;
				throw new Error("accessor");
			},
		});
		expect(() => f.create(input)).toThrow("Draft revision unavailable");
		expect(calls).toBe(0);
		const proxy = new Proxy(f.make(), {
			ownKeys() {
				calls++;
				throw new Error("proxy");
			},
			getPrototypeOf() {
				calls++;
				throw new Error("proxy");
			},
		});
		expect(() => f.create(proxy)).toThrow("Draft revision unavailable");
		expect(calls).toBe(0);
	});
	it("authenticates all earlier revisions before append or current read", async () => {
		const f = await fixture(),
			input = f.make();
		f.create(input);
		f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: 1,
				content: { ...input.content, body: "two" },
			}),
		);
		f.store.write((tx) => {
			const row = tx.get<{ payload: string }>(
				"SELECT payload FROM native_draft_revisions WHERE draft_id=? AND rev=1",
				[input.draftId],
			);
			if (!row) throw new Error("missing row");
			const payload = JSON.parse(row.payload);
			payload.author.id = newId();
			tx.run("UPDATE native_draft_revisions SET payload=? WHERE draft_id=? AND rev=1", [
				canonicalize(payload),
				input.draftId,
			]);
		});
		expect(() => f.revisions.current(f.bind(input))).toThrow("Draft revision unavailable");
		expect(() =>
			f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: 2 })),
		).toThrow("Draft revision unavailable");
	});
	it("detects missing history and authentic old-head rollback against current audit", async () => {
		const f = await fixture(),
			input = f.make();
		f.create(input);
		const old = f.store.read((db) =>
			db.get<{ payload: string; audit_seq: number; mac: string }>(
				"SELECT payload,audit_seq,mac FROM native_drafts WHERE id=?",
				[input.draftId],
			),
		);
		f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1 }));
		if (!old) throw new Error("missing row");
		f.store.write((tx) => {
			tx.run("DELETE FROM native_draft_revisions WHERE draft_id=? AND rev=2", [input.draftId]);
			tx.run("UPDATE native_drafts SET payload=?,audit_seq=?,mac=? WHERE id=?", [
				old.payload,
				old.audit_seq,
				old.mac,
				input.draftId,
			]);
		});
		expect(() => f.revisions.current(f.bind(input))).toThrow("Draft revision unavailable");
	});
	it("requires same-store live transaction and keeps revision+audit atomic on failed commit", async () => {
		const f = await fixture(),
			other = await fixture(),
			input = f.make();
		let ended: SqlTransaction | undefined;
		f.store.write((tx) => {
			ended = tx;
		});
		expect(() => f.revisions.createInTransaction(ended as SqlTransaction, input)).toThrow(
			"Draft revision unavailable",
		);
		expect(() => other.store.write((tx) => f.revisions.createInTransaction(tx, input))).toThrow(
			"Draft revision unavailable",
		);
		expect(() =>
			f.store.write((tx) => {
				f.revisions.createInTransaction(tx, input);
				tx.run("INSERT INTO revision_child(id) VALUES(99)");
			}),
		).toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }));
		expect(() => f.revisions.current(f.bind(input))).toThrow("Draft revision unavailable");
		expect(f.create(input).draft.rev).toBe(1);
	});
	it("reads history in bounded pages and counts distinct recorded authors without accepting forced counts", async () => {
		const f = await fixture(),
			input = f.make();
		f.create(input);
		for (let rev = 1; rev <= 9; rev++)
			f.store.write((tx) => f.revisions.appendInTransaction(tx, { ...input, expectedRev: rev }));
		const current = f.revisions.current(f.bind(input));
		expect(current.authors).toEqual([input.author]);
		expect(f.revisions.history(f.bind(input), 8, 2).map((item) => item.rev)).toEqual([9, 10]);
		expect(() => f.revisions.history(f.bind(input), 0, 33)).toThrow("Draft revision unavailable");
		expect(() => f.create({ ...f.make(), requiredApprovals: 0 } as never)).toThrow(
			"Draft revision unavailable",
		);
	});
	it("rejects another real store facade even when it opens the same encrypted database and audit key", async () => {
		const f = await fixture(),
			foreign = new HubStore(f.options),
			input = f.make();
		f.stores.push(foreign);
		expect(() => foreign.write((tx) => f.revisions.createInTransaction(tx, input))).toThrow(
			"Draft revision unavailable",
		);
		expect(f.create(input).draft.rev).toBe(1);
	});
	it("ignores method shadows when enforcing real transaction ownership", async () => {
		const f = await fixture(),
			foreign = new HubStore(f.options),
			input = f.make();
		f.stores.push(foreign);
		let calls = 0;
		Object.defineProperty(f.revisions, "assertTransaction", {
			value: () => {
				calls++;
			},
		});
		expect(() => foreign.write((tx) => f.revisions.createInTransaction(tx, input))).toThrow(
			"Draft revision unavailable",
		);
		expect(calls).toBe(0);
		expect(f.create(input).draft.rev).toBe(1);
	});
	it("ignores method shadows for keyed history checks and native read state", async () => {
		const f = await fixture(),
			input = f.make(),
			current = f.create(input);
		let calls = 0;
		Object.defineProperties(f.revisions, {
			read: {
				value: () => {
					calls++;
					return current;
				},
			},
			checkMac: {
				value: () => {
					calls++;
				},
			},
			sign: {
				value: () => {
					calls++;
					return "0".repeat(64);
				},
			},
		});
		const other = new NativeDraftRevisions(f.store, f.audit, f.key, f.clock);
		f.services.push(other);
		expect(f.revisions.current(f.bind(input))).toEqual(other.current(f.bind(input)));
		expect(calls).toBe(0);
		f.store.write((tx) => {
			const row = tx.get<{ payload: string }>(
				"SELECT payload FROM native_draft_revisions WHERE draft_id=? AND rev=1",
				[input.draftId],
			);
			if (!row) throw new Error("missing history");
			const payload = JSON.parse(row.payload);
			payload.author.id = newId();
			tx.run("UPDATE native_draft_revisions SET payload=? WHERE draft_id=? AND rev=1", [
				canonicalize(payload),
				input.draftId,
			]);
		});
		expect(() => f.revisions.current(f.bind(input))).toThrow("Draft revision unavailable");
		expect(calls).toBe(0);
	});
});
