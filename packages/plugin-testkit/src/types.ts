import { isProxy } from "node:util/types";
import type { Fake } from "@draftyak/fakes";
import type { HeaderList } from "@draftyak/protocol/hash";
import { HOST_MAX_ACTIVE_REQUESTS, type HostMethod } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import type { ResponsesHttpBindingInput } from "@draftyak/protocol/manifest/responses-http";
import { isPluginNodeVersionSupported } from "@draftyak/protocol/plugin-argv";
import type { PluginStdioResult } from "@draftyak/protocol/plugin-stdio";
import type { SendTicket, TicketMismatch } from "@draftyak/protocol/send-ticket";
import type { HostChannel, PluginEntry } from "@draftyak/sdk";
import { type CompatibleHttpBindingInput, snapshotCompatibleHttpInput } from "./compatible-http.ts";
import { type MessagesHttpBindingInput, snapshotMessagesHttpInput } from "./messages-http.ts";
import type { MockSocketUpstream } from "./mock-socket-upstream.ts";

export interface MockPlugin {
	readonly manifest: unknown;
	readonly entry: PluginEntry;
}
export interface MockAccount {
	readonly id: string;
	readonly mode: "read_only" | "full";
}
export interface MockHubOptions {
	readonly mode: "in-memory" | "process";
	readonly plugin: MockPlugin;
	readonly account?: MockAccount;
	readonly instance?:
		| string
		| { readonly id: string; readonly config?: Readonly<Record<string, unknown>> };
	readonly upstreams: readonly Fake[];
	/** Optional constructor-issued synthetic socket backends; never native network authority. */
	readonly socketUpstreams?: readonly MockSocketUpstream[];
	readonly secrets?: Readonly<Record<string, string>>;
	/** Trusted constructor inputs for the Responses fixture comparison; never call metadata. */
	readonly responsesHttp?: readonly ResponsesHttpBindingInput[];
	/** Independent completed-response fixture inputs; never call metadata or native authority. */
	readonly compatibleHttp?: readonly CompatibleHttpBindingInput[];
	/** Original Messages SDK request comparisons from independent constructor fixture DATA. */
	readonly messagesHttp?: readonly MessagesHttpBindingInput[];
}
export interface RenderedRequest {
	readonly outboxId: string;
	readonly method: "POST" | "PUT" | "PATCH";
	readonly url: string;
	readonly headers: HeaderList;
	readonly body: Uint8Array;
	readonly mintedAt: number;
	readonly deliverBy: number;
}
export interface Denial {
	readonly sequence: number;
	readonly method: HostMethod | "unknown";
	readonly reason: string;
	readonly lookup: number | null;
}
export interface MockHost extends HostChannel {
	readonly denials: readonly Denial[];
	readonly logs: readonly { readonly level: string; readonly message: string }[];
	readonly progress: readonly {
		readonly token: string | number;
		readonly progress: number;
		readonly total?: number;
	}[];
	readonly disabled: boolean;
	readonly alerts: readonly { readonly reason: TicketMismatch }[];
	readonly auditComplete: boolean;
	/** Trusted test state only; never supplied to a plugin's context or metadata. */
	mintTicket(rendered: RenderedRequest): SendTicket;
	/** Seeds normative negative vectors, including deliberately invalid stored ticket metadata. */
	seedTicket(ticket: unknown, renderedHeaders: HeaderList): void;
	hasTicket(ticketId: string): boolean;
	/** Trusted test blob state, for the existing Bytes/ref interface; no disk storage. */
	putBlob(bytes: Uint8Array): { readonly ref: string };
	readBlob(ref: string): Uint8Array | undefined;
}
export interface MockHub {
	readonly host: MockHost;
	readonly manifest: PluginManifestV1;
	/** Constructor-owned process I/O observation; absent for in-memory transports. */
	readonly process?: MockProcessHandle;
	discover(): Promise<Record<string, unknown>>;
	listTools(): Promise<Record<string, unknown>>;
	call(
		name: string,
		args: Record<string, unknown>,
		meta?: Record<string, unknown>,
		options?: MockCallOptions,
	): Promise<Record<string, unknown>>;
	close(): Promise<void>;
}
export interface MockProcessObservation {
	readonly started: boolean;
	readonly inputEndRequested: boolean;
	readonly inputFinished: boolean;
	readonly kind: "fifo" | "pipe" | null;
	readonly originalExit: Readonly<{
		observed: boolean;
		code: number | null;
		signal: NodeJS.Signals | null;
	}>;
	readonly originalClose: Readonly<{
		observed: boolean;
		code: number | null;
		signal: NodeJS.Signals | null;
	}>;
	readonly outputEnd: readonly [boolean, boolean];
	readonly stdio: PluginStdioResult | null;
	readonly forcedSignals: readonly NodeJS.Signals[];
}
export interface MockProcessHandle {
	/** End the real input without a termination-signal fallback. */
	endInput(): Promise<MockProcessObservation>;
	/** Actual child close and protocol-I/O completion, or sealed never-started ownership. */
	readonly whenClosed: Promise<MockProcessObservation>;
}
export interface MockProgressNotification {
	readonly jsonrpc: "2.0";
	readonly method: "notifications/progress";
	readonly params: {
		readonly progressToken: string | number;
		readonly progress: number;
		readonly total?: number;
	};
}
export interface MockCallOptions {
	/** Observes validated process-wire receipt, independently of private client handling. */
	readonly onProgress?: (notification: MockProgressNotification) => void;
	/** Cancels the originating request; not a committed lease's owner lifetime. */
	readonly signal?: AbortSignal;
}

