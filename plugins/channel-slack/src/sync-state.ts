import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { ProviderId } from "@draftyak/protocol/normalized-change";
import { UtcMs } from "@draftyak/protocol/scalars";
import type { PluginContext } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";

export type SlackSyncMode = "initial" | "resync" | "delta";

interface PagePosition {
	readonly cursor?: string;
	readonly seen: readonly string[];
}

export type SlackProviderWork =
	| ({ readonly kind: "conversations" } & PagePosition)
	| { readonly kind: "info"; readonly channelId: string }
	| ({ readonly kind: "history"; readonly channelId: string } & PagePosition)
	| ({
			readonly kind: "replies";
			readonly channelId: string;
			readonly threadTs: string;
			readonly replyCount: number;
	  } & PagePosition);

export type SlackSyncWork = SlackProviderWork | { readonly kind: "resume"; readonly block: string };

export interface SlackSyncBinding {
	readonly mode: SlackSyncMode;
	readonly since: number;
}

export interface SlackSyncCheckpoint extends SlackSyncBinding {
	readonly work: readonly SlackSyncWork[];
}

export interface SlackSyncProviderCheckpoint extends SlackSyncBinding {
	readonly work: readonly SlackProviderWork[];
}

export interface SlackSyncStore {
	save(checkpoint: SlackSyncCheckpoint): Promise<string>;
	load(cursor: string): Promise<Readonly<SlackSyncCheckpoint>>;
	release(cursor: string): Promise<void>;
	saveBlocks(checkpoint: SlackSyncProviderCheckpoint): Promise<readonly string[]>;
	loadBlock(block: string, expected: SlackSyncBinding): Promise<readonly SlackProviderWork[]>;
	releaseBlock(block: string): Promise<void>;
}

const MAX_WORK = 1_024;
const MAX_SEEN = 128;
const MAX_BYTES = 256 * 1_024;
const PROVIDER_KEYS = ["kind", "channelId", "threadTs", "replyCount", "cursor", "seen"];
type RecordKind = "root" | "block";

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
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (descriptor === undefined) continue;
		if (!descriptor.enumerable || !("value" in descriptor)) invalid();
		result[key] = descriptor.value;
	}
	return result;
}

function only(data: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(data).some((key) => !keys.includes(key))) invalid();
}

function array(raw: unknown, maximum: number): readonly unknown[] {
	if (raw === null || typeof raw !== "object" || isProxy(raw) || !Array.isArray(raw)) invalid();
	if (Object.getPrototypeOf(raw) !== Array.prototype) invalid();
	const size = Object.getOwnPropertyDescriptor(raw, "length")?.value;
	if (!Number.isSafeInteger(size) || size < 0 || size > maximum) invalid();
	if (Reflect.ownKeys(raw).length !== size + 1) invalid();
	const result: unknown[] = [];
	for (let at = 0; at < size; at++) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, String(at));
		if (!descriptor?.enumerable || !("value" in descriptor)) invalid();
		result.push(descriptor.value);
	}
	return result;
}

function providerId(raw: unknown): string {
	const value = ProviderId.safeParse(raw);
	if (!value.success || /[^!-~]/.test(value.data)) invalid();
	return value.data;
}

function timestamp(raw: unknown): string {
	const value = providerId(raw);
	if (!/^(?:0|[1-9][0-9]*)\.[0-9]{1,9}$/.test(value)) invalid();
	const dot = value.indexOf(".");
	const nanos =
		BigInt(value.slice(0, dot)) * 1_000_000_000n + BigInt(value.slice(dot + 1).padEnd(9, "0"));
	if (nanos / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
	return value;
}

function providerCursor(raw: unknown): string {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > 4_096 || /[^!-~]/.test(raw))
		invalid();
	return raw;
}

/** A per-provider-flow consistency digest, never a read permit or coverage receipt. */
export function digestSlackCursor(cursor: string): string {
	const value = providerCursor(cursor);
	return createHash("sha256")
		.update("draftyak/slack/provider-cursor/v1\0")
		.update(value)
		.digest("hex");
}

