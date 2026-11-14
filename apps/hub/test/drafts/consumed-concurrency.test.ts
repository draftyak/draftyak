import { randomBytes } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConsumedDraftDisposition } from "../../src/drafts/revisions.ts";
import type { OutcomeWorkerInput, OutcomeWorkerMessage } from "./consumed-outcome-worker.ts";
import { type RevisionFixture, revisionFixture } from "./revision-fixture.ts";

type Terminal = Extract<OutcomeWorkerMessage, { type: "committed" | "refused" | "rolled-back" }>;
type Waiter = {
	accept(message: OutcomeWorkerMessage): boolean;
	resolve(message: OutcomeWorkerMessage): void;
	reject(error: Error): void;
};
interface Actor {
	readonly worker: Worker;
	readonly threadId: number;
	readonly gate: Int32Array;
	readonly mode: OutcomeWorkerInput["mode"];
	readonly started: number;
	readonly messages: OutcomeWorkerMessage[];
	readonly waiters: Set<Waiter>;
	readonly exit: Promise<number>;
	exitCode?: number;
	failure?: Error;
	cleanupUnconfirmed?: boolean;
	termination?: Promise<number>;
}
interface Fixture {
	readonly value: RevisionFixture;
	readonly seed: Uint8Array;
}

const actors = new Set<Actor>();
const fixtures = new Set<Fixture>();
const acquisitions = new Set<Promise<RevisionFixture>>();
let closing = false;
const actorBudgetMs = 20_000;
const refused = "Draft revision unavailable";

async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error("DYTEST worker deadline")), milliseconds);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

function fail(actor: Actor, code: string): void {
	actor.failure ??= new Error(code);
	for (const waiter of actor.waiters) waiter.reject(actor.failure);
	actor.waiters.clear();
}

function launch(input: OutcomeWorkerInput): Actor {
	let worker: Worker;
	try {
		if (closing) throw new Error("DYTEST worker launch after cleanup began");
		// Preserve the original execArgv, including the Hub network preload.
		worker = new Worker(new URL("./consumed-outcome-worker.ts", import.meta.url), {
			workerData: input,
		});
	} finally {
		// Worker construction copies this synthetic seed; no key object crosses the boundary.
		input.seed.fill(0);
	}
	let resolveExit!: (code: number) => void;
	const actor: Actor = {
		worker,
		threadId: worker.threadId,
		gate: new Int32Array(input.gate),
		mode: input.mode,
		started: performance.now(),
		messages: [],
		waiters: new Set(),
		exit: new Promise<number>((resolve) => {
			resolveExit = resolve;
		}),
	};
	actors.add(actor);
	worker.on("error", () => {
		actor.cleanupUnconfirmed = true;
		fail(actor, "DYTEST worker error");
	});
	worker.on("exit", (code) => {
		actor.exitCode = code;
		resolveExit(code);
		if (code !== 0) fail(actor, "DYTEST worker nonzero exit");
		if (
			!actor.messages.some((message) =>
				["committed", "refused", "rolled-back", "fault"].includes(message.type),
			)
		) {
			actor.cleanupUnconfirmed = true;
			fail(actor, "DYTEST worker premature exit");
		}
		for (const waiter of actor.waiters) waiter.reject(new Error("DYTEST worker phase missing"));
		actor.waiters.clear();
	});
	worker.on("message", (raw: unknown) => {
		if (
			!raw ||
			typeof raw !== "object" ||
			(raw as { threadId?: unknown }).threadId !== actor.threadId ||
			!["ready", "held", "committed", "refused", "rolled-back", "fault"].includes(
				(raw as { type: string }).type,
			)
		) {
			fail(actor, "DYTEST worker message invalid");
			return;
		}
		const message = raw as OutcomeWorkerMessage;
		const ready = actor.messages.some((item) => item.type === "ready");
		const held = actor.messages.some((item) => item.type === "held");
		const terminal = actor.messages.some((item) =>
			["committed", "refused", "rolled-back", "fault"].includes(item.type),
		);
		if (
			terminal ||
			(message.type === "ready" && ready) ||
			(message.type !== "ready" && message.type !== "fault" && !ready) ||
			(message.type === "held" && (actor.mode !== "hold" || held)) ||
			(message.type === "committed" && actor.mode === "hold" && !held) ||
			(message.type === "rolled-back" && !held)
		) {
			fail(actor, "DYTEST worker phase order invalid");
			return;
		}
		actor.messages.push(message);
		if (message.type === "fault") {
			if (message.stage === "closing") actor.cleanupUnconfirmed = true;
			fail(actor, `DYTEST worker ${message.stage} fault: ${message.code}`);
			return;
		}
		for (const waiter of actor.waiters) {
			if (!waiter.accept(message)) continue;
			actor.waiters.delete(waiter);
			waiter.resolve(message);
		}
	});
	if (!Number.isSafeInteger(actor.threadId) || actor.threadId <= 0)
		fail(actor, "DYTEST original worker identity missing");
	return actor;
}