export class MockHubError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(`Mock hub: ${code}`);
		this.code = code;
	}
}

const nativeSignalPrototype = AbortSignal.prototype;
const nativeSignalAny = AbortSignal.any.bind(AbortSignal);
const nativeSignalAborted = Object.getOwnPropertyDescriptor(nativeSignalPrototype, "aborted")?.get;
const nativeSetSize = Object.getOwnPropertyDescriptor(Set.prototype, "size")?.get;
const nativeMapSize = Object.getOwnPropertyDescriptor(Map.prototype, "size")?.get;
const nativeSetValues = Set.prototype.values;
const nativeSetNext = Object.getPrototypeOf(new Set().values()).next as (
	this: object,
) => IteratorResult<unknown>;
const nativeWeakDeref = WeakRef.prototype.deref;
type SignalContainer = "set" | "map" | "weakref";
interface NativePrototype {
	readonly value: object;
	readonly parent: object | null;
	readonly slots: ReadonlyMap<PropertyKey, PropertyDescriptor>;
}
function sameSlot(
	left: PropertyDescriptor | undefined,
	right: PropertyDescriptor | undefined,
): boolean {
	return (
		left !== undefined &&
		right !== undefined &&
		left.value === right.value &&
		left.get === right.get &&
		left.set === right.set &&
		left.writable === right.writable &&
		left.enumerable === right.enumerable &&
		left.configurable === right.configurable
	);
}
function prototypeChain(value: object): readonly NativePrototype[] {
	const chain: NativePrototype[] = [];
	for (
		let current = Object.getPrototypeOf(value);
		current !== null;
		current = Object.getPrototypeOf(current)
	) {
		if (chain.length >= 8) throw new MockHubError("PROCESS_SIGNAL_INVALID");
		chain.push({
			value: current,
			parent: Object.getPrototypeOf(current),
			slots: new Map(
				Reflect.ownKeys(current).map((key) => [
					key,
					Object.getOwnPropertyDescriptor(current, key)!,
				]),
			),
		});
	}
	return chain;
}

