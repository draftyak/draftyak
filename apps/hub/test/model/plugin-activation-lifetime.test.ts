import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { PluginActivationError } from "../../src/plugins/activation/errors.ts";
import { PluginActivationLifetime } from "../../src/plugins/activation/lifetime.ts";

// Bounded cleanup bookkeeping only: approval models, nightly 10k runs and native escape/platform
// acceptance remain separate M2.21 obligations. No resource view below issues native authority.
type Kind = "supervisor" | "activation" | "process";
type Cleanup = "success" | "nonzero" | "reject" | "throw";
type Event = "R" | "O" | "C" | "D";
type Status = "pending" | "fulfilled" | "rejected";
const kinds: readonly Kind[] = ["supervisor", "activation", "process"];
const cleanups: readonly Exclude<Cleanup, "throw">[] = ["success", "nonzero", "reject"];

interface BodyState {
	entered: number;
	active: number;
	finalizing: boolean;
	readonly jobs: Promise<unknown>[];
}
interface OwnerState {
	readonly id: string;
	retained: boolean;
	clean: boolean;
	inFlight: number;
	calls: number;
	unrequestedRetry: boolean;
	wrongReason: boolean;
	abortMissed: boolean;
	readonly epoch?: AbortController;
	readonly jobs: Promise<unknown>[];
}

/** External physical markers, not the lifetime's maps, promises or closed flag. */
class Obligations {
	readonly bodies: BodyState[] = [];
	readonly owners = new Map<string, OwnerState>();
	fenced = false;
	workPending(): boolean {
		return (
			this.bodies.some((body) => body.active !== 0) ||
			[...this.owners.values()].some((owner) => owner.inFlight !== 0)
		);
	}
	dirty(): boolean {
		return this.workPending() || [...this.owners.values()].some((owner) => !owner.clean);
	}
	retain(owner: OwnerState): void {
		if (!owner.retained) {
			owner.retained = true;
			this.owners.set(owner.id, owner);
		}
	}
}

function observe(promise: Promise<unknown>, obligations?: Obligations) {
	const state = {
		status: "pending" as Status,
		unsafeSuccess: false,
		earlyRefusal: false,
		activationError: false,
	};
	const joined = promise.then(
		() => {
			state.unsafeSuccess = obligations?.dirty() ?? false;
			state.status = "fulfilled";
		},
		(error: unknown) => {
			state.earlyRefusal = obligations?.workPending() ?? false;
			state.activationError = error instanceof PluginActivationError;
			state.status = "rejected";
		},
	);
	return { promise, state, joined };
}
type Observation = ReturnType<typeof observe>;

function ownerModel(
	lifetime: PluginActivationLifetime,
	obligations: Obligations,
	id: string,
	kind: Kind,
	initial: Cleanup,
	onStart?: () => void,
) {
	const first = Promise.withResolvers<Cleanup>();
	const retry = Promise.withResolvers<Cleanup>();
	let retryAllowed = false;
	const state: OwnerState = {
		id,
		retained: false,
		clean: false,
		inFlight: 0,
		calls: 0,
		unrequestedRetry: false,
		wrongReason: false,
		abortMissed: false,
		epoch: kind === "activation" ? new AbortController() : undefined,
		jobs: [],
	};
	const cleanup = (): Promise<{ cleanupFailures: number }> => {
		state.calls++;
		if (state.calls > 1 && !retryAllowed) state.unrequestedRetry = true;
		onStart?.();
		if (state.calls === 1 && initial === "throw") throw new Error("MODEL_CLEANUP_REFUSED");
		const gate = state.calls === 1 ? first : retry;
		state.inFlight++;
		const task = (async () => {
			let quiet = false;
			try {
				const result = await gate.promise;
				if (result === "reject") throw new Error("MODEL_CLEANUP_REFUSED");
				quiet = result === "success";
				return { cleanupFailures: quiet ? 0 : 1 };
			} finally {
				state.inFlight--;
				if (quiet) state.clean = true;
			}
		})();
		state.jobs.push(task);
		void task.catch(() => {});
		return task;
	};
	// These are cleanup resource views, never branded supervisor/activation/process issuers.
	const supervisor = Object.freeze({ close: cleanup });
	const activation = Object.freeze({
		revoke(reason: "shutdown") {
			if (reason !== "shutdown") state.wrongReason = true;
			return cleanup();
		},
	});
	const process = Object.freeze({ retire: cleanup });
	return {
		state,
		retain(): void {
			obligations.retain(state);
			if (kind === "supervisor") lifetime.retainSupervisor(supervisor);
			else if (kind === "process") lifetime.retainProcess(process);
			else {
				if (!state.epoch) throw new Error("MODEL_EPOCH_MISSING");
				lifetime.retainActivation(activation, state.epoch);
			}
			if (obligations.fenced && state.epoch && !state.epoch.signal.aborted)
				state.abortMissed = true;
		},
		release(): void {
			first.resolve(initial);
		},
		allowRetry(): void {
			retryAllowed = true;
		},
		releaseRetry(): void {
			retry.resolve("success");
		},
		forceSuccess(): void {
			retryAllowed = true;
			first.resolve("success");
			retry.resolve("success");
		},
	};
}
type Owner = ReturnType<typeof ownerModel>;

