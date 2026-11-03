import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { channelV1, type SyncRequest } from "@draftyak/protocol/channel-v1";
import { canonicalize } from "@draftyak/protocol/jcs";
import { ProviderId } from "@draftyak/protocol/normalized-change";
import { UtcMs } from "@draftyak/protocol/scalars";
import type { PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import { digestSlackCursor, type SlackSyncMode } from "./sync-state.ts";

interface Position {
	readonly cursor?: string;
	/** Consumed positions only; the pending cursor is not a member. */
	readonly seen: readonly string[];
}
export type SlackLegacyWork =
	| ({ readonly kind: "conversations" } & Position)
	| { readonly kind: "info"; readonly channelId: string }
	| ({ readonly kind: "history"; readonly channelId: string } & Position)
	| ({
			readonly kind: "replies";
			readonly channelId: string;
			readonly threadTs: string;
	  } & Position);
export interface SlackLegacyFingerprint {
	readonly id: string;
	readonly sha256: string;
}
export interface SlackLegacyCheckpoint {
	readonly mode: SlackSyncMode;
	readonly since: number;
	/** Empty work is a completed observational position. */
	readonly work: readonly SlackLegacyWork[];
	readonly snapshot: readonly SlackLegacyFingerprint[];
	/** Original completed position; present only during a delta pass. */
	readonly base?: string;
}
export interface SlackLegacySyncStore {
	save(state: SlackLegacyCheckpoint): Promise<string>;
	load(ref: string, request: SyncRequest): Promise<Readonly<SlackLegacyCheckpoint>>;
	release(ref: string, request: SyncRequest): Promise<void>;
}

export const MAX_SLACK_LEGACY_WORK = 65_536;
export const MAX_SLACK_LEGACY_FINGERPRINTS = 65_536;
export const MAX_SLACK_LEGACY_SEEN = 128;
const CHUNK_ITEMS = 256;
const CHUNK_BYTES = 131_072;
const MAX_CHUNKS = 512;
type Kind = "state" | "work" | "snapshot";

function invalid(): never {
	throw new PluginError("INVALID_INPUT");
}
function transient(): never {
	throw new PluginError("TRANSIENT");
}
function record(raw: unknown, keys: readonly string[], strict = true): Record<string, unknown> {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) invalid();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) invalid();
	if (strict && Reflect.ownKeys(raw).some((key) => typeof key !== "string" || !keys.includes(key)))
		invalid();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const slot = Object.getOwnPropertyDescriptor(raw, key);
		if (!slot) continue;
		if (!slot.enumerable || !("value" in slot)) invalid();
		result[key] = slot.value;
	}
	return result;
}
function array(raw: unknown, maximum: number): readonly unknown[] {
	if (raw === null || typeof raw !== "object" || isProxy(raw) || !Array.isArray(raw)) invalid();
	if (Object.getPrototypeOf(raw) !== Array.prototype) invalid();
	const length = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (!Number.isSafeInteger(length) || length < 0 || length > maximum) invalid();
	if (Reflect.ownKeys(raw).length !== length + 1) invalid();
	return Array.from({ length }, (_, index) => {
		const slot = Object.getOwnPropertyDescriptor(raw, String(index));
		if (!slot?.enumerable || !("value" in slot)) invalid();
		return slot.value;
	});
}
function id(raw: unknown): string {
	const result = ProviderId.safeParse(raw);
	if (!result.success) invalid();
	return result.data;
}
function hash(raw: unknown): string {
	if (typeof raw !== "string" || raw.length !== 64 || !/^[a-f0-9]{64}$/.test(raw)) invalid();
	return raw;
}
function position(data: Record<string, unknown>): Readonly<Position> {
	const cursor = data.cursor;
	if (cursor !== undefined && typeof cursor !== "string") invalid();
	const pending = cursor === undefined ? undefined : digestSlackCursor(cursor);
	const seen = array(data.seen, MAX_SLACK_LEGACY_SEEN).map(hash);
	if (new Set(seen).size !== seen.length) invalid();
	if (pending === undefined ? seen.length !== 0 : seen.includes(pending)) invalid();
	return Object.freeze({ ...(cursor === undefined ? {} : { cursor }), seen: Object.freeze(seen) });
}
function work(raw: unknown): Readonly<SlackLegacyWork> {
	const data = record(raw, ["kind", "channelId", "threadTs", "cursor", "seen"]);
	const keys =
		data.kind === "info"
			? ["kind", "channelId"]
			: data.kind === "conversations"
				? ["kind", "cursor", "seen"]
				: data.kind === "history"
					? ["kind", "channelId", "cursor", "seen"]
					: ["kind", "channelId", "threadTs", "cursor", "seen"];
	if (Object.keys(data).some((key) => !keys.includes(key))) invalid();
	if (data.kind === "info") return Object.freeze({ kind: "info", channelId: id(data.channelId) });
	if (data.kind === "conversations")
		return Object.freeze({ kind: "conversations", ...position(data) });
	if (data.kind === "history")
		return Object.freeze({ kind: "history", channelId: id(data.channelId), ...position(data) });
	if (data.kind !== "replies") invalid();
	// Timestamp semantics remain with the actual provider reader; no second parser.
	return Object.freeze({
		kind: "replies",
		channelId: id(data.channelId),
		threadTs: id(data.threadTs),
		...position(data),
	});
}
function fingerprint(raw: unknown): Readonly<SlackLegacyFingerprint> {
	const data = record(raw, ["id", "sha256"]);
	if (
		typeof data.id !== "string" ||
		data.id.length < 1 ||
		data.id.length > 1_024 ||
		/[^!-~]/.test(data.id)
	)
		invalid();
	return Object.freeze({ id: data.id, sha256: hash(data.sha256) });
}
function mode(raw: unknown): SlackSyncMode {
	if (raw !== "initial" && raw !== "resync" && raw !== "delta") invalid();
	return raw;
}
function since(raw: unknown): number {
	const result = UtcMs.safeParse(raw);
	if (!result.success) invalid();
	return result.data;
}
const tag = (kind: Kind): string => (kind === "state" ? "la1." : kind === "work" ? "lw1." : "lf1.");
function key(ref: unknown, kind: Kind): string {
	if (typeof ref !== "string" || ref.length !== 68 || !ref.startsWith(tag(kind))) invalid();
	hash(ref.slice(4));
	return `slack:legacy:${kind}:v1:${ref.slice(4)}`;
}
function checkpoint(raw: unknown): Readonly<SlackLegacyCheckpoint> {
	const data = record(raw, ["mode", "since", "work", "snapshot", "base"]);
	const capturedWork = array(data.work, MAX_SLACK_LEGACY_WORK).map(work);
	const snapshot = array(data.snapshot, MAX_SLACK_LEGACY_FINGERPRINTS)
		.map(fingerprint)
		.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
	if (snapshot.some((entry, at) => at > 0 && snapshot[at - 1]?.id === entry.id)) invalid();
	const capturedMode = mode(data.mode);
	if (capturedMode === "delta" && capturedWork.length > 0 && data.base === undefined) invalid();
	if (data.base !== undefined) {
		key(data.base, "state");
		if (capturedMode !== "delta" || capturedWork.length === 0) invalid();
	}
	return Object.freeze({
		mode: capturedMode,
		since: since(data.since),
		work: Object.freeze(capturedWork),
		snapshot: Object.freeze(snapshot),
		...(data.base === undefined ? {} : { base: data.base as string }),
	});
}
function request(raw: unknown): SyncRequest {
	const data = record(raw, ["mode", "since", "cursor"]);
	const parsed = channelV1.tools.channel_sync.input.safeParse(data);
	if (!parsed.success) invalid();
	switch (parsed.data.mode) {
		case "initial":
		case "resync":
		case "delta":
			return Object.freeze(parsed.data);
		default:
			return invalid();
	}
}
function cell(scope: string, kind: Kind, fields: Record<string, unknown>) {
	const value = Object.freeze({ v: 1, scope, kind, ...fields });
	const json = canonicalize(value);
	if (Buffer.byteLength(json) > CHUNK_BYTES) invalid();
	const digest = createHash("sha256")
		.update(`draftyak/slack/legacy-${kind}/v1\0`)
		.update(json)
		.digest("hex");
	const ref = `${tag(kind)}${digest}`;
	return { ref, key: key(ref, kind), value };
}
function chunks(scope: string, kind: "work" | "snapshot", items: readonly unknown[]) {
	const result: ReturnType<typeof cell>[] = [];
	let part: unknown[] = [];
	function finish(): void {
		if (part.length === 0) return;
		result.push(cell(scope, kind, { items: Object.freeze(part) }));
		if (result.length > MAX_CHUNKS) invalid();
		part = [];
	}
	for (const item of items) {
		if (
			part.length === CHUNK_ITEMS ||
			Buffer.byteLength(canonicalize({ v: 1, scope, kind, items: [...part, item] })) > CHUNK_BYTES
		)
			finish();
		part.push(item);
	}
	finish();
	return result;
}

