import { types } from "node:util";
import type { Ulid } from "@draftyak/protocol/scalars";
import { fields, id, integer, WorkError } from "../jobs/values.ts";

/** Captured selection DATA; no registry, scope or enrollment authority. */
export interface AccountConnectSelectionData {
	readonly pluginInstanceId: Ulid;
	readonly ownerUserId: Ulid;
	readonly ownerEpoch: number;
	readonly registryId: Ulid;
	readonly versionId: Ulid;
	readonly selectedGeneration: number;
	readonly operationId: Ulid;
}

const selectionFields = [
	"pluginInstanceId",
	"ownerUserId",
	"ownerEpoch",
	"registryId",
	"versionId",
	"selectedGeneration",
	"operationId",
] as const;

/** Own only the seven scalar values; reject hooks before inspecting descriptors. */
export function captureAccountConnectSelection(raw: unknown): AccountConnectSelectionData {
	if (raw === null || typeof raw !== "object" || types.isProxy(raw)) throw new WorkError("input");
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== Object.prototype && prototype !== null) throw new WorkError("input");
	const selected = fields(raw, selectionFields);
	return Object.freeze({
		pluginInstanceId: id(selected.pluginInstanceId),
		ownerUserId: id(selected.ownerUserId),
		ownerEpoch: integer(selected.ownerEpoch),
		registryId: id(selected.registryId),
		versionId: id(selected.versionId),
		selectedGeneration: integer(selected.selectedGeneration, 1),
		operationId: id(selected.operationId),
	});
}
