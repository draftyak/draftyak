import { afterEach, describe, expect, it } from "vitest";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import { newId } from "../../src/kernel/ids.ts";
import { NativeSyncError } from "../../src/sync/apply.ts";
import {
	fixture as createApplyFixture,
	emailMessage,
	type NativeApplyFixture,
} from "./apply-fixture.ts";

type Ref = ReturnType<NativeApplyFixture["ref"]>;
type Locator = { readonly id: string; readonly threadId: string };
const bodies = new Set<Promise<void>>();
const acquisitions = new Set<Promise<NativeApplyFixture>>();
const owners = new Set<NativeApplyFixture>();
const completed = new WeakSet<NativeApplyFixture>();
const cleanupJobs = new WeakMap<NativeApplyFixture, Promise<void>>();
let teardownJob: Promise<void> | undefined;

async function acquire(): Promise<NativeApplyFixture> {
	// Retain the promise before the public adapter starts its producers.
	const pending = Promise.resolve().then(() => createApplyFixture());
	acquisitions.add(pending);
	const result = await pending;
	owners.add(result);
	return result;
}

async function retire(owner: NativeApplyFixture): Promise<void> {
	let original = cleanupJobs.get(owner);
	if (!original) {
		original = Promise.resolve().then(() => owner.cleanup());
		cleanupJobs.set(owner, original);
	}
	await original;
	completed.add(owner);
	owners.delete(owner);
}

function testcase(name: string, body: (f: NativeApplyFixture) => void | Promise<void>): void {
	it(name, () => {
		if (teardownJob || bodies.size || acquisitions.size || owners.size)
			throw new Error("Earlier conversation metadata fixture is still owned");
		const original = Promise.resolve().then(async () => {
			const f = await acquire();
			await body(f);
		});
		bodies.add(original);
		return original;
	});
}

