import { lstatSync } from "node:fs";
import path from "node:path";
import { isPromise, isProxy } from "node:util/types";
import type { HostMethod } from "@draftyak/protocol/host-channel";
import { canonicalDirectory } from "../../artifacts/index.ts";
import { systemClock, type TimerClock } from "../../kernel/clock.ts";
import { Activation, type PluginActivation } from "./activation.ts";
import type { PluginHostHandler, PluginHostRequestContext } from "./channel.ts";
import { PluginSupervisorError, refuse } from "./errors.ts";
import {
	type ActivationOptions,
	inertRecord,
	type ReviewedGeneration,
	snapshotActivationOptions,
	snapshotGeneration,
} from "./generation.ts";
import type { Instance, SupervisedProcess, SupervisorContext } from "./instance.ts";
import { activationEntry, disjoint, GRANT_UNSAFE, launchArgv } from "./launch.ts";
import { createSampler, Watchdog } from "./memory.ts";
import type { SupervisorEvent } from "./policy.ts";
import { checkRuntime, currentRuntime, type SupervisedPlatform } from "./runtime.ts";

export type { PluginActivation, RevokeResult } from "./activation.ts";
export type {
	PluginHostHandler,
	PluginHostRequestContext,
	ProgressListener,
	ProgressUpdate,
} from "./channel.ts";
export { PluginHostRefusal, PluginSupervisorError, type SupervisorErrorCode } from "./errors.ts";
export type {
	ActivationEpoch,
	ActivationOptions,
	PluginKind,
	PluginSurface,
	ReviewedGeneration,
} from "./generation.ts";
export type {
	CallToolOptions,
	InstanceLease,
	LeaseOptions,
	StopResult,
	SupervisedProcess,
} from "./instance.ts";
export * from "./policy.ts";

export interface PluginSupervisorOptions {
	/** Hub-owned folder for per-instance data, e.g. <data>/plugin-data; never chmodded here. */
	readonly dataRoot: string;
	/** Hub-owned folder the POSIX stdio FIFOs are made in, e.g. <data>/run. */
	readonly stdioRoot: string;
	readonly host: PluginHostHandler;
	readonly clock?: TimerClock;
	/** Content-free records; a throwing or async listener never affects supervision. */
	readonly onEvent?: (event: SupervisorEvent) => void;
}

export interface CloseResult {
	readonly cleanupFailures: number;
}

export interface PluginSupervisor {
	/**
	 * Admits one reviewed generation per plugin id at a time. The epoch names the caller's current
	 * authority, configuration and credential state; aborting its signal revokes the activation.
	 */
	activate(generation: ReviewedGeneration, options: ActivationOptions): Promise<PluginActivation>;
	/** Marks the supervisor closed at once, revokes everything and ends every process. Idempotent. */
	close(): Promise<CloseResult>;
	readonly closed: boolean;
}

/** What a consumer expects a supervised process to be; omitted fields are not compared. */
export interface SupervisedProcessExpectation {
	readonly pluginId: string;
	readonly generation: string;
	readonly instanceId?: string;
	readonly epoch?: string;
}

/**
 * Every handle an activation of createPluginSupervisor minted into its own instance map. Private to
 * this module: a handle made any other way, even around a real activation, is never in it.
 */
const supervised = new WeakMap<
	object,
	{ readonly core: Activation; readonly instance: Instance }
>();

/**
 * True only for a live handle this module's supervisors minted, for the expected generation (and
 * instance and epoch, when given). Structural copies, subclasses, proxies and revoked or retired
 * handles are refused. Never throws and never calls into the value.
 */
export function isSupervisedProcess(
	value: unknown,
	expected: SupervisedProcessExpectation,
): value is SupervisedProcess {
	const minted = value !== null && typeof value === "object" ? supervised.get(value) : undefined;
	if (minted === undefined || minted.instance.revoked) return false;
	const { core: activation, instance } = minted;
	let wanted: Record<string, unknown>;
	try {
		wanted = inertRecord(
			expected,
			["pluginId", "generation"],
			["instanceId", "epoch"],
			"REQUEST_INVALID",
		);
	} catch {
		return false;
	}
	const snapshot = activation.snapshot;
	return (
		typeof wanted.pluginId === "string" &&
		typeof wanted.generation === "string" &&
		snapshot.pluginId === wanted.pluginId &&
		snapshot.generation === wanted.generation &&
		(wanted.instanceId === undefined || wanted.instanceId === instance.id) &&
		(wanted.epoch === undefined || wanted.epoch === activation.epoch)
	);
}

async function hubFolder(raw: unknown, platform: SupervisedPlatform): Promise<string> {
	let folder: string;
	try {
		folder = await canonicalDirectory(raw);
	} catch {
		return refuse("CONFIG_INVALID");
	}
	if (GRANT_UNSAFE.test(folder)) return refuse("CONFIG_INVALID");
	if (platform !== "win32") {
		let owned = false;
		try {
			const stat = lstatSync(folder);
			owned = stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;
		} catch {
			owned = false;
		}
		if (!owned) return refuse("CONFIG_INVALID");
	}
	return folder;
}

