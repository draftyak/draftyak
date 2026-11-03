import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { channelV1, type SyncPage, type SyncRequest } from "@draftyak/protocol/channel-v1";
import { canonicalize } from "@draftyak/protocol/jcs";
import type { PluginChange } from "@draftyak/protocol/normalized-change";
import type { PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { fetchConversationInfo, pollConversationListPages } from "./catalog.ts";
import {
	createSlackLegacySyncStore,
	MAX_SLACK_LEGACY_SEEN,
	type SlackLegacyCheckpoint,
	type SlackLegacySyncStore,
	type SlackLegacyWork,
} from "./legacy-sync-state.ts";
import { pollMessages } from "./poll.ts";
import { digestSlackCursor } from "./sync-state.ts";
import { createSlackThreadIndex, type SlackThreadIndex } from "./thread-index.ts";

type Context = Pick<PluginContext, "fetch" | "kv" | "signal">;
type PagedWork = Exclude<SlackLegacyWork, { readonly kind: "info" }>;

function invalid(): never {
	throw new PluginError("INVALID_INPUT");
}
function transient(): never {
	throw new PluginError("TRANSIENT");
}
function selected(raw: unknown, keys: readonly string[], strict = false): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	if (strict && Reflect.ownKeys(raw).some((key) => typeof key !== "string" || !keys.includes(key)))
		invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}
function context(raw: unknown): Context {
	const value = selected(raw, ["fetch", "kv", "signal"]);
	if (typeof value.fetch !== "function" || isProxy(value.fetch)) invalid();
	if (value.signal === null || typeof value.signal !== "object" || isProxy(value.signal)) invalid();
	try {
		Reflect.get(AbortSignal.prototype, "aborted", value.signal);
	} catch {
		invalid();
	}
	const fetch = value.fetch as HostFetch;
	return Object.freeze({
		fetch: (...args: Parameters<HostFetch>) => Reflect.apply(fetch, raw, args),
		kv: value.kv as PluginContext["kv"],
		signal: value.signal as AbortSignal,
	});
}
function request(raw: unknown): SyncRequest {
	const checked = channelV1.tools.channel_sync.input.safeParse(
		selected(raw, ["mode", "since", "cursor"], true),
	);
	if (!checked.success) invalid();
	switch (checked.data.mode) {
		case "initial":
		case "resync":
		case "delta":
			return Object.freeze(checked.data);
		default:
			return invalid();
	}
}
function active(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) transient();
}
function sinceTimestamp(since: number): string {
	// The already validated UTC-millisecond instant becomes a query; no provider ID is parsed.
	const ms = BigInt(since);
	return `${ms / 1_000n}.${(ms % 1_000n).toString().padStart(3, "0")}`;
}
async function first<T>(iterator: AsyncGenerator<T, void>): Promise<T> {
	try {
		const page = await iterator.next();
		if (page.done) transient();
		return page.value;
	} finally {
		await iterator.return(undefined);
	}
}
function continuation(work: PagedWork, more: boolean, cursor: string | undefined): PagedWork[] {
	const consumed = [...work.seen];
	if (work.cursor !== undefined) {
		const digest = digestSlackCursor(work.cursor);
		if (consumed.includes(digest)) transient();
		consumed.push(digest);
	}
	if (cursor === undefined) {
		if (more) transient();
		return [];
	}
	if (cursor === work.cursor || consumed.includes(digestSlackCursor(cursor))) transient();
	if (consumed.length >= MAX_SLACK_LEGACY_SEEN) transient();
	return [{ ...work, cursor, seen: consumed }];
}
function identity(change: PluginChange): string {
	if (change.kind === "chat.conversation") return JSON.stringify([change.kind, change.channelId]);
	if (change.kind === "chat.message")
		return JSON.stringify([change.kind, change.channelId, change.ts]);
	return transient();
}
function remember(
	previous: SlackLegacyCheckpoint["snapshot"],
	observed: readonly PluginChange[],
): { snapshot: SlackLegacyCheckpoint["snapshot"]; changes: readonly PluginChange[] } {
	const hashes = new Map(previous.map(({ id, sha256 }) => [id, sha256]));
	const changes: PluginChange[] = [];
	for (const change of observed) {
		const id = identity(change);
		const sha256 = createHash("sha256")
			.update("draftyak/slack/legacy-change/v1\0")
			.update(canonicalize(change))
			.digest("hex");
		if (hashes.get(id) !== sha256) changes.push(change);
		hashes.set(id, sha256);
	}
	const snapshot = [...hashes]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([id, sha256]) => Object.freeze({ id, sha256 }));
	return { snapshot: Object.freeze(snapshot), changes: Object.freeze(changes) };
}
function sameSnapshot(a: SlackLegacyCheckpoint["snapshot"], b: SlackLegacyCheckpoint["snapshot"]) {
	return (
		a.length === b.length &&
		a.every((entry, index) => entry.id === b[index]?.id && entry.sha256 === b[index]?.sha256)
	);
}

