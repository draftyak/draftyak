import { rmSync } from "node:fs";
import { ackRequired, type Flag, Flags, flagsHash } from "@draftyak/protocol/flags";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { canonicalize } from "@draftyak/protocol/jcs";
import { contentHash } from "@draftyak/protocol/snapshot";
import { afterEach, describe, expect, it } from "vitest";
import {
	captureDraftData,
	type ModelBodyAppend,
	type NativeRevision,
} from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { revisionFixture } from "./revision-fixture.ts";

type Fixture = Awaited<ReturnType<typeof revisionFixture>>;
const fixtures: Fixture[] = [];
const channels = ["email", "chat"] as const;
const staleFlags: Flag[] = [
	{ code: "EXTERNAL_LINK", severity: "ack", detail: "https://retired.example.test/a" },
	{ code: "INVISIBLE_CHARS", severity: "ack" },
];

async function fixture(): Promise<Fixture> {
	const result = await revisionFixture();
	fixtures.push(result);
	return result;
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

function request(current: NativeRevision, body: string, flags: readonly Flag[]): ModelBodyAppend {
	return {
		draftId: current.draft.id,
		accountId: current.draft.accountId,
		conversationId: current.draft.conversationId,
		channel: current.channel,
		expectedRev: current.revision.rev,
		author: { kind: "ai", id: newId() },
		body,
		flags,
	};
}
function append(f: Fixture, input: ModelBodyAppend): NativeRevision {
	return f.store.write((tx) => f.revisions.appendModelBodyInTransaction(tx, input));
}
function expectFlags(current: NativeRevision, expected: readonly Flag[]): void {
	// Flag order is immaterial; the complete set and its approval hash must agree.
	expect(current.revision.flags).toHaveLength(expected.length);
	expect(current.revision.flags).toEqual(expect.arrayContaining([...expected]));
	expect(current.flagsHash).toBe(flagsHash(expected));
}
function checkpoint(f: Fixture, input: ModelBodyAppend) {
	const bound = {
		draftId: input.draftId,
		accountId: input.accountId,
		conversationId: input.conversationId,
		channel: input.channel,
	};
	return {
		current: f.revisions.current(bound),
		history: f.revisions.history(bound),
		audit: f.store.read((db) => f.audit.exportVerifiedJsonl(db)),
	};
}
function links(prefix: string, count: number): Flag[] {
	return Array.from({ length: count }, (_, index) => ({
		code: "EXTERNAL_LINK",
		severity: "ack",
		detail: `https://${prefix}.example.test/${index}`,
	}));
}

describe("complete current flags on model body revisions", () => {
	// These native storage callers supply already recomputed flags. This suite does not
	// implement the flag detector, admit a model output or confer any send authority.
	it.each(channels)("removes obsolete acknowledgements from a new %s body", async (channel) => {
		const f = await fixture();
		const original = f.make(channel);
		const input = {
			...original,
			flags: staleFlags,
			content: { ...original.content, body: "https://retired.example.test/a\u200b" },
		};
		const one = f.create(input);
		const before = f.store.read((db) =>
			db.all("SELECT * FROM native_draft_revisions WHERE draft_id=? AND rev=1", [input.draftId]),
		);
		const two = append(f, request(one, "Replacement\r\nCafe\u0301", []));
		expectFlags(two, []);
		expect(ackRequired(two.revision.flags)).toBe(false);
		expect(two.revision.content).toEqual({ ...one.revision.content, body: "Replacement\nCafé" });
		expect(two.revision.contentSha256).toBe(jcsSha256(two.revision.content));
		expect(two.draft).toEqual({ ...one.draft, rev: 2 });
		expect(two.authors).toEqual([input.author, two.revision.author]);
		expect(f.revisions.history(f.bind(input))).toEqual([one.revision, two.revision]);
		expect(
			f.store.read((db) =>
				db.all("SELECT * FROM native_draft_revisions WHERE draft_id=? AND rev=1", [input.draftId]),
			),
		).toEqual(before);
		const reopened = f.reopen();
		expect(reopened.revisions.current(f.bind(input))).toEqual(two);
		expect(reopened.revisions.history(f.bind(input))).toEqual([one.revision, two.revision]);
	});

	it.each(channels)(
		"keeps the recomputed envelope flags and current details for %s",
		async (channel) => {
			const f = await fixture();
			const recipient: Flag = {
				code: "NEW_RECIPIENT",
				severity: "ack",
				detail: "current recipient",
			};
			const input = { ...f.make(channel), flags: [recipient, ...staleFlags] };
			const one = f.create(input);
			const currentFlags: Flag[] = [
				recipient,
				{ code: "EXTERNAL_LINK", severity: "ack", detail: "https://current.example.test/new" },
				{ code: "SUSPECTED_INSTRUCTIONS", severity: "advisory", detail: "current body concern" },
			];
			const two = append(f, request(one, "Current https://current.example.test/new", currentFlags));
			expectFlags(two, currentFlags);
			expect(ackRequired(two.revision.flags)).toBe(true);
			expect(two.revision.content).toEqual({
				...one.revision.content,
				body: "Current https://current.example.test/new",
			});
			expect(f.revisions.history(f.bind(input))[0]).toEqual(one.revision);
		},
	);

	it.each(channels)("recomputes flags again for a later %s model generation", async (channel) => {
		const f = await fixture();
		const input = { ...f.make(channel), flags: staleFlags };
		const one = f.create(input);
		const firstFlags: Flag[] = [{ code: "EXTERNAL_LINK", severity: "ack", detail: "first body" }];
		const first = request(one, "First model body", firstFlags);
		const two = append(f, first);
		const lastFlags: Flag[] = [{ code: "SUSPECTED_INSTRUCTIONS", severity: "advisory" }];
		const second = request(two, "Second model body", lastFlags);
		const three = append(f, second);
		expectFlags(two, firstFlags);
		expectFlags(three, lastFlags);
		expect(ackRequired(three.revision.flags)).toBe(false);
		expect(first.author.id).not.toBe(second.author.id);
		expect(three.authors).toEqual([input.author, first.author, second.author]);
		expect(three.revision.author).toEqual(second.author);
		expect(three.revision.rev).toBe(3);
		const reopened = f.reopen();
		expect(reopened.revisions.current(f.bind(input))).toEqual(three);
		expect(reopened.revisions.history(f.bind(input))).toEqual([
			one.revision,
			two.revision,
			three.revision,
		]);
	});

	it("persists 129 distinct flags through creation and reopened history", async () => {
		const f = await fixture();
		const input = { ...f.make(), flags: links("current", 129) };
		expect(Flags.safeParse(input.flags).success).toBe(true);
		const one = f.create(input);
		expectFlags(one, input.flags);
		expect(ackRequired(one.revision.flags)).toBe(true);
		expect(f.revisions.current(f.bind(input))).toEqual(one);
		const reopened = f.reopen();
		expect(reopened.revisions.current(f.bind(input))).toEqual(one);
		expect(reopened.revisions.history(f.bind(input))).toEqual([one.revision]);
	});

	it("preserves 300 recipient flags through native edits, model replacement and a frozen data lock", async () => {
		const f = await fixture();
		const original = f.make();
		if (original.content.channel !== "email") throw new Error("Expected email fixture");
		const recipients = Array.from({ length: 300 }, (_, index) => `recipient${index}@example.test`);
		const recipientFlags: Flag[] = recipients.map((detail) => ({
			code: "NEW_RECIPIENT",
			severity: "ack",
			detail,
		}));
		const input = {
			...original,
			content: {
				...original.content,
				to: recipients.slice(0, 100),
				cc: recipients.slice(100, 200),
				bcc: recipients.slice(200, 300),
			},
			flags: recipientFlags,
		};
		const bound = f.bind(input);
		const one = f.create(input);
		expectFlags(one, recipientFlags);
		const retiredBodyFlag: Flag = {
			code: "EXTERNAL_LINK",
			severity: "ack",
			detail: "https://retired.example.test/a",
		};
		const ownerFlags = [...recipientFlags, retiredBodyFlag];
		const two = f.store.write((tx) =>
			f.revisions.appendInTransaction(tx, {
				...input,
				expectedRev: one.revision.rev,
				content: { ...input.content, body: "Owner edit https://retired.example.test/a" },
				flags: ownerFlags,
			}),
		);
		expectFlags(two, ownerFlags);
		const three = append(f, request(two, "Replacement body", recipientFlags));
		expectFlags(three, recipientFlags);
		expect(three.revision.content).toEqual({ ...two.revision.content, body: "Replacement body" });
		expect(three.revision.flags).not.toContainEqual(retiredBodyFlag);
		expect(f.revisions.current(bound)).toEqual(three);
		const history = [one.revision, two.revision, three.revision];
		expect(f.revisions.history(bound)).toEqual(history);
		const reopened = f.reopen();
		expect(reopened.revisions.current(bound)).toEqual(three);
		expect(reopened.revisions.history(bound)).toEqual(history);
		const snapshot = f.snapshot(three);
		const proof = reopened.store.write((tx) =>
			reopened.freeze.freezeInTransaction(tx, bound, three.revision.rev, snapshot),
		);
		const facts = reopened.store.write((tx) => reopened.freeze.consumeInTransaction(tx, proof));
		expect(facts.flagsHash).toBe(flagsHash(recipientFlags));
		expect(facts.snapshot).toEqual(snapshot);
		expect(facts.snapshotHash).toBe(contentHash(snapshot));
		expect(facts.revisionContentHash).toBe(three.revision.contentSha256);
		expect(reopened.revisions.history(bound)).toEqual(history);
	});

	it("replaces a full 1000-flag prior set with a disjoint current set without union overflow", async () => {
		const f = await fixture();
		const original = f.make();
		const previousFlags = links("retired", 1000);
		const input = {
			...original,
			flags: previousFlags,
			content: { ...original.content, body: previousFlags.map((flag) => flag.detail).join("\n") },
		};
		const one = f.create(input);
		const currentFlags = links("current", 1000);
		const two = append(
			f,
			request(one, currentFlags.map((flag) => flag.detail).join("\n"), currentFlags),
		);
		expectFlags(two, currentFlags);
		expect(two.revision.rev).toBe(2);
		expect(f.revisions.history(f.bind(input))[0]).toEqual(one.revision);
		const reopened = f.reopen();
		expect(reopened.revisions.current(f.bind(input))).toEqual(two);
		expect(reopened.revisions.history(f.bind(input))).toEqual([one.revision, two.revision]);
	});

	it("refuses 1001 schema-valid flags at creation and model intake without changing stored data", async () => {
		const f = await fixture();
		const one = f.create();
		const oversized = links("over-budget", 1001);
		expect(Flags.safeParse(oversized).success).toBe(true);
		const next = request(one, "Attempted replacement", oversized);
		const before = checkpoint(f, next);
		expect(() => f.create({ ...f.make(), flags: oversized })).toThrow("Draft revision unavailable");
		expect(checkpoint(f, next)).toEqual(before);
		expect(() => append(f, next)).toThrow("Draft revision unavailable");
		expect(checkpoint(f, next)).toEqual(before);
	});

	it("refuses schema-valid multibyte flags above the serialized byte budget without changing stored data", async () => {
		const f = await fixture();
		const one = f.create();
		const oversized: Flag[] = Array.from({ length: 750 }, (_, index) => ({
			code: "EXTERNAL_LINK",
			severity: "ack",
			detail: `${"\u754c".repeat(995)}${String(index).padStart(3, "0")}`,
		}));
		const next = request(one, "Attempted replacement", oversized);
		expect(Flags.safeParse(oversized).success).toBe(true);
		expect(() => captureDraftData(next)).not.toThrow();
		expect(Buffer.byteLength(canonicalize(oversized))).toBeGreaterThan(2_097_152);
		const before = checkpoint(f, next);
		expect(() => append(f, next)).toThrow("Draft revision unavailable");
		expect(checkpoint(f, next)).toEqual(before);
	});

	it.each([
		["duplicate flags", [staleFlags[0], staleFlags[0]]],
		["wrong severity", [{ code: "EXTERNAL_LINK", severity: "info" }]],
		["unknown code", [{ code: "UNKNOWN_BODY_FLAG", severity: "ack" }]],
		["oversized detail", [{ code: "EXTERNAL_LINK", severity: "ack", detail: "x".repeat(1001) }]],
		["malformed scalar", [{ code: "EXTERNAL_LINK", severity: "ack", detail: "\ud800" }]],
	])("rejects %s without changing revision, history or audit", async (_label, invalid) => {
		const f = await fixture();
		const one = f.create();
		const next = request(one, "Attempted replacement", []);
		const before = checkpoint(f, next);
		expect(() => append(f, { ...next, flags: invalid } as ModelBodyAppend)).toThrow(
			"Draft revision unavailable",
		);
		expect(checkpoint(f, next)).toEqual(before);
	});

	it.each(["accessor", "proxy"] as const)(
		"rejects a flag %s without invoking caller code",
		async (kind) => {
			const f = await fixture();
			const one = f.create();
			const next = request(one, "Attempted replacement", []);
			const before = checkpoint(f, next);
			let calls = 0;
			const trap = (): never => {
				calls++;
				throw new Error("Caller flag trap");
			};
			const flag: Flag = { code: "EXTERNAL_LINK", severity: "ack" };
			const hostile =
				kind === "proxy"
					? new Proxy(flag, { get: trap, ownKeys: trap, getPrototypeOf: trap })
					: Object.defineProperty(flag, "detail", { enumerable: true, get: trap });
			expect(() => append(f, { ...next, flags: [hostile] })).toThrow("Draft revision unavailable");
			expect(calls).toBe(0);
			expect(checkpoint(f, next)).toEqual(before);
		},
	);

	it.each(channels)("does not retain caller-owned mutable %s flag objects", async (channel) => {
		const f = await fixture();
		const input = { ...f.make(channel), flags: [] };
		const one = f.create(input);
		const mutableFlag: Flag = { code: "EXTERNAL_LINK", severity: "ack", detail: "current" };
		const currentFlags = [mutableFlag];
		const next = request(one, "Current body", currentFlags);
		const supplied = structuredClone(next);
		const two = append(f, next);
		expect(next).toEqual(supplied);
		mutableFlag.detail = "changed after append";
		currentFlags.push({ code: "SECRET_PATTERN", severity: "ack" });
		expectFlags(two, supplied.flags);
		expect(Object.isFrozen(two.revision.flags)).toBe(true);
		expect(() => two.revision.flags.push({ code: "SECRET_PATTERN", severity: "ack" })).toThrow(
			TypeError,
		);
		expect(f.revisions.current(f.bind(input))).toEqual(two);
	});

	it.each(channels)(
		"rejects a stale %s generation without accepting its flags or author",
		async (channel) => {
			const f = await fixture();
			const input = f.make(channel);
			const one = f.create(input);
			const winner = append(f, request(one, "Winning body", one.revision.flags));
			const stale = request(one, "Stale body", []);
			const before = checkpoint(f, stale);
			expect(() => append(f, stale)).toThrow("Draft revision unavailable");
			expect(checkpoint(f, stale)).toEqual(before);
			expect(winner.authors).not.toContainEqual(stale.author);
		},
	);

	it.each(channels)(
		"rolls back a failed %s flag append without consuming a model generation",
		async (channel) => {
			const f = await fixture();
			const input = f.make(channel);
			const one = f.create(input);
			const failed = request(one, "Uncommitted body", one.revision.flags);
			const before = checkpoint(f, failed);
			expect(() =>
				f.store.write((tx) => {
					f.revisions.appendModelBodyInTransaction(tx, failed);
					tx.run("INSERT INTO revision_child(id) VALUES(328)");
				}),
			).toThrow();
			expect(checkpoint(f, failed)).toEqual(before);
			const successful = request(one, "Committed body", one.revision.flags);
			const two = append(f, successful);
			expect(two.revision.rev).toBe(2);
			expect(two.revision.author).toEqual(successful.author);
			expect(two.authors).toEqual([input.author, successful.author]);
			expect(two.authors).not.toContainEqual(failed.author);
			expectFlags(two, one.revision.flags);
		},
	);
});
