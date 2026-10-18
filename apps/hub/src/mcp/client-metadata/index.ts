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
	MAX_CONCURRENT = 8;
/** Unmounted native fetch boundary. It does not register a client or accept any OAuth document. */
export class ClientMetadataFetcher {
	readonly #destinations: MetadataDestinations;
	readonly #denied: readonly string[];
	readonly #maxBytes: number;
	readonly #timeoutMs: number;
	readonly #failures = new Map<string, number>();
	readonly #cache = new MetadataCache();
	readonly #inFlight = new Set<string>();
	readonly #closed = new AbortController();
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
	async fetch(url: string, kind: MetadataKind, signal: AbortSignal): Promise<MetadataBytes> {
		let key: string | undefined,
			started = false,
			timer: ReturnType<typeof setTimeout> | undefined;
		const cancelled = new AbortController();
		try {
			const now = this.#now();
			signal.throwIfAborted();
			const destination = this.#destinations.check(url, kind);
			const maxBytes = metadataMaxBytes(kind, this.#maxBytes),
				deadline = now + metadataTimeoutMs(kind, this.#timeoutMs);
			const checkedNow = () => {
				const current = this.#now();
				if (current >= deadline) {
					cancelled.abort();
					throw refused();
				}
				return current;
			};
			key = createHash("sha256").update(`${kind}\n${destination.url}`).digest("hex");
			const cached = this.#cache.get(key, kind, maxBytes, now);
			if (cached !== undefined) {
				signal.throwIfAborted();
				if (checkedNow() < cached.expiresAt) return cached.value;
			}
			if (
				this.#failures.has(key) ||
				this.#inFlight.has(key) ||
				this.#inFlight.size >= MAX_CONCURRENT
			)
				throw refused();
			this.#inFlight.add(key);
			started = true;
			const stopped = AbortSignal.any([signal, cancelled.signal, this.#closed.signal]);
			timer = setTimeout(() => cancelled.abort(), deadline - checkedNow());
			const address = await resolvePublic(destination.host, this.#denied, stopped);
			stopped.throwIfAborted();
			checkedNow();
			const result = await getPinnedMetadata({
				destination,
				address,
				maxBytes,
				signal: stopped,
			});
			stopped.throwIfAborted();
			const completed = checkedNow();
			this.#cache.put(key, kind, result, result.cacheExpiresAt - completed, maxBytes, completed);
			const copied = copyMetadataBytes(result);
			checkedNow();
			stopped.throwIfAborted();
			return copied;
		} catch {
			if (key && started && !signal.aborted && !this.#closed.signal.aborted) {
				const now = this.#now();
				if (this.#failures.size >= MAX_FAILURES)
					this.#failures.delete(this.#failures.keys().next().value as string);
				this.#failures.set(key, now + FAILURE_MS);
			}
			throw refused();
		} finally {
			clearTimeout(timer);
			if (key && started) this.#inFlight.delete(key);
		}
	}
	close(): void {
		this.#closed.abort();
		this.#failures.clear();
		this.#cache.clear();
	}
}
