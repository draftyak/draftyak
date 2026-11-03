export interface MetadataAccountRef {
	readonly accountId: string;
	readonly generation: number;
	readonly pluginInstanceId: string;
	readonly ownerEpoch: number;
	readonly mode: "full" | "read_only";
}
