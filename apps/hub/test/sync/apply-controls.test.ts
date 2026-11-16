import type { Account } from "@draftyak/protocol/entities/account";
import { NormalizedChange } from "@draftyak/protocol/normalized-change";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkDatabase, type WorkScope } from "../../src/jobs/database.ts";
import { JOB_LEASE_MS, type JobLease, JobQueue } from "../../src/jobs/queue.ts";
import { newId } from "../../src/kernel/ids.ts";
import { NativeSyncError } from "../../src/sync/apply.ts";
import { emailMessage, fixture } from "./apply-fixture.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Page = ReturnType<Fixture["page"]>;
type Ref = ReturnType<Fixture["ref"]>;
let f: Fixture;
beforeEach(async () => {
	f = await fixture();
});
afterEach(() => f.cleanup());

function eventCount(): number {
	return f.store.read(
		(sql) => sql.get<{ count: number }>("SELECT COUNT(*) AS count FROM main.events")?.count ?? 0,
	);
}

function contentCounts(accountId = f.account.id): readonly number[] {
	return f.store.read((sql) =>
		["content_messages", "content_conversations", "content_pages", "content_checkpoints"].map(
			(table) =>
				sql.get<{ count: number }>(
					`SELECT COUNT(*) AS count FROM main.${table} WHERE account_id=?`,
					[accountId],
				)?.count ?? 0,
		),
	);
}

function expectEmpty(ref: Ref = f.ref()): void {
	f.database.write((scope) => {
		expect(f.model.checkpoint(scope, ref)).toEqual({ cursor: null, revision: 0 });
		expect(f.model.messages(scope, ref)).toEqual([]);
	});
}

/** Catching the public refusal must never make its live transaction committable. */
function deniedOperation(work: (scope: WorkScope) => unknown): void {
	const before = eventCount();
	let failure: unknown;
	expect(() =>
		f.database.write((scope) => {
			try {
				work(scope);
			} catch (error) {
				failure = error;
			}
		}),
	).toThrow();
	expect(failure).toBeInstanceOf(NativeSyncError);
	expect(failure).toMatchObject({ code: "SYNC_UNAVAILABLE" });
	expect(eventCount()).toBe(before);
}

function denied(lease: JobLease, page: Page = f.page([emailMessage()])): void {
	deniedOperation((scope) => f.model.applyPage(scope, lease, page));
}

function replace(changes: Partial<Account>): number {
	return f.database.write((scope) => {
		const current = f.accounts.get(scope, f.account.userId, f.account.id);
		if (!current) throw new Error("Native account fixture unavailable");
		return f.accounts.replace(
			scope,
			{ ...current.account, ...changes } as Account,
			current.generation,
		).generation;
	});
}

function issue(
	queue: JobQueue,
	kind: "sync" | "draft" | "retention" | "reconcile" = "sync",
): JobLease {
	return f.database.write((scope) => {
		const id = newId();
		queue.enqueue(scope, {
			id,
			accountId: f.account.id,
			ownerId: f.account.userId,
			kind,
			refId: newId(),
		});
		const lease = queue.claim(scope, f.account.id, id);
		if (!lease) throw new Error("Native job fixture unavailable");
		return lease;
	});
}