async function advance(
	ctx: Context,
	state: SlackLegacyCheckpoint,
	index: SlackThreadIndex,
): Promise<{ work: readonly SlackLegacyWork[]; observed: readonly PluginChange[] }> {
	const [current, ...tail] = state.work;
	if (current === undefined) transient();
	if (current.kind === "conversations") {
		const page = await first(
			pollConversationListPages(ctx, { cursor: current.cursor, maxPages: 1 }),
		);
		const children: SlackLegacyWork[] = page.conversations.flatMap(({ channelId }) => [
			{ kind: "info", channelId },
			{ kind: "history", channelId, seen: [] },
		]);
		return {
			work: [...children, ...continuation(current, page.more, page.nextCursor), ...tail],
			observed: [],
		};
	}
	if (current.kind === "info") {
		return { work: tail, observed: [await fetchConversationInfo(ctx, current.channelId)] };
	}
	const options = {
		channelId: current.channelId,
		cursor: current.cursor,
		maxPages: 1,
		inclusive: true,
	};
	const page = await first(
		current.kind === "history"
			? pollMessages(ctx, { ...options, kind: "history", oldest: "0.000" })
			: pollMessages(ctx, {
					...options,
					kind: "replies",
					threadTs: current.threadTs,
					oldest: sinceTimestamp(state.since),
				}),
	);
	const next = continuation(current, page.more, page.nextCursor);
	if (current.kind === "history") {
		// Root routing cannot be recovered from recent messages alone. Counts never omit a query.
		const roots = new Set<string>();
		for (const row of page.changes) {
			if (row.channelId !== current.channelId) transient();
			roots.add(row.threadTs ?? row.ts);
		}
		// Older routing context and unchanged rows still repair an advisory cache miss.
		for (const row of page.changes)
			await index.remember({
				channelId: row.channelId,
				ts: row.ts,
				threadTs: row.threadTs ?? row.ts,
			});
		return {
			work: [
				...[...roots].map((threadTs) => ({
					kind: "replies" as const,
					channelId: current.channelId,
					threadTs,
					seen: [],
				})),
				...next,
				...tail,
			],
			observed: page.changes.filter((row) => row.sentAt >= state.since),
		};
	}
	for (const row of page.changes) {
		if (
			row.channelId !== current.channelId ||
			(row.ts === current.threadTs
				? row.threadTs !== undefined && row.threadTs !== current.threadTs
				: row.threadTs !== current.threadTs)
		)
			transient();
	}
	for (const row of page.changes)
		await index.remember({
			channelId: row.channelId,
			ts: row.ts,
			threadTs: row.threadTs ?? row.ts,
		});
	// Genuine root context is preserved; query bounds are not an invented all-row interval rule.
	return { work: [...next, ...tail], observed: page.changes };
}

async function run(
	ctx: Context,
	store: SlackLegacySyncStore,
	index: SlackThreadIndex,
	args: SyncRequest,
): Promise<SyncPage> {
	try {
		active(ctx.signal);
		let state: SlackLegacyCheckpoint;
		if (args.cursor === undefined) {
			if (args.mode === "delta") transient();
			state = {
				mode: args.mode,
				since: args.since,
				work: [{ kind: "conversations", seen: [] }],
				snapshot: [],
			};
		} else {
			state = await store.load(args.cursor, args);
			active(ctx.signal);
			if (state.work.length === 0) {
				if (args.mode !== "delta")
					return Object.freeze({ changes: Object.freeze([]), cursor: args.cursor, more: false });
				state = {
					mode: "delta",
					since: state.since,
					work: [{ kind: "conversations", seen: [] }],
					snapshot: state.snapshot,
					base: args.cursor,
				};
			}
		}
		const completed = await advance(ctx, state, index);
		active(ctx.signal);
		const { snapshot, changes } = remember(state.snapshot, completed.observed);
		const checkpoint: SlackLegacyCheckpoint = {
			mode: state.mode,
			since: state.since,
			work: completed.work,
			snapshot,
			...(state.base === undefined || completed.work.length === 0 ? {} : { base: state.base }),
		};
		let cursor: string;
		if (completed.work.length === 0 && state.base !== undefined) {
			const baseline = await store.load(state.base, { mode: "delta", cursor: state.base });
			active(ctx.signal);
			cursor = sameSnapshot(snapshot, baseline.snapshot)
				? state.base
				: await store.save(checkpoint);
		} else {
			cursor = await store.save(checkpoint);
		}
		active(ctx.signal);
		return Object.freeze({ changes, cursor, more: completed.work.length !== 0 });
	} catch (error) {
		active(ctx.signal);
		if (error instanceof PluginError && error.result.code === "CURSOR_EXPIRED") throw error;
		return transient();
	}
}

/**
 * One ordinary account-sync step. Scope and checkpoints are DATA consistency, never read authority.
 * Only a fully drained provider traversal produces a terminal observational cursor.
 */
export function syncSlackAccount(
	ctx: Context,
	scope: string,
	args: SyncRequest,
): Promise<SyncPage> {
	const captured = context(ctx);
	const input = request(args);
	// Capture the store now too, so constructor refusals do not become deferred provider work.
	const store = createSlackLegacySyncStore(captured, scope);
	const index = createSlackThreadIndex(captured, scope);
	return run(captured, store, index, input);
}
