import type { DataClass } from "@draftyak/protocol/data-class";
import type { Sha256Hex, Ulid, UtcMs } from "@draftyak/protocol/scalars";

/** Catalogue metadata for already sealed state, not a backup-file or restore wire format. */
export interface BackupManifest {
	readonly name: string;
	readonly createdAt: UtcMs;
	readonly accounts: readonly Ulid[];
	readonly dataClasses: readonly DataClass[];
	readonly sha256: Sha256Hex;
	readonly bytes: number;
}

export interface BackupTarget {
	readonly id: string;
	/** The hub must enforce these exclusions before giving the target any sealed bytes. */
	readonly refuses: readonly DataClass[];
	put(name: string, sealed: AsyncIterable<Uint8Array>, manifest: BackupManifest): Promise<void>;
	list(): Promise<readonly BackupManifest[]>;
	get(name: string): AsyncIterable<Uint8Array>;
	delete(name: string): Promise<void>;
}