describe("native metadata transaction and current account controls", () => {
	it("refuses copied, inherited and proxied scopes without invoking hooks", () => {
		const lease = f.lease();
		let hooks = 0;
		f.database.write((scope) => {
			for (const fake of [
				{ sql: scope.sql },
				Object.create(scope),
				new Proxy(scope, {
					get() {
						hooks++;
						throw new Error("Scope hook invoked");
					},
				}),
			])
				expect(() => f.model.applyPage(fake, lease, f.page())).toThrow(NativeSyncError);
		});
		expect(hooks).toBe(0);
		expectEmpty();
	});

	it("refuses a genuine scope issued by another WorkDatabase for the same store", () => {
		const lease = f.lease();
		const foreign = new WorkDatabase(f.store);
		foreign.write((scope) => {
			expect(() => f.model.applyPage(scope, lease, f.page())).toThrow(NativeSyncError);
		});
		expectEmpty();
	});

	it("refuses a retired scope after its native transaction returns", () => {
		const lease = f.lease();
		let retired: WorkScope | undefined;
		f.database.write((scope) => {
			retired = scope;
		});
		expect(() => f.model.applyPage(retired as WorkScope, lease, f.page())).toThrow(NativeSyncError);
		expectEmpty();
	});

	it("refuses a genuine scope from another native store", async () => {
		const other = await fixture();
		try {
			const lease = f.lease();
			other.database.write((scope) => {
				expect(() => f.model.applyPage(scope, lease, f.page())).toThrow(NativeSyncError);
			});
			expectEmpty();
		} finally {
			await other.cleanup();
		}
	});

	it.each([
		["generation", 2],
		["ownerEpoch", 2],
		["pluginInstanceId", newId()],
		["mode", "read_only"],
		["accountId", newId()],
	] as const)("refuses a mismatched %s and leaves no checkpoint or metadata", (field, value) => {
		const actual = field === "ownerEpoch" ? f.ref().ownerEpoch + 1 : value;
		denied(f.lease(), f.page(undefined, { [field]: actual }));
		expectEmpty();
	});

	it("refuses an account belonging to another user even with its real sync lease", () => {
		const other = { ...f.account, id: newId(), userId: newId() };
		f.database.write((scope) => f.accounts.create(scope, other));
		const lease = f.lease("sync", other.id, other.userId);
		denied(lease, f.page(undefined, { accountId: other.id }));
		expectEmpty();
	});

	it.each(["paused", "credential_lost", "disconnecting"] as const)(
		"refuses the current generation of a %s account",
		(status) => {
			const generation = replace({
				status,
				deletionDeadline: status === "credential_lost" ? f.clock.wall + 60_000 : null,
			});
			denied(f.lease(), f.page(undefined, { generation }));
			for (const operation of [
				(scope: WorkScope) => f.model.checkpoint(scope, f.ref({ generation })),
				(scope: WorkScope) => f.model.messages(scope, f.ref({ generation })),
			])
				expect(() =>
					f.database.write((scope) => {
						operation(scope);
					}),
				).toThrow(NativeSyncError);
		},
	);

	it("refuses an expired credential-loss deadline at the current generation", () => {
		const generation = replace({ status: "credential_lost", deletionDeadline: f.clock.wall });
		denied(f.lease(), f.page(undefined, { generation }));
	});

	it("applies the current owner, generation, plugin and mode checks to metadata reads", () => {
		for (const ref of [
			f.ref({ accountId: newId() }),
			f.ref({ generation: 2 }),
			f.ref({ pluginInstanceId: newId() }),
			f.ref({ mode: "read_only" }),
			f.ref({ ownerEpoch: f.ref().ownerEpoch + 1 }),
		]) {
			expect(() => f.database.write((scope) => f.model.checkpoint(scope, ref))).toThrow(
				NativeSyncError,
			);
			expect(() => f.database.write((scope) => f.model.messages(scope, ref))).toThrow(
				NativeSyncError,
			);
		}
		expectEmpty();
	});
});

