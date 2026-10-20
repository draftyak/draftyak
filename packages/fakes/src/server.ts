import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer, type Http2Bindings, type HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { createFaults, DroppedConnectionError, type Faults, httpDate } from "./faults.ts";
import { createRecorder, type Recorder, type Recording } from "./recorder.ts";
import { rawTarget, targetOf, withTarget } from "./target.ts";

/** The hub's listeners (47613–47615) and the Node inspector's port: a fake never takes them. */
export const RESERVED_PORTS: ReadonlySet<number> = new Set([9229, 47613, 47614, 47615]);

const LOOPBACK = "127.0.0.1";
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const BODY_HEADERS = ["content-encoding", "content-language", "content-location", "content-type"];

/** A Hono app, or anything else with Hono's `fetch`. */
export interface FetchApp {
	fetch(request: Request): Response | Promise<Response>;
}

export interface FakeOptions {
	/** The host name the fake answers for, such as hello.draftyak.example. */
	readonly host: string;
	readonly recorder?: Recorder;
	readonly faults?: Faults;
	/** Optional intake cap, enforced before any redirect or application body clone. */
	readonly maxRequestBodyBytes?: number;
}

export interface Listening {
	readonly port: number;
	/** `http://127.0.0.1:<port>` */
	readonly origin: string;
	close(): Promise<void>;
}

export interface Fake {
	readonly host: string;
	readonly recorder: Recorder;
	readonly faults: Faults;
	/**
	 * Serves a request in memory, with no socket, in place of fetch: a bare path goes to
	 * `https://<host><path>`, a URL string keeps the exact target fetch would normalize, and an
	 * abort or a redirect mode acts as in fetch.
	 */
	fetch(input: Request | URL | string, init?: RequestInit): Promise<Response>;
	/** Serves the fake on 127.0.0.1 at a random port, never one of RESERVED_PORTS. */
	listen(): Promise<Listening>;
}

const failed = (cause: unknown): TypeError => new TypeError("fetch failed", { cause });

async function limitedRequest(
	request: Request,
	cap: number,
	recording: Recording,
): Promise<Request | undefined> {
	if (request.body === null) {
		recording.finish();
		return request;
	}
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let bytes = Buffer.alloc(0),
		size = 0;
	const cancel = (reason?: unknown): void => {
		void reader?.cancel(reason).catch(() => {});
	};
	const abort = (): void => cancel(request.signal.reason);
	request.signal.addEventListener("abort", abort, { once: true });
	try {
		if (request.bodyUsed) throw new TypeError("Request body has already been used");
		reader = request.body.getReader();
		if (request.signal.aborted) abort();
		request.signal.throwIfAborted();
		for (;;) {
			const item = await reader.read();
			request.signal.throwIfAborted();
			if (item.done) break;
			if (!(item.value instanceof Uint8Array)) throw new TypeError("Invalid request body chunk");
			recording.write(item.value);
			if (item.value.byteLength > cap - size) {
				cancel();
				recording.finish("request_body_too_large");
				return;
			}
			const next = size + item.value.byteLength;
			if (next > bytes.length) {
				const grown = Buffer.alloc(Math.min(cap, Math.max(next, bytes.length * 2, 1024)));
				bytes.copy(grown, 0, 0, size);
				bytes = grown;
			}
			bytes.set(item.value, size);
			size = next;
		}
		const limited = withTarget(
			new Request(request.url, {
				method: request.method,
				headers: request.headers,
				body: bytes.subarray(0, size),
				signal: request.signal,
				redirect: request.redirect,
				credentials: request.credentials,
				cache: request.cache,
				integrity: request.integrity,
				keepalive: request.keepalive,
				mode: request.mode,
				referrer: request.referrer,
				referrerPolicy: request.referrerPolicy,
			}),
			rawTarget(request),
		);
		recording.finish();
		return limited;
	} catch (error) {
		cancel(error);
		recording.discard();
		throw error;
	} finally {
		request.signal.removeEventListener("abort", abort);
		reader?.releaseLock();
	}
}

// Settles with the promise, or rejects with the signal's reason as soon as it aborts.
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

// An abort while the body streams errors it with the signal's reason.
function tied(response: Response, signal: AbortSignal): Response {
	if (response.body === null) return response;
	const { status, statusText, headers } = response;
	const body = response.body.pipeThrough(new TransformStream(), { signal });
	return new Response(body, { status, statusText, headers });
}

// fetch's next request when it follows a redirect: a 303, or a 301 or 302 after a POST, is a GET.
async function redirected(
	request: Request,
	copy: Request | null,
	status: number,
	to: URL,
): Promise<Request> {
	const { method, signal } = request;
	const toGet =
		(status === 303 && method !== "GET" && method !== "HEAD") ||
		((status === 301 || status === 302) && method === "POST");
	const headers = new Headers(request.headers);
	if (toGet) for (const name of BODY_HEADERS) headers.delete(name);
	if (new URL(request.url).origin !== to.origin) headers.delete("authorization");
	const body = toGet || copy === null ? null : await copy.arrayBuffer();
	return new Request(to, { method: toGet ? "GET" : method, headers, body, signal });
}

