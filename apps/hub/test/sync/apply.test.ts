import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emailMessage, fixture } from "./apply-fixture.ts";

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
	f = await fixture();
});
afterEach(async () => {
	await f.cleanup();
});

describe("native account-fenced email metadata application", () => {
	it("commits message metadata, checkpoint and actual job completion together", () => {
		const lease = f.lease();
		f.database.write((scope) => {
			expect(f.model.checkpoint(scope, f.ref())).toEqual({ cursor: null, revision: 0 });
			expect(f.model.messages(scope, f.ref())).toEqual([]);
			const result = f.model.applyPage(
				scope,
				lease,
				f.page([
					emailMessage("DYTEST-mail-a", { raw: { base64: "RFlURVNU" } }),
					emailMessage("DYTEST-mail-b", { sizeBytes: undefined, internalDate: 990_001 }),
				]),
			);
			const records = f.model.messages(scope, f.ref());
			expect(records).toHaveLength(2);
			expect(new Set(records.map((row) => row.id)).size).toBe(2);
			expect(records.find((row) => row.providerId === "DYTEST-mail-a")).toMatchObject({
				providerId: "DYTEST-mail-a",
				threadId: "DYTEST-thread-1",
				internalDate: 990_000,
				labelIds: ["INBOX", "UNREAD"],
				sizeBytes: 123,
				state: "unparsed",
				direction: "inbound",
			});
			expect(records.find((row) => row.providerId === "DYTEST-mail-b")?.sizeBytes).toBeNull();
			for (const row of records) {
				expect(row).not.toHaveProperty("raw");
				expect(row).not.toHaveProperty("body");
			}
			expect(result).toEqual({
				cursor: "DYTEST-cursor-1",
				revision: 1,
				changedIds: expect.arrayContaining(records.map((row) => row.id)),
			});
			expect(result.changedIds).toHaveLength(2);
			expect(f.model.checkpoint(scope, f.ref())).toEqual({
				cursor: "DYTEST-cursor-1",
				revision: 1,
			});
			expect(f.jobs.get(scope, lease.job.id)?.state).toBe("SUCCEEDED");
		});
	});

	it("upserts duplicate provider messages without creating another hub identity", () => {
		const first = f.lease();
		f.database.write((scope) => f.model.applyPage(scope, first, f.page([emailMessage()])));
		const original = f.database.write((scope) => f.model.messages(scope, f.ref())[0]);
		expect(original).toBeDefined();
		const lease = f.lease();
		f.database.write((scope) => {
			f.model.applyPage(
				scope,
				lease,
				f.page([emailMessage()], {
					expectedCursor: "DYTEST-cursor-1",
					expectedRevision: 1,
					cursor: "DYTEST-cursor-2",
				}),
			);
			expect(f.model.messages(scope, f.ref())).toEqual([original]);
			expect(f.model.checkpoint(scope, f.ref())).toEqual({
				cursor: "DYTEST-cursor-2",
				revision: 2,
			});
		});
	});

	it("applies label replacement and repeated deletion without resurrecting metadata", () => {
		const first = f.lease();
		f.database.write((scope) => f.model.applyPage(scope, first, f.page([emailMessage()])));
		const labels = f.lease();
		f.database.write((scope) => {
			f.model.applyPage(
				scope,
				labels,
				f.page(
					[
						{
							kind: "email.labels",
							providerId: "DYTEST-message-1",
							threadId: "DYTEST-thread-1",
							labelIds: ["ARCHIVE"],
						},
					],
					{ expectedCursor: "DYTEST-cursor-1", expectedRevision: 1, cursor: "DYTEST-cursor-2" },
				),
			);
			expect(f.model.messages(scope, f.ref())[0]?.labelIds).toEqual(["ARCHIVE"]);
		});
		for (let revision = 2; revision < 4; revision++) {
			const lease = f.lease();
			f.database.write((scope) => {
				f.model.applyPage(
					scope,
					lease,
					f.page([{ kind: "email.deleted", providerId: "DYTEST-message-1" }], {
						expectedCursor: `DYTEST-cursor-${revision}`,
						expectedRevision: revision,
						cursor: `DYTEST-cursor-${revision + 1}`,
					}),
				);
				expect(f.model.messages(scope, f.ref())).toEqual([]);
			});
		}
	});

	it("keeps the same provider identifier independent across real accounts", () => {
		const other = f.email();
		f.database.write((scope) => f.accounts.create(scope, other));
		const first = f.lease();
		f.database.write((scope) => f.model.applyPage(scope, first, f.page([emailMessage()])));
		const second = f.lease("sync", other.id);
		const otherRef = f.ref({ accountId: other.id, pluginInstanceId: other.pluginInstanceId });
		f.database.write((scope) => {
			f.model.applyPage(
				scope,
				second,
				f.page([emailMessage("DYTEST-message-1", { labelIds: ["SENT"] })], otherRef),
			);
			const mine = f.model.messages(scope, f.ref());
			const theirs = f.model.messages(scope, otherRef);
			expect(mine).toHaveLength(1);
			expect(theirs).toHaveLength(1);
			expect(mine[0]?.id).not.toBe(theirs[0]?.id);
			expect(mine[0]?.labelIds).toEqual(["INBOX", "UNREAD"]);
			expect(theirs[0]?.labelIds).toEqual(["SENT"]);
			expect(theirs[0]?.direction).toBe("inbound");
		});
	});

	it("rolls back metadata, checkpoint and job state if the enclosing transaction fails", () => {
		const lease = f.lease();
		expect(() =>
			f.database.write((scope) => {
				f.model.applyPage(scope, lease, f.page([emailMessage()]));
				throw new Error("DYTEST transaction rollback");
			}),
		).toThrow("DYTEST transaction rollback");
		f.database.write((scope) => {
			expect(f.model.messages(scope, f.ref())).toEqual([]);
			expect(f.model.checkpoint(scope, f.ref())).toEqual({ cursor: null, revision: 0 });
			expect(f.jobs.get(scope, lease.job.id)?.state).toBe("RUNNING");
		});
		f.clock.wall += 30_001;
		f.clock.monotonic += 30_001;
		const retry = f.database.write((scope) => f.jobs.claim(scope, f.account.id, lease.job.id));
		expect(retry).toBeDefined();
		if (!retry) throw new Error("Synthetic retry was not claimed");
		f.database.write((scope) => {
			f.model.applyPage(scope, retry, f.page([emailMessage()]));
			expect(f.model.messages(scope, f.ref())).toHaveLength(1);
			expect(f.model.checkpoint(scope, f.ref())).toEqual({
				cursor: "DYTEST-cursor-1",
				revision: 1,
			});
			expect(f.jobs.get(scope, lease.job.id)?.state).toBe("SUCCEEDED");
		});
	});

	it("reopens encrypted state and resumes from the durable checkpoint without duplicating messages", async () => {
		const first = f.lease();
		f.database.write((scope) => f.model.applyPage(scope, first, f.page([emailMessage()])));
		const before = f.database.write((scope) => f.model.messages(scope, f.ref()));
		await f.reopen();
		f.database.write((scope) => {
			expect(f.model.messages(scope, f.ref())).toEqual(before);
			expect(f.model.checkpoint(scope, f.ref())).toEqual({
				cursor: "DYTEST-cursor-1",
				revision: 1,
			});
			expect(f.jobs.get(scope, first.job.id)?.state).toBe("SUCCEEDED");
		});
		const second = f.lease();
		f.database.write((scope) => {
			f.model.applyPage(
				scope,
				second,
				f.page([emailMessage()], {
					expectedCursor: "DYTEST-cursor-1",
					expectedRevision: 1,
					cursor: "DYTEST-cursor-2",
				}),
			);
			expect(f.model.messages(scope, f.ref())).toEqual(before);
			expect(f.model.checkpoint(scope, f.ref())).toEqual({
				cursor: "DYTEST-cursor-2",
				revision: 2,
			});
		});
	});

	it("resumes explicitly migrated content through the bare default storage catalog", async () => {
		const first = f.lease();
		f.database.write((scope) => f.model.applyPage(scope, first, f.page([emailMessage()])));
		const before = f.database.write((scope) => f.model.messages(scope, f.ref()));
		await f.reopen(false);
		f.database.write((scope) => {
			expect(f.model.checkpoint(scope, f.ref())).toEqual({
				cursor: "DYTEST-cursor-1",
				revision: 1,
			});
			expect(f.model.messages(scope, f.ref())).toEqual(before);
			expect(f.jobs.get(scope, first.job.id)?.state).toBe("SUCCEEDED");
		});
		const next = f.lease();
		f.database.write((scope) => {
			f.model.applyPage(
				scope,
				next,
				f.page([emailMessage(), emailMessage("DYTEST-after-reopen")], {
					expectedCursor: "DYTEST-cursor-1",
					expectedRevision: 1,
					cursor: "DYTEST-cursor-2",
				}),
			);
			const records = f.model.messages(scope, f.ref());
			expect(records).toHaveLength(2);
			expect(records.find((row) => row.providerId === "DYTEST-message-1")).toEqual(before[0]);
			expect(records.some((row) => row.providerId === "DYTEST-after-reopen")).toBe(true);
			expect(f.model.checkpoint(scope, f.ref())).toEqual({
				cursor: "DYTEST-cursor-2",
				revision: 2,
			});
			expect(f.jobs.get(scope, next.job.id)?.state).toBe("SUCCEEDED");
		});
	});

	it("accepts metadata synchronization in the real read_only account mode", () => {
		f.database.write((scope) =>
			f.accounts.replace(scope, { ...f.account, mode: "read_only" }, f.generation),
		);
		const ref = f.ref({ generation: 2, mode: "read_only" });
		const lease = f.lease();
		f.database.write((scope) => {
			f.model.applyPage(scope, lease, f.page([emailMessage()], ref));
			expect(f.model.messages(scope, ref)).toHaveLength(1);
			expect(f.model.checkpoint(scope, ref)).toEqual({ cursor: "DYTEST-cursor-1", revision: 1 });
		});
	});
});