async function message<K extends OutcomeWorkerMessage["type"]>(
	actor: Actor,
	types: readonly K[],
): Promise<Extract<OutcomeWorkerMessage, { type: K }>> {
	if (actor.failure) throw actor.failure;
	const found = actor.messages.find((item) => types.includes(item.type as K));
	if (found) return found as Extract<OutcomeWorkerMessage, { type: K }>;
	if (actor.exitCode !== undefined) throw new Error("DYTEST original worker already exited");
	const pending = new Promise<OutcomeWorkerMessage>((resolve, reject) => {
		actor.waiters.add({ accept: (item) => types.includes(item.type as K), resolve, reject });
	});
	return (await bounded(
		pending,
		Math.max(1, actorBudgetMs - (performance.now() - actor.started)),
	)) as Extract<OutcomeWorkerMessage, { type: K }>;
}

async function finished(actor: Actor): Promise<Terminal> {
	const terminal = await message(actor, ["committed", "refused", "rolled-back"]);
	expect(
		await bounded(actor.exit, Math.max(1, actorBudgetMs - (performance.now() - actor.started))),
	).toBe(0);
	if (actor.failure) throw actor.failure;
	return terminal;
}

function release(actor: Actor, index: number, value: number): void {
	Atomics.store(actor.gate, index, value);
	Atomics.notify(actor.gate, index);
}

beforeEach(() => {
	if (actors.size || fixtures.size || acquisitions.size)
		throw new Error("DYTEST previous cleanup debt retained");
	closing = false;
});

afterEach(async () => {
	closing = true;
	await bounded(Promise.allSettled([...acquisitions]), 6000);
	if (acquisitions.size) throw new Error("DYTEST fixture acquisition debt retained");
	for (const fixture of fixtures) fixture.seed.fill(0);
	for (const actor of actors) {
		release(actor, 0, -1);
		release(actor, 1, -1);
	}
	const cleanup = await Promise.allSettled(
		[...actors].map(async (actor) => {
			try {
				await bounded(actor.exit, 6000);
			} catch {
				actor.cleanupUnconfirmed = true;
				actor.termination = actor.worker.terminate();
				await bounded(Promise.all([actor.termination, actor.exit]), 5000);
				throw new Error("DYTEST worker required forced cleanup");
			}
			if (actor.cleanupUnconfirmed) throw new Error("DYTEST worker resource cleanup unconfirmed");
			actors.delete(actor);
			if (actor.failure) throw actor.failure;
		}),
	);
	// An unconfirmed original worker keeps its fixture, key and directory retained.
	if (actors.size !== 0) throw new Error("DYTEST worker cleanup debt retained");
	const failures = cleanup.flatMap((item) => (item.status === "rejected" ? [item.reason] : []));
	for (const fixture of fixtures) {
		const f = fixture.value;
		try {
			for (const store of f.stores) store.close();
			for (const service of f.services) service.destroy();
			f.audit.destroy();
			f.key.destroy();
			rmSync(f.dir, { recursive: true, force: true });
			expect(existsSync(f.dir)).toBe(false);
			fixtures.delete(fixture);
		} catch {
			failures.push(new Error("DYTEST fixture cleanup debt retained"));
		}
	}
	if (failures.length) throw new AggregateError(failures, "DYTEST concurrency cleanup failed");
}, 20_000);

async function consumed() {
	if (closing || actors.size || fixtures.size || acquisitions.size)
		throw new Error("DYTEST previous cleanup debt retained");
	const seed = randomBytes(32);
	const acquisition = revisionFixture(seed).then((value) => {
		fixtures.add({ value, seed });
		return value;
	});
	acquisitions.add(acquisition);
	let f: RevisionFixture;
	try {
		f = await acquisition;
	} catch (error) {
		seed.fill(0);
		throw error;
	}
	acquisitions.delete(acquisition);
	if (closing) {
		seed.fill(0);
		throw new Error("DYTEST fixture completed after cleanup began");
	}
	const input = f.make();
	const bound = f.bind(input);
	const current = f.create(input);
	const snapshot = f.snapshot(current);
	const proof = f.store.write((tx) => f.freeze.freezeInTransaction(tx, bound, 1, snapshot));
	f.store.write((tx) => f.freeze.consumeInTransaction(tx, proof));
	const held = f.revisions.current(bound);
	if (!held.lockId) throw new Error("DYTEST original consumed lock missing");
	const request: ConsumedDraftDisposition = {
		...bound,
		expectedRev: 1,
		lockId: held.lockId,
		outboxId: snapshot.outbox,
		outcome: "returned",
	};
	return { f, seed, input, bound, current, snapshot, proof, held, request };
}

function rows(f: RevisionFixture) {
	return f.store.read((db) => ({
		headers: db.all("SELECT * FROM native_drafts ORDER BY id"),
		revisions: db.all("SELECT * FROM native_draft_revisions ORDER BY draft_id,rev"),
		locks: db.all("SELECT * FROM native_draft_locks ORDER BY id"),
		events: db.all("SELECT * FROM audit_events ORDER BY seq"),
		meta: db.all("SELECT * FROM audit_meta ORDER BY singleton"),
	}));
}

