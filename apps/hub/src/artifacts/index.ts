/** A pinned package identity, distinct from permission to install or execute it. */
export interface PackageLock {
	readonly name: string;
	readonly version: string;
	readonly integrity: string;
	readonly entry: string;
}

export interface FileDigest {
	readonly path: string;
	readonly bytes: number;
	readonly sha256: string;
}

export type BundleInventory = PackageLock & {
	readonly files: readonly FileDigest[];
};

export interface InstalledBundle {
	readonly directory: string;
	readonly inventory: BundleInventory;
}

/** Owned buffers remain mutable; materialized files require independent verification. */
export interface PreparedPackage {
	readonly inventory: BundleInventory;
	readonly files: ReadonlyMap<string, Buffer>;
	readonly metadata: Readonly<Record<string, unknown>>;
}

export { canonicalDirectory, verifyBundle, verifyBundleFile } from "./inventory.ts";
export { preparePinnedPackage } from "./pin.ts";