describe("native metadata real lease controls", () => {
	it.each(["draft", "retention", "reconcile"] as const)(
		"refuses a real %s lease for page application",
		(kind) => {
			denied(issue(f.jobs, kind));
			expectEmpty();
		},
	);

	it("refuses a real lease for a different account", () => {
		denied(f.lease("sync", newId()));
		expectEmpty();
	});

	it("refuses a real lease whose owner is not the native account owner", () => {
		denied(f.lease("sync", f.account.id, newId()));
		expectEmpty();
	});

	it("refuses a copied or inherited lease despite its matching public job projection", () => {
		const lease = f.lease();
		denied({ job: lease.job });
		denied(Object.create(lease));
		expectEmpty();
	});

	it("refuses an effectful forged lease without invoking its job getter", () => {
		let hooks = 0;
		const fake = Object.defineProperty({}, "job", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("Lease getter invoked");
			},
		});
		denied(fake as JobLease);
		expect(hooks).toBe(0);
		expectEmpty();
	});

	it("refuses a genuine lease issued by another queue instance", () => {
		const other = new JobQueue(f.database, f.events, {
			wallMs: () => f.clock.wall,
			monotonicMs: () => f.clock.monotonic,
		});
		denied(issue(other));
		expectEmpty();
	});

	it.each(["wall", "monotonic"] as const)(
		"rolls back metadata and cursor when the genuine lease has expired on %s time",
		(clock) => {
			const lease = f.lease();
			f.clock[clock] += JOB_LEASE_MS;
			denied(lease);
			expectEmpty();
			expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("RUNNING");
		},
	);

	it("refuses an already consumed genuine lease", () => {
		const lease = f.lease();
		f.database.write((scope) => f.jobs.complete(scope, lease));
		denied(lease);
		expectEmpty();
		expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("SUCCEEDED");
	});

	it("does not commit a page when the caught completion failure discovers a changed lease row", () => {
		const lease = f.lease();
		f.store.write((sql) => {
			sql.run("UPDATE main.jobs SET attempts=attempts+1 WHERE id=?", [lease.job.id]);
		});
		denied(lease);
		expectEmpty();
		expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("RUNNING");
	});
});

describe("native metadata durable checkpoint controls", () => {
	it.each(["cursor", "revision"] as const)(
		"refuses a stale checkpoint %s without overwriting already committed metadata",
		(field) => {
			const first = f.lease();
			f.database.write((scope) => f.model.applyPage(scope, first, f.page([emailMessage()])));
			const before = f.database.write((scope) => f.model.messages(scope, f.ref()));
			denied(
				f.lease(),
				f.page([emailMessage("DYTEST-stale-page")], {
					expectedCursor: field === "cursor" ? null : "DYTEST-cursor-1",
					expectedRevision: field === "revision" ? 0 : 1,
					cursor: "DYTEST-cursor-2",
				}),
			);
			f.database.write((scope) => {
				expect(f.model.messages(scope, f.ref())).toEqual(before);
				expect(f.model.checkpoint(scope, f.ref())).toEqual({
					cursor: "DYTEST-cursor-1",
					revision: 1,
				});
			});
		},
	);
});

