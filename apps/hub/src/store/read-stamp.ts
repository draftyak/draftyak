import type { SqlReader } from "./store.ts";

export interface ReadStamp {
	readonly owner: object;
	readonly revision: number;
	readonly dataVersion: number;
	readonly totalChanges: number;
	readonly schemaVersion: number;
}
const readers = new WeakMap<SqlReader, () => ReadStamp>();

// Only the native facade registers a live reader; arbitrary readers cannot reuse a checkpoint.
export const bindReadStamp = (reader: SqlReader, read: () => ReadStamp): void => {
	readers.set(reader, read);
};
export const releaseReadStamp = (reader: SqlReader): void => {
	readers.delete(reader);
};
export const readStamp = (reader: SqlReader): ReadStamp | undefined => readers.get(reader)?.();
export const sameReadStamp = (left: ReadStamp | undefined, right: ReadStamp | undefined): boolean =>
	left !== undefined &&
	right !== undefined &&
	left.owner === right.owner &&
	left.revision === right.revision &&
	left.dataVersion === right.dataVersion &&
	left.totalChanges === right.totalChanges &&
	left.schemaVersion === right.schemaVersion;