function workerInput(
	value: Awaited<ReturnType<typeof consumed>>,
	gate: SharedArrayBuffer,
	mode: OutcomeWorkerInput["mode"],
): OutcomeWorkerInput {
	const f = value.f;
	if (typeof f.options.nativeBinding !== "string" || !f.options.migrations)
		throw new Error("DYTEST original storage inputs missing");
	return {
		seed: Uint8Array.from(value.seed),
		filename: f.filename,
		nativeBinding: f.options.nativeBinding,
		migrations: { ...f.options.migrations },
		at: f.time.now,
		request: value.request,
		gate,
		mode,
	};
}

async function ready(actor: Actor, request: ConsumedDraftDisposition): Promise<void> {
	expect(await message(actor, ["ready"])).toEqual({
		type: "ready",
		threadId: actor.threadId,
		state: "open",
		rev: request.expectedRev,
		lockId: request.lockId,
	});
}

describe("consumed disposition across independent encrypted connections", () => {
	it("commits one simultaneous return and refuses the competing original worker", async () => {
		const value = await consumed();
		const { f } = value;
		const before = rows(f);
		const gate = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
		const first = launch(workerInput(value, gate, "race"));
		await ready(first, value.request);
		const second = launch(workerInput(value, gate, "race"));
		value.seed.fill(0);
		expect(first.worker).not.toBe(second.worker);
		expect(first.threadId).not.toBe(second.threadId);
		await ready(second, value.request);
		Atomics.store(first.gate, 0, 1);
		Atomics.notify(first.gate, 0, 2);
		const outcomes = await Promise.all([finished(first), finished(second)]);
		expect(outcomes.map((item) => item.type).sort()).toEqual(["committed", "refused"]);
		expect(outcomes.find((item) => item.type === "refused")).toMatchObject({
			code: "DRAFT_REVISION_UNAVAILABLE",
		});
		const after = rows(f);
		expect(after.locks).toEqual(before.locks);
		expect(after.revisions).toEqual(before.revisions);
		expect(after.events).toHaveLength(before.events.length + 1);
		expect(
			f.store.read((db) => db.all("SELECT 1 FROM audit_events WHERE action='draft.returned'")),
		).toHaveLength(1);
		const returned = f.revisions.current(value.bound);
		expect(returned).toEqual({ ...value.held, lockId: null });
		expect(() => f.store.read((db) => f.audit.verify(db))).not.toThrow();
		expect(() => f.store.write((tx) => f.freeze.consumeInTransaction(tx, value.proof))).toThrow(
			refused,
		);
		expect(() =>
			f.store.write((tx) => f.revisions.settleConsumedInTransaction(tx, value.request)),
		).toThrow(refused);
		const reopened = f.reopen();
		expect(reopened.revisions.current(value.bound)).toEqual(returned);
		expect(reopened.revisions.history(value.bound)).toEqual([value.current.revision]);
		const edited = reopened.store.write((tx) =>
			reopened.revisions.appendInTransaction(tx, {
				...value.input,
				expectedRev: 1,
				content: { ...value.current.revision.content, body: "DYTEST edit after concurrent return" },
			}),
		);
		const reused = { ...f.snapshot(edited), outbox: value.snapshot.outbox };
		expect(() =>
			reopened.store.write((tx) => reopened.freeze.freezeInTransaction(tx, value.bound, 2, reused)),
		).toThrow(refused);
		expect(rows({ ...f, store: reopened.store }).locks).toEqual(before.locks);
	}, 35_000);

	it.each(["commit", "rollback"] as const)(
		"keeps another connection on the committed preimage until a held return's %s",
		async (decision) => {
			const value = await consumed();
			const { f } = value;
			const before = rows(f);
			const gate = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
			const writer = launch(workerInput(value, gate, "hold"));
			value.seed.fill(0);
			await ready(writer, value.request);
			release(writer, 0, 1);
			expect(await message(writer, ["held"])).toEqual({
				type: "held",
				threadId: writer.threadId,
				state: "open",
				lockId: null,
			});
			expect(rows(f)).toEqual(before);
			expect(f.revisions.current(value.bound)).toEqual(value.held);
			f.store.read((db) => f.audit.verify(db));
			release(writer, 1, decision === "commit" ? 1 : 2);
			expect((await finished(writer)).type).toBe(
				decision === "commit" ? "committed" : "rolled-back",
			);
			const after = rows(f);
			const expected = decision === "commit" ? { ...value.held, lockId: null } : value.held;
			expect(f.revisions.current(value.bound)).toEqual(expected);
			expect(after.locks).toEqual(before.locks);
			expect(after.revisions).toEqual(before.revisions);
			if (decision === "rollback") expect(after).toEqual(before);
			else expect(after.events).toHaveLength(before.events.length + 1);
			f.store.read((db) => f.audit.verify(db));
			const reopened = f.reopen();
			expect(reopened.revisions.current(value.bound)).toEqual(expected);
			expect(rows({ ...f, store: reopened.store })).toEqual(after);
		},
		35_000,
	);
});