export function createFake(app: FetchApp, options: FakeOptions): Fake {
	const cap = options.maxRequestBodyBytes;
	if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1 || cap > 64 * 1024 * 1024))
		throw new RangeError("maxRequestBodyBytes must be whole bytes from 1 to 64 MiB");
	const host = options.host.toLowerCase();
	if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) {
		throw new TypeError(`a fake's host is a bare host name: ${options.host}`);
	}
	const recorder = options.recorder ?? createRecorder();
	const begin = recorder.begin?.bind(recorder);
	if (cap !== undefined && begin === undefined) {
		throw new TypeError("A capped fake requires recorder.begin");
	}
	const faults = options.faults ?? createFaults();
	const tooLarge = (): Response =>
		Response.json(
			{ error: "request_body_too_large" },
			{
				status: 413,
				headers: { Date: httpDate(faults.clock.now()) },
			},
		);

	const misdirected = async (authority: string): Promise<Response> => {
		const headers = { Date: httpDate(faults.clock.now()) };
		return Response.json(
			{ error: "misdirected_request", host: authority },
			{ status: 421, headers },
		);
	};

	// Reserve records and faults synchronously on arrival, before awaiting bounded intake.
	const handle = async (
		request: Request,
		names: readonly string[],
		ready?: (request: Request) => void,
	): Promise<Response> => {
		let intake: Promise<Request | undefined>;
		if (cap === undefined) intake = Promise.resolve(request);
		else {
			if (begin === undefined) throw new TypeError("A capped fake requires recorder.begin");
			intake = limitedRequest(request, cap, begin(request));
		}
		const recorded = cap === undefined ? recorder.record(request) : intake.then(() => {});
		const authority = new URL(request.url).host;
		const answered = names.includes(authority)
			? faults.run(request, async () => {
					const forwarded = cap === undefined ? request : await intake;
					if (forwarded === undefined) return tooLarge();
					ready?.(forwarded);
					return await app.fetch(forwarded);
				})
			: misdirected(authority);
		await Promise.allSettled([recorded, answered]);
		await recorded;
		return await answered;
	};

	// fetch's redirect modes: "follow" (the default) re-asks this fake, at most 20 times.
	const follow = async (first: Request): Promise<Response> => {
		let request = first;
		for (let hops = 0; ; hops += 1) {
			request.signal.throwIfAborted();
			const follows = request.redirect === "follow";
			let copy: Request | null = null;
			const response = await handle(request, [host], (forwarded) => {
				if (follows && forwarded.body !== null) copy = forwarded.clone();
			});
			if (!REDIRECTS.has(response.status) || request.redirect === "manual") return response;
			if (!follows) throw failed(new Error("unexpected redirect"));
			const location = response.headers.get("location");
			if (location === null) return response;
			if (hops === 20) throw failed(new Error("redirect count exceeded"));
			request = await redirected(request, copy, response.status, new URL(location, request.url));
		}
	};

	const serve = async (names: () => readonly string[]): Promise<Server> => {
		const server = createAdaptorServer({
			overrideGlobalObjects: false,
			fetch: async (request: Request, env: HttpBindings | Http2Bindings) => {
				try {
					const input = withTarget(request, targetOf(env.incoming.url ?? "/"));
					return await handle(input, names());
				} catch (error) {
					if (!(error instanceof DroppedConnectionError)) throw error;
					env.incoming.socket.destroy();
					return RESPONSE_ALREADY_SENT;
				}
			},
		}) as Server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: LOOPBACK, port: 0, exclusive: true }, () => {
				server.off("error", reject);
				resolve();
			});
		});
		return server;
	};

	const closer = (server: Server): (() => Promise<void>) => {
		let closing: Promise<void> | undefined;
		return () => {
			closing ??= new Promise((resolve) => {
				server.close(() => resolve());
				server.closeAllConnections();
			});
			return closing;
		};
	};

	return {
		host,
		recorder,
		faults,
		async fetch(input, init) {
			const url =
				typeof input === "string" && input.startsWith("/") ? `https://${host}${input}` : input;
			const request = url instanceof Request && init === undefined ? url : new Request(url, init);
			if (typeof url === "string") withTarget(request, targetOf(url));
			try {
				return tied(await abortable(follow(request), request.signal), request.signal);
			} catch (error) {
				throw error instanceof DroppedConnectionError ? failed(error) : error;
			}
		},
		async listen() {
			// The OS picks the port; Linux's ephemeral range includes 47613–47615, so retry those.
			for (let attempt = 0; attempt < 10; attempt += 1) {
				let names: readonly string[] = [];
				const server = await serve(() => names);
				const { port } = server.address() as AddressInfo;
				const close = closer(server);
				if (RESERVED_PORTS.has(port)) {
					await close();
					continue;
				}
				names = [host, `${host}:${port}`, `${LOOPBACK}:${port}`, `localhost:${port}`];
				return { port, origin: `http://${LOOPBACK}:${port}`, close };
			}
			throw new Error("listen: the OS offered only reserved ports");
		},
	};
}
