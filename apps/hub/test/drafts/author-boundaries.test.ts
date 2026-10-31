import { rmSync } from "node:fs";
import type { DraftAuthor, DraftContent } from "@draftyak/protocol/entities/draft";
import { jcsSha256 } from "@draftyak/protocol/hash";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type DraftCreation,
	NativeDraftRevisions,
	type NativeRevision,
} from "../../src/drafts/revisions.ts";
import { newId } from "../../src/kernel/ids.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

const fixtures: RevisionFixture[] = [];
async function fixture() {
	const result = await revisionFixture();
	fixtures.push(result);
	return result;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const f of fixtures.splice(0)) {
		for (const service of f.services) service.destroy();
		for (const store of f.stores) store.close();
		f.audit.destroy();
		f.key.destroy();
		rmSync(f.dir, { recursive: true, force: true });
	}
});

const nonOwners = ["ai", "agent", "plugin"] as const;
const channels = ["email", "chat"] as const;
function author(kind: DraftAuthor["kind"], id = newId()): DraftAuthor {
	return { kind, id };
}
function persisted(f: RevisionFixture) {
	return f.store.read((db) => ({
		headers: db.all("SELECT id,payload,audit_seq,mac FROM native_drafts ORDER BY id"),
		revisions: db.all(
			"SELECT draft_id,rev,payload,previous,mac FROM native_draft_revisions ORDER BY draft_id,rev",
		),
		audit: db.all("SELECT * FROM audit_events ORDER BY seq"),
		head: db.all("SELECT * FROM audit_meta"),
	}));
}
function refusedWithoutChange(f: RevisionFixture, run: () => unknown) {
	const before = persisted(f);
	expect(run).toThrow("Draft revision unavailable");
	expect(persisted(f)).toEqual(before);
}
function append(
	f: RevisionFixture,
	input: DraftCreation,
	current: NativeRevision,
	by: DraftAuthor,
	body = `revision-${current.draft.rev + 1}`,
): NativeRevision {
	return f.store.write((tx) =>
		by.kind === "ai"
			? f.revisions.appendModelBodyInTransaction(tx, {
					...f.bind(input),
					expectedRev: current.draft.rev,
					author: by,
					body,
					flags: [],
				})
			: f.revisions.appendInTransaction(tx, {
					...input,
					expectedRev: current.draft.rev,
					author: by,
					content: { ...current.revision.content, body },
				}),
	);
}
function distinctAuthors(
	f: RevisionFixture,
	input: DraftCreation,
	kind: (typeof nonOwners)[number],
	count: number,
) {
	const authors = [author(kind)];
	let current = f.create({ ...input, author: authors[0] as DraftAuthor });
	for (let index = 1; index < count; index++) {
		const next = author(kind);
		authors.push(next);
		current = append(f, input, current, next);
	}
	expect(current.authors).toEqual(authors);
	expect(current.draft.rev).toBe(count);
	return { current, authors };
}

