import { describe, expect, it, vi } from "vitest";
import type {
	SidecarControl,
	SidecarInputState,
	SidecarStop,
} from "../../src/kernel/sidecar-input.ts";
import { bindSidecarResumes, SidecarResumeError } from "../../src/lifecycle/sidecar-resume.ts";
import { SchedulerLoop, type TickContext } from "../../src/outbox/scheduler-loop.ts";
import { FakeClock, settle } from "../kernel/fake-clock.ts";

const CANARY = "DYTEST-PRIVATE-RESUME-FAILURE";
type Code = "OPTIONS" | "BOUND" | "STREAM";

function receiver() {
	const terminal = Promise.withResolvers<SidecarStop>();
	const closed = Promise.withResolvers<void>();
	const controls = [Promise.withResolvers<SidecarControl>()];
	let state: SidecarInputState = "initial-taken";
	let at = 0;
	const readState = vi.fn(() => state);
	const next = vi.fn(() => {
		let control = controls[at++];
		if (control === undefined) {
			control = Promise.withResolvers<SidecarControl>();
			controls.push(control);
		}
		return control.promise;
	});
	const input = {
		get state() {
			return readState();
		},
		nextControl: next,
		terminal: terminal.promise,
		closed: closed.promise,
	};
	return {
		input,
		terminal,
		closed,
		controls,
		readState,
		next,
		end() {
			state = "closed";
			const stop: SidecarStop = { kind: "stop", reason: "eof" };
			terminal.resolve(stop);
			for (const control of controls) control.resolve(stop);
			closed.resolve();
		},
	};
}

function loop() {
	const clock = new FakeClock();
	const ticks: TickContext[] = [];
	const scheduler = new SchedulerLoop({
		clock,
		gate: { state: () => "running" },
		tick: (context) => {
			ticks.push(context);
			return 15_000;
		},
	});
	return { scheduler, ticks, clock };
}

function fixed(error: unknown, code: Code): void {
	expect(error).toBeInstanceOf(SidecarResumeError);
	expect(error).toMatchObject({
		name: "SidecarResumeError",
		code: `SIDECAR_RESUME_${code}`,
		message: `SIDECAR_RESUME_${code}`,
	});
	expect((error as Error).cause).toBeUndefined();
	expect(String(error)).not.toContain(CANARY);
}

async function refusal(action: () => unknown, code: Code): Promise<void> {
	const result = await Promise.resolve()
		.then(action)
		.catch((error: unknown) => error);
	fixed(result, code);
}

