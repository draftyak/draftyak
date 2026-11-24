import {
	type PluginChange as Change,
	MAX_CHANGES,
	PluginChange,
} from "@draftyak/protocol/normalized-change";
import { decodeGmailMetadata } from "../decode.ts";
import {
	copyHistoryData,
	decodeHistoryPage,
	GmailHistoryError,
	type HistoryOptions,
	historyDecimal,
	historyRecord,
	invalidHistory,
} from "./page.ts";

export interface HistoryReduction {
	readonly changes: readonly Change[];
	readonly historyId: string;
	readonly nextPageToken: string | null;
	readonly more: boolean;
}

/** Bounded provider DATA only; raw bodies, direction, account and source authority are absent. */
export function reduceHistoryPage(
	wire: unknown,
	metadata: unknown,
	options: HistoryOptions,
): HistoryReduction {
	try {
		// One shared cap covers all three caller inputs before any field is interpreted.
		const input = historyRecord(copyHistoryData({ wire, metadata, options }));
		const plan = decodeHistoryPage(input.wire, input.options as unknown as HistoryOptions);
		if (!Array.isArray(input.metadata) || input.metadata.length > MAX_CHANGES) invalidHistory();
		const needed = new Map(
			plan.entries
				.filter((entry) => entry.kind !== "deleted")
				.map((entry) => [entry.providerId, entry]),
		);
		const found = new Map<
			string,
			{ threadId: string; labels: readonly string[]; internalDate?: number; sizeBytes?: number }
		>();
		for (const item of input.metadata) {
			const data = decodeGmailMetadata(item);
			const id = data.providerId,
				threadId = data.threadId;
			const entry = needed.get(id);
			if (!entry || found.has(id) || threadId !== entry.threadId) invalidHistory();
			const labels = data.labelIds;
			const internalDate = data.internalDate;
			if (entry.kind === "message" && internalDate === undefined) invalidHistory();
			if (
				data.historyId !== undefined &&
				BigInt(historyDecimal(data.historyId)) < BigInt(entry.historyId)
			)
				invalidHistory();
			const sizeBytes = data.sizeBytes;
			found.set(id, {
				threadId,
				labels,
				...(internalDate === undefined ? {} : { internalDate }),
				...(sizeBytes === undefined ? {} : { sizeBytes }),
			});
		}
		if (found.size !== needed.size) invalidHistory();
		const changes: Change[] = [];
		for (const entry of plan.entries) {
			let value: unknown;
			if (entry.kind === "deleted") value = { kind: "email.deleted", providerId: entry.providerId };
			else {
				const message = found.get(entry.providerId);
				if (!message) invalidHistory();
				value =
					entry.kind === "message"
						? {
								kind: "email.message",
								providerId: entry.providerId,
								threadId: message.threadId,
								internalDate: message.internalDate,
								labelIds: message.labels,
								...(message.sizeBytes === undefined ? {} : { sizeBytes: message.sizeBytes }),
							}
						: {
								kind: "email.labels",
								providerId: entry.providerId,
								threadId: message.threadId,
								labelIds: message.labels,
							};
			}
			const parsed = PluginChange.safeParse(value);
			if (!parsed.success) invalidHistory();
			if (parsed.data.kind === "email.message" || parsed.data.kind === "email.labels")
				Object.freeze(parsed.data.labelIds);
			changes.push(Object.freeze(parsed.data));
		}
		return Object.freeze({
			changes: Object.freeze(changes),
			historyId: plan.historyId,
			nextPageToken: plan.nextPageToken,
			more: plan.more,
		});
	} catch {
		throw new GmailHistoryError();
	}
}