function position(data: Record<string, unknown>): Readonly<PagePosition> {
	const cursor = data.cursor === undefined ? undefined : providerCursor(data.cursor);
	const seen: string[] = [];
	const unique = new Set<string>();
	for (const raw of array(data.seen, MAX_SEEN)) {
		if (
			typeof raw !== "string" ||
			raw.length !== 64 ||
			!/^[a-f0-9]{64}$/.test(raw) ||
			unique.has(raw)
		)
			invalid();
		unique.add(raw);
		seen.push(raw);
	}
	if (cursor === undefined ? seen.length !== 0 : seen.at(-1) !== digestSlackCursor(cursor))
		invalid();
	return Object.freeze({ ...(cursor === undefined ? {} : { cursor }), seen: Object.freeze(seen) });
}

function referenceKey(raw: unknown, kind: RecordKind): string {
	const tag = kind === "root" ? "s1." : "b1.";
	if (
		typeof raw !== "string" ||
		raw.length !== 67 ||
		!raw.startsWith(tag) ||
		!/^[a-f0-9]{64}$/.test(raw.slice(3))
	)
		invalid();
	return `${kind === "root" ? "slack:sync:v1:" : "slack:sync:block:v1:"}${raw.slice(3)}`;
}

function providerWork(data: Record<string, unknown>): Readonly<SlackProviderWork> {
	if (data.kind === "info") {
		only(data, ["kind", "channelId"]);
		return Object.freeze({ kind: "info", channelId: providerId(data.channelId) });
	}
	if (data.kind === "conversations") {
		only(data, ["kind", "cursor", "seen"]);
		return Object.freeze({ kind: "conversations", ...position(data) });
	}
	if (data.kind === "history") {
		only(data, ["kind", "channelId", "cursor", "seen"]);
		return Object.freeze({
			kind: "history",
			channelId: providerId(data.channelId),
			...position(data),
		});
	}
	if (data.kind !== "replies") invalid();
	only(data, PROVIDER_KEYS);
	if (
		typeof data.replyCount !== "number" ||
		!Number.isSafeInteger(data.replyCount) ||
		data.replyCount <= 0
	)
		invalid();
	return Object.freeze({
		kind: "replies",
		channelId: providerId(data.channelId),
		threadTs: timestamp(data.threadTs),
		replyCount: data.replyCount,
		...position(data),
	});
}

function rootWork(raw: unknown): Readonly<SlackSyncWork> {
	const data = record(raw, [...PROVIDER_KEYS, "block"]);
	if (data.kind === "resume") {
		only(data, ["kind", "block"]);
		referenceKey(data.block, "block");
		return Object.freeze({ kind: "resume", block: data.block as string });
	}
	return providerWork(data);
}

function binding(raw: unknown): Readonly<SlackSyncBinding> {
	const data = record(raw, ["mode", "since"]);
	if (data.mode !== "initial" && data.mode !== "resync" && data.mode !== "delta") invalid();
	const since = UtcMs.safeParse(data.since);
	if (!since.success) invalid();
	return Object.freeze({ mode: data.mode, since: since.data });
}

function rootCheckpoint(raw: unknown): Readonly<SlackSyncCheckpoint> {
	const data = record(raw, ["mode", "since", "work"]);
	return Object.freeze({
		...binding({ mode: data.mode, since: data.since }),
		work: Object.freeze(array(data.work, MAX_WORK).map(rootWork)),
	});
}

function blockCheckpoint(raw: unknown): Readonly<SlackSyncProviderCheckpoint> {
	const data = record(raw, ["mode", "since", "work"]);
	return Object.freeze({
		...binding({ mode: data.mode, since: data.since }),
		work: Object.freeze(
			array(data.work, MAX_WORK).map((value) => providerWork(record(value, PROVIDER_KEYS))),
		),
	});
}

