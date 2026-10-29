import { describe, expect, it } from "vitest";
import { ACCOUNT, fixture, OWNER, REF, testId } from "./fixture.ts";

describe("native lease snapshot integrity", () => {
	for (const [column, changed, original] of [
		["attempts", 0, 1],
		["attempts", 2, 1],
		["max_attempts", 20, 5],
		["created_at", 1_000_001, 1_000_000],
		["next_at", 1_000_001, 1_000_000],
	] as const) {
		it(`fences a changed ${column}=${changed} and never revives the attempted lease`, async () => {
			const f = await fixture();
			try {
				const jobId = testId(77);
				f.database.write((scope) =>
					f.queue.enqueue(scope, {
						id: jobId,
						accountId: ACCOUNT,
						ownerId: OWNER,
						kind: "sync",
						refId: REF,
					}),
				);
				const lease = f.database.write((scope) => f.queue.claim(scope, ACCOUNT));
				if (!lease) throw new Error("Native claim fixture failed");
				f.store.write((sql) =>
					sql.run(`UPDATE main.jobs SET ${column}=? WHERE id=?`, [changed, jobId]),
				);
				expect(() => f.database.write((scope) => f.queue.complete(scope, lease))).toThrow();
				expect(
					f.store.read((sql) =>
						sql.get<{ state: string }>("SELECT state FROM main.jobs WHERE id=?", [jobId]),
					)?.state,
				).toBe("RUNNING");
				f.store.write((sql) =>
					sql.run(`UPDATE main.jobs SET ${column}=? WHERE id=?`, [original, jobId]),
				);
				expect(() => f.database.write((scope) => f.queue.complete(scope, lease))).toThrow();
			} finally {
				f.cleanup();
			}
		});
	}
});
