import { assertToken, type Clock, callSlack, retryWait, SlackError, systemClock } from "./api.ts";
import { reduceEvent, type SlackEvent } from "./reduce.ts";

// Socket Mode with Node's built-in WebSocket client (https://docs.slack.dev/apis/events-api/
// using-socket-mode, read 2026-10-17): apps.connections.open with the app-level token gives a
// single-use wss URL; Slack greets each connection with `hello`, refreshes it every few hours
// (`disconnect` with `warning` about 10 s ahead, then `refresh_requested`) and sends
// `link_disabled` when Socket Mode is turned off. Every envelope is acked once, at once, with its
// envelope_id alone; events leave this module only as ids and timestamps (src/reduce.ts).

export type StopReason = "aborted" | "auth" | "bad_url" | "link_disabled";

export type SocketState =
	| { readonly kind: "connecting" }
	| { readonly kind: "waiting"; readonly reason: "backoff" | "rate_limited"; readonly ms: number }
	| { readonly kind: "ready"; readonly connections: number }
	| { readonly kind: "refreshing"; readonly reason: "warning" | "refresh_requested" | "other" }
	| { readonly kind: "closed"; readonly code: number }
	| { readonly kind: "stopped"; readonly reason: StopReason };

export interface SocketModeOptions {
	readonly appToken: string;
	readonly onEvent: (event: SlackEvent) => void;
	readonly onState?: (state: SocketState) => void;
	readonly apiBase?: string;
	readonly fetch?: typeof fetch;
	readonly WebSocket?: typeof WebSocket;
	readonly allowSocketUrl?: (url: URL) => boolean;
	readonly clock?: Clock;
	readonly random?: () => number;
	readonly backoffMs?: { readonly base: number; readonly max: number };
	readonly helloTimeoutMs?: number;
	readonly signal?: AbortSignal;
}

// Slack hands out wss: URLs on its own hosts only.
export function slackSocketUrl(url: URL): boolean {
	const host = url.hostname;
	return (
		url.protocol === "wss:" &&
		(host === "slack.com" || host.endsWith(".slack.com")) &&
		url.username === "" &&
		url.password === "" &&
		(url.port === "" || url.port === "443")
	);
}

const ENVELOPE_ID = /^[\w-]{1,128}$/;
const MEMORY = 4096;

// Insertion-ordered, forgetting the oldest entries beyond its limit.
class Recent {
	private readonly items = new Set<string>();
	add(item: string): boolean {
		if (this.items.has(item)) return false;
		this.items.add(item);
		if (this.items.size > MEMORY) this.items.delete(this.items.values().next().value as string);
		return true;
	}
}

interface Connection {
	readonly socket: WebSocket;
	readonly acked: Recent;
	readonly helloTimer: NodeJS.Timeout;
	ready: boolean;
	draining: boolean;
}

class Session {
	private readonly options: SocketModeOptions;
	private readonly clock: Clock;
	private readonly connections = new Set<Connection>();
	private readonly events = new Recent();
	private opening = false;
	private stopped = false;
	private attempt = 0;
	private finish: (reason: StopReason) => void = () => {};
	private fail: (error: unknown) => void = () => {};
	readonly done: Promise<StopReason>;

	constructor(options: SocketModeOptions) {
		this.options = options;
		this.clock = options.clock ?? systemClock;
		this.done = new Promise((resolve, reject) => {
			this.finish = resolve;
			this.fail = reject;
		});
	}

	private readonly abort = (): void => this.stop("aborted");

	start(): Promise<StopReason> {
		const { signal } = this.options;
		if (signal?.aborted) this.stop("aborted");
		else {
			signal?.addEventListener("abort", this.abort, { once: true });
			void this.open(0);
		}
		return this.done;
	}

	private state(state: SocketState): void {
		try {
			this.options.onState?.(state);
		} catch {
			// An observer's failure never stops the connection.
		}
	}

	private backoff(): number {
		const { base, max } = this.options.backoffMs ?? { base: 1000, max: 60_000 };
		const ceiling = Math.min(max, base * 2 ** this.attempt);
		this.attempt = Math.min(this.attempt + 1, 30);
		return Math.round(ceiling / 2 + ((this.options.random ?? Math.random)() * ceiling) / 2);
	}

	// apps.connections.open until it yields a URL: Retry-After on a 429 (never less than the backoff
	// step, never more than 15 minutes), backoff on other failures.
	private async open(firstWait: number): Promise<void> {
		if (this.opening || this.stopped) return;
		this.opening = true;
		let wait = firstWait;
		let reason: "backoff" | "rate_limited" = "backoff";
		try {
			while (!this.stopped) {
				if (wait > 0) {
					this.state({ kind: "waiting", reason, ms: wait });
					await this.clock.delay(wait, this.options.signal);
				}
				if (this.stopped) return;
				this.state({ kind: "connecting" });
				const url = await this.fetchUrl();
				if (url instanceof URL) {
					if (!(this.options.allowSocketUrl ?? slackSocketUrl)(url)) this.stop("bad_url");
					if (this.stopped || this.connect(url)) return;
				} else if (url.kind === "auth") {
					this.stop("auth");
					return;
				}
				const limited = url instanceof URL || url.kind !== "rate_limited" ? null : url;
				reason = limited ? "rate_limited" : "backoff";
				wait = limited ? retryWait(limited, this.backoff()) : this.backoff();
			}
		} catch (error) {
			// Only an abort is expected here; anything else is a bug, reported through `done`.
			if (this.shutdown()) this.fail(error);
		} finally {
			this.opening = false;
		}
	}