function bodyModel(
	lifetime: PluginActivationLifetime,
	obligations: Obligations,
	owner: Owner,
	primaryReject = false,
) {
	const retain = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const state: BodyState = { entered: 0, active: 0, finalizing: false, jobs: [] };
	obligations.bodies.push(state);
	const tracked = observe(
		lifetime.track(() => {
			const physical = (async () => {
				state.entered++;
				state.active++;
				try {
					await retain.promise;
					if (primaryReject) throw new Error("MODEL_PRIMARY_REFUSED");
				} finally {
					state.finalizing = true;
					try {
						owner.retain();
						await finish.promise;
					} finally {
						state.active--;
					}
				}
			})();
			state.jobs.push(physical);
			void physical.catch(() => {});
			return physical;
		}),
	);
	return {
		state,
		tracked,
		publish(): void {
			retain.resolve();
		},
		finish(): void {
			finish.resolve();
		},
		releaseAll(): void {
			retain.resolve();
			finish.resolve();
		},
	};
}
type Body = ReturnType<typeof bodyModel>;

function check(
	observations: readonly Observation[],
	obligations: Obligations,
	label: string,
): void {
	for (const { state } of observations) {
		expect(state.unsafeSuccess, label).toBe(false);
		expect(state.earlyRefusal, label).toBe(false);
	}
	for (const owner of obligations.owners.values()) {
		expect(owner.unrequestedRetry, label).toBe(false);
		expect(owner.wrongReason, label).toBe(false);
		expect(owner.abortMissed, label).toBe(false);
	}
}

async function dispose(
	lifetime: PluginActivationLifetime,
	obligations: Obligations,
	bodies: readonly Body[],
	owners: readonly Owner[],
	observations: readonly Observation[],
): Promise<void> {
	// Teardown joins the actual dependency callbacks even if a mutant cached a false success.
	for (const body of bodies) body.releaseAll();
	for (const owner of owners) owner.forceSuccess();
	obligations.fenced = true;
	const first = observe(lifetime.close());
	await nextTurn();
	await Promise.allSettled(bodies.flatMap((body) => body.state.jobs));
	await Promise.allSettled(owners.flatMap((owner) => owner.state.jobs));
	const last = observe(lifetime.close());
	await nextTurn();
	await Promise.allSettled([
		first.joined,
		last.joined,
		...observations.map((observation) => observation.joined),
		...bodies.map((body) => body.tracked.joined),
		...owners.flatMap((owner) => owner.state.jobs),
	]);
}

function permutations(items: readonly Event[]): Event[][] {
	if (items.length === 0) return [[]];
	return items.flatMap((item, index) =>
		permutations(items.filter((_, position) => position !== index)).map((tail) => [item, ...tail]),
	);
}

// Entered body first. R=retain in finally; O=physical finally done; C=close; D=cleanup done.
// The independently declared DAG R<O, R<D, C<D has exactly five linear extensions.
const schedules = permutations(["R", "O", "C", "D"]).filter(
	(trace) =>
		trace.indexOf("R") < trace.indexOf("O") &&
		trace.indexOf("R") < trace.indexOf("D") &&
		trace.indexOf("C") < trace.indexOf("D"),
);

const modelCases = kinds.flatMap((kind) =>
	cleanups.flatMap((cleanup) =>
		[false, true].flatMap((primary) =>
			schedules.map((trace) => ({
				kind,
				cleanup,
				primary,
				trace,
				label: `${kind} cleanup=${cleanup} operation=${primary ? "reject" : "success"} order=${trace.join("")}`,
			})),
		),
	),
);

