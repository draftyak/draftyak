export { ExtensionError, type ExtensionErrorCode } from "./errors.ts";
export type { SendPolicyDecision } from "./policy.ts";
export {
	type ExtensionHost,
	type ExtensionLogEntry,
	type ExtensionModuleInfo,
	type ExtensionStartOptions,
	type ProviderService,
	type RegisteredProvider,
	startExtensions,
} from "./registry.ts";
