import type { HostMethod } from "@draftyak/protocol/host-channel";
import { jsonCopy } from "@draftyak/protocol/host-channel";
import { JcsError } from "@draftyak/protocol/jcs";
import type { TimerClock } from "../../kernel/clock.ts";
import {
	Endpoint,
	type HostBinding,
	type PluginHostRequestContext,
	type ProgressListener,
	type RpcOutcome,
} from "./channel.ts";
import { pluginEnvironment } from "./environment.ts";
import { PluginSupervisorError, type SupervisorErrorCode } from "./errors.ts";
import { deepFreeze, type GenerationSnapshot, inertRecord, type PluginKind } from "./generation.ts";
import { ensureDataDir, launchArgv, verifiedAgain } from "./launch.ts";
import type { Watchdog } from "./memory.ts";
import {
	CANCEL_GRACE_MS,
	callLimitMs,
	END_BOUND_MS,
	IDLE_MS,
	LEASE_MAX_MS,
	LEASE_MIN_MS,
	LIVENESS_INTERVAL_MS,
	LIVENESS_TIMEOUT_MS,
	type LocalRevokeReason,
	MAX_ADMITTED_CALLS,
	MAX_UNSCOPED_LEASES,
	type PluginEventType,
	STARTUP_MS,
	type StopReason,
	type SupervisorEventReason,
} from "./policy.ts";
import { type LaunchPlan, PluginProcess, type ProcessEnd } from "./process.ts";
import type { CheckedRuntime } from "./runtime.ts";
import { schedule, type Timer, within } from "./timers.ts";

const MINT = Symbol("supervised-process");

/** Supervisor-wide facts every spawn of every activation reuses. */
export interface SupervisorContext {
	readonly runtime: CheckedRuntime;
	readonly dataRoot: string;
	readonly stdioRoot: string;
	readonly clock: TimerClock;
	readonly watchdog: Watchdog;
	readonly parentEnv: Readonly<Record<string, string | undefined>>;
	dispatch(
		method: HostMethod,
		params: unknown,
		context: PluginHostRequestContext,
	): Promise<unknown>;
}

/** What an instance needs from its activation. */
export interface ActivationCore {
	readonly snapshot: GenerationSnapshot;
	readonly entry: string;
	readonly epoch: string;
	readonly context: SupervisorContext;
	/** The code calls get once the activation can no longer run, else undefined. */
	refusal(): SupervisorErrorCode | undefined;
	/** True only for the instance the activation created for that id and still keeps. */
	holds(instance: Instance): boolean;
	crashed(): void;
	localRevoke(reason: LocalRevokeReason): void;
	emit(type: PluginEventType, instanceId: string, reason?: SupervisorEventReason): void;
	released(instance: Instance): void;
}

export interface CallToolOptions {
	readonly signal?: AbortSignal;
	/** 1 up to the tool's limit (120 000 for channel_sync, else 30 000); the limit by default. */
	readonly timeoutMs?: number;
	/** Opaque native invocation that host requests made during this call are attributed to. */
	readonly invocation?: unknown;
	readonly onProgress?: ProgressListener;
}

export interface LeaseOptions {
	/** A scoped lease lets host requests outside a call run with this as their invocation. */
	readonly scope?: unknown;
}

export interface InstanceLease {
	/** Aborts at expiry, release, process end, revoke or close. */
	readonly signal: AbortSignal;
	/** Extends the lease to now + ms; false once it has ended. */
	renew(ms: number): boolean;
	release(): void;
}

export interface StopResult {
	readonly processes: number;
	readonly cleanupFailures: number;
}

/** A stop's result within END_BOUND_MS; a process that outlives the bound is a cleanup failure. */
export async function boundedStop(
	clock: TimerClock,
	wait: Promise<StopResult>,
): Promise<StopResult> {
	let result: StopResult | undefined;
	const ended = await within(
		clock,
		END_BOUND_MS,
		wait.then((value) => {
			result = value;
		}),
	);
	return ended && result !== undefined
		? result
		: Object.freeze({ processes: 1, cleanupFailures: 1 });
}

