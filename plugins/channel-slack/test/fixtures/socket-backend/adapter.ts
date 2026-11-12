import { setImmediate as nextTurn } from "node:timers/promises";
import { createFake, type Fake } from "@draftyak/fakes/server";
import {
	createSlackSocketFake,
	MAX_SLACK_SOCKET_EVENT_BYTES,
	type SlackSocketFake,
} from "@draftyak/fakes/slack";

export const SLACK_SOCKET_LOGICAL_WSS = "wss://wss-primary.slack.com/DYTEST-socket-backend";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refused = (): Error => new Error("Slack socket backend refused");

export interface SlackSocketLease {
	ack(envelopeId: string): Promise<void>;
	close(): Promise<void>;
	/** Fulfilled only by the actual client close event. */
	readonly closed: Promise<void>;
}
export interface SlackSocketBackend {
	readonly httpFake: Fake;
	readonly fake: SlackSocketFake;
	readonly logicalWss: string;
	open(input: {
		readonly signal: AbortSignal;
		readonly onData: (data: string) => void | Promise<void>;
	}): Promise<SlackSocketLease>;
	close(): Promise<void>;
}

/** Synthetic HTTP and loopback WebSocket state; this is not a native broker. */
export async function createSlackSocketBackend(
	options: { readonly ackTimeoutMs?: number; readonly nowMs?: number } = {},
): Promise<SlackSocketBackend> {
	const fake = createSlackSocketFake(options);
	try {
		await fake.start();
	} catch {
		await fake.close();
		throw refused();
	}
	const base = new URL(fake.apiBase);
	if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]*\/api\/$/.test(base.href)) {
		await fake.close();
		throw refused();
	}
	const physicalOrigin = base.origin.replace("http:", "ws:");
	const fetchFake = fake.fetch;
	const work = new Set<Promise<unknown>>();
	const track = <T>(promise: Promise<T>): Promise<T> => {
		work.add(promise);
		void promise.finally(() => work.delete(promise)).catch(() => {});
		return promise;
	};
	let disposed = false;
	let httpBusy = false;
	let ticket: string | undefined;
	let active: { close(): Promise<void>; closed: Promise<void> } | undefined;
	let disposal: Promise<void> | undefined;
	let callbackFailed = false;
	const httpFake = createFake(
		{
			fetch(request) {
				const opening = request.url === "https://slack.com/api/apps.connections.open";
				if (
					disposed || httpBusy || request.method !== "POST" ||
					(!opening && request.url !== "https://slack.com/api/auth.test") ||
					(opening && (ticket !== undefined || active !== undefined || work.size !== 0))
				) return Response.json({ ok: false, error: "fixture_refused" }, { status: 409 });
				httpBusy = true;
				return track((async () => {
					try {
						const target = request.url.replace("https://slack.com/", `https://${fake.host}/`);
						const init: RequestInit & { duplex: "half" } = {
							method: request.method, headers: request.headers, body: request.body,
							signal: request.signal, duplex: "half",
						};
						const response = await fetchFake(new Request(target, init));
						if (!opening || !response.ok) return response;
						const value = await response.clone().json();
						if (value.ok !== true) return response;
						if (typeof value.url !== "string") throw refused();
						const url = new URL(value.url);
						if (
							disposed || request.signal.aborted || url.href !== value.url ||
							url.origin !== physicalOrigin || url.username || url.password || url.search || url.hash ||
							!url.pathname.startsWith("/link/") || !UUID.test(url.pathname.slice(6))
						) throw refused();
						ticket = value.url;
						return Response.json({ ok: true, url: SLACK_SOCKET_LOGICAL_WSS });
					} catch {
						if (opening) {
							disposed = true;
							ticket = undefined;
							try { await fake.close(); } catch { throw refused(); }
						}
						throw refused();
					} finally {
						httpBusy = false;
					}
				})());
			},
		},
		{ host: "slack.com", maxRequestBodyBytes: 16 * 1024 },
	);
	const open: SlackSocketBackend["open"] = async (input) => {
		let signal: AbortSignal;
		try { signal = AbortSignal.any([input.signal]); } catch { throw refused(); }
		const onData = input.onData;
		if (disposed || signal.aborted || active || work.size !== 0 || !ticket || typeof onData !== "function")
			throw refused();
		const target = ticket;
		ticket = undefined;
		const client = new WebSocket(target);
		let stopped = false;
		let connection = -1;
		let ackBusy = false;
		let queued = 0;
		let queuedBytes = 0;
		let tail = Promise.resolve();
		let resolveClosed!: () => void;
		let rejectOpen!: (error: Error) => void;
		const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
		const close = (): Promise<void> => {
			if (!stopped) {
				stopped = true;
				client.close();
			}
			return closed;
		};
		const stop = (): void => { void close(); };
		active = { close, closed };
		client.addEventListener("close", () => {
			stopped = true;
			signal.removeEventListener("abort", stop);
			active = undefined;
			rejectOpen(refused());
			resolveClosed();
		}, { once: true });
		client.addEventListener("error", () => { rejectOpen(refused()); stop(); });
		client.addEventListener("message", (event) => {
			if (disposed || stopped || signal.aborted) return;
			const text: unknown = event.data;
			if (typeof text !== "string" || !text.isWellFormed()) { stop(); return; }
			const bytes = Buffer.byteLength(text);
			if (bytes > MAX_SLACK_SOCKET_EVENT_BYTES || queued >= 64 || queuedBytes + bytes > 1024 * 1024) {
				stop(); return;
			}
			queued++;
			queuedBytes += bytes;
			tail = track(tail.then(async () => {
				if (!disposed && !stopped && !signal.aborted) await onData(text);
			}).catch(() => { callbackFailed = true; stop(); throw refused(); }).finally(() => {
				queued--;
				queuedBytes -= bytes;
			}));
		});
		const opened = new Promise<void>((resolve, reject) => {
			rejectOpen = reject;
			client.addEventListener("open", () => {
				const live = fake.live();
				if (disposed || stopped || signal.aborted || live.length !== 1) {
					reject(refused()); stop(); return;
				}
				connection = live[0]!.id;
				resolve();
			}, { once: true });
		});
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		await opened;
		return {
			closed,
			close,
			ack(envelopeId) {
				if (
					disposed || stopped || signal.aborted || ackBusy || typeof envelopeId !== "string" || !UUID.test(envelopeId) ||
					!fake.envelopes.some((row) => row.envelopeId === envelopeId && row.connection === connection)
				) return Promise.reject(refused());
				ackBusy = true;
				const previous = new Set(fake.acksFor(envelopeId));
				return track((async () => {
					try {
						client.send(JSON.stringify({ envelope_id: envelopeId }));
						// send() is dispatch only. Success requires the fake's actual receive record.
						for (;;) {
							if (disposed || stopped || signal.aborted) throw refused();
							const receipt = fake.acksFor(envelopeId).find((row) => !previous.has(row));
							if (receipt) {
								if (!receipt.accepted || receipt.dropped || receipt.connection !== connection) throw refused();
								return;
							}
							await nextTurn();
						}
					} finally { ackBusy = false; }
				})());
			},
		};
	};
	return {
		httpFake, fake, logicalWss: SLACK_SOCKET_LOGICAL_WSS, open,
		close() {
			if (disposal) return disposal;
			disposed = true;
			ticket = undefined;
			const current = active;
			disposal = Promise.resolve().then(async () => {
				const results = await Promise.allSettled([
					Promise.resolve().then(() => current?.close()), fake.close(), ...work,
				]);
				if (callbackFailed || results.slice(0, 2).some((result) => result.status === "rejected")) throw refused();
			});
			return disposal;
		},
	};
}
