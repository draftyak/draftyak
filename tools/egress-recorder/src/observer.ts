import { canonicalize } from "@draftyak/protocol/jcs";
import { type PayloadChunks, scanCanary } from "./canary.ts";
import {
	type CanaryVerdict,
	type Destination,
	descriptors,
	destination,
	MAX_ATTEMPTS,
	MAX_PENDING,
	MAX_RESULT_BYTES,
	type ObserverDescriptor,
	type ObserverResult,
	type ObserverState,
	type Outcome,
	type RecordedAttempt,
	RecorderError,
	record,
	type Stage,
} from "./schema.ts";

export interface ObservationSteps<T, R> {
	policy(signal: AbortSignal): boolean | Promise<boolean>;
	resolve(signal: AbortSignal): T | Promise<T>;
	connect(target: T, signal: AbortSignal): R | Promise<R>;
}
export type Observed<R> =
	| { readonly outcome: "succeeded"; readonly stage: "connect"; readonly value: R }
	| { readonly outcome: "refused" | "failed"; readonly stage: Stage };
export interface Observer {
	observe<T, R>(
		target: Destination,
		steps: ObservationSteps<T, R>,
		timeoutMs?: number,
	): Promise<Observed<R>>;
	scanCanary(canary: Uint8Array, chunks: PayloadChunks, timeoutMs?: number): Promise<CanaryVerdict>;
	complete(): void;
	fail(): void;
}
export interface Recorder {
	observer(id: string): Observer;
	finish(): string;
}
interface State {
	readonly descriptor: ObserverDescriptor;
	state: ObserverState;
	attempts: number;
	canary: CanaryVerdict;
	readonly pending: Set<AbortController>;
}
interface Entry {
	readonly observerId: string;
	readonly sequence: number;
	readonly destination: Destination;
	outcome: Outcome;
	stage: Stage;
}

/** Gate observer installation and test-upstream overrides before their callbacks run. */
export function activateTestOnly<T>(profile: unknown, activate: () => T): T {
	if (profile !== "test") throw new RecorderError("PROFILE_FORBIDDEN");
	return activate();
}