describe("native metadata purge controls", () => {
	it("bounds a large account purge and finishes with the returned genuine retention lease", () => {
		const first = f.lease();
		const changes = Array.from({ length: 500 }, (_, index) =>
			emailMessage(`DYTEST-purge-${index}`),
		);
		f.database.write((scope) => f.model.applyPage(scope, first, f.page(changes)));
		const second = f.lease();
		f.database.write((scope) =>
			f.model.applyPage(
				scope,
				second,
				f.page([emailMessage("DYTEST-purge-500")], {
					expectedCursor: "DYTEST-cursor-1",
					expectedRevision: 1,
					cursor: "DYTEST-cursor-2",
				}),
			),
		);
		expect(contentCounts()).toEqual([501, 1, 2, 1]);
		const generation = replace({ status: "disconnecting", deletionDeadline: null });
		const ref = f.ref({ generation });
		const lease = f.lease("retention");
		const progress = f.database.write((scope) => f.model.purge(scope, lease, ref));
		expect(progress.more).toBe(true);
		expect(progress.deleted).toBeGreaterThan(0);
		expect(progress.deleted).toBeLessThanOrEqual(2000);
		expect(progress.lease).not.toBeNull();
		expect(contentCounts()[0]).toBe(1);
		expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("RUNNING");
		if (!progress.lease) throw new Error("Native purge continuation lease unavailable");
		const continuation = progress.lease;
		expect(continuation.job.id).toBe(lease.job.id);
		const finished = f.database.write((scope) => f.model.purge(scope, continuation, ref));
		expect(finished.more).toBe(false);
		expect(finished.lease).toBeNull();
		expect(finished.deleted).toBeGreaterThan(0);
		expect(finished.deleted).toBeLessThanOrEqual(2000);
		expect(contentCounts()).toEqual([0, 0, 0, 0]);
		expect(f.database.write((scope) => f.jobs.get(scope, lease.job.id)?.state)).toBe("SUCCEEDED");
	});

	it("purges every owned account generation while preserving another real account", () => {
		const first = f.lease();
		f.database.write((scope) => f.model.applyPage(scope, first, f.page([emailMessage()])));
		const generation = replace({ mode: "read_only" });
		const secondRef = f.ref({ generation, mode: "read_only" });
		const second = f.lease();
		f.database.write((scope) =>
			f.model.applyPage(scope, second, f.page([emailMessage("DYTEST-generation-2")], secondRef)),
		);
		const other = f.email();
		f.database.write((scope) => f.accounts.create(scope, other));
		const otherRef = f.ref({ accountId: other.id, pluginInstanceId: other.pluginInstanceId });
		const otherLease = f.lease("sync", other.id);
		f.database.write((scope) =>
			f.model.applyPage(scope, otherLease, f.page([emailMessage()], otherRef)),
		);
		expect(contentCounts()).toEqual([2, 2, 2, 2]);
		const otherCounts = contentCounts(other.id);
		expect(otherCounts).toEqual([1, 1, 1, 1]);
		const disconnecting = replace({ status: "disconnecting", deletionDeadline: null });
		const lease = f.lease("retention");
		f.database.write((scope) => {
			f.model.purge(scope, lease, f.ref({ generation: disconnecting, mode: "read_only" }));
			expect(f.jobs.get(scope, lease.job.id)?.state).toBe("SUCCEEDED");
			expect(f.model.messages(scope, otherRef)).toHaveLength(1);
			expect(f.model.checkpoint(scope, otherRef)).toEqual({
				cursor: "DYTEST-cursor-1",
				revision: 1,
			});
		});
		expect(contentCounts()).toEqual([0, 0, 0, 0]);
		expect(contentCounts(other.id)).toEqual(otherCounts);
	});

	it("refuses a genuine retention lease while the account is still active", () => {
		const lease = f.lease("retention");
		deniedOperation((scope) => f.model.purge(scope, lease, f.ref()));
		expectEmpty();
	});

	it("refuses a sync lease for a current disconnecting account", () => {
		const generation = replace({ status: "disconnecting", deletionDeadline: null });
		const lease = f.lease();
		deniedOperation((scope) => f.model.purge(scope, lease, f.ref({ generation })));
	});

	it("refuses a stale generation even with a genuine retention lease", () => {
		replace({ status: "disconnecting", deletionDeadline: null });
		const lease = f.lease("retention");
		deniedOperation((scope) => f.model.purge(scope, lease, f.ref()));
	});

	it("refuses a retention lease issued for another owner", () => {
		const generation = replace({ status: "disconnecting", deletionDeadline: null });
		const lease = f.lease("retention", f.account.id, newId());
		deniedOperation((scope) => f.model.purge(scope, lease, f.ref({ generation })));
	});
});

describe("native metadata corrupt ownership controls", () => {
	it.each(["content_messages", "content_conversations", "content_checkpoints"] as const)(
		"refuses a foreign owner in the current account's %s rows",
		(table) => {
			const first = f.lease();
			f.database.write((scope) => f.model.applyPage(scope, first, f.page([emailMessage()])));
			f.store.write((sql) => {
				sql.run(`UPDATE main.${table} SET user_id=? WHERE account_id=? AND generation=?`, [
					newId(),
					f.account.id,
					f.generation,
				]);
			});
			const before = contentCounts();
			expect(() => f.database.write((scope) => f.model.checkpoint(scope, f.ref()))).toThrow(
				NativeSyncError,
			);
			expect(() => f.database.write((scope) => f.model.messages(scope, f.ref()))).toThrow(
				NativeSyncError,
			);
			denied(f.lease());
			expect(contentCounts()).toEqual(before);
		},
	);
});

