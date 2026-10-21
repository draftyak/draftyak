import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { Fake } from "@draftyak/fakes";
import { type HeaderList, headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import {
	HOST_METHOD_SCHEMAS,
	type HostFetchParams,
	type HostFetchResult,
	HostHeaders,
	type HostMethod,
	type HostMethods,
	jsonCopy,
} from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
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
	type Denial,
	type MockAccount,
	type MockHost,
	MockHubError,
	type RenderedRequest,
} from "./types.ts";

interface Lookup {
	readonly id: number;
	readonly controller: AbortController;
	readonly deadline: number;
	active: boolean;
	requests: number;
}
class Refusal extends HostError {
	readonly reason: string;
	constructor(reason: string, code: "DENIED" | "TIMEOUT" | "TOO_LARGE" | "UNSUPPORTED" = "DENIED") {
		super(code);
		this.reason = reason;
	}
}
const STATE_LIMIT = 1024;
const BODY_LIMIT = 35 * 1024 ** 2;
const STATE_BYTES = 64 * 1024 ** 2;
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

export function createMockHost(options: {
	readonly manifest: PluginManifestV1;
	readonly account?: MockAccount;
	readonly instance: string;
	readonly upstreams: readonly Fake[];
	readonly secrets?: Readonly<Record<string, string>>;
}): {
	readonly host: MockHost;
	lookup<T>(action: (signal: AbortSignal) => Promise<T>, kind?: ToolKind): Promise<T>;
} {
	const manifest = options.manifest;
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
	const active = new Set<Lookup>();
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
	const streams = new Set<NodeJS.Immediate>();
	const deny = (
		reason: string,
		code?: "DENIED" | "TIMEOUT" | "TOO_LARGE" | "UNSUPPORTED",
	): never => {
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
				disabled = true;
				alerts.push(Object.freeze({ reason: mismatch }));
			}
			return deny(mismatch);
		}
		return headers;
	};
	const queueStream = (bytes: Uint8Array, signal: AbortSignal, scope?: Lookup): string => {
		const streamId = id();
		let position = 0,
			sequence = 0;
		const schedule = (): void => {
			const immediate = setImmediate(() => {
				streams.delete(immediate);
				if (closed || signal.aborted || (scope && !scope.active)) return;
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
			});
			streams.add(immediate);
		};
		schedule();
		return streamId;
	};
	const fetch = async (
		params: HostFetchParams,
		parentSignal: AbortSignal,
	): Promise<HostFetchResult> => {
		const scope = scopes.getStore();
		const foundTicket = takeTicket(params);
		if (params.saveAs !== undefined && params.saveAs !== "blob")
			return deny("STORAGE_MODE_UNSUPPORTED", "UNSUPPORTED");
		if (manifest.kind === "tool") {
			if (!scope?.active || scope.controller.signal.aborted) return deny("LOOKUP_REQUIRED");
			if (++scope.requests > TOOL_REQUESTS_PER_LOOKUP) return deny("LOOKUP_REQUEST_LIMIT");
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
		const matched = matchRequest(manifest, params.url, params.method, secrets);
		if (!matched) return deny("OFF_RULE");
		const { rule, url } = matched;
		if (rule.class === "organize" && options.account?.mode !== "full")
			return deny("FULL_MODE_REQUIRED");
		if (rule.class === "send") {
			if (manifest.kind !== "channel" || !manifest.send) return deny("RENDERER_REQUIRED");
			ticketHeaders ??= consumeTicket(params, body);
		}
		if (body.byteLength > rule.maxBytes) return deny("REQUEST_TOO_LARGE", "TOO_LARGE");
		const upstream = upstreams.get(new URL(url).hostname);
		if (!upstream) return deny("UPSTREAM_UNAVAILABLE");
		const now = Date.now();
		const deadline = Math.min(now + rule.timeoutMs, scope?.deadline ?? now + 30_000);
		const budget = deadline - now;
		if (budget <= 0) return deny("FETCH_TIMEOUT", "TIMEOUT");
		const timeout = new AbortController();
		const signal = AbortSignal.any([
			parentSignal,
			timeout.signal,
			...(scope ? [scope.controller.signal] : []),
		]);
		const timer = setTimeout(() => timeout.abort(new Refusal("FETCH_TIMEOUT", "TIMEOUT")), budget);
		const admit = (): void => {
			if (signal.aborted) throw signal.reason;
			if (Date.now() >= deadline) deny("FETCH_TIMEOUT", "TIMEOUT");
			if (scope && !scope.active) deny("LOOKUP_ENDED");
		};
		let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
		try {
			const allowed =
				manifest.kind === "tool"
					? TOOL_REQUEST_HEADERS
					: ["accept", "content-type", "if-none-match", "if-modified-since"];
			const headers = ticketHeaders ?? keepToolHeaders(params.headers, allowed);
			admit();
			const response = await interrupted(
				upstream.fetch(url, {
					method: params.method,
					headers: headers as [string, string][],
					...(body.length ? { body: body as BodyInit } : {}),
					redirect: "manual",
					signal,
				}),
				signal,
			);
			reader = response.body?.getReader();
			admit();
			if (response.status >= 300 && response.status < 400 && response.status !== 304)
				return deny("REDIRECT_REFUSED");
			const chunks: Uint8Array[] = [];
			let total = 0;
			while (reader) {
				const next = await interrupted(reader.read(), signal);
				admit();
				if (next.done) break;
				if (next.value.byteLength > rule.maxBytes - total)
					return deny("RESPONSE_TOO_LARGE", "TOO_LARGE");
				total += next.value.byteLength;
				chunks.push(next.value);
			}
			const bytes = Buffer.concat(chunks, total);
			const responseHeaders = keepToolHeaders(
				[...response.headers.entries()],
				manifest.kind === "tool"
					? TOOL_RESPONSE_HEADERS
					: ["content-type", "etag", "last-modified", "content-length"],
			);
			const common = { status: response.status, headers: responseHeaders };
			admit();
			if (params.saveAs === "blob") return { ...common, body: putBlob(bytes) };
			if (bytes.length <= MAX_INLINE_BYTES)
				return { ...common, body: { base64: bytes.toString("base64url") } };
			if (params.stream === false) return deny("INLINE_TOO_LARGE", "TOO_LARGE");
			return { ...common, streamId: queueStream(bytes, parentSignal, scope) };
		} catch (error) {
			if (signal.aborted) throw signal.reason;
			if (error instanceof Refusal) throw error;
			return deny("UPSTREAM_FAILED");
		} finally {
			clearTimeout(timer);
			void reader?.cancel().catch(() => {});
			reader?.releaseLock();
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
			case "host/fetch":
				return fetch(params as HostFetchParams, signal);
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
			const scope = scopes.getStore();
			try {
				return await base.request(method, params, requestOptions);
			} catch (error) {
				const failure = error instanceof HostError ? error : new HostError("BAD_REQUEST");
				if (denials.length < 4096)
					denials.push(
						Object.freeze({
							sequence: denials.length,
							method: Object.hasOwn(HOST_METHOD_SCHEMAS, method) ? method : "unknown",
							reason:
								error instanceof Refusal ? error.reason : closed ? "HOST_CLOSED" : failure.code,
							lookup: scope?.id ?? null,
						}),
					);
				else {
					auditComplete = false;
					disabled = true;
				}
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
			for (const scope of active) {
				scope.active = false;
				scope.controller.abort(new HostError("DENIED"));
			}
			for (const immediate of streams) clearImmediate(immediate);
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
		async lookup<T>(action: (signal: AbortSignal) => Promise<T>, kind?: ToolKind): Promise<T> {
			if (closed || disabled) throw new MockHubError(closed ? "HOST_CLOSED" : "PLUGIN_DISABLED");
			if (active.size >= 16) throw new MockHubError("LOOKUP_LIMIT");
			const budget = kind
				? toolKindsV1[kind].timeoutMs
				: manifest.kind === "tool"
					? 15_000
					: 30_000;
			const scope: Lookup = {
				id: ++nextLookup,
				controller: new AbortController(),
				deadline: Date.now() + budget,
				active: true,
				requests: 0,
			};
			active.add(scope);
			const timer = setTimeout(
				() => scope.controller.abort(new Refusal("LOOKUP_TIMEOUT", "TIMEOUT")),
				budget,
			);
			try {
				const result = await scopes.run(scope, () =>
					interrupted(action(scope.controller.signal), scope.controller.signal),
				);
				if (closed || !scope.active || scope.controller.signal.aborted)
					throw scope.controller.signal.reason ?? new HostError("DENIED");
				if (Date.now() >= scope.deadline) throw new Refusal("LOOKUP_TIMEOUT", "TIMEOUT");
				return result;
			} finally {
				clearTimeout(timer);
				scope.active = false;
				scope.controller.abort(new HostError("DENIED"));
				active.delete(scope);
			}
		},
	};
}