	private async fetchUrl(): Promise<URL | SlackError> {
		try {
			const { data } = await callSlack(
				"apps.connections.open",
				this.options.appToken,
				{},
				{
					...(this.options.apiBase ? { base: this.options.apiBase } : {}),
					...(this.options.fetch ? { fetch: this.options.fetch } : {}),
					...(this.options.signal ? { signal: this.options.signal } : {}),
					now: () => this.clock.now(),
				},
			);
			return typeof data.url === "string" && URL.canParse(data.url)
				? new URL(data.url)
				: new SlackError("apps.connections.open", 200, "malformed");
		} catch (error) {
			if (error instanceof SlackError) return error;
			throw error;
		}
	}

	private connect(url: URL): boolean {
		const Socket = this.options.WebSocket ?? globalThis.WebSocket;
		let socket: WebSocket;
		try {
			socket = new Socket(url.href);
		} catch {
			return false;
		}
		const helloTimer = setTimeout(() => socket.close(4000), this.options.helloTimeoutMs ?? 15_000);
		const connection: Connection = {
			socket,
			acked: new Recent(),
			helloTimer,
			ready: false,
			draining: false,
		};
		this.connections.add(connection);
		socket.addEventListener("message", (event) => this.receive(connection, event.data));
		socket.addEventListener("close", (event) => this.closed(connection, event.code));
		return true;
	}

	private receive(connection: Connection, data: unknown): void {
		if (typeof data !== "string" || this.stopped) return;
		let frame: unknown;
		try {
			frame = JSON.parse(data);
		} catch {
			return;
		}
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
		const { type, envelope_id: envelopeId, payload, reason } = frame as Record<string, unknown>;
		if (type === "hello" || type === "disconnect") {
			if (type === "hello") this.hello(connection);
			else this.disconnect(connection, reason);
			return;
		}
		if (typeof envelopeId !== "string" || !ENVELOPE_ID.test(envelopeId)) return;
		// A repeat on the same connection was acked already; a redelivery has a new envelope_id.
		if (!connection.acked.add(envelopeId)) return;
		try {
			connection.socket.send(JSON.stringify({ envelope_id: envelopeId }));
		} catch {
			// Closing: unacked, so Slack delivers it again on another connection.
		}
		if (type !== "events_api") return;
		const event = reduceEvent(payload);
		if (event === null || (event.eventId !== null && !this.events.add(event.eventId))) return;
		try {
			this.options.onEvent(event);
		} catch {
			// The envelope stays acked; the poller's reconcile reads cover a consumer failure.
		}
	}

	private hello(connection: Connection): void {
		clearTimeout(connection.helloTimer);
		if (connection.ready) return;
		connection.ready = true;
		this.attempt = 0;
		for (const other of this.connections) {
			if (other !== connection && other.draining) other.socket.close(1000);
		}
		const ready = [...this.connections].filter((each) => each.ready && !each.draining);
		this.state({ kind: "ready", connections: ready.length });
	}

	private disconnect(connection: Connection, reason: unknown): void {
		if (reason === "link_disabled") {
			this.stop("link_disabled");
			return;
		}
		connection.draining = true;
		const known = reason === "warning" || reason === "refresh_requested";
		this.state({ kind: "refreshing", reason: known ? reason : "other" });
		// Slack sends `warning` and then `refresh_requested` on the same connection: one replacement,
		// whether it is still connecting or already live, answers both.
		if ([...this.connections].some((each) => !each.draining)) return;
		void this.open(0);
	}

	private closed(connection: Connection, code: number): void {
		clearTimeout(connection.helloTimer);
		this.connections.delete(connection);
		if (this.stopped) return;
		this.state({ kind: "closed", code });
		const live = [...this.connections].some((each) => !each.draining);
		if (!live && !this.opening) void this.open(this.backoff());
	}

	private shutdown(): boolean {
		if (this.stopped) return false;
		this.stopped = true;
		this.options.signal?.removeEventListener("abort", this.abort);
		for (const connection of this.connections) {
			clearTimeout(connection.helloTimer);
			connection.socket.close(1000);
		}
		return true;
	}

	stop(reason: StopReason): void {
		if (!this.shutdown()) return;
		this.state({ kind: "stopped", reason });
		this.finish(reason);
	}
}

// Runs until the signal aborts, Socket Mode is disabled for the app, the app-level token fails
// authentication or apps.connections.open returns a URL outside Slack's wss hosts.
export async function runSocketMode(options: SocketModeOptions): Promise<StopReason> {
	assertToken("app", options.appToken);
	return new Session(options).start();
}