interface CallEntry {
	readonly name: string;
	readonly args: Record<string, unknown>;
	readonly invocation: unknown;
	readonly onProgress: ProgressListener | undefined;
	readonly timeoutMs: number;
	readonly controller: AbortController;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: PluginSupervisorError) => void;
	readonly run: number;
	settled: boolean;
	sent: string | undefined;
	deadline: Timer | undefined;
	grace: Timer | undefined;
	detach: (() => void) | undefined;
}

interface LeaseState {
	readonly controller: AbortController;
	readonly scoped: boolean;
	readonly scope: unknown;
	readonly run: number;
	timer: Timer | undefined;
	ended: boolean;
}

type Unanswered = { readonly kind: "ended" | "busy" | "refused" };
type Asked = { readonly kind: "ok"; readonly result: Record<string, unknown> } | Unanswered;
type Probe = { readonly kind: "ok"; readonly names: ReadonlySet<string> } | Unanswered;

export const TOOL_NAME: RegExp = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_TOOLS = 256;

function failure(code: SupervisorErrorCode): PluginSupervisorError {
	return new PluginSupervisorError(code);
}

function validLeaseMs(ms: unknown): ms is number {
	return (
		typeof ms === "number" && Number.isSafeInteger(ms) && ms >= LEASE_MIN_MS && ms <= LEASE_MAX_MS
	);
}

/** A canonical JSON copy of the call arguments, an object of at most one frame. */
function copyArguments(args: unknown): Record<string, unknown> {
	let copy: unknown;
	try {
		copy = jsonCopy(args);
	} catch (error) {
		throw failure(error instanceof JcsError ? "REQUEST_INVALID" : "FRAME_TOO_LARGE");
	}
	if (copy === null || typeof copy !== "object" || Array.isArray(copy))
		throw failure("REQUEST_INVALID");
	return copy as Record<string, unknown>;
}

function toolNames(result: Record<string, unknown>): ReadonlySet<string> | undefined {
	if (Object.hasOwn(result, "nextCursor")) return undefined;
	const tools = result.tools;
	if (!Array.isArray(tools) || tools.length > MAX_TOOLS) return undefined;
	const names = new Set<string>();
	for (const tool of tools) {
		if (tool === null || typeof tool !== "object" || Array.isArray(tool)) return undefined;
		const name = (tool as Record<string, unknown>).name;
		if (typeof name !== "string" || !TOOL_NAME.test(name) || names.has(name)) return undefined;
		names.add(name);
	}
	return names;
}

function endCode(end: ProcessEnd, ready: boolean): SupervisorErrorCode {
	if (end.outcome === "crashed") {
		if (end.reason.startsWith("violation:")) return "PLUGIN_VIOLATION";
		if (!ready) {
			if (end.reason === "start-timeout") return "START_TIMEOUT";
			if (end.reason === "spawn") return "SPAWN_FAILED";
			return "START_FAILED";
		}
	}
	return "PLUGIN_EXITED";
}

/**
 * One channel account or AI-provider instance: at most one process at a time, started lazily,
 * calls serialized in FIFO order so every host request has one unambiguous native invocation.
 */
export class Instance {
	readonly id: string;
	readonly core: ActivationCore;
	readonly handle: SupervisedProcess;
	readonly #lifetime = new AbortController();
	readonly #queue: CallEntry[] = [];
	readonly #leases = new Set<LeaseState>();
	readonly #quiet: (() => void)[] = [];
	#run = 0;
	#runLife = new AbortController();
	#phase: "idle" | "starting" | "ready" = "idle";
	#ready = false;
	#process: PluginProcess | undefined;
	#endpoint: Endpoint | undefined;
	#tools: ReadonlySet<string> = new Set();
	#inFlight: CallEntry | undefined;
	#admitted = 0;
	#scoped: LeaseState | undefined;
	#idle: Timer | undefined;
	#refusal: SupervisorErrorCode | undefined;
	#stopReason: StopReason = "revoke";
	#shutdown: Promise<StopResult> | undefined;
	#shutdownStats = { processes: 0, cleanupFailures: 0 };
	#failed = false;