describe("full-content and model-body revision entry points", () => {
	it.each(channels)(
		"refuses even a body-only model author through the public %s append",
		async (channel) => {
			const f = await fixture();
			const input = f.make(channel);
			const one = f.create(input);
			refusedWithoutChange(f, () =>
				f.store.write((tx) =>
					f.revisions.appendInTransaction(tx, {
						...input,
						expectedRev: 1,
						author: author("ai"),
						content: { ...one.revision.content, body: "model body" },
					}),
				),
			);
			expect(f.revisions.current(f.bind(input))).toEqual(one);
			const two = append(f, input, one, author("ai"), "model body");
			expect(two.revision.content).toEqual({ ...one.revision.content, body: "model body" });
			expect(two.revision.author.kind).toBe("ai");
			expect(two.revision.contentSha256).toBe(jcsSha256(two.revision.content));
			expect(f.revisions.history(f.bind(input))).toEqual([one.revision, two.revision]);
		},
	);

	it("rejects model full-content email recipient, subject and attachment changes without a write", async () => {
		const f = await fixture();
		const input = f.make();
		const one = f.create(input);
		if (one.revision.content.channel !== "email") throw new Error("Expected email fixture");
		const content = one.revision.content;
		const attempts = [
			{ ...content, to: ["other@example.test"] },
			{ ...content, cc: ["copy@example.test"] },
			{ ...content, bcc: ["hidden@example.test"] },
			{ ...content, subject: "different subject" },
			{ ...content, attachments: [] },
			{
				...content,
				attachments: content.attachments.map((item) => ({ ...item, blobId: newId() })),
			},
		];
		for (const changed of attempts) {
			refusedWithoutChange(f, () =>
				f.store.write((tx) =>
					f.revisions.appendInTransaction(tx, {
						...input,
						expectedRev: 1,
						author: author("ai"),
						content: changed,
					}),
				),
			);
		}
		expect(f.revisions.current(f.bind(input))).toEqual(one);
	});

	it("rejects model full-content chat thread and broadcast changes without a write", async () => {
		const f = await fixture();
		const input = f.make("chat");
		const one = f.create(input);
		if (one.revision.content.channel !== "chat") throw new Error("Expected chat fixture");
		for (const changed of [
			{ ...one.revision.content, threadTs: "200.300" },
			{ ...one.revision.content, broadcast: true },
			{ ...one.revision.content, threadTs: null, broadcast: false },
		]) {
			refusedWithoutChange(f, () =>
				f.store.write((tx) =>
					f.revisions.appendInTransaction(tx, {
						...input,
						expectedRev: 1,
						author: author("ai"),
						content: changed,
					}),
				),
			);
		}
		expect(f.revisions.current(f.bind(input))).toEqual(one);
	});

	it.each(["owner", "agent", "plugin"] as const)(
		"retains native-caller full-content editing for %s attribution",
		async (kind) => {
			const f = await fixture();
			for (const channel of channels) {
				const input = f.make(channel);
				const one = f.create(input);
				const content: DraftContent =
					one.revision.content.channel === "email"
						? {
								...one.revision.content,
								to: ["changed@example.test"],
								cc: ["copy@example.test"],
								bcc: [],
								subject: "Native envelope edit",
								attachments: [],
							}
						: { ...one.revision.content, threadTs: "300.400", broadcast: true };
				const by = author(kind);
				const two = f.store.write((tx) =>
					f.revisions.appendInTransaction(tx, { ...input, expectedRev: 1, author: by, content }),
				);
				expect(two.revision.content).toEqual(content);
				expect(two.revision.author).toEqual(by);
				expect(two.revision.contentSha256).toBe(jcsSha256(content));
				expect(f.revisions.history(f.bind(input))).toEqual([one.revision, two.revision]);
			}
		},
	);

	it.each(nonOwners)(
		"keeps initial %s attribution with the native caller's computed envelope",
		async (kind) => {
			const f = await fixture();
			for (const channel of channels) {
				const input = { ...f.make(channel), author: author(kind) };
				const one = f.create(input);
				expect(one.revision.author).toEqual(input.author);
				expect(one.authors).toEqual([input.author]);
				expect(one.revision.content).toEqual(
					channel === "email"
						? {
								...input.content,
								body: `${f.canary}\nCaf\u00e9`,
								attachments: [
									{
										...(input.content.channel === "email" ? input.content.attachments[0] : {}),
										contentType: "text/plain",
									},
								],
							}
						: input.content,
				);
				const two = append(f, input, one, f.author, "Owner edit after native creation");
				expect(two.authors).toEqual([input.author, f.author]);
			}
		},
	);

	it.each(["owner", "agent", "plugin"] as const)(
		"refuses %s attribution through the model-only path",
		async (kind) => {
			const f = await fixture();
			const input = f.make();
			f.create(input);
			refusedWithoutChange(f, () =>
				f.store.write((tx) =>
					f.revisions.appendModelBodyInTransaction(tx, {
						...f.bind(input),
						expectedRev: 1,
						author: author(kind),
						body: "replacement",
						flags: [],
					}),
				),
			);
		},
	);

	it.each(channels)(
		"model %s edits preserve the whole native envelope and previous immutable result",
		async (channel) => {
			const f = await fixture();
			const input = f.make(channel);
			const one = f.create(input);
			const original = structuredClone(one);
			const two = append(f, input, one, author("ai"), "New\r\nCafe\u0301");
			expect(two.revision.content).toEqual({ ...one.revision.content, body: "New\nCaf\u00e9" });
			expect(two.revision.flags).toEqual(one.revision.flags);
			expect(two.revision.contentSha256).toBe(jcsSha256(two.revision.content));
			expect(one).toEqual(original);
			expect(Object.isFrozen(two.revision.content)).toBe(true);
			const next = f.reopen();
			expect(next.revisions.current(f.bind(input))).toEqual(two);
			expect(next.revisions.history(f.bind(input))).toEqual([one.revision, two.revision]);
		},
	);

	it("does not route the model's private body append through an overridable public append", async () => {
		const f = await fixture();
		const input = f.make();
		const one = f.create(input);
		const publicAppend = vi
			.spyOn(NativeDraftRevisions.prototype, "appendInTransaction")
			.mockImplementation(() => {
				throw new Error("Public full-content path reached");
			});
		const two = append(f, input, one, author("ai"));
		expect(publicAppend).not.toHaveBeenCalled();
		expect(two.draft.rev).toBe(2);
		expect(two.revision.content).toEqual({ ...one.revision.content, body: "revision-2" });
	});

	it("rejects added envelope properties on the body-only request", async () => {
		const f = await fixture();
		const input = f.make();
		f.create(input);
		for (const extra of [
			{ content: input.content },
			{ to: ["other@example.test"] },
			{ subject: "injected" },
			{ attachments: [] },
			{ threadTs: "900.100" },
			{ broadcast: true },
		]) {
			refusedWithoutChange(f, () =>
				f.store.write((tx) =>
					f.revisions.appendModelBodyInTransaction(tx, {
						...f.bind(input),
						expectedRev: 1,
						author: author("ai"),
						body: "body",
						flags: [],
						...extra,
					} as never),
				),
			);
		}
	});

	it("keeps stale-revision and lock fences on the private model append", async () => {
		const f = await fixture();
		const input = f.make();
		const one = f.create(input);
		const two = append(f, input, one, author("ai"));
		refusedWithoutChange(f, () => append(f, input, one, author("ai")));
		f.store.write((tx) => f.revisions.setLockInTransaction(tx, f.bind(input), 2, null, newId()));
		refusedWithoutChange(f, () => append(f, input, two, author("ai")));
		expect(f.revisions.current(f.bind(input)).draft.rev).toBe(2);
	});
});

