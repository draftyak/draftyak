import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { expect, it } from "vitest";
import { receiveSidecarInput } from "../../src/kernel/sidecar-input.ts";
import { FakeClock, settle } from "../kernel/fake-clock.ts";

function frame(value: object): Buffer {
	const body = Buffer.from(JSON.stringify(value));
	const result = Buffer.alloc(4 + body.length);
	result.writeUInt32BE(body.length);
	body.copy(result, 4);
	body.fill(0);
	return result;
}

it("forwards a native frame through the compiled public loop and adapter", async () => {
	const hub: typeof import("../../src/index.ts") = await import(
		new URL("../../dist/index.mjs", import.meta.url).href
	);
	const clock = new FakeClock();
	const reasons: string[] = [];
	const scheduler = new hub.SchedulerLoop({
		clock,
		gate: { state: () => "running" },
		tick: ({ reason }) => {
			reasons.push(reason);
			return 15_000;
		},
	});
	const stream = new Readable({ read() {} });
	const input = receiveSidecarInput(stream);
	const key = randomBytes(32);
	const secret = randomBytes(16);
	try {
		scheduler.start();
		const done = hub.bindSidecarResumes(input, scheduler);
		const initial = frame({
			masterKey: key.toString("hex"),
			bootstrapSecret: secret.toString("hex"),
		});
		key.fill(0);
		secret.fill(0);
		stream.push(initial);
		await input.initialReady;
		await settle();
		expect(reasons).toEqual(["start"]);
		stream.push(frame({ power: "resumed" }));
		await settle();
		expect(reasons).toEqual(["start", "resumed"]);
		expect(clock.mono).toBe(1_000.25);
		stream.push(frame({ shutdown: true }));
		await done;
		expect(input.state).toBe("closed");
		expect(initial.every((byte) => byte === 0)).toBe(true);
		// The adapter observes receiver lifetime; lifecycle drain still owns the scheduler.
		expect(scheduler.status().state).toBe("running");
	} finally {
		key.fill(0);
		secret.fill(0);
		await input.dispose();
		await scheduler.stop();
	}
});