	constructor(core: ActivationCore, id: string) {
		this.core = core;
		this.id = id;
		this.handle = new SupervisedProcess(MINT, this);
	}

	get revoked(): boolean {
		return this.#refusalNow() !== undefined;
	}

	get signal(): AbortSignal {
		return this.#lifetime.signal;
	}

	get retiring(): boolean {
		return this.#refusal === "INSTANCE_RETIRED";
	}

	get #clock(): TimerClock {
		return this.core.context.clock;
	}

	#refusalNow(): SupervisorErrorCode | undefined {
		// An instance its activation did not create, or no longer keeps, never runs a process.
		return (
			this.#refusal ??
			this.core.refusal() ??
			(this.core.holds(this) ? undefined : "INSTANCE_INVALID")
		);
	}

	callTool(name: unknown, args: unknown, rawOptions: unknown): Promise<unknown> {
		try {
			return this.#admit(name, args, rawOptions);
		} catch (error) {
			return Promise.reject(
				error instanceof PluginSupervisorError ? error : failure("REQUEST_INVALID"),
			);
		}
	}

	#admit(name: unknown, args: unknown, rawOptions: unknown): Promise<unknown> {
		const refusal = this.#refusalNow();
		if (refusal !== undefined) throw failure(refusal);
		if (this.#failed) throw failure("INSTANCE_FAILED");
		const options =
			rawOptions === undefined
				? Object.create(null)
				: inertRecord(
						rawOptions,
						[],
						["signal", "timeoutMs", "invocation", "onProgress"],
						"REQUEST_INVALID",
					);
		if (typeof name !== "string" || !TOOL_NAME.test(name)) throw failure("TOOL_UNKNOWN");
		let signal: AbortSignal | undefined;
		if (options.signal !== undefined) {
			try {
				signal = AbortSignal.any([options.signal as AbortSignal]);
			} catch {
				throw failure("REQUEST_INVALID");
			}
		}
		const limit = callLimitMs(name);
		const timeoutMs: unknown = options.timeoutMs ?? limit;
		if (
			typeof timeoutMs !== "number" ||
			!Number.isSafeInteger(timeoutMs) ||
			timeoutMs < 1 ||
			timeoutMs > limit
		)
			throw failure("REQUEST_INVALID");
		const onProgress: unknown = options.onProgress;
		if (onProgress !== undefined && typeof onProgress !== "function")
			throw failure("REQUEST_INVALID");
		const copied = copyArguments(args);
		if (signal?.aborted) throw failure("CALL_CANCELLED");
		if (this.#admitted >= MAX_ADMITTED_CALLS) throw failure("CALL_LIMIT");
		const { promise, resolve, reject } = Promise.withResolvers<unknown>();
		const entry: CallEntry = {
			name,
			args: copied,
			invocation: options.invocation,
			onProgress: onProgress as ProgressListener | undefined,
			timeoutMs,
			controller: new AbortController(),
			resolve,
			reject,
			run: this.#admissionRun(),
			settled: false,
			sent: undefined,
			deadline: undefined,
			grace: undefined,
			detach: undefined,
		};
		this.#admitted++;
		this.#queue.push(entry);
		this.#cancelIdle();
		if (signal !== undefined) {
			const onAbort = (): void => this.#expire(entry, "CALL_CANCELLED");
			signal.addEventListener("abort", onAbort, { once: true });
			entry.detach = () => signal.removeEventListener("abort", onAbort);
		}
		// The deadline starts once the call is admitted and the instance is ready; queue wait counts.
		if (this.#phase === "ready" && entry.run === this.#run) this.#arm(entry);
		if (this.#phase === "idle") this.#start();
		else this.#pump();
		return promise;
	}

	#admissionRun(): number {
		const live = this.#process === undefined || !this.#process.ending;
		return this.#phase !== "idle" && live ? this.#run : this.#run + 1;
	}

	#arm(entry: CallEntry): void {
		if (entry.deadline !== undefined || entry.settled) return;
		entry.deadline = schedule(this.#clock, entry.timeoutMs, this.#lifetime.signal, () =>
			this.#expire(entry, "CALL_TIMEOUT"),
		);
	}

	#expire(entry: CallEntry, code: "CALL_TIMEOUT" | "CALL_CANCELLED"): void {
		if (entry.settled) return;
		const process = this.#process;
		const endpoint = this.#endpoint;
		const id = entry.sent;
		if (
			this.#inFlight === entry &&
			id !== undefined &&
			process !== undefined &&
			endpoint !== undefined &&
			!process.ending
		) {
			// The plugin hears of the cancellation before the call's host requests are refused.
			endpoint.cancel(id, code === "CALL_TIMEOUT" ? "timeout" : "cancelled");
			this.#settle(entry, failure(code));
			entry.grace = schedule(this.#clock, CANCEL_GRACE_MS, this.#lifetime.signal, () => {
				if (this.#inFlight !== entry) return;
				// An MCP server leaves a cancelled request unanswered. After a caller's cancel the kill
				// is the supervisor's own stop (ADR 0013); after an overrun deadline it is a crash.
				if (code === "CALL_TIMEOUT") process.kill("call-timeout");
				else process.stop("cancel");
			});
			return;
		}
		this.#settle(entry, failure(code));
		const index = this.#queue.indexOf(entry);
		if (index !== -1) this.#queue.splice(index, 1);
	}

	#settle(entry: CallEntry, error: PluginSupervisorError | undefined, value?: unknown): void {
		if (entry.settled) return;
		entry.settled = true;
		entry.deadline?.cancel();
		entry.detach?.();
		entry.controller.abort();
		if (entry.sent !== undefined) this.#endpoint?.forget(entry.sent);
		this.#admitted--;
		if (error !== undefined) entry.reject(error);
		else entry.resolve(value);
		this.#idleCheck();
	}

	#pump(): void {
		const process = this.#process;
		const endpoint = this.#endpoint;
		if (
			this.#phase !== "ready" ||
			this.#inFlight !== undefined ||
			process === undefined ||
			endpoint === undefined ||
			process.ending
		)
			return;
		while (this.#queue.length > 0) {
			const entry = this.#queue.shift() as CallEntry;
			if (entry.settled) continue;
			if (!this.#tools.has(entry.name)) {
				this.#settle(entry, failure("TOOL_UNKNOWN"));
				continue;
			}
			// In flight before the write, so host requests it causes are attributed to it.
			this.#inFlight = entry;
			let request: ReturnType<Endpoint["request"]>;
			try {
				request = endpoint.request(
					"tools/call",
					{ name: entry.name, arguments: entry.args },
					entry.onProgress,
				);
			} catch (error) {
				this.#inFlight = undefined;
				this.#settle(
					entry,
					error instanceof PluginSupervisorError ? error : failure("PLUGIN_EXITED"),
				);
				continue;
			}
			entry.sent = request.id;
			void request.outcome.then((outcome) => this.#answered(entry, outcome));
			return;
		}
		this.#idleCheck();
	}

	#answered(entry: CallEntry, outcome: RpcOutcome): void {
		if (this.#inFlight !== entry || (!outcome.ok && "ended" in outcome)) return;
		this.#inFlight = undefined;
		entry.grace?.cancel();
		// A reply after the deadline only clears the grace kill; it is discarded.
		if (outcome.ok) this.#settle(entry, undefined, deepFreeze(outcome.result));
		else this.#settle(entry, new PluginSupervisorError("PLUGIN_RPC_ERROR", outcome.rpcCode));
		this.#pump();
	}

	#start(): void {
		if (this.#phase !== "idle" || this.#refusalNow() !== undefined) return;
		const run = ++this.#run;
		this.#runLife = new AbortController();
		this.#phase = "starting";
		this.#ready = false;
		void this.#launch(run);
	}

	#runSignal(): AbortSignal {
		return AbortSignal.any([this.#lifetime.signal, this.#runLife.signal]);
	}

	#blocked(): SupervisorErrorCode | undefined {
		return this.#refusalNow();
	}

	async #launch(run: number): Promise<void> {
		const { snapshot, entry, context } = this.core;
		try {
			let blocked = this.#blocked();
			if (blocked !== undefined) {
				this.#startFailed(run, blocked);
				return;
			}
			// The re-hash before every spawn: changed, extra or missing files or links refuse it.
			if (!(await verifiedAgain(snapshot.bundle, entry))) {
				this.#startFailed(run, "BUNDLE_REFUSED");
				this.core.localRevoke("bundle");
				return;
			}
			blocked = this.#blocked();
			if (blocked !== undefined) {
				this.#startFailed(run, blocked);
				return;
			}
			const platform = context.runtime.platform;
			const dataDir = ensureDataDir(context.dataRoot, snapshot.pluginId, this.id, platform);
			const plan: LaunchPlan = {
				execPath: context.runtime.execPath,
				argv: launchArgv(
					snapshot.bundle.directory,
					entry,
					snapshot.dataGrant ? dataDir : undefined,
					"SPAWN_FAILED",
				),
				cwd: snapshot.bundle.directory,
				env: pluginEnvironment({
					pluginId: snapshot.pluginId,
					instanceId: this.id,
					dataDir,
					platform,
					systemRoot: context.runtime.systemRoot,
					parentEnv: context.parentEnv,
				}),
				stdioRoot: context.stdioRoot,
			};
			const holder: { endpoint?: Endpoint } = {};
			let process: PluginProcess | undefined;
			try {
				process = await PluginProcess.open(
					plan,
					{
						frame: (frame) => holder.endpoint?.frame(frame) ?? false,
						heldWriter: () => this.core.emit("held-writer", this.id),
						cleanupFailed: () => this.core.emit("cleanup-failed", this.id),
						killUnconfirmed: () => {
							this.#failed = true;
							this.core.emit("kill-unconfirmed", this.id);
						},
					},
					this.#clock,
					() => this.#blocked() === undefined,
				);
			} catch {
				this.core.emit("crashed", this.id, "spawn");
				this.core.crashed();
				this.#startFailed(run, "SPAWN_FAILED");
				return;
			}
			if (process === undefined) this.#startFailed(run, this.#blocked() ?? "PLUGIN_EXITED");
			else this.#attach(run, process, holder);
		} catch (error) {
			this.#startFailed(run, error instanceof PluginSupervisorError ? error.code : "SPAWN_FAILED");
		}
	}

	#attach(run: number, process: PluginProcess, holder: { endpoint?: Endpoint }): void {
		const context = this.core.context;
		const endpoint = new Endpoint(process, {
			pluginId: this.core.snapshot.pluginId,
			instanceId: this.id,
			generation: this.core.snapshot.generation,
			kind: this.core.snapshot.kind,
			clock: this.#clock,
			binding: () => this.#binding(run),
			dispatch: (method, params, request) => context.dispatch(method, params, request),
		});
		holder.endpoint = endpoint;
		this.#process = process;
		this.#endpoint = endpoint;
		const unregister =
			process.pid === undefined
				? () => {}
				: context.watchdog.register(process.pid, (reason) => process.kill(reason));
		void process.ended.then((end) => {
			unregister();
			this.#ended(run, process, endpoint, end);
		});
		this.core.emit("spawned", this.id);
		if (this.#blocked() !== undefined) {
			process.stop(this.#stopReason);
			return;
		}
		const startup = schedule(this.#clock, STARTUP_MS, this.#runSignal(), () => {
			if (this.#run === run && !this.#ready) process.kill("start-timeout");
		});
		this.#scheduleLiveness(run, process, endpoint);
		void this.#handshake(run, process, endpoint, startup);
	}

	async #handshake(
		run: number,
		process: PluginProcess,
		endpoint: Endpoint,
		startup: Timer,
	): Promise<void> {
		const probe = await this.#probe(endpoint);
		if (this.#run !== run || process.ending) return;
		if (probe.kind === "ended") return;
		if (probe.kind === "busy") {
			process.kill("start-timeout");
			return;
		}
		if (probe.kind !== "ok") {
			process.kill("surface");
			this.core.localRevoke("surface");
			return;
		}
		startup.cancel();
		this.#tools = probe.names;
		this.#ready = true;
		this.#phase = "ready";
		this.core.emit("ready", this.id);
		for (const entry of this.#queue) if (entry.run === run) this.#arm(entry);
		this.#pump();
	}

	async #ask(endpoint: Endpoint, method: string): Promise<Asked> {
		let request: ReturnType<Endpoint["request"]>;
		try {
			request = endpoint.request(method, {});
		} catch (error) {
			return {
				kind:
					error instanceof PluginSupervisorError && error.code === "PLUGIN_BUSY" ? "busy" : "ended",
			};
		}
		const outcome = await request.outcome;
		if (outcome.ok) return { kind: "ok", result: outcome.result };
		return { kind: "ended" in outcome ? "ended" : "refused" };
	}

	/** server/discover then tools/list; the reviewed generation's acceptSurface must say exactly true. */
	async #probe(endpoint: Endpoint): Promise<Probe> {
		const discover = await this.#ask(endpoint, "server/discover");
		if (discover.kind !== "ok") return { kind: discover.kind };
		const tools = await this.#ask(endpoint, "tools/list");
		if (tools.kind !== "ok") return { kind: tools.kind };
		const names = toolNames(tools.result);
		if (names === undefined) return { kind: "refused" };
		let accepted: unknown;
		try {
			accepted = this.core.snapshot.acceptSurface(
				Object.freeze({ discover: deepFreeze(discover.result), tools: deepFreeze(tools.result) }),
			);
		} catch {
			return { kind: "refused" };
		}
		return accepted === true ? { kind: "ok", names } : { kind: "refused" };
	}

	#scheduleLiveness(run: number, process: PluginProcess, endpoint: Endpoint): void {
		schedule(this.#clock, LIVENESS_INTERVAL_MS, this.#runSignal(), () => {
			void this.#liveness(run, process, endpoint);
		});
	}

	/** Every minute of uptime: neither an admitted call nor activity, and it never resets idle. */
	async #liveness(run: number, process: PluginProcess, endpoint: Endpoint): Promise<void> {
		if (this.#run !== run || process.ending) return;
		this.#scheduleLiveness(run, process, endpoint);
		const timer = schedule(this.#clock, LIVENESS_TIMEOUT_MS, this.#runSignal(), () => {
			if (this.#run === run) process.kill("liveness");
		});
		const probe = await this.#probe(endpoint);
		timer.cancel();
		if (this.#run !== run || process.ending || probe.kind === "ended") return;
		if (probe.kind === "ok") {
			this.#tools = probe.names;
			return;
		}
		if (probe.kind === "refused") {
			process.kill("surface");
			this.core.localRevoke("surface");
			return;
		}
		process.kill("liveness");
	}

	#idleCheck(): void {
		const process = this.#process;
		const quiet =
			this.#phase === "ready" &&
			this.#admitted === 0 &&
			this.#inFlight === undefined &&
			this.#leases.size === 0 &&
			process !== undefined &&
			!process.ending;
		if (!quiet) {
			this.#cancelIdle();
			return;
		}
		if (this.#idle !== undefined) return;
		const run = this.#run;
		this.#idle = schedule(this.#clock, IDLE_MS, this.#runSignal(), () => {
			this.#idle = undefined;
			if (
				this.#run === run &&
				this.#admitted === 0 &&
				this.#inFlight === undefined &&
				this.#leases.size === 0
			)
				process.stop("idle");
		});
	}

	#cancelIdle(): void {
		this.#idle?.cancel();
		this.#idle = undefined;
	}

	#binding(run: number): HostBinding | undefined {
		if (this.#run !== run) return undefined;
		const call = this.#inFlight;
		// A request written after the call's own reply belongs to no call, even in the same chunk.
		if (
			call !== undefined &&
			!call.settled &&
			(call.sent === undefined || this.#endpoint?.outstanding(call.sent) === true)
		)
			return { invocation: call.invocation, signal: call.controller.signal };
		const lease = this.#scoped;
		if (lease !== undefined && !lease.ended && lease.run === run)
			return { invocation: lease.scope, signal: lease.controller.signal };
		return undefined;
	}

	lease(ms: unknown, rawOptions: unknown): InstanceLease {
		const refusal = this.#refusalNow();
		if (refusal !== undefined) throw failure(refusal);
		if (!validLeaseMs(ms)) throw failure("LEASE_INVALID");
		const options =
			rawOptions === undefined
				? Object.create(null)
				: inertRecord(rawOptions, [], ["scope"], "LEASE_INVALID");
		const process = this.#process;
		if (this.#phase !== "ready" || process === undefined || process.ending)
			throw failure("INSTANCE_NOT_RUNNING");
		const scoped = options.scope !== undefined;
		if (scoped && this.#scoped !== undefined) throw failure("LEASE_ACTIVE");
		if (!scoped && [...this.#leases].filter((lease) => !lease.scoped).length >= MAX_UNSCOPED_LEASES)
			throw failure("LEASE_LIMIT");
		const state: LeaseState = {
			controller: new AbortController(),
			scoped,
			scope: options.scope,
			run: this.#run,
			timer: undefined,
			ended: false,
		};
		this.#leases.add(state);
		if (scoped) this.#scoped = state;
		this.#cancelIdle();
		const arm = (wait: number): void => {
			state.timer?.cancel();
			state.timer = schedule(this.#clock, wait, this.#lifetime.signal, () => this.#endLease(state));
		};
		arm(ms);
		return Object.freeze({
			signal: state.controller.signal,
			renew: (next: number): boolean => {
				if (!validLeaseMs(next)) throw failure("LEASE_INVALID");
				if (state.ended) return false;
				arm(next);
				return true;
			},
			release: (): void => this.#endLease(state),
		});
	}

	#endLease(state: LeaseState): void {
		if (state.ended) return;
		state.ended = true;
		state.timer?.cancel();
		this.#leases.delete(state);
		if (this.#scoped === state) this.#scoped = undefined;
		state.controller.abort();
		this.#idleCheck();
	}

	#startFailed(run: number, code: SupervisorErrorCode): void {
		if (this.#run !== run) return;
		this.#phase = "idle";
		this.#runLife.abort();
		for (const entry of this.#queue.filter((item) => item.run <= run)) {
			this.#queue.splice(this.#queue.indexOf(entry), 1);
			this.#settle(entry, failure(code));
		}
		this.#becameIdle();
	}

	#ended(run: number, process: PluginProcess, endpoint: Endpoint, end: ProcessEnd): void {
		endpoint.close();
		if (this.#run === run) {
			this.#runLife.abort();
			this.#phase = "idle";
		}
		if (this.#process === process) {
			this.#process = undefined;
			this.#endpoint = undefined;
		}
		const ready = this.#ready;
		this.#ready = false;
		this.#tools = new Set();
		this.#cancelIdle();
		this.#failed = false;
		for (const lease of [...this.#leases]) if (lease.run === run) this.#endLease(lease);
		const code = endCode(end, ready);
		const inFlight = this.#inFlight;
		if (inFlight !== undefined && inFlight.run === run) {
			this.#inFlight = undefined;
			inFlight.grace?.cancel();
			this.#settle(inFlight, failure(code));
		}
		// Calls never sent outlive the stop after a cancel: the next process runs them.
		const carried = end.outcome === "stopped" && end.reason === "cancel";
		for (const entry of carried ? [] : this.#queue.filter((item) => item.run <= run)) {
			this.#queue.splice(this.#queue.indexOf(entry), 1);
			this.#settle(entry, failure(code));
		}
		if (this.#refusal !== undefined) {
			this.#shutdownStats.processes++;
			if (end.cleanupFailed) this.#shutdownStats.cleanupFailures++;
		}
		if (end.outcome === "stopped") {
			this.core.emit("stopped", this.id, end.reason);
			if (end.cleanupFailed) {
				this.core.emit("crashed", this.id, "cleanup");
				this.core.crashed();
			}
		} else {
			this.core.emit("crashed", this.id, end.reason);
			this.core.crashed();
		}
		this.#becameIdle();
	}

	#becameIdle(): void {
		const blocked = this.#blocked();
		if (this.#queue.length > 0) {
			if (blocked === undefined) {
				this.#start();
				return;
			}
			for (const entry of this.#queue.splice(0)) this.#settle(entry, failure(blocked));
		}
		for (const done of this.#quiet.splice(0)) done();
	}

	#whenQuiet(): Promise<void> {
		if (this.#phase === "idle" && this.#process === undefined) return Promise.resolve();
		return new Promise((resolve) => this.#quiet.push(resolve));
	}

	/** Stops the running process, if any; it is never counted as a crash. Bounded by END_BOUND_MS. */
	stop(): Promise<void> {
		const process = this.#process;
		if (process === undefined) return Promise.resolve();
		process.stop("stop");
		return within(this.#clock, END_BOUND_MS, process.ended).then(() => undefined);
	}

	/**
	 * Revocation's synchronous half: refuse further IO, fail admitted calls, end host contexts and
	 * leases, and ask the process to stop. The promise follows the process to its bounded end.
	 */
	shutdown(code: SupervisorErrorCode, reason: StopReason): Promise<StopResult> {
		if (this.#shutdown !== undefined) return this.#shutdown;
		this.#refusal = code;
		this.#stopReason = reason;
		this.#lifetime.abort();
		const inFlight = this.#inFlight;
		this.#inFlight = undefined;
		if (inFlight !== undefined) {
			inFlight.grace?.cancel();
			this.#settle(inFlight, failure(code));
		}
		for (const entry of this.#queue.splice(0)) this.#settle(entry, failure(code));
		for (const lease of [...this.#leases]) this.#endLease(lease);
		this.#cancelIdle();
		this.#endpoint?.close();
		this.#process?.stop(reason);
		this.#shutdown = this.#whenQuiet().then(() => Object.freeze({ ...this.#shutdownStats }));
		return this.#shutdown;
	}

	/**
	 * Revokes this instance for good; resolves within END_BOUND_MS, counting a process that outlives
	 * it as a cleanup failure. The id stays retired until its process has really ended.
	 */
	retire(): Promise<StopResult> {
		const pending = this.shutdown("INSTANCE_RETIRED", "retire");
		void pending.then(() => this.core.released(this));
		return boundedStop(this.#clock, pending);
	}
}

/**
 * The capability for one supervised plugin instance. Only the supervisor mints it; its identity is
 * read-only, and every byte to the plugin goes through it and the merged framing. It holds no
 * child process, stream, descriptor or pid, and it is revoked with its instance or activation.
 */
export class SupervisedProcess {
	readonly #instance: Instance;

	constructor(token: unknown, instance: unknown) {
		if (token !== MINT || !(instance instanceof Instance))
			throw new TypeError("Supervised processes are minted by the plugin supervisor only");
		this.#instance = instance;
		Object.freeze(this);
	}

	get pluginId(): string {
		return this.#instance.core.snapshot.pluginId;
	}

	get generation(): string {
		return this.#instance.core.snapshot.generation;
	}

	get instanceId(): string {
		return this.#instance.id;
	}

	get kind(): PluginKind {
		return this.#instance.core.snapshot.kind;
	}

	/** The caller-supplied authority, configuration and credential epoch it was activated under. */
	get epoch(): string {
		return this.#instance.core.epoch;
	}

	get revoked(): boolean {
		return this.#instance.revoked;
	}

	/** Aborts when this handle is revoked: retire, activation revoke, epoch change or close. */
	get signal(): AbortSignal {
		return this.#instance.signal;
	}

	callTool(name: string, args: unknown, options?: CallToolOptions): Promise<unknown> {
		return this.#instance.callTool(name, args, options);
	}

	lease(ms: number, options?: LeaseOptions): InstanceLease {
		return this.#instance.lease(ms, options);
	}

	/** Stops the running process (bounded); the next call starts a new one after a full re-verify. */
	stop(): Promise<void> {
		return this.#instance.stop();
	}

	/**
	 * Revokes this handle for good (bounded). Once its process has ended, a later instance() call
	 * for the same id mints a new one.
	 */
	retire(): Promise<StopResult> {
		return this.#instance.retire();
	}
}
Object.freeze(SupervisedProcess.prototype);
Object.freeze(SupervisedProcess);