describe("finite attribution capacity reserves the first owner edit", () => {
	it.each(nonOwners)(
		"reserves author 100 for the owner after 99 distinct %s authors, including after restart",
		async (kind) => {
			const f = await fixture();
			const input = f.make("chat");
			const seeded = distinctAuthors(f, input, kind, 99);
			let current = seeded.current;
			const original = structuredClone(current);
			expect(current.authors).toHaveLength(99);
			expect(current.authors.every((entry) => entry.kind !== "owner")).toBe(true);
			refusedWithoutChange(f, () => append(f, input, current, author(kind)));
			expect(f.revisions.current(f.bind(input))).toEqual(original);
			current = append(f, input, current, seeded.authors[0] as DraftAuthor, "repeat before owner");
			expect(current.authors).toEqual(seeded.authors);
			current = append(f, input, current, f.author, "first owner edit");
			expect(current.authors).toEqual([...seeded.authors, f.author]);
			expect(current.authors).toHaveLength(100);
			expect(current.revision.author).toEqual(f.author);
			for (const nextKind of nonOwners) {
				refusedWithoutChange(f, () => append(f, input, current, author(nextKind)));
			}
			const firstOwner = structuredClone(current);
			current = append(f, input, current, f.author, "owner still edits at capacity");
			expect(current.authors).toEqual(firstOwner.authors);
			current = append(
				f,
				input,
				current,
				seeded.authors[0] as DraftAuthor,
				"existing author at capacity",
			);
			expect(current.authors).toHaveLength(100);
			expect(current.draft.rev).toBe(103);
			expect(current.revision.contentSha256).toBe(jcsSha256(current.revision.content));
			const next = f.reopen();
			expect(next.revisions.current(f.bind(input))).toEqual(current);
			const before = next.revisions.current(f.bind(input));
			const edited = next.store.write((tx) =>
				next.revisions.appendInTransaction(tx, {
					...input,
					expectedRev: before.draft.rev,
					author: f.author,
					content: { ...before.revision.content, body: "owner after restart" },
				}),
			);
			expect(edited.authors).toEqual(current.authors);
			expect(edited.draft.rev).toBe(104);
			expect(edited.revision.content.body).toBe("owner after restart");
		},
		120_000,
	);

	it("uses all 100 slots when the owner was present from creation, and refuses only new identities", async () => {
		const f = await fixture();
		const input = f.make("chat");
		let current = f.create(input);
		const others: DraftAuthor[] = [];
		for (let index = 0; index < 99; index++) {
			const by = author(index % 2 === 0 ? "agent" : "plugin");
			others.push(by);
			current = append(f, input, current, by);
		}
		expect(current.authors).toEqual([f.author, ...others]);
		expect(current.authors).toHaveLength(100);
		refusedWithoutChange(f, () => append(f, input, current, author("owner")));
		for (const kind of nonOwners) {
			refusedWithoutChange(f, () => append(f, input, current, author(kind)));
		}
		current = append(f, input, current, f.author, "owner at full capacity");
		current = append(f, input, current, others[0] as DraftAuthor, "agent at full capacity");
		current = append(f, input, current, others[1] as DraftAuthor, "plugin at full capacity");
		expect(current.draft.rev).toBe(103);
		expect(current.authors).toHaveLength(100);
		expect(current.revision.content.body).toBe("plugin at full capacity");
	}, 120_000);

	it("counts attribution by both kind and id rather than allowing another kind to claim an owner's slot", async () => {
		const f = await fixture();
		const shared = newId();
		const input = { ...f.make(), author: author("agent", shared) };
		let current = f.create(input);
		current = append(f, input, current, author("ai", shared));
		current = append(f, input, current, author("plugin", shared));
		expect(current.authors).toEqual([
			author("agent", shared),
			author("ai", shared),
			author("plugin", shared),
		]);
		current = append(f, input, current, author("owner", shared));
		expect(current.authors).toHaveLength(4);
		expect(current.authors.at(-1)).toEqual(author("owner", shared));
		for (const kind of ["owner", ...nonOwners] as const) {
			current = append(f, input, current, author(kind, shared));
			expect(current.authors).toHaveLength(4);
		}
		expect(current.draft.rev).toBe(8);
	});

	it("does not consume another slot when the same model run emits multiple bodies", async () => {
		const f = await fixture();
		const input = f.make();
		let current = f.create(input);
		const model = author("ai");
		for (let index = 0; index < 5; index++) {
			current = append(f, input, current, model, `model body ${index}`);
			expect(current.authors).toEqual([f.author, model]);
		}
		const revisions = f.revisions.history(f.bind(input));
		expect(revisions).toHaveLength(6);
		expect(revisions.slice(1).map((entry) => entry.content.body)).toEqual([
			"model body 0",
			"model body 1",
			"model body 2",
			"model body 3",
			"model body 4",
		]);
		expect(revisions[0]?.author).toEqual(f.author);
		expect(revisions.slice(1).every((entry) => entry.author.id === model.id)).toBe(true);
	});
});