// Discover native DATA roles from private fresh examples, without reading Node internals.
const callerSignalPolicy = isPluginNodeVersionSupported(process.versions.node)
	? (() => {
			const reason = Object.freeze(Object.create(null));
			const ended = AbortSignal.abort(reason);
			const reasonKey = Reflect.ownKeys(ended).find(
				(key) => Object.getOwnPropertyDescriptor(ended, key)?.value === reason,
			);
			const source = new AbortController().signal;
			const composite = nativeSignalAny([source]);
			const linkedSetKey = (signal: AbortSignal, target: AbortSignal): PropertyKey => {
				const found = Reflect.ownKeys(signal).filter((key) => {
					const value: unknown = Object.getOwnPropertyDescriptor(signal, key)?.value;
					try {
						if (Reflect.apply(nativeSetSize!, value, []) !== 1) return false;
						const iterator = Reflect.apply(nativeSetValues, value, []);
						const first = Reflect.apply(nativeSetNext, iterator, []);
						return !first.done && Reflect.apply(nativeWeakDeref, first.value, []) === target;
					} catch {
						return false;
					}
				});
				if (found.length !== 1) throw new MockHubError("PROCESS_SIGNAL_INVALID");
				return found[0]!;
			};
			const sourceSetKey = linkedSetKey(composite, source);
			const dependantSetKey = linkedSetKey(source, composite);
			if (sourceSetKey === dependantSetKey) throw new MockHubError("PROCESS_SIGNAL_INVALID");
			const events = new AbortController().signal;
			events.addEventListener("abort", () => {});
			events.onabort = () => {};
			const timeout = AbortSignal.timeout(0);
			const examples = [source, composite, events, ended, timeout];
			const rules = new Map<PropertyKey, { slot: PropertyDescriptor; kinds: Set<string> }>();
			const containers = new Map<
				object,
				{
					kind: SignalContainer;
					chain: readonly NativePrototype[];
					iteratorChain: readonly NativePrototype[];
				}
			>();
			for (const signal of examples)
				for (const key of Reflect.ownKeys(signal)) {
					const slot = Object.getOwnPropertyDescriptor(signal, key)!;
					const rule = rules.get(key) ?? { slot, kinds: new Set<string>() };
					if (slot.value !== null && typeof slot.value === "object" && key !== reasonKey) {
						let kind: SignalContainer;
						try {
							Reflect.apply(nativeSetSize!, slot.value, []);
							kind = "set";
						} catch {
							try {
								Reflect.apply(nativeMapSize!, slot.value, []);
								kind = "map";
							} catch {
								Reflect.apply(nativeWeakDeref, slot.value, []);
								kind = "weakref";
							}
						}
						const prototype = Object.getPrototypeOf(slot.value);
						const iterator =
							kind === "weakref"
								? undefined
								: Reflect.apply(
										Object.getOwnPropertyDescriptor(prototype, Symbol.iterator)!.value,
										slot.value,
										[],
									);
						if (iterator !== undefined && (iterator === null || typeof iterator !== "object"))
							throw new MockHubError("PROCESS_SIGNAL_INVALID");
						containers.set(prototype, {
							kind,
							chain: prototypeChain(slot.value),
							iteratorChain: iterator === undefined ? [] : prototypeChain(iterator),
						});
						rule.kinds.add(kind);
					} else rule.kinds.add(typeof slot.value);
					rules.set(key, rule);
				}
			const fresh = new AbortController().signal;
			return {
				reasonKey,
				sourceSetKey,
				dependantSetKey,
				rules,
				containers,
				required: Reflect.ownKeys(fresh),
				chain: prototypeChain(fresh),
			};
		})()
	: undefined;