describe("plugin cleanup obligation model", () => {
	it("declares exactly 90 distinct valid model rows", () => {
		expect(schedules.map((trace) => trace.join("")).sort()).toEqual(
			["CROD", "CRDO", "RCOD", "RCDO", "ROCD"].sort(),
		);
		expect(modelCases.length).toBe(90);
		expect(new Set(modelCases.map((row) => row.label)).size).toBe(90);
	});

	for (const row of modelCases) {
		const { kind, cleanup, primary, trace, label } = row;
		it(`trace ${label}`, async () => {
			const lifetime = new PluginActivationLifetime();
			const obligations = new Obligations();
			const owner = ownerModel(lifetime, obligations, "owner", kind, cleanup);
			const body = bodyModel(lifetime, obligations, owner, primary);
			const observations: Observation[] = [];
			let attempt: Observation | undefined;
			let closed = false;
			let retained = false;
			const executed: Event[] = [];
			try {
				await nextTurn();
				expect(body.state.entered, label).toBe(1);
				for (const event of trace) {
					executed.push(event);
					if (event === "R") {
						body.publish();
						retained = true;
					} else if (event === "O") body.finish();
					else if (event === "D") owner.release();
					else {
						obligations.fenced = true;
						const promise = lifetime.close();
						attempt = observe(promise, obligations);
						observations.push(attempt);
						closed = true;
						expect(lifetime.close() === promise, label).toBe(true);
						if (owner.state.retained && owner.state.epoch)
							expect(owner.state.epoch.signal.aborted, label).toBe(true);
					}
					await nextTurn();
					check(observations, obligations, label);
					expect(owner.state.calls, label).toBe(closed && retained ? 1 : 0);
					if (owner.state.epoch && closed && retained)
						expect(owner.state.epoch.signal.aborted, label).toBe(true);
					if (attempt) {
						const expected = obligations.workPending()
							? "pending"
							: obligations.dirty()
								? "rejected"
								: "fulfilled";
						expect(attempt.state.status, label).toBe(expected);
					}
				}
				expect(executed.join(""), label).toBe(trace.join(""));
				if (!attempt) throw new Error("MODEL_CLOSE_MISSING");
				if (cleanup !== "success") {
					expect(attempt.state.activationError, label).toBe(true);
					owner.allowRetry();
					const retry = observe(lifetime.close(), obligations);
					observations.push(retry);
					await nextTurn();
					expect(owner.state.calls, label).toBe(2);
					expect(retry.state.status, label).toBe("pending");
					owner.releaseRetry();
					await nextTurn();
					expect(retry.state.status, label).toBe("fulfilled");
				}
				check(observations, obligations, label);
				expect(obligations.dirty(), label).toBe(false);
			} finally {
				await dispose(lifetime, obligations, [body], [owner], observations);
			}
		});
	}

	it("fences body entry synchronously before the deferred admission runs", async () => {
		const lifetime = new PluginActivationLifetime();
		let entries = 0;
		const before = observe(
			lifetime.track(async () => {
				entries++;
			}),
		);
		lifetime.beginClose();
		const after = observe(
			lifetime.track(async () => {
				entries++;
			}),
		);
		const closed = observe(lifetime.close(), new Obligations());
		try {
			await nextTurn();
			expect(entries).toBe(0);
			expect(before.state.status).toBe("rejected");
			expect(after.state.status).toBe("rejected");
			expect(closed.state.status).toBe("fulfilled");
		} finally {
			await Promise.allSettled([before.joined, after.joined, closed.joined]);
		}
	});

	it.each(kinds)("deduplicates %s identity and retains reentrant close identity", async (kind) => {
		const lifetime = new PluginActivationLifetime();
		const obligations = new Obligations();
		const reentrant: Promise<void>[] = [];
		const observations: Observation[] = [];
		const owner = ownerModel(lifetime, obligations, "same", kind, "success", () => {
			const nested = lifetime.close();
			reentrant.push(nested);
			observations.push(observe(nested, obligations));
		});
		try {
			owner.retain();
			owner.retain();
			obligations.fenced = true;
			const first = observe(lifetime.close(), obligations);
			observations.push(first);
			owner.retain();
			await nextTurn();
			expect(reentrant.length).toBe(1);
			expect(reentrant[0] === first.promise).toBe(true);
			expect(owner.state.calls).toBe(1);
			expect(first.state.status).toBe("pending");
			owner.release();
			await nextTurn();
			expect(first.state.status).toBe("fulfilled");
			owner.retain();
			expect(lifetime.closed).toBe(true);
			expect(lifetime.close() === first.promise).toBe(true);
			expect(owner.state.calls).toBe(1);
			check(observations, obligations, kind);
		} finally {
			await dispose(lifetime, obligations, [], [owner], observations);
		}
	});

	it.each(kinds)("joins a new %s owner after a prior successful close", async (kind) => {
		const lifetime = new PluginActivationLifetime();
		const obligations = new Obligations();
		const owner = ownerModel(lifetime, obligations, "late", kind, "success");
		const observations: Observation[] = [];
		try {
			obligations.fenced = true;
			const first = observe(lifetime.close(), obligations);
			observations.push(first);
			await nextTurn();
			expect(first.state.status).toBe("fulfilled");
			owner.retain();
			expect(lifetime.closed).toBe(false);
			if (owner.state.epoch) expect(owner.state.epoch.signal.aborted).toBe(true);
			const second = observe(lifetime.close(), obligations);
			observations.push(second);
			expect(second.promise === first.promise).toBe(false);
			await nextTurn();
			expect(second.state.status).toBe("pending");
			owner.release();
			await nextTurn();
			expect(second.state.status).toBe("fulfilled");
			check(observations, obligations, kind);
		} finally {
			await dispose(lifetime, obligations, [], [owner], observations);
		}
	});

	it("joins late work after a failed cleanup and retries only the failed owner", async () => {
		let visited = 0;
		for (const firstKind of kinds)
			for (const lateKind of kinds)
				for (const failure of ["nonzero", "reject"] as const) {
					const label = `${firstKind}/${lateKind}/${failure}`;
					const lifetime = new PluginActivationLifetime();
					const obligations = new Obligations();
					const firstOwner = ownerModel(lifetime, obligations, "failed", firstKind, failure);
					const lateOwner = ownerModel(lifetime, obligations, "late", lateKind, "success");
					const body = bodyModel(lifetime, obligations, lateOwner);
					const observations: Observation[] = [];
					try {
						firstOwner.retain();
						await nextTurn();
						obligations.fenced = true;
						const first = observe(lifetime.close(), obligations);
						observations.push(first);
						firstOwner.release();
						await nextTurn();
						expect(first.state.status, label).toBe("pending");
						body.publish();
						await nextTurn();
						body.finish();
						await nextTurn();
						expect(body.state.active, label).toBe(0);
						expect(first.state.status, label).toBe("pending");
						lateOwner.release();
						await nextTurn();
						expect(first.state.status, label).toBe("rejected");
						expect(first.state.activationError, label).toBe(true);
						expect(firstOwner.state.calls, label).toBe(1);
						expect(lateOwner.state.calls, label).toBe(1);
						firstOwner.allowRetry();
						const second = observe(lifetime.close(), obligations);
						observations.push(second);
						await nextTurn();
						expect(firstOwner.state.calls, label).toBe(2);
						expect(lateOwner.state.calls, label).toBe(1);
						expect(second.state.status, label).toBe("pending");
						firstOwner.releaseRetry();
						await nextTurn();
						expect(second.state.status, label).toBe("fulfilled");
						check(observations, obligations, label);
						visited++;
					} finally {
						await dispose(lifetime, obligations, [body], [firstOwner, lateOwner], observations);
					}
				}
		expect(visited).toBe(18);
	});

	it.each(kinds)("keeps a synchronous %s cleanup refusal until explicit retry", async (kind) => {
		const lifetime = new PluginActivationLifetime();
		const obligations = new Obligations();
		const owner = ownerModel(lifetime, obligations, "sync", kind, "throw");
		const observations: Observation[] = [];
		try {
			owner.retain();
			obligations.fenced = true;
			const first = observe(lifetime.close(), obligations);
			observations.push(first);
			await nextTurn();
			expect(first.state.status).toBe("rejected");
			expect(first.state.activationError).toBe(true);
			expect(owner.state.calls).toBe(1);
			owner.allowRetry();
			const second = observe(lifetime.close(), obligations);
			observations.push(second);
			await nextTurn();
			expect(second.state.status).toBe("pending");
			owner.releaseRetry();
			await nextTurn();
			expect(second.state.status).toBe("fulfilled");
			check(observations, obligations, kind);
		} finally {
			await dispose(lifetime, obligations, [], [owner], observations);
		}
	});
});
