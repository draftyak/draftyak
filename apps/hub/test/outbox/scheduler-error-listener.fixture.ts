import assert from "node:assert/strict";
import { MAX_WAIT_MS } from "../../src/kernel/clock.ts";
import { SchedulerLoop } from "../../src/outbox/scheduler-loop.ts";
import { FakeClock, settle } from "../kernel/fake-clock.ts";

const mode = process.argv[2];
const failure = (): Error => new Error("Synthetic listener failure");
const outcomes: Readonly<Record<string, () => unknown>> = {
	void: () => undefined,
	number: () => 1,
	throw: () => {
		throw failure();
	},
	resolve: async () => undefined,
	reject: async () => {
		throw failure();
	},
	"delayed-reject": () =>
		new Promise<never>((_resolve, reject) => setImmediate(() => reject(failure()))),
	"then-reject": () => ({
		// biome-ignore lint/suspicious/noThenProperty: Exercise a rejecting listener thenable.
		then: (_resolve: unknown, reject: (reason: unknown) => void) => reject(failure()),
	}),
	"then-accessor-throw": () =>
		// biome-ignore lint/suspicious/noThenProperty: Exercise a throwing listener then accessor.
		Object.defineProperty({}, "then", {
			get: () => {
				throw failure();
			},
		}),
	pending: () => new Promise(() => {}),
	"pending-thenable": () => ({
		// biome-ignore lint/suspicious/noThenProperty: Exercise a listener thenable that never settles.
		then: () => {},
	}),
};
assert(mode !== undefined && Object.hasOwn(outcomes, mode));
const outcome = outcomes[mode];
assert(outcome !== undefined);

const clock = new FakeClock();
let ticks = 0;
const reports: string[] = [];
const loop = new SchedulerLoop({
	clock,
	gate: { state: () => "running" },
	tick: () => {
		ticks += 1;
		if (ticks === 1) return -1;
		if (ticks === 3) throw new Error("Synthetic tick failure");
		return MAX_WAIT_MS;
	},
	onError: (code) => {
		reports.push(code);
		return outcome();
	},
});
try {
	loop.start();
	await settle();
	assert.equal(ticks, 1);
	assert.deepEqual(reports, ["SCHEDULER_DATA"]);
	for (let step = 0; step < 3; step++) {
		assert.equal(clock.last().state, "pending");
		clock.advance(MAX_WAIT_MS);
		await settle();
		assert.equal(ticks, step + 2);
	}
	assert.deepEqual(reports, ["SCHEDULER_DATA", "SCHEDULER_STORE"]);
	assert.equal(loop.status().state, "running");
} finally {
	await loop.stop();
}
assert.equal(clock.pending().length, 0);
process.stdout.write(`${JSON.stringify({ ticks, reports, state: loop.status().state })}\n`);
