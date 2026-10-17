import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";

// What a paired desktop is shown. The 2-digit code is never in it: the owner reads it off the
// public page and types it, which ties the approval to the browser that started the request.
export interface ConsentRequest {
	readonly uid: string;
	readonly clientId: string;
	// Self-declared by the client, so shown as such.
	readonly clientName: string;
	readonly redirectHost: string;
	readonly scopes: readonly string[];
	readonly ip: string | undefined;
	readonly userAgent: string | undefined;
}

// refused: over the push limits or paused after denials; finish then answers temporarily_unavailable.
export type ConsentState = "pending" | "approved" | "denied" | "refused";

// A refused entry keeps only what the status poll and finish need: no request and no code.
export interface ConsentEntry {
	readonly request?: ConsentRequest;
	readonly code: string;
	readonly csrf: string;
	readonly expiresAt: number;
	state: ConsentState;
	granted: readonly string[];
}

export type Limits = Readonly<
	Record<"perMinute" | "perDay" | "denialsToPause" | "pauseMs", number>
>;
// §6 limits: 3 pushes a minute and 20 a day; five denials in a row pause consent for 15 minutes.
export const LIMITS: Limits = {
	perMinute: 3,
	perDay: 20,
	denialsToPause: 5,
	pauseMs: 15 * 60_000,
};
// Unticked unless the owner ticks it (§6 Tools).
export const UNTICKED: readonly string[] = ["inbox:organize"];
// At most this many consents are held at once. The push limits bound the pushed ones; refused
// ones, oldest first, make room for new requests.
export const MAX_ENTRIES = 256;

export interface ConsentOptions {
	// Delivery to the online desktop approvers (the hub's device channel; tests stand in).
	readonly onPush?: (request: ConsentRequest) => void;
	readonly now?: () => number;
	readonly limits?: Partial<Limits>;
}

// The typed-code consent stub: in memory, one entry per provider interaction, used once.
export class ConsentStub {
	readonly #entries = new Map<string, ConsentEntry>();
	readonly #pushes: number[] = [];
	readonly #onPush: ((request: ConsentRequest) => void) | undefined;
	readonly #now: () => number;
	readonly #limits: Limits;
	#denials = 0;
	#pausedUntil = 0;

	constructor(options: ConsentOptions = {}) {
		this.#onPush = options.onPush;
		this.#now = options.now ?? Date.now;
		this.#limits = { ...LIMITS, ...options.limits };
	}

	// Called when the consent page first renders; later renders get the same entry. The entry lives
	// as long as the provider interaction (ttlMs from now).
	open(request: ConsentRequest, ttlMs: number): ConsentEntry {
		const now = this.#now();
		for (const [uid, entry] of this.#entries) if (entry.expiresAt <= now) this.#entries.delete(uid);
		const existing = this.#entries.get(request.uid);
		if (existing) return existing;
		const csrf = randomBytes(32).toString("base64url");
		const refused: ConsentEntry = {
			code: "",
			csrf,
			expiresAt: now + ttlMs,
			state: "refused",
			granted: [],
		};
		// Full of pushed requests (only with raised limits): refused, and not even kept.
		if (this.#entries.size >= MAX_ENTRIES && !this.#dropRefused()) return refused;
		const entry: ConsentEntry = this.#admit(now)
			? {
					...refused,
					request,
					code: randomInt(0, 100).toString().padStart(2, "0"),
					state: "pending",
				}
			: refused;
		this.#entries.set(request.uid, entry);
		if (entry.state === "pending") this.#onPush?.(request);
		return entry;
	}

	#dropRefused(): boolean {
		for (const [uid, entry] of this.#entries) {
			if (entry.state !== "refused") continue;
			this.#entries.delete(uid);
			return true;
		}
		return false;
	}

	#admit(now: number): boolean {
		if (now < this.#pausedUntil) return false;
		const day = this.#pushes.filter((at) => at > now - 86_400_000);
		this.#pushes.splice(0, this.#pushes.length, ...day);
		const minute = day.filter((at) => at > now - 60_000).length;
		if (minute >= this.#limits.perMinute || day.length >= this.#limits.perDay) return false;
		this.#pushes.push(now);
		return true;
	}

	// The paired desktop's answer: the code the owner typed and the scopes left ticked.
	approve(uid: string, typedCode: string, scopes?: readonly string[]): ConsentState | undefined {
		const entry = this.#live(uid);
		if (entry?.state !== "pending") return entry?.state;
		if (typedCode !== entry.code) return this.deny(uid);
		const asked = entry.request?.scopes ?? [];
		const ticked = scopes ?? asked.filter((scope) => !UNTICKED.includes(scope));
		entry.granted = asked.filter((scope) => ticked.includes(scope));
		entry.state = "approved";
		this.#denials = 0;
		return entry.state;
	}

	deny(uid: string): ConsentState | undefined {
		const entry = this.#live(uid);
		if (entry?.state !== "pending") return entry?.state;
		entry.state = "denied";
		this.#denials += 1;
		if (this.#denials >= this.#limits.denialsToPause) {
			this.#denials = 0;
			this.#pausedUntil = this.#now() + this.#limits.pauseMs;
		}
		return entry.state;
	}

	state(uid: string): ConsentState | undefined {
		return this.#live(uid)?.state;
	}

	csrfMatches(uid: string, token: string | undefined): boolean {
		const expected = this.#live(uid)?.csrf;
		if (expected === undefined || token === undefined) return false;
		const [a, b] = [Buffer.from(expected), Buffer.from(token)];
		return a.length === b.length && timingSafeEqual(a, b);
	}

	// finish: a decided entry is removed, so each consent finishes one authorization.
	take(uid: string): ConsentEntry | undefined {
		const entry = this.#live(uid);
		if (!entry || entry.state === "pending") return undefined;
		this.#entries.delete(uid);
		return entry;
	}

	#live(uid: string): ConsentEntry | undefined {
		const entry = this.#entries.get(uid);
		return entry && entry.expiresAt > this.#now() ? entry : undefined;
	}
}