/** Immutable observational state. Create from BOTH the current RPC's KV and signal. */
export function createSlackLegacySyncStore(
	ctx: Pick<PluginContext, "kv" | "signal">,
	scope: string,
): Readonly<SlackLegacySyncStore> {
	if (
		typeof scope !== "string" ||
		!scope.isWellFormed() ||
		scope.length < 1 ||
		scope.length > 4_096
	)
		invalid();
	const context = record(ctx, ["kv", "signal"], false);
	if (context.signal === null || typeof context.signal !== "object" || isProxy(context.signal))
		invalid();
	const signal = context.signal as AbortSignal;
	try {
		Reflect.get(AbortSignal.prototype, "aborted", signal);
	} catch {
		invalid();
	}
	const methods = record(context.kv, ["get", "set", "delete"], false);
	for (const method of [methods.get, methods.set, methods.delete])
		if (typeof method !== "function" || isProxy(method)) invalid();
	const get = methods.get as PluginContext["kv"]["get"];
	const set = methods.set as PluginContext["kv"]["set"];
	const remove = methods.delete as PluginContext["kv"]["delete"];
	const active = (): void => {
		if (Reflect.get(AbortSignal.prototype, "aborted", signal)) transient();
	};
	let pending: Promise<void> = Promise.resolve();
	function enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = pending.then(async () => {
			try {
				active();
				const value = await operation();
				active();
				return value;
			} catch {
				return transient();
			}
		});
		pending = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}
	async function read(ref: string, kind: Kind, fields: readonly string[]) {
		const value: unknown = await Reflect.apply(get, context.kv, [key(ref, kind)]);
		active();
		const data = record(value, ["v", "scope", "kind", ...fields]);
		if (data.v !== 1 || data.scope !== scope || data.kind !== kind) transient();
		return data;
	}
	async function verified(
		ref: string,
		expected: SyncRequest,
		asBase = false,
	): Promise<Readonly<SlackLegacyCheckpoint>> {
		const data = await read(ref, "state", [
			"mode",
			"since",
			"work",
			"snapshot",
			"workCount",
			"snapshotCount",
			"base",
		]);
		const capturedMode = mode(data.mode),
			capturedSince = since(data.since);
		const workRefs = array(data.work, MAX_CHUNKS).map((value) => {
			key(value, "work");
			return value as string;
		});
		const snapshotRefs = array(data.snapshot, MAX_CHUNKS).map((value) => {
			key(value, "snapshot");
			return value as string;
		});
		if (
			!Number.isSafeInteger(data.workCount) ||
			(data.workCount as number) < 0 ||
			(data.workCount as number) > MAX_SLACK_LEGACY_WORK ||
			!Number.isSafeInteger(data.snapshotCount) ||
			(data.snapshotCount as number) < 0 ||
			(data.snapshotCount as number) > MAX_SLACK_LEGACY_FINGERPRINTS
		)
			transient();
		if (data.base !== undefined) key(data.base, "state");
		const fields = {
			mode: capturedMode,
			since: capturedSince,
			work: workRefs,
			snapshot: snapshotRefs,
			workCount: data.workCount,
			snapshotCount: data.snapshotCount,
			...(data.base === undefined ? {} : { base: data.base }),
		};
		if (cell(scope, "state", fields).ref !== ref) transient();
		if (asBase && data.workCount !== 0) transient();
		if (
			expected.mode === "delta"
				? data.workCount !== 0 && capturedMode !== "delta"
				: expected.mode !== capturedMode || expected.since !== capturedSince
		)
			transient();
		const capturedWork: SlackLegacyWork[] = [],
			snapshot: SlackLegacyFingerprint[] = [];
		for (const [kind, refs] of [
			["work", workRefs],
			["snapshot", snapshotRefs],
		] as const) {
			for (const partRef of refs) {
				const part = await read(partRef, kind, ["items"]);
				const items =
					kind === "work"
						? array(part.items, CHUNK_ITEMS).map(work)
						: array(part.items, CHUNK_ITEMS).map(fingerprint);
				if (items.length === 0 || cell(scope, kind, { items }).ref !== partRef) transient();
				if (kind === "work") capturedWork.push(...(items as SlackLegacyWork[]));
				else snapshot.push(...(items as SlackLegacyFingerprint[]));
				if (
					capturedWork.length > MAX_SLACK_LEGACY_WORK ||
					snapshot.length > MAX_SLACK_LEGACY_FINGERPRINTS
				)
					transient();
			}
		}
		if (capturedWork.length !== data.workCount || snapshot.length !== data.snapshotCount)
			transient();
		const result = checkpoint({
			mode: capturedMode,
			since: capturedSince,
			work: capturedWork,
			snapshot,
			...(data.base === undefined ? {} : { base: data.base }),
		});
		if (result.base !== undefined) {
			const base = await verified(result.base, { mode: "delta", cursor: result.base }, true);
			if (base.since !== result.since) transient();
		}
		return result;
	}
	return Object.freeze({
		save(raw: SlackLegacyCheckpoint): Promise<string> {
			const value = checkpoint(raw);
			const workParts = chunks(scope, "work", value.work),
				snapshotParts = chunks(scope, "snapshot", value.snapshot);
			const root = cell(scope, "state", {
				mode: value.mode,
				since: value.since,
				work: workParts.map((part) => part.ref),
				snapshot: snapshotParts.map((part) => part.ref),
				workCount: value.work.length,
				snapshotCount: value.snapshot.length,
				...(value.base === undefined ? {} : { base: value.base }),
			});
			return enqueue(async () => {
				if (value.base !== undefined) {
					const base = await verified(value.base, { mode: "delta", cursor: value.base }, true);
					if (base.since !== value.since) transient();
				}
				for (const part of [...workParts, ...snapshotParts, root]) {
					await Reflect.apply(set, context.kv, [part.key, part.value]);
					active();
				}
				return root.ref;
			});
		},
		load(ref: string, rawRequest: SyncRequest): Promise<Readonly<SlackLegacyCheckpoint>> {
			const expected = request(rawRequest);
			return enqueue(() => {
				if (expected.cursor !== undefined && expected.cursor !== ref) transient();
				return verified(ref, expected);
			});
		},
		release(ref: string, rawRequest: SyncRequest): Promise<void> {
			const expected = request(rawRequest);
			return enqueue(async () => {
				if (expected.cursor !== undefined && expected.cursor !== ref) transient();
				await verified(ref, expected);
				active();
				// Chunks can be shared by other immutable roots; no refcount/CAS is implied.
				await Reflect.apply(remove, context.kv, [key(ref, "state")]);
			});
		},
	});
}
