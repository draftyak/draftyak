import { Ulid } from "@draftyak/protocol/scalars";
import { PluginSupervisorError, type SupervisorErrorCode } from "./errors.ts";
import type { EpochSnapshot, GenerationSnapshot, PluginKind } from "./generation.ts";
import {
	type ActivationCore,
	boundedStop,
	Instance,
	type StopResult,
	type SupervisedProcess,
	type SupervisorContext,
} from "./instance.ts";
import {
	type ActivationRevokeReason,
	CrashWindow,
	type LocalRevokeReason,
	type PluginEventType,
	type StopReason,
	type SupervisorEvent,
	type SupervisorEventReason,
} from "./policy.ts";

export interface RevokeResult {
	readonly processes: number;
	readonly cleanupFailures: number;
}

/** One reviewed generation, live until revoked. It holds no authority of its own. */
export interface PluginActivation {
	readonly pluginId: string;
	readonly generation: string;
	readonly kind: PluginKind;
	readonly epoch: string;
	readonly revoked: boolean;
	/** The same handle per id while it is live; no process starts until the first call. */
	instance(instanceId: string): SupervisedProcess;
	/** Synchronously refuses further IO; resolves once every process ended (bounded). Idempotent. */
	revoke(reason: ActivationRevokeReason): Promise<RevokeResult>;
}

export interface ActivationHost {
	readonly context: SupervisorContext;
	closed(): boolean;
	emit(event: SupervisorEvent): void;
	/** Frees the plugin id for a new activation. */
	release(activation: Activation): void;
	/** Records a handle this activation minted into its own instance map. */
	minted(handle: SupervisedProcess, activation: Activation, instance: Instance): void;
}

export class Activation implements ActivationCore {
	readonly snapshot: GenerationSnapshot;
	readonly entry: string;
	readonly epoch: string;
	readonly context: SupervisorContext;
	readonly facade: PluginActivation;
	readonly #host: ActivationHost;
	readonly #instances = new Map<string, Instance>();
	readonly #crashes = new CrashWindow();
	readonly #epochSignal: AbortSignal;
	readonly #onEpoch = (): void => this.localRevoke("epoch");
	#revoked: { readonly code: SupervisorErrorCode; promise: Promise<RevokeResult> } | undefined;

	constructor(
		snapshot: GenerationSnapshot,
		entry: string,
		epoch: EpochSnapshot,
		host: ActivationHost,
	) {
		this.snapshot = snapshot;
		this.entry = entry;
		this.epoch = epoch.id;
		this.context = host.context;
		this.#host = host;
		const activation = this;
		this.facade = Object.freeze({
			pluginId: snapshot.pluginId,
			generation: snapshot.generation,
			kind: snapshot.kind,
			epoch: epoch.id,
			get revoked(): boolean {
				return activation.refusal() !== undefined;
			},
			instance: (instanceId: string): SupervisedProcess => this.instance(instanceId),
			revoke: (reason: ActivationRevokeReason): Promise<RevokeResult> => this.revoke(reason),
		});
		// The caller's authority, configuration or credential epoch ended: so does every handle.
		this.#epochSignal = epoch.signal;
		this.#epochSignal.addEventListener("abort", this.#onEpoch, { once: true });
	}

	refusal(): SupervisorErrorCode | undefined {
		if (this.#revoked !== undefined) return this.#revoked.code;
		return this.#host.closed() ? "SUPERVISOR_CLOSED" : undefined;
	}

	/** True only for the instance this activation created for that id and still keeps. */
	holds(instance: Instance): boolean {
		return this.#instances.get(instance.id) === instance;
	}

	instance(instanceId: unknown): SupervisedProcess {
		const refusal = this.refusal();
		if (refusal !== undefined) throw new PluginSupervisorError(refusal);
		if (typeof instanceId !== "string" || !Ulid.safeParse(instanceId).success)
			throw new PluginSupervisorError("INSTANCE_INVALID");
		const existing = this.#instances.get(instanceId);
		if (existing !== undefined) {
			if (existing.retiring) throw new PluginSupervisorError("INSTANCE_RETIRED");
			return existing.handle;
		}
		const created = new Instance(this, instanceId);
		this.#instances.set(instanceId, created);
		this.#host.minted(created.handle, this, created);
		return created.handle;
	}

	revoke(
		reason: ActivationRevokeReason | LocalRevokeReason,
		stop: StopReason = "revoke",
	): Promise<RevokeResult> {
		if (this.#revoked !== undefined) return this.#revoked.promise;
		const code = reason === "crash-limit" ? "PLUGIN_DISABLED" : "ACTIVATION_REVOKED";
		const state: { code: SupervisorErrorCode; promise: Promise<RevokeResult> } = {
			code,
			promise: Promise.resolve({ processes: 0, cleanupFailures: 0 }),
		};
		this.#revoked = state;
		this.#epochSignal.removeEventListener("abort", this.#onEpoch);
		this.#host.release(this);
		const waits = [...this.#instances.values()].map((instance) => instance.shutdown(code, stop));
		state.promise = this.#settle(waits);
		return state.promise;
	}

	async #settle(waits: readonly Promise<StopResult>[]): Promise<RevokeResult> {
		const results = await Promise.all(waits.map((wait) => boundedStop(this.context.clock, wait)));
		return Object.freeze({
			processes: results.reduce((sum, result) => sum + result.processes, 0),
			cleanupFailures: results.reduce((sum, result) => sum + result.cleanupFailures, 0),
		});
	}

	/** Crash-limit, surface, bundle or epoch: the same as revoke, reported for the registry to act on. */
	localRevoke(reason: LocalRevokeReason): void {
		if (this.#revoked !== undefined) return;
		void this.revoke(reason);
		if (reason === "crash-limit") this.emit("disabled", undefined, reason);
		this.emit("revoked", undefined, reason);
	}

	crashed(): void {
		if (this.#revoked !== undefined) return;
		if (this.#crashes.record(this.context.clock.monotonicMs())) this.localRevoke("crash-limit");
	}

	emit(
		type: PluginEventType,
		instanceId: string | undefined,
		reason?: SupervisorEventReason,
	): void {
		this.#host.emit(
			Object.freeze({
				type,
				pluginId: this.snapshot.pluginId,
				generation: this.snapshot.generation,
				...(instanceId === undefined ? {} : { instanceId }),
				...(reason === undefined ? {} : { reason }),
			}),
		);
	}

	released(instance: Instance): void {
		if (this.#instances.get(instance.id) === instance) this.#instances.delete(instance.id);
	}
}
