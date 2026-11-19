import type { BundledPluginId, InstalledPlugin } from "../installer/index.ts";
import type { PluginRecordState } from "./index.ts";

export interface PluginCandidatePrior {
	readonly versionId: string;
	readonly version: string;
	readonly registryGeneration: number;
	readonly state: PluginRecordState;
}

/** Immutable installed DATA and a selection basis, never a reviewed or runnable issuer. */
export interface PluginCandidateRecord {
	readonly id: string;
	readonly registryId: string;
	readonly versionId: string;
	readonly pluginId: BundledPluginId;
	readonly version: string;
	readonly ownerUserId: string;
	readonly epoch: number;
	readonly expectedGeneration: number;
	readonly from: PluginCandidatePrior | null;
	readonly installed: InstalledPlugin;
}
