// The provider's records, in memory. oidc-provider's own memory adapter holds them in an LRU of
// 1,000 entries, which a flood of unauthenticated authorization requests empties: grants, tokens,
// the consumed refresh tokens that reuse detection needs and the client-assertion replay records
// go with it. Here only interactions, the one record such a request creates, are capped (oldest
// out first); every other record stays until it expires.
export const MAX_INTERACTIONS = 1000;
const SWEEP_EVERY = 1000;

interface Entry {
	readonly value: unknown;
	readonly expiresAt: number;
}

// The store oidc-provider's MemoryAdapter takes: get, set with maxAge in milliseconds, delete.
export class RecordStore {
	readonly #records = new Map<string, Entry>();
	readonly #interactions = new Map<string, Entry>();
	#writes = 0;

	#mapFor(key: string): Map<string, Entry> {
		return key.startsWith("Interaction:") ? this.#interactions : this.#records;
	}

	get(key: string): unknown {
		const map = this.#mapFor(key);
		const entry = map.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			map.delete(key);
			return undefined;
		}
		// A read counts as use, so a sign-in whose page keeps polling stays among the newest.
		if (map === this.#interactions) this.#renew(key, entry);
		return entry.value;
	}

	set(key: string, value: unknown, options: { readonly maxAge?: number } = {}): void {
		const map = this.#mapFor(key);
		const expiresAt = Date.now() + (options.maxAge ?? Number.POSITIVE_INFINITY);
		if (map === this.#interactions) this.#renew(key, { value, expiresAt });
		else map.set(key, { value, expiresAt });
		this.#writes += 1;
		if (this.#writes % SWEEP_EVERY === 0) this.#sweep();
	}

	#renew(key: string, entry: Entry): void {
		this.#interactions.delete(key);
		this.#interactions.set(key, entry);
		if (this.#interactions.size <= MAX_INTERACTIONS) return;
		for (const oldest of this.#interactions.keys()) {
			this.#interactions.delete(oldest);
			return;
		}
	}

	delete(key: string): void {
		this.#mapFor(key).delete(key);
	}

	#sweep(): void {
		const now = Date.now();
		for (const map of [this.#records, this.#interactions]) {
			for (const [key, entry] of map) if (entry.expiresAt <= now) map.delete(key);
		}
	}
}