describe("native metadata bounded input admission", () => {
	it("accepts a valid maximum label set below the page snapshot budget", () => {
		const labelIds = Array.from(
			{ length: 256 },
			(_, index) =>
				"\\".repeat(248) +
				index
					.toString(2)
					.padStart(8, "0")
					.split("")
					.map((bit) => (bit === "0" ? "\\" : '"'))
					.join(""),
		);
		expect(Buffer.byteLength(JSON.stringify(labelIds))).toBe(131_841);
		const change = emailMessage("DYTEST-maximum-labels", { labelIds });
		expect(() => NormalizedChange.parse(change)).not.toThrow();
		const lease = f.lease();
		f.database.write((scope) => {
			f.model.applyPage(scope, lease, f.page([change]));
			expect(f.model.messages(scope, f.ref())[0]?.labelIds).toEqual([...labelIds].sort());
			expect(f.jobs.get(scope, lease.job.id)?.state).toBe("SUCCEEDED");
		});
	});

	it("refuses an effectful page without invoking its cursor getter", () => {
		let hooks = 0;
		const page = Object.defineProperty({ ...f.page() }, "cursor", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("Page getter invoked");
			},
		});
		denied(f.lease(), page);
		expect(hooks).toBe(0);
		expectEmpty();
	});

	it("refuses proxied pages and change arrays without invoking their traps", () => {
		let hooks = 0;
		const trap = () => {
			hooks++;
			throw new Error("Input proxy invoked");
		};
		const lease = f.lease();
		denied(lease, new Proxy(f.page(), { get: trap, ownKeys: trap }));
		denied(lease, f.page(new Proxy([emailMessage()], { get: trap, ownKeys: trap })));
		expect(hooks).toBe(0);
		expectEmpty();
	});

	it("refuses a sparse or accessor-backed changes array before invoking an element getter", () => {
		let hooks = 0;
		const changes = Object.defineProperty([emailMessage()], "0", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("Change getter invoked");
			},
		});
		const lease = f.lease();
		denied(lease, f.page(changes));
		denied(lease, f.page(new Array(1)));
		expect(hooks).toBe(0);
		expectEmpty();
	});

	it("refuses an effectful normalized change without invoking its nested field getter", () => {
		let hooks = 0;
		const change = Object.defineProperty({ ...emailMessage() }, "labelIds", {
			enumerable: true,
			get() {
				hooks++;
				throw new Error("Nested change getter invoked");
			},
		});
		denied(f.lease(), f.page([change]));
		expect(hooks).toBe(0);
		expectEmpty();
	});

	it("refuses callable serialization hooks without executing them", () => {
		let hooks = 0;
		const page = {
			...f.page(),
			toJSON() {
				hooks++;
				throw new Error("Serialization hook invoked");
			},
		};
		denied(f.lease(), page);
		expect(hooks).toBe(0);
		expectEmpty();
	});

	it("refuses 501 changes before any checkpoint, metadata or event can commit", () => {
		const changes = Array.from({ length: 501 }, (_, index) => emailMessage(`DYTEST-${index}`));
		denied(f.lease(), f.page(changes));
		expectEmpty();
	});

	it("refuses an otherwise valid metadata page exceeding the four MiB snapshot budget", () => {
		const labelIds = Array.from(
			{ length: 256 },
			(_, index) => `L${index.toString().padStart(3, "0")}${"x".repeat(252)}`,
		);
		const changes = Array.from({ length: 65 }, (_, index) =>
			emailMessage(`DYTEST-budget-${index}`, { labelIds: [...labelIds] }),
		);
		denied(f.lease(), f.page(changes));
		expectEmpty();
	});

	it.each(["", " ", "DYTEST-\n", "x".repeat(4097)])(
		"refuses a noncanonical or oversized cursor %j",
		(cursor) => {
			denied(f.lease(), f.page(undefined, { cursor }));
			expectEmpty();
		},
	);
});
