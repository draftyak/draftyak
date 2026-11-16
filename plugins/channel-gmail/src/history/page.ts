import { types } from "node:util";
import { MAX_CHANGES, ProviderId } from "@draftyak/protocol/normalized-change";

export interface HistoryOptions {
	readonly startHistoryId: string;
	readonly pageToken?: string;
	readonly seenPageTokens?: readonly string[];
}
export interface HistoryEntry {
	readonly providerId: string;
	readonly threadId: string;
	readonly kind: "message" | "labels" | "deleted";
	readonly historyId: string;
}
/** Provider DATA and hydration requirements; neither a checkpoint nor scan authority. */
export interface HistoryPagePlan {
	readonly historyId: string;
	readonly nextPageToken: string | null;
	readonly more: boolean;
	readonly metadataIds: readonly string[];
	readonly entries: readonly HistoryEntry[];
}

export class GmailHistoryError extends Error {
	override name = "GmailHistoryError";
	readonly code = "GMAIL_HISTORY_INVALID";
	constructor() {
		super("GMAIL_HISTORY_INVALID");
	}
}

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_NODES = 20_000;
const MAX_DEPTH = 16;
const MAX_TOKENS = 128;
const MAX_TOKEN_BYTES = 2_048;
const MAX_UINT64 = 18_446_744_073_709_551_615n;
const messageKeys = [
	"id",
	"threadId",
	"labelIds",
	"snippet",
	"historyId",
	"internalDate",
	"payload",
	"sizeEstimate",
	"raw",
	"classificationLabelValues",
] as const;

/** @internal Fixed refusal shared by the two pure DATA modules. */
export function invalidHistory(): never {
	throw new GmailHistoryError();
}

/** @internal Snapshot before parsing, without caller accessors, iterators or proxy hooks. */
export function copyHistoryData(input: unknown): unknown {
	let nodes = 0;
	let bytes = 0;
	const active = new Set<object>();
	const charge = (amount: number): void => {
		bytes += amount;
		if (bytes > MAX_BYTES) invalidHistory();
	};
	function copy(value: unknown, depth: number): unknown {
		if (++nodes > MAX_NODES || depth > MAX_DEPTH) invalidHistory();
		if (value === null || value === undefined || typeof value === "boolean") {
			charge(value === undefined ? 9 : value === false ? 5 : 4);
			return value;
		}
		if (typeof value === "string") {
			charge(Buffer.byteLength(JSON.stringify(value), "utf8"));
			return value;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) invalidHistory();
			charge(Buffer.byteLength(JSON.stringify(value), "utf8"));
			return value;
		}
		if (typeof value !== "object" || types.isProxy(value) || active.has(value)) invalidHistory();
		const array = Array.isArray(value);
		const prototype = Object.getPrototypeOf(value);
		if (
			array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
		)
			invalidHistory();
		const keys = Reflect.ownKeys(value);
		if (keys.length > MAX_NODES || keys.some((key) => typeof key !== "string")) invalidHistory();
		const descriptors = Object.getOwnPropertyDescriptors(value);
		active.add(value);
		try {
			charge(2);
			if (array) {
				const length = descriptors.length?.value;
				if (
					!Number.isSafeInteger(length) ||
					length < 0 ||
					length > MAX_NODES ||
					keys.length !== length + 1
				)
					invalidHistory();
				const result: unknown[] = [];
				for (let index = 0; index < length; index++) {
					const descriptor = descriptors[String(index)];
					if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
						invalidHistory();
					if (index > 0) charge(1);
					result.push(copy(descriptor.value, depth + 1));
				}
				return result;
			}
			const result: Record<string, unknown> = Object.create(null);
			let first = true;
			for (const key of keys as string[]) {
				const descriptor = descriptors[key];
				if (!descriptor || !Object.hasOwn(descriptor, "value") || !descriptor.enumerable)
					invalidHistory();
				charge(Buffer.byteLength(JSON.stringify(key), "utf8") + (first ? 1 : 2));
				first = false;
				result[key] = copy(descriptor.value, depth + 1);
			}
			return result;
		} finally {
			active.delete(value);
		}
	}
	try {
		return copy(input, 0);
	} catch {
		throw new GmailHistoryError();
	}
}

/** @internal Use only after copyHistoryData, which removes caller behavior. */
export function historyRecord(
	value: unknown,
	allowed?: readonly string[],
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) invalidHistory();
	const result = value as Record<string, unknown>;
	if (allowed && Object.keys(result).some((key) => !allowed.includes(key))) invalidHistory();
	return result;
}

/** @internal Canonical provider uint64 DATA, never a JavaScript number. */
export function historyDecimal(value: unknown): string {
	if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) invalidHistory();
	if (BigInt(value) > MAX_UINT64) invalidHistory();
	return value;
}

/** @internal The merged contract owns provider-id and label bounds. */
export function historyProviderId(value: unknown): string {
	const parsed = ProviderId.safeParse(value);
	if (!parsed.success) invalidHistory();
	return parsed.data;
}

