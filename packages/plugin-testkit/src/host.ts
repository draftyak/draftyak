import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { types } from "node:util";
import type { Fake } from "@draftyak/fakes";
import { type HeaderList, headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import {
	HOST_MAX_ACTIVE_REQUESTS,
	HOST_MAX_STREAM_BYTES,
	HOST_METHOD_SCHEMAS,
	type HostErrorCode,
	type HostFetchParams,
	type HostFetchResult,
	HostHeaders,
	type HostMethod,
	type HostMethods,
	jsonCopy,
	parseHostResult,
} from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import {
	createResponsesHttpBinding,
	type ResponsesHttpBinding,
	type ResponsesHttpBindingInput,
} from "@draftyak/protocol/manifest/responses-http";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { Ulid } from "@draftyak/protocol/scalars";
import {
	presentedTicketId,
	SendTicket,
	sendTicketExp,
	TICKET_DISABLES_PLUGIN,
	type TicketMismatch,
	ticketMismatch,
} from "@draftyak/protocol/send-ticket";
import {
	checkUrlSecret,
	keepToolHeaders,
	TOOL_REQUEST_HEADERS,
	TOOL_REQUESTS_PER_LOOKUP,
	TOOL_RESPONSE_HEADERS,
	type ToolKind,
	toolKindsV1,
} from "@draftyak/protocol/tool-v1";
import { HostError, type HostRequestOptions, memoryHost } from "@draftyak/sdk";
import { matchRequest } from "./policy.ts";
import {
	copyResponsesHttpInputs,
	type Denial,
	type MockAccount,
	type MockHost,
	MockHubError,
	type RenderedRequest,
} from "./types.ts";

interface Lookup {
	readonly id: number;
	readonly generation: symbol;
	readonly instance: string;
	readonly account: MockAccount | undefined;
	readonly kind: ToolKind | undefined;
	readonly argumentsDigest: string;
	readonly controller: AbortController;
	readonly deadline: number;
	readonly permit: string | undefined;
	active: boolean;
	requests: number;
	pending: number;
}
interface Attempt {
	scope?: Lookup;
	reason?: string;
	signal?: AbortSignal;
}
class Refusal extends HostError {
	readonly reason: string;
	constructor(reason: string, code: HostErrorCode = "DENIED") {
		super(code);
		this.reason = reason;
	}
}
const STATE_LIMIT = 1024;
const BODY_LIMIT = 35 * 1024 ** 2;
const STATE_BYTES = 64 * 1024 ** 2;
const STREAM_DATA_CHUNK_LIMIT = 65_536;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
const streamBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const streamOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const streamLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;
const validateStreamView = Uint8Array.prototype.values;
const copyStreamBytes = Uint8Array.prototype.set;

function captureStreamChunk(value: unknown, remaining: number): Uint8Array {
	try {
		if (types.isProxy(value) || !types.isUint8Array(value)) throw new HostError("BAD_REQUEST");
		// Iterator creation validates detached and out-of-bounds views without reading caller fields.
		Reflect.apply(validateStreamView, value, []);
		const buffer: unknown = streamBuffer && Reflect.apply(streamBuffer, value, []);
		const offset: unknown = streamOffset && Reflect.apply(streamOffset, value, []);
		const length: unknown = streamLength && Reflect.apply(streamLength, value, []);
		if (
			!types.isAnyArrayBuffer(buffer) ||
			types.isSharedArrayBuffer(buffer) ||
			typeof offset !== "number" ||
			typeof length !== "number"
		)
			throw new HostError("BAD_REQUEST");
		if (length > remaining) throw new HostError("TOO_LARGE");
		const copy = new Uint8Array(length);
		Reflect.apply(copyStreamBytes, copy, [new Uint8Array(buffer as ArrayBuffer, offset, length)]);
		return copy;
	} catch (error) {
		throw error instanceof HostError ? error : new HostError("BAD_REQUEST");
	}
}
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function id(): string {
	let number = BigInt(`0x${randomBytes(16).toString("hex")}`);
	let text = "";
	for (let index = 0; index < 26; index++) {
		text = ALPHABET[Number(number & 31n)] + text;
		number >>= 5n;
	}
	return text;
}
function copyHeaders(input: HeaderList): HeaderList {
	return Object.freeze(HostHeaders.parse(jsonCopy(input)).map((row) => Object.freeze(row)));
}
// The channel parses a reply only after the handler returns; check status and headers first.
function representable(reply: { readonly status: number; readonly headers: HeaderList }): boolean {
	try {
		parseHostResult("host/fetch", { ...reply, body: { base64: "" } });
		return true;
	} catch {
		return false;
	}
}
async function interrupted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) throw signal.reason;
	let stop: () => void = () => {};
	try {
		const value = await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				stop = () => reject(signal.reason);
				signal.addEventListener("abort", stop, { once: true });
			}),
		]);
		if (signal.aborted) throw signal.reason;
		return value;
	} finally {
		signal.removeEventListener("abort", stop);
	}
}

