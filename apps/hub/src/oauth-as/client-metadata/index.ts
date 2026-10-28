import { createHash } from "node:crypto";
import { canonicalAddress, resolvePublic } from "./addresses.ts";
import { copyMetadataBytes, MetadataCache } from "./cache.ts";
import { getPinnedMetadata, type MetadataBytes } from "./https.ts";
import {
	METADATA_MAX_BYTES,
	METADATA_TIMEOUT_MS,
	metadataMaxBytes,
	metadataTimeoutMs,
} from "./limits.ts";
import {
	configData,
	type MetadataDestination,
	type MetadataDestinationRule,
	MetadataDestinations,
	type MetadataKind,
	record,
	refused,
} from "./policy.ts";

export interface ClientMetadataOptions {
	readonly destinations: readonly MetadataDestinationRule[];
	/** Includes advertised/tunnel addresses belonging to this hub, even when absent from NICs. */
	readonly deniedAddresses: readonly string[];
	readonly maxBytes: number;
	readonly timeoutMs: number;
}
const FAILURE_MS = 30000,
	MAX_FAILURES = 1024,
	MAX_CONCURRENT = 8,
	MAX_WAITERS = 128;
interface InFlight {
	readonly cancelled: AbortController;
	readonly waiters: Set<(value: MetadataBytes | undefined) => void>;
	settled: boolean;
	abandoned: boolean;
}
/** Unmounted native fetch boundary. It does not register a client or accept any OAuth document. */
export class ClientMetadataFetcher {
	readonly #destinations: MetadataDestinations;
	readonly #denied: readonly string[];
	readonly #maxBytes: number;
	readonly #timeoutMs: number;
	readonly #failures = new Map<string, number>();
	readonly #cache = new MetadataCache();
	readonly #inFlight = new Map<string, InFlight>();
	readonly #closed = new AbortController();
	#waiters = 0;
	#lastNow = -1;
	constructor(options: ClientMetadataOptions) {
		const value = configData(options);
		if (
			!record(value, ["destinations", "deniedAddresses", "maxBytes", "timeoutMs"]) ||
			!Array.isArray(value.deniedAddresses) ||
			value.deniedAddresses.length > 256 ||
			!Number.isSafeInteger(value.maxBytes) ||
			(value.maxBytes as number) < 1 ||
			(value.maxBytes as number) > METADATA_MAX_BYTES ||
			!Number.isSafeInteger(value.timeoutMs) ||
			(value.timeoutMs as number) < 1 ||
			(value.timeoutMs as number) > METADATA_TIMEOUT_MS
		)
			throw refused();
		this.#destinations = new MetadataDestinations(
			value.destinations as readonly MetadataDestinationRule[],
		);
		this.#denied = Object.freeze(
			value.deniedAddresses.map((address: unknown) => {
				if (typeof address !== "string") throw refused();
				return canonicalAddress(address);
			}),
		);
		this.#maxBytes = value.maxBytes as number;
		this.#timeoutMs = value.timeoutMs as number;
	}
	#now(): number {
		const now = performance.now();
		if (this.#closed.signal.aborted || !Number.isFinite(now) || now < 0 || now < this.#lastNow) {
			this.close();
			throw refused();
		}
		this.#lastNow = now;
		for (const [key, until] of this.#failures) if (until <= now) this.#failures.delete(key);
		return now;
	}
	#checkedNow(deadline: number): number {
		const now = this.#now();
		if (now >= deadline) throw refused();
		return now;
	}
	#start(
		key: string,
		destination: MetadataDestination,
		kind: MetadataKind,
		maxBytes: number,
		deadline: number,
	): InFlight {
		const cancelled = new AbortController();
		const flight: InFlight = {
			cancelled,
			waiters: new Set(),
			settled: false,
			abandoned: false,
		};
		this.#inFlight.set(key, flight);
		void Promise.resolve()
			.then(async () => {
				let timer: ReturnType<typeof setTimeout> | undefined;
				const stopped = AbortSignal.any([cancelled.signal, this.#closed.signal]);
				try {
					stopped.throwIfAborted();
					timer = setTimeout(() => cancelled.abort(), deadline - this.#checkedNow(deadline));
					const address = await resolvePublic(destination.host, this.#denied, stopped);
					stopped.throwIfAborted();
					this.#checkedNow(deadline);
					const result = await getPinnedMetadata({
						destination,
						address,
						maxBytes,
						signal: stopped,
					});
					stopped.throwIfAborted();
					const completed = this.#checkedNow(deadline);
					this.#cache.put(
						key,
						kind,
						result,
						result.cacheExpiresAt - completed,
						maxBytes,
						completed,
					);
					const copied = copyMetadataBytes(result);
					this.#checkedNow(deadline);
					stopped.throwIfAborted();
					return copied;
				} catch {
					cancelled.abort();
					if (!flight.abandoned && !this.#closed.signal.aborted) {
						const now = this.#now();
						if (this.#failures.size >= MAX_FAILURES)
							this.#failures.delete(this.#failures.keys().next().value as string);
						this.#failures.set(key, now + FAILURE_MS);
					}
					throw refused();
				} finally {
					clearTimeout(timer);
				}
			})
			.then(
				(value) => this.#settle(key, flight, value),
				() => this.#settle(key, flight, undefined),
			);
		return flight;
	}
	#settle(key: string, flight: InFlight, value: MetadataBytes | undefined): void {
		flight.settled = true;
		if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
		for (const settle of flight.waiters) settle(value);
		flight.waiters.clear();
	}
	async #wait(flight: InFlight, signal: AbortSignal, deadline: number): Promise<MetadataBytes> {
		this.#waiters++;
		let stopped: AbortSignal | undefined,
			abort: (() => void) | undefined,
			settle: ((value: MetadataBytes | undefined) => void) | undefined,
			released = false;
		const release = () => {
			if (released) return;
			released = true;
			this.#waiters--;
			if (settle) flight.waiters.delete(settle);
			if (flight.waiters.size === 0 && !flight.settled && !flight.cancelled.signal.aborted) {
				flight.abandoned = true;
				flight.cancelled.abort();
			}
		};
		try {
			const current = AbortSignal.any([signal, flight.cancelled.signal, this.#closed.signal]);
			stopped = current;
			const result = await new Promise<MetadataBytes>((resolve, reject) => {
				settle = (value) => (value === undefined ? reject(refused()) : resolve(value));
				flight.waiters.add(settle);
				abort = () => {
					release();
					reject(refused());
				};
				current.addEventListener("abort", abort, { once: true });
				if (current.aborted) abort();
			});
			current.throwIfAborted();
			this.#checkedNow(deadline);
			const copied = copyMetadataBytes(result);
			this.#checkedNow(deadline);
			current.throwIfAborted();
			return copied;
		} finally {
			if (abort) stopped?.removeEventListener("abort", abort);
			release();
		}
	}
	async fetch(url: string, kind: MetadataKind, signal: AbortSignal): Promise<MetadataBytes> {
		try {
			const now = this.#now();
			signal.throwIfAborted();
			const destination = this.#destinations.check(url, kind);
			const maxBytes = metadataMaxBytes(kind, this.#maxBytes),
				deadline = now + metadataTimeoutMs(kind, this.#timeoutMs);
			const key = createHash("sha256").update(`${kind}\n${destination.url}`).digest("hex");
			const cached = this.#cache.get(key, kind, maxBytes, now);
			if (cached !== undefined) {
				signal.throwIfAborted();
				if (this.#checkedNow(deadline) < cached.expiresAt) return cached.value;
			}
			if (this.#failures.has(key) || this.#waiters >= MAX_WAITERS) throw refused();
			let flight = this.#inFlight.get(key);
			if (!flight) {
				if (this.#inFlight.size >= MAX_CONCURRENT) throw refused();
				flight = this.#start(key, destination, kind, maxBytes, deadline);
			}
			if (flight.cancelled.signal.aborted) throw refused();
			return await this.#wait(flight, signal, deadline);
		} catch {
			throw refused();
		}
	}
	close(): void {
		this.#closed.abort();
		this.#failures.clear();
		this.#cache.clear();
	}
}