/** @internal Label arrays are complete only when explicitly supplied as metadata. */
export function historyLabels(value: unknown): string[] {
	if (!Array.isArray(value) || value.length > 256) invalidHistory();
	const labels = value.map(historyProviderId);
	if (new Set(labels).size !== labels.length) invalidHistory();
	return labels;
}

function token(value: unknown): string {
	if (typeof value !== "string" || !/^[!-~]+$/.test(value) || value.length > MAX_TOKEN_BYTES)
		invalidHistory();
	return value;
}
function array(value: unknown): unknown[] {
	if (!Array.isArray(value) || value.length > MAX_CHANGES) invalidHistory();
	return value;
}
function reference(value: unknown): { providerId: string; threadId: string } {
	const data = historyRecord(value, messageKeys);
	const providerId = historyProviderId(data.id),
		threadId = historyProviderId(data.threadId);
	if (data.labelIds !== undefined) historyLabels(data.labelIds);
	if (data.historyId !== undefined) historyDecimal(data.historyId);
	return { providerId, threadId };
}

export function decodeHistoryPage(wire: unknown, options: HistoryOptions): HistoryPagePlan {
	try {
		const input = historyRecord(copyHistoryData({ wire, options }));
		const settings = historyRecord(input.options, [
			"startHistoryId",
			"pageToken",
			"seenPageTokens",
		]);
		const start = historyDecimal(settings.startHistoryId);
		const used = new Set<string>();
		if (settings.pageToken !== undefined) used.add(token(settings.pageToken));
		if (settings.seenPageTokens !== undefined) {
			if (!Array.isArray(settings.seenPageTokens) || settings.seenPageTokens.length > MAX_TOKENS)
				invalidHistory();
			for (const previous of settings.seenPageTokens) used.add(token(previous));
		}
		const page = historyRecord(input.wire, ["history", "historyId", "nextPageToken"]);
		const historyId = historyDecimal(page.historyId);
		if (BigInt(historyId) < BigInt(start)) invalidHistory();
		const nextPageToken = page.nextPageToken === undefined ? null : token(page.nextPageToken);
		if (nextPageToken !== null && used.has(nextPageToken)) invalidHistory();
		const records = page.history === undefined ? [] : array(page.history);
		const state = new Map<string, HistoryEntry>();
		const threads = new Map<string, string>();
		let previous = BigInt(start),
			logicalReferences = 0;
		for (const record of records) {
			const data = historyRecord(record, [
				"id",
				"messages",
				"messagesAdded",
				"messagesDeleted",
				"labelsAdded",
				"labelsRemoved",
			]);
			const id = historyDecimal(data.id),
				numeric = BigInt(id);
			if (numeric <= previous || numeric > BigInt(historyId)) invalidHistory();
			previous = numeric;
			const changes = new Map<
				string,
				{ threadId: string; message: boolean; labels: boolean; deleted: boolean }
			>();
			for (const family of [
				"messagesAdded",
				"messagesDeleted",
				"labelsAdded",
				"labelsRemoved",
			] as const) {
				if (data[family] === undefined) continue;
				for (const entry of array(data[family])) {
					const item = historyRecord(
						entry,
						family.startsWith("labels") ? ["message", "labelIds"] : ["message"],
					);
					const ref = reference(item.message);
					if (family.startsWith("labels")) historyLabels(item.labelIds);
					const change = changes.get(ref.providerId) ?? {
						threadId: ref.threadId,
						message: false,
						labels: false,
						deleted: false,
					};
					if (
						change.threadId !== ref.threadId ||
						(threads.has(ref.providerId) && threads.get(ref.providerId) !== ref.threadId)
					)
						invalidHistory();
					threads.set(ref.providerId, ref.threadId);
					if (family === "messagesAdded") change.message = true;
					else if (family === "messagesDeleted") change.deleted = true;
					else change.labels = true;
					changes.set(ref.providerId, change);
				}
			}
			if (data.messages !== undefined) {
				for (const entry of array(data.messages)) {
					const ref = reference(entry),
						matched = changes.get(ref.providerId);
					if (!matched || matched.threadId !== ref.threadId) invalidHistory();
				}
			}
			if (changes.size === 0) invalidHistory();
			logicalReferences += changes.size;
			if (logicalReferences > MAX_CHANGES) invalidHistory();
			for (const providerId of [...changes.keys()].sort()) {
				const change = changes.get(providerId);
				if (!change || (change.deleted && (change.message || change.labels))) invalidHistory();
				const old = state.get(providerId);
				if (old?.kind === "deleted" && !change.deleted && !change.message) invalidHistory();
				const kind = change.deleted
					? "deleted"
					: change.message || old?.kind === "message"
						? "message"
						: "labels";
				// Reinsert so output follows the last relevant record, then canonical id order.
				state.delete(providerId);
				state.set(
					providerId,
					Object.freeze({ providerId, threadId: change.threadId, kind, historyId: id }),
				);
			}
		}
		const entries = Object.freeze([...state.values()]);
		return Object.freeze({
			historyId,
			nextPageToken,
			more: nextPageToken !== null,
			metadataIds: Object.freeze(
				entries.filter((entry) => entry.kind !== "deleted").map((entry) => entry.providerId),
			),
			entries,
		});
	} catch {
		throw new GmailHistoryError();
	}
}