export function createMockHost(
	options: {
		readonly manifest: PluginManifestV1;
		readonly account?: MockAccount;
		readonly instance: string;
		readonly upstreams: readonly Fake[];
		readonly secrets?: Readonly<Record<string, string>>;
		readonly responsesHttp?: readonly ResponsesHttpBindingInput[];
	},
	controls: { readonly entropy?: () => Uint8Array } = {},
): {
	readonly host: MockHost;
	lookup<T>(
		action: (signal: AbortSignal, permit?: string) => Promise<T>,
		kind?: ToolKind,
		args?: unknown,
	): Promise<T>;
} {
	const manifest = options.manifest;
	const bindingSlot = Object.getOwnPropertyDescriptor(options, "responsesHttp");
	if (bindingSlot && !Object.hasOwn(bindingSlot, "value"))
		throw new MockHubError("INVALID_RESPONSES_BINDINGS");
	const inputs = bindingSlot?.value === undefined ? [] : copyResponsesHttpInputs(bindingSlot.value);
	if (
		inputs.length > 0 &&
		(manifest.kind !== "ai-provider" || manifest.egress.profile !== "responses-api-v1")
	)
		throw new MockHubError("INVALID_RESPONSES_BINDINGS");
	const responsesBindings: ResponsesHttpBinding[] = [];
	for (const input of inputs) {
		const issued = createResponsesHttpBinding(input);
		if (!issued.ok) throw new MockHubError("INVALID_RESPONSES_BINDINGS");
		responsesBindings.push(issued.binding);
	}
	Object.freeze(responsesBindings);
	const generation = Symbol();
	const account = options.account ? Object.freeze({ ...options.account }) : undefined;
	if (!Ulid.safeParse(options.instance).success) throw new MockHubError("INVALID_INSTANCE");
	const upstreams = new Map(options.upstreams.map((upstream) => [upstream.host, upstream]));
	if (upstreams.size !== options.upstreams.length || upstreams.size > 64)
		throw new MockHubError("INVALID_UPSTREAMS");
	const secrets = new Map<string, string>();
	for (const [name, value] of Object.entries(options.secrets ?? {})) {
		if (!manifest.credentials.urlSecrets.some((row) => row.name === name))
			throw new MockHubError("UNDECLARED_SECRET");
		const checked = checkUrlSecret(value);
		if (!checked.ok) throw new MockHubError(checked.refusal);
		secrets.set(name, checked.url);
	}
	const scopes = new AsyncLocalStorage<Lookup>();
	const attempts = new AsyncLocalStorage<Attempt>();
	const retained = new Set<Lookup>();
	const grants = new Map<string, Lookup>();
	const reserved = new Set<string>();
	const tickets = new Map<string, { ticket: SendTicket; headers: HeaderList }>();
	const blobs = new Map<string, Uint8Array>();
	const kv = new Map<string, unknown>();
	const denials: Denial[] = [];
	const alerts: { readonly reason: TicketMismatch }[] = [];
	const logs: { level: string; message: string }[] = [];
	const progress: { token: string | number; progress: number; total?: number }[] = [];
	let closed = false,
		disabled = false,
		auditComplete = true,
		nextLookup = 0,
		blobBytes = 0;
	const streams = new Set<() => void>();
	const incrementalStreams = new Set<object>();
	const elapsed = (): number => performance.now();
	const release = (scope: Lookup): void => {
		if (scope.active || scope.pending !== 0) return;
		retained.delete(scope);
		if (scope.permit !== undefined) reserved.delete(scope.permit);
	};
	const own = <T>(scope: Lookup | undefined, work: Promise<T>): Promise<T> => {
		if (!scope) return work;
		scope.pending++;
		const settled = (): void => {
			scope.pending--;
			release(scope);
		};
		void work.then(settled, settled);
		return work;
	};
	const retire = (scope: Lookup, reason: HostError): void => {
		scope.active = false;
		if (scope.permit !== undefined) grants.delete(scope.permit);
		scope.controller.abort(reason);
		release(scope);
	};
	const disable = (): void => {
		disabled = true;
		for (const scope of retained) retire(scope, new HostError("DENIED"));
	};
	const recordDenial = (method: HostMethod, reason: string, scope?: Lookup): void => {
		if (denials.length < 4096)
			denials.push(
				Object.freeze({
					sequence: denials.length,
					method: Object.hasOwn(HOST_METHOD_SCHEMAS, method) ? method : "unknown",
					reason,
					lookup: scope?.id ?? null,
				}),
			);
		else {
			auditComplete = false;
			disable();
		}
	};
	const deny = (reason: string, code?: HostErrorCode): never => {
		const attempt = attempts.getStore();
		if (attempt) attempt.reason = reason;
		throw new Refusal(reason, code);
	};
	const putBlob = (bytes: Uint8Array): { readonly ref: string } => {
		if (
			closed ||
			!(bytes instanceof Uint8Array) ||
			bytes.byteLength > BODY_LIMIT ||
			blobs.size >= STATE_LIMIT ||
			bytes.byteLength > STATE_BYTES - blobBytes
		)
			throw new MockHubError("BLOB_LIMIT");
		const ref = id();
		blobs.set(ref, Uint8Array.from(bytes));
		blobBytes += bytes.byteLength;
		return Object.freeze({ ref });
	};
	const bodyOf = (body: HostFetchParams["body"]): Uint8Array => {
		if (!body) return new Uint8Array();
		if ("base64" in body) return Buffer.from(body.base64, "base64url");
		const bytes = blobs.get(body.ref);
		return bytes ? Uint8Array.from(bytes) : deny("BODY_REF_UNKNOWN");
	};
	const takeTicket = (
		params: HostFetchParams,
	): { ticket: SendTicket; headers: HeaderList } | undefined => {
		const presented = presentedTicketId(params.sendTicket);
		const found = presented === undefined ? undefined : tickets.get(presented);
		if (presented !== undefined && found) tickets.delete(presented);
		return found;
	};
	const consumeTicket = (
		params: HostFetchParams,
		bytes: Uint8Array,
		found?: { ticket: SendTicket; headers: HeaderList },
	): HeaderList => {
		const contentTypes = params.headers.filter(([name]) => name.toLowerCase() === "content-type");
		const headers = found?.headers ?? [];
		const mismatch = ticketMismatch(
			found?.ticket,
			{
				ticket: params.sendTicket,
				instanceId: options.instance,
				method: params.method,
				url: params.url,
				contentType: contentTypes.length === 1 ? (contentTypes[0]?.[1] ?? "") : "",
				headers,
				body: bytes,
			},
			Date.now(),
		);
		if (mismatch) {
			if (TICKET_DISABLES_PLUGIN.includes(mismatch)) {
				const attempt = attempts.getStore();
				if (attempt) attempt.reason = mismatch;
				disable();
				alerts.push(Object.freeze({ reason: mismatch }));
			}
			return deny(mismatch);
		}
		return headers;
	};
	const queueStream = (
		bytes: Uint8Array,
		signal: AbortSignal,
		deadline: number,
		scope?: Lookup,
	): string => {
		const streamId = id();
		let position = 0,
			sequence = 0;
		let immediate: NodeJS.Immediate | undefined;
		const done = Promise.withResolvers<void>();
		own(scope, done.promise);
		const cancel = (): void => {
			if (immediate) clearImmediate(immediate);
			streams.delete(cancel);
			signal.removeEventListener("abort", cancel);
			done.resolve();
		};
		const schedule = (): void => {
			immediate = setImmediate(() => {
				if (closed || signal.aborted || (scope && !scope.active)) {
					cancel();
					return;
				}
				if (elapsed() >= deadline) {
					base.notify({
						jsonrpc: "2.0",
						method: "host/stream.chunk",
						params: {
							streamId,
							sequence: sequence++,
							base64: "",
							done: true,
							error: "TIMEOUT",
						},
					});
					cancel();
					if (scope && elapsed() >= scope.deadline)
						retire(scope, new Refusal("LOOKUP_TIMEOUT", "TIMEOUT"));
					return;
				}
				const chunk = bytes.subarray(position, position + MAX_INLINE_BYTES);
				position += chunk.length;
				base.notify({
					jsonrpc: "2.0",
					method: "host/stream.chunk",
					params: {
						streamId,
						sequence: sequence++,
						base64: Buffer.from(chunk).toString("base64url"),
						done: position === bytes.length,
					},
				});
				if (position < bytes.length) schedule();
				else cancel();
			});
		};
		streams.add(cancel);
		signal.addEventListener("abort", cancel, { once: true });
		schedule();
		return streamId;
	};
	const fetch = async (
		params: HostFetchParams,
		parentSignal: AbortSignal,
		scope: Lookup | undefined,
	): Promise<HostFetchResult> => {
		const foundTicket = takeTicket(params);
		if (manifest.kind !== "tool" && params.lookupPermit !== undefined)
			return deny("LOOKUP_PERMIT_FORBIDDEN");
		if (params.saveAs !== undefined && params.saveAs !== "blob")
			return deny("STORAGE_MODE_UNSUPPORTED", "UNSUPPORTED");
		if (manifest.kind === "tool") {
			if (
				!["GET", "HEAD"].includes(params.method) ||
				params.saveAs !== undefined ||
				params.sendTicket !== undefined
			)
				return deny("TOOL_FETCH_FORBIDDEN");
		}
		const body = bodyOf(params.body);
		// Presented tickets are consumed even when a subsequent policy check refuses the request.
		let ticketHeaders =
			params.sendTicket === undefined ? undefined : consumeTicket(params, body, foundTicket);
		const matched = matchRequest(manifest, params.url, params.method, secrets, {
			bindings: responsesBindings,
			headers: params.headers,
			body,
		});
		if (!matched) return deny("OFF_RULE");
		const { rule, url } = matched;
		if (rule.class === "organize" && account?.mode !== "full") return deny("FULL_MODE_REQUIRED");
		if (rule.class === "send") {
			if (manifest.kind !== "channel" || !manifest.send) return deny("RENDERER_REQUIRED");
			ticketHeaders ??= consumeTicket(params, body);
		}
		if (body.byteLength > rule.maxBytes) return deny("REQUEST_TOO_LARGE", "TOO_LARGE");
		const upstream = upstreams.get(new URL(url).hostname);
		if (!upstream) return deny("UPSTREAM_UNAVAILABLE");
		const now = elapsed();
		const deadline = Math.min(now + rule.timeoutMs, scope?.deadline ?? now + 30_000);
		const budget = deadline - now;
		if (budget <= 0) return deny("FETCH_TIMEOUT", "TIMEOUT");
		const timeout = new AbortController();
		const originalSignal = attempts.getStore()?.signal;
		const signal = AbortSignal.any([
			parentSignal,
			...(originalSignal ? [originalSignal] : []),
			timeout.signal,
			...(scope ? [scope.controller.signal] : []),
		]);
		const timer = setTimeout(() => timeout.abort(new Refusal("FETCH_TIMEOUT", "TIMEOUT")), budget);
		const reservation = params.stream === true && params.saveAs === undefined ? {} : undefined;
		if (reservation && incrementalStreams.size >= HOST_MAX_ACTIVE_REQUESTS) {
			clearTimeout(timer);
			return deny("STREAM_LIMIT", "TOO_LARGE");
		}
		if (reservation) incrementalStreams.add(reservation);
		let pending = 0;
		let retired = false;
		const releaseStream = (): void => {
			if (reservation && retired && pending === 0) incrementalStreams.delete(reservation);
		};
		const track = <T>(work: Promise<T>): Promise<T> => {
			pending++;
			const settled = (): void => {
				pending--;
				releaseStream();
			};
			void work.then(settled, settled);
			return own(scope, work);
		};
		const admit = (): void => {
			if (signal.aborted) throw signal.reason;
			if (elapsed() >= deadline) {
				const attempt = attempts.getStore();
				if (attempt) attempt.reason = "FETCH_TIMEOUT";
				const failure = new Refusal("FETCH_TIMEOUT", "TIMEOUT");
				if (scope && elapsed() >= scope.deadline) retire(scope, failure);
				throw failure;
			}
			if (scope && !scope.active) deny("LOOKUP_ENDED");
		};
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		let transferred = false;
		try {
			const allowed =
				manifest.kind === "tool"
					? TOOL_REQUEST_HEADERS
					: ["accept", "content-type", "if-none-match", "if-modified-since"];
			const headers =
				manifest.kind === "ai-provider" && manifest.egress.profile === "responses-api-v1"
					? params.headers
					: (ticketHeaders ?? keepToolHeaders(params.headers, allowed));
			admit();
			const response = await interrupted(
				track(
					Promise.resolve()
						.then(() => {
							admit();
							return upstream.fetch(url, {
								method: params.method,
								headers: headers as [string, string][],
								...(body.length ? { body: body as BodyInit } : {}),
								redirect: "manual",
								signal,
							});
						})
						.then((response) => {
							if (closed || signal.aborted || elapsed() >= deadline || (scope && !scope.active))
								track(response.body?.cancel().catch(() => {}) ?? Promise.resolve());
							return response;
						}),
				),
				signal,
			);
			reader = response.body?.getReader();
			admit();
			if (response.status >= 300 && response.status < 400 && response.status !== 304)
				return deny("REDIRECT_REFUSED");
			const responseHeaders = keepToolHeaders(
				[...response.headers.entries()],
				manifest.kind === "tool"
					? TOOL_RESPONSE_HEADERS
					: ["content-type", "etag", "last-modified", "content-length"],
			);
			const common = { status: response.status, headers: responseHeaders };
			if (!representable(common)) return deny("RESPONSE_INVALID", "BAD_REQUEST");
			admit();
			if (reservation) {
				const streamId = id();
				const ownedReader = reader;
				let sequence = 0;
				let total = 0;
				let dataChunks = 0;
				let emittedChunks = 0;
				let ended = false;
				let immediate: NodeJS.Immediate | undefined;
				const done = Promise.withResolvers<void>();
				track(done.promise);
				const finish = (error?: HostErrorCode, denial?: string): void => {
					if (ended) return;
					ended = true;
					if (immediate) clearImmediate(immediate);
					clearTimeout(timer);
					signal.removeEventListener("abort", cancel);
					streams.delete(cancel);
					if (denial !== undefined) recordDenial("host/fetch", denial, scope);
					if (!closed)
						base.notify({
							jsonrpc: "2.0",
							method: "host/stream.chunk",
							params: {
								streamId,
								sequence: sequence++,
								base64: "",
								done: true,
								...(error ? { error } : {}),
							},
						});
					const cancellation = ownedReader?.cancel().catch(() => {}) ?? Promise.resolve();
					track(cancellation).finally(() => {
						ownedReader?.releaseLock();
						retired = true;
						done.resolve();
						releaseStream();
					});
				};
				const cancel = (): void => {
					const reason: unknown = signal.reason;
					if (
						reason instanceof Refusal &&
						reason.code === "TIMEOUT" &&
						((timeout.signal.aborted && reason === timeout.signal.reason) ||
							(scope?.controller.signal.aborted && reason === scope.controller.signal.reason))
					)
						finish("TIMEOUT", reason.reason);
					else finish("DENIED");
				};
				streams.add(cancel);
				signal.addEventListener("abort", cancel, { once: true });
				const pump = async (): Promise<void> => {
					try {
						while (!ended) {
							admit();
							let next: ReadableStreamReadResult<Uint8Array>;
							try {
								next = ownedReader
									? await interrupted(track(ownedReader.read()), signal)
									: { done: true, value: undefined };
							} catch {
								if (signal.aborted) cancel();
								else finish("DENIED", "UPSTREAM_FAILED");
								return;
							}
							if (ended) return;
							admit();
							if (next.done) return finish();
							if (++dataChunks > STREAM_DATA_CHUNK_LIMIT)
								return finish("TOO_LARGE", "RESPONSE_TOO_LARGE");
							const chunk = captureStreamChunk(
								next.value,
								Math.min(rule.maxBytes, HOST_MAX_STREAM_BYTES) - total,
							);
							total += chunk.byteLength;
							for (let position = 0; position < chunk.byteLength; position += MAX_INLINE_BYTES) {
								admit();
								if (ended) return;
								if (++emittedChunks > STREAM_DATA_CHUNK_LIMIT)
									return finish("TOO_LARGE", "RESPONSE_TOO_LARGE");
								base.notify({
									jsonrpc: "2.0",
									method: "host/stream.chunk",
									params: {
										streamId,
										sequence: sequence++,
										base64: Buffer.from(
											chunk.subarray(position, position + MAX_INLINE_BYTES),
										).toString("base64url"),
										done: false,
									},
								});
							}
						}
					} catch (error) {
						if (signal.aborted) cancel();
						else if (error instanceof Refusal) finish(error.code, error.reason);
						else if (error instanceof HostError)
							finish(
								error.code,
								error.code === "TOO_LARGE" ? "RESPONSE_TOO_LARGE" : "UPSTREAM_FAILED",
							);
						else finish("DENIED", "UPSTREAM_FAILED");
					}
				};
				transferred = true;
				immediate = setImmediate(() => {
					void pump();
				});
				if (signal.aborted) cancel();
				return { ...common, streamId };
			}
			const chunks: Uint8Array[] = [];
			let total = 0;
			while (reader) {
				const next = await interrupted(own(scope, reader.read()), signal);
				admit();
				if (next.done) break;
				if (next.value.byteLength > rule.maxBytes - total)
					return deny("RESPONSE_TOO_LARGE", "TOO_LARGE");
				total += next.value.byteLength;
				chunks.push(next.value);
			}
			const bytes = Buffer.concat(chunks, total);
			admit();
			if (params.saveAs === "blob") return { ...common, body: putBlob(bytes) };
			if (bytes.length <= MAX_INLINE_BYTES)
				return { ...common, body: { base64: bytes.toString("base64url") } };
			if (params.stream === false) return deny("INLINE_TOO_LARGE", "TOO_LARGE");
			return { ...common, streamId: queueStream(bytes, signal, deadline, scope) };
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof Refusal) throw error;
			return deny("UPSTREAM_FAILED");
		} finally {
			if (!transferred) {
				clearTimeout(timer);
				const ownedReader = reader;
				if (ownedReader) {
					const cancellation = track(ownedReader.cancel().catch(() => {}));
					if (reservation) void cancellation.then(() => ownedReader.releaseLock());
					else ownedReader.releaseLock();
				}
				retired = true;
				releaseStream();
			}
		}
	};
	const base = memoryHost(async (method, params, signal) => {
		if (closed) return deny("HOST_CLOSED");
		if (disabled) return deny("PLUGIN_DISABLED");
		if (
			manifest.kind === "tool" &&
			!["host/fetch", "host/log", "host/kv.get", "host/kv.set", "host/kv.delete"].includes(method)
		)
			return deny("TOOL_METHOD_FORBIDDEN");
		switch (method) {
			case "host/fetch": {
				const request = params as HostFetchParams;
				const scope =
					manifest.kind === "tool"
						? request.lookupPermit === undefined
							? undefined
							: grants.get(request.lookupPermit)
						: scopes.getStore();
				if (manifest.kind === "tool") {
					if (!scope?.active || scope.controller.signal.aborted) return deny("LOOKUP_REQUIRED");
					const attempt = attempts.getStore();
					if (attempt) attempt.scope = scope;
					if (elapsed() >= scope.deadline) {
						if (attempt) attempt.reason = "FETCH_TIMEOUT";
						const failure = new Refusal("FETCH_TIMEOUT", "TIMEOUT");
						retire(scope, failure);
						throw failure;
					}
					if (++scope.requests > TOOL_REQUESTS_PER_LOOKUP) return deny("LOOKUP_REQUEST_LIMIT");
				}
				return own(scope, fetch(request, signal, scope));
			}
			case "host/log": {
				if (logs.length >= STATE_LIMIT) return deny("LOG_LIMIT", "TOO_LARGE");
				logs.push(jsonCopy(params) as { level: string; message: string });
				return null;
			}
			case "host/progress": {
				if (progress.length >= STATE_LIMIT) return deny("PROGRESS_LIMIT", "TOO_LARGE");
				progress.push(
					jsonCopy(params) as { token: string | number; progress: number; total?: number },
				);
				return null;
			}
			case "host/changed":
				return null;
			case "host/kv.get":
				return { value: jsonCopy(kv.get((params as { key: string }).key) ?? null) };
			case "host/kv.set": {
				const item = params as { key: string; value: unknown };
				if (kv.size >= STATE_LIMIT && !kv.has(item.key)) return deny("KV_LIMIT", "TOO_LARGE");
				if (Buffer.byteLength(JSON.stringify(item.value)) > MAX_INLINE_BYTES)
					return deny("KV_VALUE_LIMIT", "TOO_LARGE");
				kv.set(item.key, jsonCopy(item.value));
				return null;
			}
			case "host/kv.delete":
				kv.delete((params as { key: string }).key);
				return null;
			default:
				return deny("METHOD_UNSUPPORTED", "UNSUPPORTED");
		}
	});
	const host: MockHost = {
		async request<M extends HostMethod>(
			method: M,
			params: HostMethods[M]["params"],
			requestOptions?: HostRequestOptions,
		): Promise<HostMethods[M]["result"]> {
			const attempt: Attempt = {};
			if (manifest.kind !== "tool" || method !== "host/fetch") attempt.scope = scopes.getStore();
			try {
				const signal = requestOptions?.signal;
				const timeoutMs = requestOptions?.timeoutMs;
				attempt.signal = signal;
				return await attempts.run(attempt, () =>
					base.request(
						method,
						params,
						requestOptions === undefined ? undefined : { signal, timeoutMs },
					),
				);
			} catch (error) {
				const failure = error instanceof HostError ? error : new HostError("BAD_REQUEST");
				recordDenial(
					method,
					attempt.reason ??
						(error instanceof Refusal ? error.reason : closed ? "HOST_CLOSED" : failure.code),
					attempt.scope,
				);
				throw failure;
			}
		},
		subscribe: base.subscribe,
		get denials() {
			return Object.freeze([...denials]);
		},
		get logs() {
			return Object.freeze(logs.map((value) => Object.freeze({ ...value })));
		},
		get progress() {
			return Object.freeze(progress.map((value) => Object.freeze({ ...value })));
		},
		get disabled() {
			return disabled;
		},
		get alerts() {
			return Object.freeze([...alerts]);
		},
		get auditComplete() {
			return auditComplete;
		},
		mintTicket(rendered: RenderedRequest) {
			if (closed || manifest.kind !== "channel" || !manifest.send || tickets.size >= STATE_LIMIT)
				throw new MockHubError("TICKET_MINT_REFUSED");
			const headers = copyHeaders(rendered.headers);
			const types = headers.filter(([name]) => name.toLowerCase() === "content-type");
			if (types.length !== 1) throw new MockHubError("TICKET_HEADERS_INVALID");
			const ticket = SendTicket.parse({
				id: id(),
				outboxId: rendered.outboxId,
				instanceId: options.instance,
				method: rendered.method,
				url: rendered.url,
				headersSha256: headersSha256(headers),
				contentType: types[0]?.[1],
				bodySha256: sha256Hex(rendered.body),
				exp: sendTicketExp(rendered.mintedAt, rendered.deliverBy),
			});
			tickets.set(ticket.id, { ticket, headers });
			return Object.freeze({ ...ticket });
		},
		seedTicket(input, renderedHeaders) {
			if (closed || tickets.size >= STATE_LIMIT) throw new MockHubError("TICKET_SEED_REFUSED");
			const ticket = jsonCopy(input);
			const key = presentedTicketId(ticket);
			if (!key || key.length > 128) throw new MockHubError("TICKET_ID_INVALID");
			tickets.set(key, { ticket: ticket as SendTicket, headers: copyHeaders(renderedHeaders) });
		},
		hasTicket(ticketId) {
			return tickets.has(ticketId);
		},
		putBlob,
		readBlob(ref) {
			const bytes = blobs.get(ref);
			return bytes ? Uint8Array.from(bytes) : undefined;
		},
		close() {
			if (closed) return;
			closed = true;
			for (const scope of retained) retire(scope, new HostError("DENIED"));
			for (const cancel of streams) cancel();
			streams.clear();
			base.close();
			kv.clear();
			tickets.clear();
			secrets.clear();
			for (const bytes of blobs.values()) bytes.fill(0);
			blobs.clear();
			blobBytes = 0;
		},
	};
	return {
		host,
		async lookup<T>(
			action: (signal: AbortSignal, permit?: string) => Promise<T>,
			kind?: ToolKind,
			args?: unknown,
		): Promise<T> {
			if (closed || disabled) throw new MockHubError(closed ? "HOST_CLOSED" : "PLUGIN_DISABLED");
			// Trusted-fixture safeguard, including disposing work; no native admission bound is implied.
			if (retained.size >= 16) throw new MockHubError("LOOKUP_LIMIT");
			let permit: string | undefined;
			if (manifest.kind === "tool" && kind !== undefined) {
				try {
					for (let draw = 0; draw < 4; draw++) {
						const bytes = controls.entropy ? controls.entropy() : randomBytes(32);
						if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32)
							throw new Error("entropy");
						const candidate = Buffer.from(bytes).toString("base64url");
						if (!reserved.has(candidate)) {
							permit = candidate;
							break;
						}
					}
				} catch {
					throw new HostError("DENIED");
				}
				if (permit === undefined) throw new HostError("DENIED");
			}
			const budget = kind
				? toolKindsV1[kind].timeoutMs
				: manifest.kind === "tool"
					? 15_000
					: 30_000;
			const scope: Lookup = {
				id: ++nextLookup,
				generation,
				instance: options.instance,
				account,
				kind,
				argumentsDigest: sha256Hex(Buffer.from(JSON.stringify(jsonCopy(args ?? null)))),
				controller: new AbortController(),
				deadline: elapsed() + budget,
				permit,
				active: true,
				requests: 0,
				pending: 0,
			};
			retained.add(scope);
			if (permit !== undefined) {
				grants.set(permit, scope);
				reserved.add(permit);
			}
			const timer = setTimeout(
				() => retire(scope, new Refusal("LOOKUP_TIMEOUT", "TIMEOUT")),
				budget,
			);
			try {
				const result = await scopes.run(scope, () =>
					interrupted(
						own(
							scope,
							Promise.resolve().then(() => {
								if (closed || !scope.active || scope.controller.signal.aborted)
									throw scope.controller.signal.reason ?? new HostError("DENIED");
								if (elapsed() >= scope.deadline) throw new Refusal("LOOKUP_TIMEOUT", "TIMEOUT");
								return action(scope.controller.signal, permit);
							}),
						),
						scope.controller.signal,
					),
				);
				if (closed || !scope.active || scope.controller.signal.aborted)
					throw scope.controller.signal.reason ?? new HostError("DENIED");
				if (elapsed() >= scope.deadline) throw new Refusal("LOOKUP_TIMEOUT", "TIMEOUT");
				return result;
			} finally {
				clearTimeout(timer);
				retire(scope, new HostError("DENIED"));
			}
		},
	};
}
