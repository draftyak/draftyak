import type { AuditChain } from "../audit/chain.ts";
import type { EventLog } from "../events/log.ts";
import type { DeviceRegistry } from "../identity/devices.ts";
import { closeNativeAppAdmission } from "../installer/native-app-admission.ts";
import type { WorkDatabase } from "../jobs/database.ts";
import type { Clock } from "../kernel/clock.ts";
import { type BundledPluginPin, closeNativePluginInstaller } from "../plugins/installer/index.ts";
import { closeNativePluginRegistry } from "../plugins/registry/index.ts";
import type { HubStore } from "../store/store.ts";
import { nativePluginSession } from "./session.ts";

/** Captures from the original constructing factory, never a caller-issued ownership proof. */
export interface NativePluginSessionParts {
	readonly store: HubStore;
	readonly database: WorkDatabase;
	readonly devices: DeviceRegistry;
	readonly audit: AuditChain;
	readonly events: EventLog;
	readonly directory: string;
	readonly nativeBinding: string;
	readonly bundles: readonly BundledPluginPin[];
	readonly clock: Clock;
}

/** The original session module alone can issue an entry in its private owner map. */
export function nativePluginInputs(
	session: unknown,
	phase: "open" | "held" = "open",
): NativePluginSessionParts {
	return nativePluginSession(session, phase);
}

export function assertNativePluginOwner(
	session: unknown,
	parts: NativePluginSessionParts,
	phase: "open" | "held" = "open",
): void {
	if (nativePluginSession(session, phase) !== parts)
		throw new Error("Native plugin session unavailable");
}

/** Starts all real closes immediately, including resources opened directly by internal consumers. */
export async function drainNativePlugins(session: unknown): Promise<void> {
	const results = await Promise.allSettled([
		closeNativePluginRegistry(session),
		closeNativePluginInstaller(session),
		closeNativeAppAdmission(session),
	]);
	if (results.some((result) => result.status === "rejected"))
		throw new Error("Native plugin drain incomplete");
}