export function createRecorder(options: {
	readonly profile: unknown;
	readonly observers: readonly ObserverDescriptor[];
}): Recorder {
	const fields = record(options, ["profile", "observers"]);
	return activateTestOnly(fields.profile, () => {
		const states = new Map<string, State>(
			descriptors(fields.observers).map((row) => [
				row.id,
				{
					descriptor: row,
					state: "missing",
					attempts: 0,
					canary: "unobserved",
					pending: new Set(),
				},
			]),
		);
		const entries: Entry[] = [];
		let sealed = false;
		let failed = false;
		let pending = 0;
		let scans = 0;
		const fail = (state: State): void => {
			state.state = "failed";
			for (const controller of state.pending) controller.abort();
		};
		const requireActive = (state: State): void => {
			if (sealed || state.state !== "active") {
				if (!sealed) {
					failed = true;
					fail(state);
				}
				throw new RecorderError("LIFECYCLE");
			}
		};
		return Object.freeze({
			observer(id: string): Observer {
				const state = states.get(id);
				if (sealed || !state || state.state !== "missing") {
					failed = true;
					throw new RecorderError("LIFECYCLE");
				}
				state.state = "active";
				return Object.freeze({
					async scanCanary(
						canary: Uint8Array,
						chunks: PayloadChunks,
						timeoutMs = 1000,
					): Promise<CanaryVerdict> {
						requireActive(state);
						if (
							++scans > MAX_ATTEMPTS ||
							pending >= MAX_PENDING ||
							!Number.isInteger(timeoutMs) ||
							timeoutMs < 1 ||
							timeoutMs > 30_000
						) {
							failed = true;
							fail(state);
							throw new RecorderError("CAPACITY_EXCEEDED");
						}
						const controller = new AbortController();
						state.pending.add(controller);
						pending++;
						const timer = setTimeout(() => controller.abort(), timeoutMs);
						try {
							let verdict: CanaryVerdict;
							try {
								verdict = await scanCanary(canary, chunks, controller.signal);
							} catch {
								verdict = "failed";
							}
							if (sealed || state.state !== "active" || controller.signal.aborted)
								verdict = "failed";
							state.canary =
								state.canary === "failed" || verdict === "failed"
									? "failed"
									: state.canary === "matched" || verdict === "matched"
										? "matched"
										: verdict;
							if (state.canary === "failed") fail(state);
							return state.canary;
						} finally {
							clearTimeout(timer);
							state.pending.delete(controller);
							pending--;
						}
					},
					async observe<T, R>(
						target: Destination,
						steps: ObservationSteps<T, R>,
						timeoutMs = 1000,
					): Promise<Observed<R>> {
						requireActive(state);
						if (entries.length >= MAX_ATTEMPTS || pending >= MAX_PENDING) {
							failed = true;
							fail(state);
							throw new RecorderError("CAPACITY_EXCEEDED");
						}
						let copied: Destination;
						try {
							copied = destination(target);
							if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000)
								throw new RecorderError("INVALID_RESULT");
						} catch {
							failed = true;
							fail(state);
							throw new RecorderError("INVALID_RESULT");
						}
						const entry: Entry = {
							observerId: id,
							sequence: entries.length,
							destination: copied,
							outcome: "pending",
							stage: "policy",
						};
						entries.push(entry);
						state.attempts++;
						const controller = new AbortController();
						state.pending.add(controller);
						pending++;
						const interrupted = new Promise<never>((_resolve, reject) => {
							controller.signal.addEventListener(
								"abort",
								() => reject(new Error("Observation ended")),
								{ once: true },
							);
						});
						const timer = setTimeout(() => controller.abort(), timeoutMs);
						const wait = async <V>(stage: Stage, action: () => V | Promise<V>): Promise<V> => {
							if (sealed || state.state !== "active" || controller.signal.aborted)
								throw new Error("Observation ended");
							entry.stage = stage;
							const value = await Promise.race([
								Promise.resolve().then(() => {
									if (sealed || state.state !== "active" || controller.signal.aborted)
										throw new Error("Observation ended");
									return action();
								}),
								interrupted,
							]);
							if (sealed || state.state !== "active" || controller.signal.aborted)
								throw new Error("Observation ended");
							return value;
						};
						try {
							const allowed = await wait("policy", () => steps.policy(controller.signal));
							if (allowed !== true) {
								if (allowed !== false) throw new Error("Invalid policy result");
								entry.outcome = "refused";
								return { outcome: "refused", stage: "policy" };
							}
							const resolved = await wait("dns", () => steps.resolve(controller.signal));
							const value = await wait("connect", () => steps.connect(resolved, controller.signal));
							entry.outcome = "succeeded";
							return { outcome: "succeeded", stage: "connect", value };
						} catch {
							entry.outcome = "failed";
							return { outcome: "failed", stage: entry.stage };
						} finally {
							clearTimeout(timer);
							state.pending.delete(controller);
							pending--;
						}
					},
					complete(): void {
						if (sealed || state.state !== "active" || state.pending.size > 0) {
							fail(state);
							throw new RecorderError("LIFECYCLE");
						}
						state.state = "complete";
					},
					fail(): void {
						if (sealed) throw new RecorderError("LIFECYCLE");
						fail(state);
					},
				});
			},
			finish(): string {
				if (sealed) throw new RecorderError("LIFECYCLE");
				sealed = true;
				for (const state of states.values()) if (state.pending.size) fail(state);
				const observers: ObserverResult[] = [...states.values()].map((state) => ({
					...state.descriptor,
					state: state.state,
					attempts: state.attempts,
					canary: state.canary,
				}));
				const attempts: RecordedAttempt[] = entries.map((entry) => ({
					...entry,
					outcome: entry.outcome === "pending" ? "failed" : entry.outcome,
				}));
				const json = canonicalize({
					format: "draftyak.egress-recorder",
					version: 1,
					scope: "component",
					state:
						!failed && observers.every((row) => row.state === "complete") ? "complete" : "failed",
					observers,
					attempts,
				});
				if (Buffer.byteLength(json) > MAX_RESULT_BYTES)
					throw new RecorderError("CAPACITY_EXCEEDED");
				return json;
			},
		});
	});
}
