import { describe, expect, it } from "vitest";
import type { EventLog } from "../../src/events/log.ts";
import type { WorkDatabase } from "../../src/jobs/database.ts";
import { type JobClock, JobQueue } from "../../src/jobs/queue.ts";
import { WorkError } from "../../src/jobs/values.ts";

function identityFixture() {
	const reads = { database: 0, events: 0, clock: 0, proxy: 0 };
	function forbidden(kind: keyof typeof reads): never {
		reads[kind]++;
		throw new Error("Identity checks must not inspect dependencies");
	}
	// Inert identity sentinels only: no store, scope, native database or lease is admitted.
	const database = Object.create(null, {
		sql: { get: () => forbidden("database") },
		write: { get: () => forbidden("database") },
		abort: { get: () => forbidden("database") },
	}) as WorkDatabase;
	const events = Object.create(null, {
		append: { get: () => forbidden("events") },
	}) as EventLog;
	const clock = Object.create(null, {
		wallMs: { get: () => forbidden("clock") },
		monotonicMs: { get: () => forbidden("clock") },
	}) as JobClock;
	const traps: ProxyHandler<object> = {
		get: () => forbidden("proxy"),
		getOwnPropertyDescriptor: () => forbidden("proxy"),
		getPrototypeOf: () => forbidden("proxy"),
		ownKeys: () => forbidden("proxy"),
	};
	return { database, queue: new JobQueue(database, events, clock), reads, traps };
}

function untouched(reads: ReturnType<typeof identityFixture>["reads"]): void {
	expect(reads).toEqual({ database: 0, events: 0, clock: 0, proxy: 0 });
}

describe("JobQueue database identity", () => {
	it("accepts the retained database reference without inspecting dependencies", () => {
		const fixture = identityFixture();
		expect(fixture.queue.assertDatabase(fixture.database)).toBeUndefined();
		untouched(fixture.reads);
	});

	it("refuses a different database reference and preserves the original binding", () => {
		const fixture = identityFixture();
		const other = identityFixture();
		expect(fixture.queue.assertDatabase(fixture.database)).toBeUndefined();
		let failure: unknown;
		try {
			fixture.queue.assertDatabase(other.database);
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(WorkError);
		expect(failure).toMatchObject({ code: "scope" });
		expect(fixture.queue.assertDatabase(fixture.database)).toBeUndefined();
		untouched(fixture.reads);
		untouched(other.reads);
	});

	it("refuses a proxy alias of the retained database without running its traps", () => {
		const fixture = identityFixture();
		const alias = new Proxy<WorkDatabase>(fixture.database, fixture.traps);
		expect(() => fixture.queue.assertDatabase(alias)).toThrowError(WorkError);
		expect(fixture.queue.assertDatabase(fixture.database)).toBeUndefined();
		untouched(fixture.reads);
	});

	it.each(["prototype lookalike", "spread copy", "proxy wrapper"] as const)(
		"refuses a %s queue receiver without inspecting dependencies",
		(kind) => {
			const fixture = identityFixture();
			const receiver =
				kind === "prototype lookalike"
					? Object.create(JobQueue.prototype)
					: kind === "spread copy"
						? { ...fixture.queue }
						: new Proxy(fixture.queue, fixture.traps);
			expect(() =>
				Reflect.apply(JobQueue.prototype.assertDatabase, receiver, [fixture.database]),
			).toThrowError(TypeError);
			expect(fixture.queue.assertDatabase(fixture.database)).toBeUndefined();
			untouched(fixture.reads);
		},
	);
});