/** Validate the bounded native signal graph before either native getter or any(). */
function validateCallerSignal(raw: unknown): void {
	const policy = callerSignalPolicy;
	if (policy === undefined) throw new MockHubError("PROCESS_NODE_UNSUPPORTED");
	const invalid: () => never = () => {
		throw new MockHubError("PROCESS_SIGNAL_INVALID");
	};
	const visited = new Set<object>();
	const checkedChains = new Set<object>();
	let references = 0;
	let dependantReferences = 0;
	const checkChain = (chain: readonly NativePrototype[]): void => {
		for (const record of chain) {
			if (checkedChains.has(record.value)) continue;
			if (Object.getPrototypeOf(record.value) !== record.parent) invalid();
			const keys = Reflect.ownKeys(record.value);
			if (keys.length !== record.slots.size) invalid();
			for (const key of keys)
				if (!sameSlot(Object.getOwnPropertyDescriptor(record.value, key), record.slots.get(key)))
					invalid();
			checkedChains.add(record.value);
		}
	};
	const weakTarget = (value: object, sourceReference = true): unknown => {
		if (isProxy(value)) invalid();
		const template = policy.containers.get(Object.getPrototypeOf(value));
		if (!template || template.kind !== "weakref" || Reflect.ownKeys(value).length) invalid();
		checkChain(template.chain);
		if (sourceReference ? ++references > 256 : ++dependantReferences > 4096) invalid();
		return Reflect.apply(nativeWeakDeref, value, []);
	};
	const visit = (value: unknown): void => {
		if (
			value === null ||
			typeof value !== "object" ||
			isProxy(value) ||
			Object.getPrototypeOf(value) !== nativeSignalPrototype
		)
			invalid();
		if (visited.has(value)) return;
		if (visited.size >= 64) invalid();
		visited.add(value);
		checkChain(policy.chain);
		const keys = Reflect.ownKeys(value);
		if (keys.length > 32 || policy.required.some((key) => !Object.hasOwn(value, key))) invalid();
		for (const key of keys) {
			const slot = Object.getOwnPropertyDescriptor(value, key);
			const rule = policy.rules.get(key);
			if (
				!slot ||
				!Object.hasOwn(slot, "value") ||
				!rule ||
				slot.enumerable !== rule.slot.enumerable ||
				slot.configurable !== rule.slot.configurable ||
				slot.writable !== rule.slot.writable
			)
				invalid();
			// Abort reasons are opaque DATA; copying must never classify or traverse them.
			if (key === policy.reasonKey) continue;
			const item: unknown = slot.value;
			if (item === null || typeof item !== "object") {
				if (!rule.kinds.has(typeof item)) invalid();
				continue;
			}
			if (isProxy(item) || Reflect.ownKeys(item).length) invalid();
			const template = policy.containers.get(Object.getPrototypeOf(item));
			if (!template || !rule.kinds.has(template.kind)) invalid();
			checkChain(template.chain);
			checkChain(template.iteratorChain);
			if (template.kind === "weakref") {
				const target = weakTarget(item);
				if (target !== undefined) visit(target);
			} else if (template.kind === "set") {
				const sourceSet = key === policy.sourceSetKey;
				if (!sourceSet && key !== policy.dependantSetKey) invalid();
				// Historical dependants are not native getter/any() traversal sources.
				// Check their container/WeakRef brands, with a separate finite fixture cap.
				if (Reflect.apply(nativeSetSize!, item, []) > (sourceSet ? 64 : 4096)) invalid();
				const iterator = Reflect.apply(nativeSetValues, item, []);
				for (;;) {
					const next = Reflect.apply(nativeSetNext, iterator, []);
					if (next.done) break;
					if (next.value === null || typeof next.value !== "object" || isProxy(next.value))
						invalid();
					const target = weakTarget(next.value, sourceSet);
					if (sourceSet && target !== undefined) visit(target);
				}
			} else Reflect.apply(nativeMapSize!, item, []);
		}
	};
	visit(raw);
}

function copyCallerSignal(raw: unknown): AbortSignal | undefined {
	if (raw === undefined) return undefined;
	if (callerSignalPolicy === undefined) throw new MockHubError("PROCESS_NODE_UNSUPPORTED");
	const invalid = (): never => {
		throw new MockHubError("PROCESS_SIGNAL_INVALID");
	};
	try {
		validateCallerSignal(raw);
		if (typeof nativeSignalAborted?.call(raw) !== "boolean") invalid();
		return nativeSignalAny([raw as AbortSignal]);
	} catch {
		return invalid();
	}
}

