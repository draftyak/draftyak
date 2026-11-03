import { HOST_ERROR_CODES, type HostErrorCode } from "@draftyak/protocol/host-channel";

/** A closed vocabulary: a refusal never carries a path, argument, plugin output or handler text. */
export type SupervisorErrorCode =
	| "SUPERVISOR_CLOSED"
	| "CONFIG_INVALID"
	| "RUNTIME_UNSUPPORTED"
	| "GENERATION_INVALID"
	| "EPOCH_INVALID"
	| "ACTIVATION_CONFLICT"
	| "ACTIVATION_REVOKED"
	| "PLUGIN_DISABLED"
	| "INSTANCE_INVALID"
	| "INSTANCE_RETIRED"
	| "INSTANCE_FAILED"
	| "INSTANCE_NOT_RUNNING"
	| "BUNDLE_REFUSED"
	| "DATA_DIR_REFUSED"
	| "SPAWN_FAILED"
	| "START_TIMEOUT"
	| "START_FAILED"
	| "TOOL_UNKNOWN"
	| "REQUEST_INVALID"
	| "FRAME_TOO_LARGE"
	| "CALL_LIMIT"
	| "CALL_TIMEOUT"
	| "CALL_CANCELLED"
	| "PLUGIN_BUSY"
	| "PLUGIN_RPC_ERROR"
	| "PLUGIN_EXITED"
	| "PLUGIN_VIOLATION"
	| "HOST_CONTEXT_ENDED"
	| "LEASE_INVALID"
	| "LEASE_ACTIVE"
	| "LEASE_LIMIT";

export class PluginSupervisorError extends Error {
	readonly code: SupervisorErrorCode;
	/** The plugin's integer JSON-RPC error code for PLUGIN_RPC_ERROR; never its message or data. */
	readonly rpcCode: number | undefined;

	constructor(code: SupervisorErrorCode, rpcCode?: number) {
		super("Plugin supervisor refused.");
		this.name = "PluginSupervisorError";
		this.code = code;
		this.rpcCode = code === "PLUGIN_RPC_ERROR" ? rpcCode : undefined;
	}
}

const refusals = new WeakMap<object, HostErrorCode>();

/** A host handler throws this to answer the plugin with one fixed host error code. */
export class PluginHostRefusal extends Error {
	readonly code: HostErrorCode;

	constructor(code: HostErrorCode) {
		if (!HOST_ERROR_CODES.includes(code)) throw new TypeError("Unknown host error code");
		super("Host request refused.");
		this.name = "PluginHostRefusal";
		this.code = code;
		refusals.set(this, code);
	}
}

/** The code recorded at construction; anything else, including a lookalike, is DENIED. */
export function refusalCode(error: unknown): HostErrorCode {
	return (error !== null && typeof error === "object" && refusals.get(error)) || "DENIED";
}

export function refuse(code: SupervisorErrorCode): never {
	throw new PluginSupervisorError(code);
}
