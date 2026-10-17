import { type Gmail, GmailError } from "./api.ts";
import { countsAsSent } from "./reconcile.ts";

// history.list from a stored historyId (plan §3 Sync engine: every 30 s; a 404 means resync).

export const HISTORY_TYPES = [
	"messageAdded",
	"messageDeleted",
	"labelAdded",
	"labelRemoved",
] as const;
export type HistoryType = (typeof HISTORY_TYPES)[number];

export interface HistoryMessage {
	readonly id: string;
	readonly threadId: string;
	readonly labelIds?: readonly string[];
}

export interface LabelChange extends HistoryMessage {
	readonly changed: readonly string[];
}

interface HistoryRecord {
	readonly id: string;
	readonly messagesAdded?: readonly { readonly message: HistoryMessage }[];
	readonly messagesDeleted?: readonly { readonly message: HistoryMessage }[];
	readonly labelsAdded?: readonly {
		readonly message: HistoryMessage;
		readonly labelIds: readonly string[];
	}[];
	readonly labelsRemoved?: readonly {
		readonly message: HistoryMessage;
		readonly labelIds: readonly string[];
	}[];
}

interface HistoryPage {
	readonly history?: readonly HistoryRecord[];
	readonly nextPageToken?: string;
	readonly historyId: string;
}

export interface HistoryDelta {
	// Store it only once nextPageToken is absent: it is the start point for the next read.
	readonly historyId: string;
	readonly added: readonly HistoryMessage[];
	readonly deleted: readonly string[];
	readonly labelsAdded: readonly LabelChange[];
	readonly labelsRemoved: readonly LabelChange[];
	readonly nextPageToken?: string;
}

export type HistoryResult =
	| { readonly expired: false; readonly delta: HistoryDelta }
	| { readonly expired: true };

export interface HistoryOptions {
	readonly historyTypes?: readonly HistoryType[];
	readonly labelId?: string;
	readonly maxPages?: number;
	readonly pageToken?: string;
}

const change = (entry: { message: HistoryMessage; labelIds: readonly string[] }): LabelChange => ({
	...entry.message,
	changed: entry.labelIds,
});

export async function readHistory(
	gmail: Gmail,
	startHistoryId: string,
	options: HistoryOptions = {},
): Promise<HistoryResult> {
	const added: HistoryMessage[] = [];
	const deleted: string[] = [];
	const labelsAdded: LabelChange[] = [];
	const labelsRemoved: LabelChange[] = [];
	let pageToken = options.pageToken;
	let historyId = startHistoryId;
	for (let page = 0; page < (options.maxPages ?? 10); page++) {
		let response: HistoryPage;
		try {
			response = (await gmail.call("GET", "gmail/v1/users/me/history", {
				query: {
					startHistoryId,
					historyTypes: options.historyTypes,
					labelId: options.labelId,
					maxResults: 500,
					pageToken,
				},
			})) as HistoryPage;
		} catch (error) {
			if (error instanceof GmailError && error.status === 404) return { expired: true };
			throw error;
		}
		historyId = response.historyId;
		for (const record of response.history ?? []) {
			for (const { message } of record.messagesAdded ?? []) added.push(message);
			for (const { message } of record.messagesDeleted ?? []) deleted.push(message.id);
			for (const entry of record.labelsAdded ?? []) labelsAdded.push(change(entry));
			for (const entry of record.labelsRemoved ?? []) labelsRemoved.push(change(entry));
		}
		pageToken = response.nextPageToken;
		if (pageToken === undefined) break;
	}
	const delta = { historyId, added, deleted, labelsAdded, labelsRemoved };
	return {
		expired: false,
		delta: pageToken === undefined ? delta : { ...delta, nextPageToken: pageToken },
	};
}

// Messages that start counting as sent in this delta: added as sent, given SENT, or relieved of
// SCHEDULED or DRAFT (a Gmail-UI scheduled mail going out, whichever way Gmail relabels it).
// Scheduled ones never count before that.
export function sentIn(delta: HistoryDelta): string[] {
	const candidates = [
		...delta.added,
		...delta.labelsAdded.filter((entry) => entry.changed.includes("SENT")),
		...delta.labelsRemoved.filter((entry) =>
			entry.changed.some((label) => label === "SCHEDULED" || label === "DRAFT"),
		),
	];
	const sent = candidates.filter((message) => countsAsSent(message.labelIds));
	return [...new Set(sent.map((message) => message.id))];
}