export function copyMockCallOptions(
	options: MockCallOptions | undefined,
): MockCallOptions | undefined {
	if (options === undefined) return undefined;
	if (options === null || typeof options !== "object" || isProxy(options))
		throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const prototype = Object.getPrototypeOf(options);
	if (prototype !== Object.prototype && prototype !== null)
		throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const keys = Reflect.ownKeys(options);
	if (keys.some((key) => key !== "onProgress" && key !== "signal"))
		throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const slot = Object.getOwnPropertyDescriptor(options, "onProgress");
	if (slot && !Object.hasOwn(slot, "value")) throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const callback: unknown = slot?.value;
	if (callback !== undefined && typeof callback !== "function")
		throw new MockHubError("PROCESS_PROGRESS_INVALID");
	const signalSlot = Object.getOwnPropertyDescriptor(options, "signal");
	if (signalSlot && !Object.hasOwn(signalSlot, "value"))
		throw new MockHubError("PROCESS_SIGNAL_INVALID");
	const signal = copyCallerSignal(signalSlot?.value);
	return callback === undefined && signal === undefined
		? undefined
		: Object.freeze({
				...(callback === undefined
					? {}
					: { onProgress: callback as NonNullable<MockCallOptions["onProgress"]> }),
				...(signal === undefined ? {} : { signal }),
			});
}

/** Copies trusted binding inputs from own data properties without invoking caller hooks. */
export function copyResponsesHttpInputs(value: unknown): readonly ResponsesHttpBindingInput[] {
	const invalid: () => never = () => {
		throw new MockHubError("INVALID_RESPONSES_BINDINGS");
	};
	if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		invalid();
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > HOST_MAX_ACTIVE_REQUESTS ||
		Reflect.ownKeys(value).length !== length + 1
	)
		invalid();
	const inputs: ResponsesHttpBindingInput[] = [];
	for (let index = 0; index < length; index++) {
		const slot = Object.getOwnPropertyDescriptor(value, String(index));
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) invalid();
		inputs.push(slot.value);
	}
	return Object.freeze(inputs);
}

/** Capture the independent fixture DATA before other option reads can change it. */
export function copyCompatibleHttpInputs(value: unknown): readonly CompatibleHttpBindingInput[] {
	const invalid: () => never = () => {
		throw new MockHubError("INVALID_COMPATIBLE_BINDINGS");
	};
	if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		invalid();
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > HOST_MAX_ACTIVE_REQUESTS ||
		Reflect.ownKeys(value).length !== length + 1
	)
		invalid();
	const inputs: CompatibleHttpBindingInput[] = [];
	for (let index = 0; index < length; index++) {
		const slot = Object.getOwnPropertyDescriptor(value, String(index));
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) invalid();
		try {
			inputs.push(snapshotCompatibleHttpInput(slot.value));
		} catch {
			invalid();
		}
	}
	return Object.freeze(inputs);
}
export function copyMessagesHttpInputs(value: unknown): readonly MessagesHttpBindingInput[] {
	const invalid: () => never = () => {
		throw new MockHubError("INVALID_MESSAGES_BINDINGS");
	};
	if (isProxy(value) || !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
		invalid();
	const length: unknown = Object.getOwnPropertyDescriptor(value, "length")?.value;
	if (
		typeof length !== "number" ||
		!Number.isSafeInteger(length) ||
		length < 0 ||
		length > HOST_MAX_ACTIVE_REQUESTS ||
		Reflect.ownKeys(value).length !== length + 1
	)
		invalid();
	const inputs: MessagesHttpBindingInput[] = [];
	for (let index = 0; index < length; index++) {
		const slot = Object.getOwnPropertyDescriptor(value, String(index));
		if (!slot?.enumerable || !Object.hasOwn(slot, "value")) invalid();
		try {
			inputs.push(snapshotMessagesHttpInput(slot.value));
		} catch {
			invalid();
		}
	}
	return Object.freeze(inputs);
}