function checkedClock(raw: unknown): TimerClock {
	if (raw === undefined) return systemClock;
	if (raw === null || typeof raw !== "object" || isProxy(raw)) return refuse("CONFIG_INVALID");
	const clock = raw as TimerClock;
	if (typeof clock.after !== "function" || typeof clock.monotonicMs !== "function")
		return refuse("CONFIG_INVALID");
	return clock;
}

/**
 * The low-level plugin supervisor. It imports no registry, vault or broker: a reviewed generation
 * enters through activate(), host requests leave through the injected handler.
 */
export async function createPluginSupervisor(
	options: PluginSupervisorOptions,
): Promise<PluginSupervisor> {
	const input = inertRecord(
		options,
		["dataRoot", "stdioRoot", "host"],
		["clock", "onEvent"],
		"CONFIG_INVALID",
	);
	const host = input.host;
	if (host === null || typeof host !== "object" || isProxy(host)) return refuse("CONFIG_INVALID");
	let request: unknown;
	try {
		request = (host as PluginHostHandler).request;
	} catch {
		return refuse("CONFIG_INVALID");
	}
	if (typeof request !== "function") return refuse("CONFIG_INVALID");
	const clock = checkedClock(input.clock);
	const onEvent = input.onEvent;
	if (onEvent !== undefined && typeof onEvent !== "function") return refuse("CONFIG_INVALID");
	const runtime = checkRuntime(currentRuntime());
	const dataRoot = await hubFolder(input.dataRoot, runtime.platform);
	const stdioRoot = await hubFolder(input.stdioRoot, runtime.platform);
	if (!disjoint(dataRoot, stdioRoot, runtime.platform)) return refuse("CONFIG_INVALID");

	let closed = false;
	let closing: Promise<CloseResult> | undefined;
	const byPlugin = new Map<string, object>();
	const activations = new Set<Activation>();
	const emit = (event: SupervisorEvent): void => {
		try {
			const returned: unknown = (onEvent as ((event: SupervisorEvent) => unknown) | undefined)?.(
				event,
			);
			if (isPromise(returned)) Promise.prototype.then.call(returned, undefined, () => {});
		} catch {
			/* A listener never affects supervision. */
		}
	};
	const watchdog = new Watchdog(clock, () =>
		createSampler(runtime.platform, runtime.systemRoot, clock, () =>
			emit(Object.freeze({ type: "memory-reader-fallback" })),
		),
	);
	const context: SupervisorContext = Object.freeze({
		runtime,
		dataRoot,
		stdioRoot,
		clock,
		watchdog,
		parentEnv: process.env,
		dispatch: (method: HostMethod, params: unknown, request_: PluginHostRequestContext) =>
			Reflect.apply(request as PluginHostHandler["request"], host, [method, params, request_]),
	});
	const activationHost = Object.freeze({
		context,
		closed: () => closed,
		emit,
		release: (activation: Activation) => {
			if (byPlugin.get(activation.snapshot.pluginId) === activation)
				byPlugin.delete(activation.snapshot.pluginId);
			activations.delete(activation);
		},
		minted: (handle: SupervisedProcess, core: Activation, instance: Instance) => {
			supervised.set(handle, Object.freeze({ core, instance }));
		},
	});

	async function activate(raw: unknown, rawOptions: unknown): Promise<PluginActivation> {
		if (closed) refuse("SUPERVISOR_CLOSED");
		const snapshot = snapshotGeneration(raw);
		const epoch = snapshotActivationOptions(rawOptions);
		// One live or pending activation per plugin id: concurrent and stale activation both refuse.
		if (byPlugin.has(snapshot.pluginId)) refuse("ACTIVATION_CONFLICT");
		const reservation = {};
		byPlugin.set(snapshot.pluginId, reservation);
		try {
			const directory = snapshot.bundle.directory;
			if (
				typeof directory !== "string" ||
				!path.isAbsolute(directory) ||
				GRANT_UNSAFE.test(directory) ||
				!disjoint(directory, dataRoot, runtime.platform) ||
				!disjoint(directory, stdioRoot, runtime.platform)
			)
				refuse("BUNDLE_REFUSED");
			const entry = await activationEntry(snapshot.bundle);
			launchArgv(directory, entry, undefined, "BUNDLE_REFUSED");
			if (closed) refuse("SUPERVISOR_CLOSED");
			if (epoch.signal.aborted) refuse("EPOCH_INVALID");
			const activation = new Activation(snapshot, entry, epoch, activationHost);
			byPlugin.set(snapshot.pluginId, activation);
			activations.add(activation);
			return activation.facade;
		} catch (error) {
			if (byPlugin.get(snapshot.pluginId) === reservation) byPlugin.delete(snapshot.pluginId);
			throw error instanceof PluginSupervisorError
				? error
				: new PluginSupervisorError("BUNDLE_REFUSED");
		}
	}

	function close(): Promise<CloseResult> {
		if (closing !== undefined) return closing;
		closed = true;
		const revokes = [...activations].map((activation) => activation.revoke("shutdown", "close"));
		closing = Promise.all(revokes).then((results) => {
			watchdog.close();
			return Object.freeze({
				cleanupFailures: results.reduce((sum, result) => sum + result.cleanupFailures, 0),
			});
		});
		return closing;
	}

	return Object.freeze({
		activate: (generation: ReviewedGeneration, activationOptions: ActivationOptions) =>
			activate(generation, activationOptions),
		close,
		get closed(): boolean {
			return closed;
		},
	});
}