function encodeWork(work: SlackSyncWork): string {
	if (work.kind === "resume") return `{"kind":"resume","block":${JSON.stringify(work.block)}}`;
	if (work.kind === "info") return `{"kind":"info","channelId":${JSON.stringify(work.channelId)}}`;
	const cursor = work.cursor === undefined ? "" : `,"cursor":${JSON.stringify(work.cursor)}`;
	const seen = `,"seen":[${work.seen.map((value) => JSON.stringify(value)).join(",")}]`;
	if (work.kind === "conversations") return `{"kind":"conversations"${cursor}${seen}}`;
	const channel = `,"channelId":${JSON.stringify(work.channelId)}`;
	if (work.kind === "history") return `{"kind":"history"${channel}${cursor}${seen}}`;
	return `{"kind":"replies"${channel},"threadTs":${JSON.stringify(work.threadTs)},"replyCount":${JSON.stringify(work.replyCount)}${cursor}${seen}}`;
}

function encodeEnvelope(scope: string, value: SlackSyncCheckpoint): string {
	return `{"v":1,"scope":${JSON.stringify(scope)},"mode":${JSON.stringify(value.mode)},"since":${JSON.stringify(value.since)},"work":[${value.work.map(encodeWork).join(",")}]}`;
}

function savedRecord(scope: string, value: SlackSyncCheckpoint, kind: RecordKind) {
	const json = encodeEnvelope(scope, value);
	if (Buffer.byteLength(json, "utf8") > MAX_BYTES) invalid();
	const domain =
		kind === "root" ? "draftyak/slack/sync-checkpoint/v1\0" : "draftyak/slack/sync-work-block/v1\0";
	const digest = createHash("sha256").update(domain).update(json).digest("hex");
	return Object.freeze({
		ref: `${kind === "root" ? "s1." : "b1."}${digest}`,
		key: `${kind === "root" ? "slack:sync:v1:" : "slack:sync:block:v1:"}${digest}`,
		envelope: Object.freeze({
			v: 1,
			scope,
			mode: value.mode,
			since: value.since,
			work: value.work,
		}),
	});
}

function planBlocks(scope: string, value: SlackSyncProviderCheckpoint) {
	const planned: ReturnType<typeof savedRecord>[] = [];
	const emptyBytes = Buffer.byteLength(encodeEnvelope(scope, { ...value, work: [] }), "utf8");
	let chunk: SlackProviderWork[] = [];
	let bytes = emptyBytes;
	function finish(): void {
		if (chunk.length === 0) return;
		planned.push(savedRecord(scope, { ...value, work: Object.freeze(chunk) }, "block"));
		chunk = [];
		bytes = emptyBytes;
	}
	for (const work of value.work) {
		const encodedBytes = Buffer.byteLength(encodeWork(work), "utf8");
		if (
			chunk.length === MAX_WORK ||
			bytes + encodedBytes + (chunk.length === 0 ? 0 : 1) > MAX_BYTES
		)
			finish();
		if (bytes + encodedBytes > MAX_BYTES) invalid();
		bytes += encodedBytes + (chunk.length === 0 ? 0 : 1);
		chunk.push(work);
	}
	finish();
	return Object.freeze(planned);
}

function capture(ctx: unknown, scope: unknown) {
	if (
		typeof scope !== "string" ||
		scope.length === 0 ||
		scope.length > 4_096 ||
		!scope.isWellFormed()
	)
		invalid();
	const context = record(ctx, ["kv", "signal"], false);
	if (context.signal === null || typeof context.signal !== "object" || isProxy(context.signal))
		invalid();
	try {
		Reflect.get(AbortSignal.prototype, "aborted", context.signal);
	} catch {
		invalid();
	}
	const methods = record(context.kv, ["get", "set", "delete"], false);
	for (const method of [methods.get, methods.set, methods.delete]) {
		if (typeof method !== "function" || isProxy(method)) invalid();
	}
	return {
		scope,
		signal: context.signal as AbortSignal,
		receiver: context.kv,
		get: methods.get as PluginContext["kv"]["get"],
		set: methods.set as PluginContext["kv"]["set"],
		delete: methods.delete as PluginContext["kv"]["delete"],
	};
}