describe("sidecar resume collaborator boundaries", () => {
	it.each(["fake", "proxy", "new", "stopped"] as const)("refuses a %s scheduler", async (kind) => {
		const r = receiver();
		const l = loop();
		if (kind === "proxy") {
			l.scheduler.start();
			await settle();
		}
		if (kind === "stopped") await l.scheduler.stop();
		const candidate =
			kind === "fake"
				? { status: () => ({ state: "running" }), resumed() {} }
				: kind === "proxy"
					? new Proxy(l.scheduler, {})
					: l.scheduler;
		try {
			await refusal(
				() => bindSidecarResumes(r.input, candidate as unknown as SchedulerLoop),
				"OPTIONS",
			);
			expect(r.next).not.toHaveBeenCalled();
		} finally {
			r.end();
			await l.scheduler.stop();
		}
	});

	it("captures state and control methods rather than consulting replacements", async () => {
		const r = receiver();
		const l = loop();
		l.scheduler.start();
		await settle();
		const replacement = vi.fn(() => {
			throw new Error(CANARY);
		});
		const done = bindSidecarResumes(r.input, l.scheduler);
		try {
			Object.defineProperty(r.input, "state", { get: replacement });
			Object.defineProperty(r.input, "nextControl", { value: replacement });
			Object.defineProperty(l.scheduler, "resumed", { get: replacement });
			r.controls[0]?.resolve({ kind: "resumed" });
			await settle();
			expect(l.ticks.map((tick) => tick.reason)).toEqual(["start", "resumed"]);
			expect(r.next).toHaveBeenCalledTimes(2);
			expect(replacement).not.toHaveBeenCalled();
			r.end();
			await expect(done).resolves.toBeUndefined();
		} finally {
			r.end();
			await l.scheduler.stop();
		}
	});

	it.each(["terminal", "closed"] as const)(
		"refuses an accessor %s without invoking it",
		async (property) => {
			const r = receiver();
			const l = loop();
			l.scheduler.start();
			await settle();
			const accessor = vi.fn(() => {
				throw new Error(CANARY);
			});
			Object.defineProperty(r.input, property, { get: accessor });
			try {
				await refusal(() => bindSidecarResumes(r.input, l.scheduler), "OPTIONS");
				expect(accessor).not.toHaveBeenCalled();
				expect(r.next).not.toHaveBeenCalled();
			} finally {
				r.end();
				await l.scheduler.stop();
			}
		},
	);

	it("does not invoke own then overrides on any admitted native promise", async () => {
		const r = receiver();
		const l = loop();
		l.scheduler.start();
		await settle();
		const overridden = vi.fn(() => {
			throw new Error(CANARY);
		});
		for (const promise of [r.terminal.promise, r.closed.promise, r.controls[0]?.promise]) {
			// biome-ignore lint/suspicious/noThenProperty: Prove that the own override is never consulted.
			Object.defineProperty(promise, "then", { get: overridden });
		}
		const pending = new Promise<SidecarControl>(() => {});
		const first = r.controls[0]?.promise;
		let reads = 0;
		Object.defineProperty(r.input, "nextControl", {
			value: () => (reads++ === 0 ? first : pending),
		});
		const done = bindSidecarResumes(r.input, l.scheduler);
		try {
			r.controls[0]?.resolve({ kind: "resumed" });
			await settle();
			expect(l.ticks.map((tick) => tick.reason)).toEqual(["start", "resumed"]);
			r.end();
			await expect(done).resolves.toBeUndefined();
			expect(overridden).not.toHaveBeenCalled();
		} finally {
			r.end();
			await l.scheduler.stop();
		}
	});

	it.each(["terminal", "closed", "control"] as const)(
		"refuses a poisoned %s promise constructor without reading it",
		async (which) => {
			const r = receiver();
			const l = loop();
			l.scheduler.start();
			await settle();
			const poison = vi.fn(() => {
				throw new Error(CANARY);
			});
			const promise =
				which === "terminal"
					? r.terminal.promise
					: which === "closed"
						? r.closed.promise
						: r.controls[0]?.promise;
			Object.defineProperty(promise, "constructor", { get: poison });
			if (which === "control")
				Object.defineProperty(r.input, "nextControl", { value: () => promise });
			try {
				await refusal(
					() => bindSidecarResumes(r.input, l.scheduler),
					which === "control" ? "STREAM" : "OPTIONS",
				);
				expect(poison).not.toHaveBeenCalled();
			} finally {
				r.end();
				await l.scheduler.stop();
			}
		},
	);

	it.each(["terminal", "closed", "control"] as const)(
		"refuses an intermediate native promise prototype for %s",
		async (which) => {
			const r = receiver();
			const l = loop();
			l.scheduler.start();
			await settle();
			const promise =
				which === "terminal"
					? r.terminal.promise
					: which === "closed"
						? r.closed.promise
						: r.controls[0]?.promise;
			if (promise === undefined) throw new Error("DYTEST-MISSING-CONTROL");
			Object.setPrototypeOf(promise, Object.create(Promise.prototype));
			expect(Object.hasOwn(promise, "constructor")).toBe(false);
			if (which === "control")
				Object.defineProperty(r.input, "nextControl", { value: () => promise });
			let failure: unknown;
			const done = bindSidecarResumes(r.input, l.scheduler);
			void done.catch((error: unknown) => {
				failure = error;
			});
			try {
				await settle();
				fixed(failure, which === "control" ? "STREAM" : "OPTIONS");
				expect(l.ticks.map((tick) => tick.reason)).toEqual(["start"]);
				if (which !== "control") expect(r.next).not.toHaveBeenCalled();
			} finally {
				r.end();
				await l.scheduler.stop();
			}
		},
	);

	it.each(["read throws", "read rejects", "state throws", "state invalid"])(
		"sanitizes a fault when %s",
		async (fault) => {
			const r = receiver();
			const l = loop();
			l.scheduler.start();
			await settle();
			if (fault === "read throws")
				r.next.mockImplementation(() => {
					throw new Error(CANARY);
				});
			if (fault === "read rejects")
				r.next.mockImplementation(() => Promise.reject(new Error(CANARY)));
			if (fault === "state throws")
				r.readState.mockImplementation(() => {
					throw new Error(CANARY);
				});
			if (fault === "state invalid") r.readState.mockReturnValue(CANARY as SidecarInputState);
			try {
				await refusal(() => bindSidecarResumes(r.input, l.scheduler), "STREAM");
				expect(l.ticks.map((tick) => tick.reason)).toEqual(["start"]);
			} finally {
				r.end();
				await l.scheduler.stop();
			}
		},
	);

	it.each([
		null,
		{},
		{ kind: "private" },
		{ kind: "stop", reason: CANARY },
		{ kind: "stop" },
		Object.defineProperty({}, "kind", {
			get() {
				throw new Error(CANARY);
			},
		}),
	])("refuses malformed control data without exposing its contents", async (control) => {
		const r = receiver();
		const l = loop();
		l.scheduler.start();
		await settle();
		const result = bindSidecarResumes(r.input, l.scheduler).catch((error: unknown) => error);
		try {
			r.controls[0]?.resolve(control as SidecarControl);
			await settle();
			r.end();
			fixed(await result, "STREAM");
			expect(l.ticks.map((tick) => tick.reason)).toEqual(["start"]);
		} finally {
			r.end();
			await l.scheduler.stop();
		}
	});

	it.each([null, {}, { kind: "resumed", reason: "eof" }, { kind: "stop", reason: CANARY }])(
		"refuses malformed terminal data",
		async (terminal) => {
			const r = receiver();
			const l = loop();
			l.scheduler.start();
			await settle();
			const result = bindSidecarResumes(r.input, l.scheduler).catch((error: unknown) => error);
			try {
				r.terminal.resolve(terminal as SidecarStop);
				r.end();
				fixed(await result, "STREAM");
			} finally {
				r.end();
				await l.scheduler.stop();
			}
		},
	);

	it("rejects a failed terminal while the control source remains pending", async () => {
		const r = receiver();
		const l = loop();
		l.scheduler.start();
		await settle();
		let failure: unknown;
		const done = bindSidecarResumes(r.input, l.scheduler);
		void done.catch((error: unknown) => {
			failure = error;
		});
		try {
			r.terminal.reject(new Error(CANARY));
			await settle();
			fixed(failure, "STREAM");
			r.controls[0]?.resolve({ kind: "resumed" });
			await settle();
			expect(l.ticks.map((tick) => tick.reason)).toEqual(["start"]);
		} finally {
			r.end();
			await l.scheduler.stop();
		}
	});

	it("owns one consumer, waits for receiver closure, and leaves loop shutdown to lifecycle", async () => {
		const r = receiver();
		const l = loop();
		const other = loop();
		l.scheduler.start();
		other.scheduler.start();
		await settle();
		const done = bindSidecarResumes(r.input, l.scheduler);
		let complete = false;
		void done.then(
			() => {
				complete = true;
			},
			() => {},
		);
		try {
			expect(bindSidecarResumes(r.input, l.scheduler)).toBe(done);
			await refusal(() => bindSidecarResumes(r.input, other.scheduler), "BOUND");
			expect(r.next).toHaveBeenCalledTimes(1);
			r.terminal.resolve({ kind: "stop", reason: "eof" });
			r.controls[0]?.resolve({ kind: "stop", reason: "eof" });
			await settle();
			expect(complete).toBe(false);
			expect(l.scheduler.status().state).toBe("running");
			r.closed.resolve();
			await done;
			expect(complete).toBe(true);
			expect(l.scheduler.status().state).toBe("running");
			expect(l.clock.last().state).toBe("pending");
		} finally {
			r.end();
			await Promise.all([l.scheduler.stop(), other.scheduler.stop()]);
		}
	});

	it("completion cannot be held open by a broken control source or dispatch its late resume", async () => {
		const r = receiver();
		const l = loop();
		l.scheduler.start();
		await settle();
		let complete = false;
		const done = bindSidecarResumes(r.input, l.scheduler);
		void done.then(
			() => {
				complete = true;
			},
			() => {},
		);
		try {
			r.terminal.resolve({ kind: "stop", reason: "shutdown" });
			r.closed.resolve();
			await settle();
			expect(complete).toBe(true);
			r.controls[0]?.resolve({ kind: "resumed" });
			await settle();
			expect(l.ticks.map((tick) => tick.reason)).toEqual(["start"]);
			expect(r.next).toHaveBeenCalledTimes(1);
			expect(l.scheduler.status().state).toBe("running");
		} finally {
			r.end();
			await l.scheduler.stop();
		}
	});

	it("reports a rejected receiver close with the fixed stream error", async () => {
		const r = receiver();
		const l = loop();
		l.scheduler.start();
		await settle();
		const result = bindSidecarResumes(r.input, l.scheduler).catch((error: unknown) => error);
		try {
			r.closed.reject(new Error(CANARY));
			r.end();
			fixed(await result, "STREAM");
		} finally {
			r.end();
			await l.scheduler.stop();
		}
	});
});
