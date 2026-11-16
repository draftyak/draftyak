import { UtcMs } from "@draftyak/protocol/scalars";
import {
	copyHistoryData,
	historyDecimal,
	historyLabels,
	historyProviderId,
	historyRecord,
	invalidHistory,
} from "./history/page.ts";

/** Detached provider DATA only; this carries no account, source or body authority. */
export interface GmailMetadata {
	readonly providerId: string;
	readonly threadId: string;
	readonly labelIds: readonly string[];
	readonly internalDate?: number;
	readonly sizeBytes?: number;
	readonly historyId?: string;
}

function date(value: unknown): number {
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,15})$/.test(value)) invalidHistory();
	const result = UtcMs.safeParse(Number(value));
	if (!result.success) invalidHistory();
	return result.data;
}

/** Shared metadata decoding for history hydration and fixed message reads. */
export function decodeGmailMetadata(value: unknown): GmailMetadata {
	const data = historyRecord(copyHistoryData(value));
	const providerId = historyProviderId(data.id);
	const threadId = historyProviderId(data.threadId);
	const labelIds = Object.freeze(historyLabels(data.labelIds));
	const internalDate = data.internalDate === undefined ? undefined : date(data.internalDate);
	const historyId = data.historyId === undefined ? undefined : historyDecimal(data.historyId);
	const sizeBytes = data.sizeEstimate;
	if (
		sizeBytes !== undefined &&
		(typeof sizeBytes !== "number" || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
	)
		invalidHistory();
	return Object.freeze({
		providerId,
		threadId,
		labelIds,
		...(internalDate === undefined ? {} : { internalDate }),
		...(historyId === undefined ? {} : { historyId }),
		...(sizeBytes === undefined ? {} : { sizeBytes }),
	});
}