afterEach(() => {
	if (teardownJob) return teardownJob;
	const original = Promise.resolve().then(async () => {
		// A hook timeout must not close a still-running body's fixture.
		await Promise.allSettled([...bodies]);
		const created = await Promise.allSettled([...acquisitions]);
		const errors: unknown[] = [];
		for (const result of created) {
			if (result.status === "fulfilled") {
				if (!completed.has(result.value)) owners.add(result.value);
			} else errors.push(result.reason);
		}
		for (const owner of owners) {
			try {
				await retire(owner);
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length)
			throw new AggregateError(errors, "Conversation metadata fixture cleanup unavailable");
		acquisitions.clear();
		bodies.clear();
	});
	teardownJob = original;
	void original.then(
		() => {
			if (teardownJob === original) teardownJob = undefined;
		},
		() => {
			// Failed creation or cleanup retains original owners and refuses new work.
		},
	);
	return original;
});

function snapshot(f: NativeApplyFixture): unknown {
	return f.store.read((sql) => ({
		conversations: sql.all("SELECT * FROM main.content_conversations ORDER BY id"),
		messages: sql.all("SELECT * FROM main.content_messages ORDER BY id"),
		checkpoints: sql.all("SELECT * FROM main.content_checkpoints ORDER BY account_id,generation"),
		events: sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM main.events")?.count,
	}));
}

function seed(f: NativeApplyFixture, ref: Ref = f.ref(), threadId: string = newId()): Locator {
	const lease = f.lease("sync", ref.accountId, f.account.userId);
	f.database.write((scope) => {
		f.model.applyPage(scope, lease, f.page([emailMessage(newId(), { threadId })], ref));
	});
	const row = f.store.read((sql) =>
		sql.get<Locator>(
			"SELECT id,provider_id AS threadId FROM main.content_conversations WHERE account_id=? AND generation=? AND provider_id=?",
			[ref.accountId, ref.generation, threadId],
		),
	);
	if (!row) throw new Error("Applied conversation fixture row unavailable");
	return row;
}

function lookup(f: NativeApplyFixture, ref: Ref, canonicalId: string): Locator | undefined {
	return f.database.write((scope) => {
		return f.model.conversation(scope, ref, canonicalId);
	});
}

function refused(f: NativeApplyFixture, ref: Ref, canonicalId: string): void {
	const before = snapshot(f);
	expect(() => {
		f.database.write((scope) => {
			f.model.conversation(scope, ref, canonicalId);
		});
	}).toThrow(NativeSyncError);
	expect(snapshot(f)).toEqual(before);
}

describe("canonical conversation metadata in the original account scope", () => {
	testcase(
		"returns only the frozen canonical and provider locator without treating provider IDs as canonical",
		(f) => {
			const providerId = newId();
			const stored = seed(f, f.ref(), providerId);
			expect(stored.id).not.toBe(providerId);
			const before = snapshot(f);
			const result = lookup(f, f.ref(), stored.id);
			expect(result).toEqual({ id: stored.id, threadId: providerId });
			expect(Object.keys(result ?? {}).sort()).toEqual(["id", "threadId"]);
			expect(Object.isFrozen(result)).toBe(true);
			// The provider locator is deliberately a valid ULID, not malformed input.
			expect(lookup(f, f.ref(), providerId)).toBeUndefined();
			expect(snapshot(f)).toEqual(before);
		},
	);

	for (const boundary of [
		{ label: "one", providerId: "!", bytes: 1 },
		{ label: "256", providerId: "~".repeat(256), bytes: 256 },
	] as const) {
		testcase(
			`accepts a provider locator with exactly ${boundary.label} printable ASCII bytes`,
			(f) => {
				const stored = seed(f, f.ref(), boundary.providerId);
				expect(Buffer.byteLength(stored.threadId, "utf8")).toBe(boundary.bytes);
				const before = snapshot(f);
				const result = lookup(f, f.ref(), stored.id);
				expect(result).toEqual({ id: stored.id, threadId: boundary.providerId });
				expect(Object.isFrozen(result)).toBe(true);
				expect(snapshot(f)).toEqual(before);
			},
		);
	}

	testcase(
		"returns undefined for an absent well-formed canonical ID without changing storage",
		(f) => {
			const stored = seed(f);
			const missing = newId();
			expect(missing).not.toBe(stored.id);
			const before = snapshot(f);
			expect(lookup(f, f.ref(), missing)).toBeUndefined();
			expect(snapshot(f)).toEqual(before);
		},
	);

	testcase(
		"isolates two real accounts even when their provider conversation IDs are identical",
		(f) => {
			const providerId = newId();
			const first = seed(f, f.ref(), providerId);
			const other = f.email({ alias: "dytest-other-mailbox" });
			f.database.write((scope) => {
				f.accounts.create(scope, other);
			});
			const otherRef = f.ref({ accountId: other.id, pluginInstanceId: other.pluginInstanceId });
			const second = seed(f, otherRef, providerId);
			expect(first.id).not.toBe(second.id);
			const before = snapshot(f);
			expect(lookup(f, f.ref(), first.id)).toEqual(first);
			expect(lookup(f, otherRef, second.id)).toEqual(second);
			expect(lookup(f, otherRef, first.id)).toBeUndefined();
			expect(lookup(f, f.ref(), second.id)).toBeUndefined();
			expect(snapshot(f)).toEqual(before);
		},
	);

	testcase(
		"refuses the stale generation and does not expose its row through the real new generation",
		(f) => {
			const oldRef = f.ref();
			const old = seed(f, oldRef);
			const replacement = f.database.write((scope) => {
				return f.accounts.replace(scope, { ...f.account, mode: "read_only" }, f.generation);
			});
			expect(replacement.generation).toBeGreaterThan(f.generation);
			const currentRef = f.ref({
				generation: replacement.generation,
				mode: replacement.account.mode,
			});
			const current = seed(f, currentRef);
			refused(f, oldRef, old.id);
			const before = snapshot(f);
			expect(lookup(f, currentRef, old.id)).toBeUndefined();
			expect(lookup(f, currentRef, current.id)).toEqual(current);
			expect(snapshot(f)).toEqual(before);
		},
	);

	testcase("retains the current owner, plugin, mode and account checks", (f) => {
		const stored = seed(f);
		for (const ref of [
			f.ref({ ownerEpoch: f.ref().ownerEpoch + 1 }),
			f.ref({ pluginInstanceId: newId() }),
			f.ref({ mode: "read_only" }),
			f.ref({ accountId: newId() }),
		])
			refused(f, ref, stored.id);
	});

	for (const state of [
		{ label: "paused", status: "paused", deadline: null },
		{ label: "disconnecting", status: "disconnecting", deadline: null },
		{ label: "credential lost before its deadline", status: "credential_lost", deadline: 60_000 },
		{ label: "credential lost at its deadline", status: "credential_lost", deadline: 0 },
	] as const) {
		testcase(`refuses the actual current ${state.label} account`, (f) => {
			const stored = seed(f);
			const replacement = f.database.write((scope) => {
				return f.accounts.replace(
					scope,
					{
						...f.account,
						status: state.status,
						deletionDeadline: state.deadline === null ? null : f.clock.wall + state.deadline,
					},
					f.generation,
				);
			});
			expect(replacement.account.status).toBe(state.status);
			refused(f, f.ref({ generation: replacement.generation }), stored.id);
		});
	}

	testcase(
		"refuses malformed canonical IDs and an opaque provider ID without changing rows",
		(f) => {
			const providerId = "DYTEST-thread-1";
			const stored = seed(f, f.ref(), providerId);
			expect(lookup(f, f.ref(), stored.id)).toEqual(stored);
			for (const invalid of ["", "x", "0".repeat(25), "0".repeat(27), providerId])
				refused(f, f.ref(), invalid);
		},
	);

	testcase(
		"refuses actual stored foreign ownership without repairing or disclosing the row",
		(f) => {
			const stored = seed(f);
			const otherOwner = newId();
			expect(otherOwner).not.toBe(f.account.userId);
			f.database.write((scope) => {
				const sql = scope.sql;
				const changed = sql.run("UPDATE main.content_conversations SET user_id=? WHERE id=?", [
					otherOwner,
					stored.id,
				]);
				expect(changed.changes).toBe(1);
				expect(
					sql.get<{ user_id: string }>(
						"SELECT user_id FROM main.content_conversations WHERE id=?",
						[stored.id],
					)?.user_id,
				).toBe(otherOwner);
			});
			refused(f, f.ref(), stored.id);
		},
	);

	testcase("refuses a genuine scope from another WorkDatabase for the same store", (f) => {
		const stored = seed(f);
		const foreign = new WorkDatabase(f.store);
		const before = snapshot(f);
		foreign.write((scope) => {
			expect(() => f.model.conversation(scope, f.ref(), stored.id)).toThrow(NativeSyncError);
		});
		expect(snapshot(f)).toEqual(before);
	});

	testcase("refuses copies of a genuine scope without invoking a proxy hook", (f) => {
		const stored = seed(f);
		const before = snapshot(f);
		let hooks = 0;
		f.database.write((scope) => {
			// These are negative copies of an issued scope, never fixture authority.
			const copies = [
				{ ...scope },
				Object.create(scope) as WorkScope,
				new Proxy(scope, {
					get() {
						hooks++;
						throw new Error("Conversation scope proxy hook invoked");
					},
				}),
			];
			for (const copied of copies)
				expect(() => f.model.conversation(copied, f.ref(), stored.id)).toThrow(NativeSyncError);
		});
		expect(hooks).toBe(0);
		expect(snapshot(f)).toEqual(before);
	});

	testcase(
		"refuses an actual retired scope and retains refusal after awaited fixture cleanup",
		async (f) => {
			const stored = seed(f);
			const ref = f.ref();
			let retired: WorkScope | undefined;
			f.database.write((scope) => {
				retired = scope;
			});
			const originalScope = retired;
			if (!originalScope) throw new Error("Original metadata scope was not captured");
			expect(() => f.model.conversation(originalScope, ref, stored.id)).toThrow(NativeSyncError);
			await retire(f);
			expect(() => f.model.conversation(originalScope, ref, stored.id)).toThrow(NativeSyncError);
		},
	);

	testcase(
		"aborts a real earlier write even when its lookup refusal is caught by the caller",
		(f) => {
			const stored = seed(f);
			const before = snapshot(f);
			const changedProvider = newId();
			expect(changedProvider).not.toBe(stored.threadId);
			let changed = false;
			let caught: unknown;
			expect(() => {
				f.database.write((scope) => {
					const result = scope.sql.run(
						"UPDATE main.content_conversations SET provider_id=? WHERE id=?",
						[changedProvider, stored.id],
					);
					changed =
						result.changes === 1 &&
						scope.sql.get<{ provider_id: string }>(
							"SELECT provider_id FROM main.content_conversations WHERE id=?",
							[stored.id],
						)?.provider_id === changedProvider;
					try {
						f.model.conversation(scope, f.ref({ ownerEpoch: f.ref().ownerEpoch + 1 }), stored.id);
					} catch (error) {
						caught = error;
					}
				});
			}).toThrow();
			expect(changed).toBe(true);
			expect(caught).toBeInstanceOf(NativeSyncError);
			expect(snapshot(f)).toEqual(before);
		},
	);
});