function assertActive(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) transient();
}

/**
 * Typed immutable sync metadata. Scope and cursors are consistency DATA, not read
 * grants or durable job receipts. Old cells remain until explicit verified release.
 */
export function createSlackSyncStore(
	ctx: Pick<PluginContext, "kv" | "signal">,
	scope: string,
): Readonly<SlackSyncStore> {
	const input = capture(ctx, scope);
	let pending: Promise<void> = Promise.resolve();
	function enqueue<T>(work: () => Promise<T>): Promise<T> {
		const operation = pending.then(async () => {
			try {
				assertActive(input.signal);
				const value = await work();
				assertActive(input.signal);
				return value;
			} catch {
				return transient();
			}
		});
		pending = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}
	function verified(ref: string, key: string, kind: "root"): Promise<Readonly<SlackSyncCheckpoint>>;
	function verified(
		ref: string,
		key: string,
		kind: "block",
	): Promise<Readonly<SlackSyncProviderCheckpoint>>;
	async function verified(
		ref: string,
		key: string,
		kind: RecordKind,
	): Promise<Readonly<SlackSyncCheckpoint>> {
		const raw: unknown = await Reflect.apply(input.get, input.receiver, [key]);
		assertActive(input.signal);
		const data = record(raw, ["v", "scope", "mode", "since", "work"]);
		if (data.v !== 1 || data.scope !== input.scope) transient();
		const fields = { mode: data.mode, since: data.since, work: data.work };
		const value = kind === "root" ? rootCheckpoint(fields) : blockCheckpoint(fields);
		if (savedRecord(input.scope, value, kind).ref !== ref) transient();
		return value;
	}
	return Object.freeze({
		save(raw: SlackSyncCheckpoint): Promise<string> {
			const saved = savedRecord(input.scope, rootCheckpoint(raw), "root");
			return enqueue(async () => {
				await Reflect.apply(input.set, input.receiver, [saved.key, saved.envelope]);
				return saved.ref;
			});
		},
		load(cursor: string): Promise<Readonly<SlackSyncCheckpoint>> {
			const key = referenceKey(cursor, "root");
			return enqueue(() => verified(cursor, key, "root"));
		},
		release(cursor: string): Promise<void> {
			const key = referenceKey(cursor, "root");
			return enqueue(async () => {
				await verified(cursor, key, "root");
				assertActive(input.signal);
				await Reflect.apply(input.delete, input.receiver, [key]);
			});
		},
		saveBlocks(raw: SlackSyncProviderCheckpoint): Promise<readonly string[]> {
			// Capture and validate every chunk before the first write. Failure may leave cells,
			// but it never returns partial refs or claims an atomic multi-cell transaction.
			const planned = planBlocks(input.scope, blockCheckpoint(raw));
			return enqueue(async () => {
				for (const saved of planned) {
					await Reflect.apply(input.set, input.receiver, [saved.key, saved.envelope]);
					assertActive(input.signal);
				}
				return Object.freeze(planned.map((saved) => saved.ref));
			});
		},
		loadBlock(block: string, rawExpected: SlackSyncBinding): Promise<readonly SlackProviderWork[]> {
			const key = referenceKey(block, "block");
			const expected = binding(rawExpected);
			return enqueue(async () => {
				const value = await verified(block, key, "block");
				if (value.mode !== expected.mode || value.since !== expected.since) transient();
				return value.work;
			});
		},
		releaseBlock(block: string): Promise<void> {
			const key = referenceKey(block, "block");
			return enqueue(async () => {
				await verified(block, key, "block");
				assertActive(input.signal);
				await Reflect.apply(input.delete, input.receiver, [key]);
			});
		},
	});
}
