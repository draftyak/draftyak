import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
	type InitialMaterial,
	receiveSidecarInput,
	type SidecarControl,
	type SidecarInputState,
	type SidecarStop,
} from "../../src/kernel/sidecar-input.ts";
import { bindSidecarResumes, SidecarResumeError } from "../../src/lifecycle/sidecar-resume.ts";
import {
	SchedulerLoop,
	type SchedulerTick,
	type TickContext,
} from "../../src/outbox/scheduler-loop.ts";
import { FakeClock, FakeGate, settle } from "../outbox/scheduler-fixture.ts";

const CANARY = "DYTEST-PRIVATE-RESUME-FAILURE";
const RESUMED = '{"power":"resumed"}';
const SHUTDOWN = '{"shutdown":true}';

function frame(payload: string): Buffer {
	const body = Buffer.from(payload, "utf8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(body.length);
	try {
		return Buffer.concat([header, body]);
	} finally {
		body.fill(0);
		header.fill(0);
	}
}

function handled(promise: Promise<void>): Promise<void> {
	void promise.catch(() => {});
	return promise;
}

function scheduler(tick: SchedulerTick = () => 15_000) {
	const clock = new FakeClock();
	const gate = new FakeGate();
	const ticks: TickContext[] = [];
	const errors: string[] = [];
	const loop = new SchedulerLoop({
		clock,
		gate,
		tick: (context) => {
			ticks.push(context);
			return tick(context);
		},
		onError: (code) => errors.push(code),
	});
	return { clock, gate, loop, ticks, errors };
}

async function fixture(
	tick?: SchedulerTick,
	options: { readonly deferClose?: boolean; readonly failClose?: boolean } = {},
) {
	let releaseClose: (() => void) | undefined;
	const source = new Readable({
		read() {},
		destroy(error, callback) {
			releaseClose = () => {
				releaseClose = undefined;
				callback(options.failClose ? new Error(CANARY) : error);
			};
			if (!options.deferClose) releaseClose();
		},
	});
	const input = receiveSidecarInput(source);
	const key = randomBytes(32);
	const bootstrap = randomBytes(16);
	const initial = frame(
		JSON.stringify({ masterKey: key.toString("hex"), bootstrapSecret: bootstrap.toString("hex") }),
	);
	let material: InitialMaterial;
	try {
		source.push(initial);
		await input.initialReady;
		material = input.takeInitial();
	} finally {
		key.fill(0);
		bootstrap.fill(0);
		initial.fill(0);
	}
	const h = scheduler(tick);
	h.loop.start();
	await settle();
	return {
		...h,
		source,
		input,
		releaseClose: (): void => releaseClose?.(),
		cleanup: async (): Promise<void> => {
			const closing = input.dispose();
			releaseClose?.();
			await closing.catch(() => {});
			await h.loop.stop();
			material.masterKey.destroy();
			material.bootstrapSecret.fill(0);
		},
	};
}

function fixed(error: unknown, code: "OPTIONS" | "BOUND" | "STREAM"): void {
	const expected = `SIDECAR_RESUME_${code}`;
	expect(error).toBeInstanceOf(SidecarResumeError);
	expect(error).toMatchObject({ name: "SidecarResumeError", code: expected, message: expected });
	expect((error as Error).cause).toBeUndefined();
	expect(JSON.stringify(error)).not.toContain(CANARY);
}

function controlled() {
	const control = Promise.withResolvers<SidecarControl>();
	const terminal = Promise.withResolvers<SidecarStop>();
	const closed = Promise.withResolvers<void>();
	const nextControl = vi.fn(() => control.promise);
	const input = {
		get state(): SidecarInputState {
			return "initial-taken";
		},
		nextControl,
		terminal: terminal.promise,
		closed: closed.promise,
	};
	return { input, control, terminal, closed, nextControl };
}

describe("native sidecar resume binding", () => {
	it("wakes one suspended wait through the concrete scheduler without advancing fake time", async () => {
		const h = await fixture();
		const done = handled(bindSidecarResumes(h.input, h.loop));
		try {
			const firstWait = h.clock.last();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			expect(firstWait).toMatchObject({ ms: 15_000, state: "pending" });
			h.source.push(frame(RESUMED));
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start", "resumed"]);
			expect(h.ticks[1]?.now).toEqual(h.ticks[0]?.now);
			expect(firstWait.state).toBe("aborted");
			expect(h.clock.last()).toMatchObject({ ms: 15_000, state: "pending" });
			expect(h.errors).toEqual([]);
			h.source.push(frame(SHUTDOWN));
			await expect(done).resolves.toBeUndefined();
		} finally {
			await h.cleanup();
		}
	});

	it("preserves a closed scheduler gate and never turns a resume into tick authority", async () => {
		const h = await fixture();
		const done = handled(bindSidecarResumes(h.input, h.loop));
		try {
			h.gate.value = "paused";
			h.source.push(frame(RESUMED));
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			expect(h.loop.status().state).toBe("paused");
			expect(h.gate.value).toBe("paused");
			h.source.push(frame(SHUTDOWN));
			await done;
			expect(h.loop.status().state).toBe("paused");
		} finally {
			await h.cleanup();
		}
	});

	it.each([
		["shutdown", SHUTDOWN],
		["fault", "{}"],
	])(
		"drops a queued resume followed by %s in the same native input buffer",
		async (_reason, last) => {
			const h = await fixture();
			const done = handled(bindSidecarResumes(h.input, h.loop));
			try {
				const wait = h.clock.last();
				h.source.push(Buffer.concat([frame(RESUMED), frame(last)]));
				await done;
				await settle();
				expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
				expect(wait.state).toBe("pending");
				expect(h.loop.status().state).toBe("running");
			} finally {
				await h.cleanup();
			}
		},
	);

	it("coalesces resumes during an active tick without overlapping its work", async () => {
		const first = Promise.withResolvers<number>();
		let active = 0;
		let maximum = 0;
		const h = await fixture(async ({ reason }) => {
			active++;
			maximum = Math.max(maximum, active);
			try {
				return reason === "start" ? await first.promise : 15_000;
			} finally {
				active--;
			}
		});
		const done = handled(bindSidecarResumes(h.input, h.loop));
		try {
			h.source.push(Buffer.concat([frame(RESUMED), frame(RESUMED), frame(RESUMED)]));
			await settle();
			expect(active).toBe(1);
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			first.resolve(15_000);
			await settle();
			expect(h.clock.last().ms).toBe(0);
			h.clock.advance(0);
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start", "resumed"]);
			expect(maximum).toBe(1);
			h.source.push(frame(SHUTDOWN));
			await done;
		} finally {
			first.resolve(15_000);
			await h.cleanup();
		}
	});

	it.each(["shutdown", "eof", "dispose"] as const)(
		"ceases consumption at %s, waits for receiver closure and leaves scheduler ownership alone",
		async (ending) => {
			const h = await fixture(undefined, { deferClose: true });
			const reads = vi.spyOn(h.input, "nextControl");
			const done = handled(bindSidecarResumes(h.input, h.loop));
			let completed = false;
			void done.then(
				() => {
					completed = true;
				},
				() => {},
			);
			try {
				if (ending === "shutdown") h.source.push(frame(SHUTDOWN));
				else if (ending === "eof") h.source.push(null);
				else void h.input.dispose();
				await h.input.terminal;
				await settle();
				const consumed = reads.mock.calls.length;
				expect(completed).toBe(false);
				expect(h.input.state).toBe("closing");
				expect(h.loop.status().state).toBe("running");
				await settle();
				expect(reads).toHaveBeenCalledTimes(consumed);
				h.releaseClose();
				await expect(done).resolves.toBeUndefined();
				expect(h.input.state).toBe("closed");
				h.clock.advance(15_000);
				await settle();
				expect(h.ticks.map(({ reason }) => reason)).toEqual(["start", "timer"]);
				expect(reads).toHaveBeenCalledTimes(consumed);
			} finally {
				await h.cleanup();
			}
		},
	);

	it("returns the identical binding without taking a second control consumer", async () => {
		const h = await fixture();
		const other = scheduler();
		other.loop.start();
		await settle();
		const reads = vi.spyOn(h.input, "nextControl");
		const done = handled(bindSidecarResumes(h.input, h.loop));
		try {
			expect(bindSidecarResumes(h.input, h.loop)).toBe(done);
			expect(reads).toHaveBeenCalledTimes(1);
			let conflict: unknown;
			try {
				bindSidecarResumes(h.input, other.loop);
			} catch (error) {
				conflict = error;
			}
			fixed(conflict, "BOUND");
			expect(reads).toHaveBeenCalledTimes(1);
			h.source.push(frame(RESUMED));
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start", "resumed"]);
			expect(other.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			h.source.push(frame(SHUTDOWN));
			await done;
			expect(bindSidecarResumes(h.input, h.loop)).toBe(done);
		} finally {
			await h.cleanup();
			await other.loop.stop();
		}
	});

	it("uses the captured real state getter and next-control method after property replacement", async () => {
		const h = await fixture();
		const done = handled(bindSidecarResumes(h.input, h.loop));
		const replacedState = vi.fn(() => {
			throw new Error(CANARY);
		});
		const replacedRead = vi.fn(() => Promise.reject(new Error(CANARY)));
		Object.defineProperty(h.input, "state", { get: replacedState });
		Object.defineProperty(h.input, "nextControl", { value: replacedRead });
		try {
			h.source.push(frame(RESUMED));
			await settle();
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start", "resumed"]);
			h.source.push(frame(SHUTDOWN));
			await done;
			expect(replacedState).not.toHaveBeenCalled();
			expect(replacedRead).not.toHaveBeenCalled();
		} finally {
			await h.cleanup();
		}
	});

	it("does not restart a scheduler stopped separately by its owner", async () => {
		const h = await fixture();
		const done = handled(bindSidecarResumes(h.input, h.loop));
		try {
			await h.loop.stop();
			h.source.push(frame(RESUMED));
			await settle();
			expect(h.loop.status().state).toBe("stopped");
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			h.source.push(frame(SHUTDOWN));
			await done;
		} finally {
			await h.cleanup();
		}
	});

	it.each(["new", "stopped"] as const)(
		"refuses a %s scheduler without starting it",
		async (state) => {
			const h = await fixture();
			const invalid = scheduler();
			if (state === "stopped") await invalid.loop.stop();
			try {
				let caught: unknown;
				try {
					bindSidecarResumes(h.input, invalid.loop);
				} catch (error) {
					caught = error;
				}
				fixed(caught, "OPTIONS");
				expect(invalid.loop.status().state).toBe(state);
				expect(invalid.ticks).toEqual([]);
			} finally {
				await h.cleanup();
				await invalid.loop.stop();
			}
		},
	);

	it.each(["read rejection", "malformed control", "terminal rejection"] as const)(
		"redacts a %s even when the other pending read never settles",
		async (failure) => {
			const h = scheduler();
			h.loop.start();
			await settle();
			const stream = controlled();
			const done = handled(bindSidecarResumes(stream.input, h.loop));
			try {
				if (failure === "read rejection") stream.control.reject(new Error(CANARY));
				else if (failure === "terminal rejection") stream.terminal.reject(new Error(CANARY));
				else stream.control.resolve({ kind: CANARY } as unknown as SidecarControl);
				fixed(await done.catch((error: unknown) => error), "STREAM");
				expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
			} finally {
				stream.terminal.resolve({ kind: "stop", reason: "disposed" });
				stream.closed.resolve();
				stream.control.resolve({ kind: "stop", reason: "disposed" });
				await h.loop.stop();
			}
		},
	);

	it("redacts a real receiver cleanup failure", async () => {
		const h = await fixture(undefined, { deferClose: true, failClose: true });
		const done = handled(bindSidecarResumes(h.input, h.loop));
		try {
			h.source.push(frame(SHUTDOWN));
			await h.input.terminal;
			h.releaseClose();
			fixed(await done.catch((error: unknown) => error), "STREAM");
			expect(h.ticks.map(({ reason }) => reason)).toEqual(["start"]);
		} finally {
			await h.cleanup();
		}
	});
});
