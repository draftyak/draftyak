import {
	type Credential,
	type Endpoints,
	isHostId,
	planUsage,
	REGISTRATION_CLIENT,
	RESOURCE,
	type Registration,
	type Tokens,
	tokenRequest,
} from "./auth.ts";
import { SiwcError } from "./errors.ts";

// Accounts and sessions; Self-hosted VMs; plan §4 steps 2 and 4.

export interface CredentialStore {
	read(): Promise<Credential | null>;
	// Atomic; a rotated token is written before anything uses it.
	write(credential: Credential | null): Promise<void>;
}

export const EARLY_MS = 120_000;

// earliest_refresh_at is undocumented; it holds back only a still-valid token (S7b checks it).
export function refreshDue(tokens: Tokens, now: number): boolean {
	if (now < tokens.expiresAt - EARLY_MS) return false;
	const earliest = tokens.earliestRefreshAt;
	return earliest === undefined || now >= earliest || now >= tokens.expiresAt;
}

type SignedIn = Credential & { readonly tokens: Tokens };

export interface SessionOptions {
	readonly fetch?: typeof fetch;
	readonly now?: () => number;
	readonly sleep?: (ms: number) => Promise<void>;
}

// One Session per credential: its lock serializes refreshes, so a refresh token is sent once.
export class Session {
	readonly #store: CredentialStore;
	readonly #endpoints: Endpoints;
	readonly #fetch: typeof fetch;
	readonly #now: () => number;
	readonly #sleep: (ms: number) => Promise<void>;
	#queue: Promise<unknown> = Promise.resolve();

	constructor(store: CredentialStore, endpoints: Endpoints, options: SessionOptions = {}) {
		this.#store = store;
		this.#endpoints = endpoints;
		this.#fetch = options.fetch ?? fetch;
		this.#now = options.now ?? Date.now;
		this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	#locked<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#queue.then(work, work);
		this.#queue = run.catch(() => undefined);
		return run;
	}

	async #signedIn(): Promise<SignedIn> {
		const current = await this.#store.read();
		if (!current?.tokens) throw new SiwcError("REAUTH_REQUIRED", { detail: "signed out" });
		return current as SignedIn;
	}

	// Without plan permission no request starts (Errors and recovery, plan §4 step 3).
	accessToken(): Promise<string> {
		return this.#locked(async () => {
			const current = await this.#signedIn();
			const due = refreshDue(current.tokens, this.#now());
			const usable = due ? await this.#rotate(current) : current;
			if (planUsage(usable) === "disabled") throw new SiwcError("PLAN_USAGE_DISABLED");
			return usable.tokens.accessToken;
		});
	}

	// A refresh now, unless another caller already replaced `stale` meanwhile.
	refresh(stale?: string): Promise<Credential> {
		return this.#locked(async () => {
			const current = await this.#signedIn();
			const replaced = stale !== undefined && current.tokens.accessToken !== stale;
			return replaced ? current : this.#rotate(current);
		});
	}

	async #rotate(current: SignedIn): Promise<SignedIn> {
		const form = {
			grant_type: "refresh_token",
			client_id: current.clientId,
			refresh_token: current.tokens.refreshToken,
			resource: RESOURCE,
		};
		const response = await tokenRequest(this.#endpoints.token, form, this.#fetch).catch(
			async (error: unknown) => {
				const unusable = error instanceof SiwcError && error.code === "REAUTH_REQUIRED";
				if (unusable) await this.#store.write({ ...current, tokens: null });
				throw error;
			},
		);
		const savedAt = this.#now();
		const { refreshToken = current.tokens.refreshToken, earliestRefreshAt } = response;
		const next: SignedIn = {
			...current,
			tokens: {
				accessToken: response.accessToken,
				refreshToken,
				scopes: response.scopes.length > 0 ? response.scopes : current.tokens.scopes,
				expiresAt: savedAt + response.expiresIn * 1000,
				...(earliestRefreshAt !== undefined && { earliestRefreshAt }),
				savedAt,
			},
		};
		await this.#store.write(next);
		return next;
	}

	// false: revocation wasn't confirmed, which the owner is told.
	revoke(): Promise<boolean> {
		return this.#locked(async () => {
			const current = await this.#store.read();
			if (!current?.tokens) return true;
			const body = new URLSearchParams({
				token: current.tokens.refreshToken,
				token_type_hint: "refresh_token",
				client_id: current.clientId,
			}).toString();
			let confirmed = false;
			for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
				if (attempt > 0) await this.#sleep(500 * 2 ** attempt);
				const response = await this.#fetch(this.#endpoints.revocation, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body,
					redirect: "error",
					signal: AbortSignal.timeout(30_000),
				}).catch(() => undefined);
				await response?.body?.cancel();
				confirmed = response?.status === 200;
				if (response && response.status < 500 && !confirmed) break;
			}
			const { idTokenHint: _hint, ...kept } = current;
			await this.#store.write({ ...kept, tokens: null });
			return confirmed;
		});
	}
}

// The desktop signs in with the hub's host ID, sends this over L2, then forgets it.
export const transferText = (credential: Credential): string =>
	JSON.stringify({ v: 1, credential });

const refuse = (detail: string): SiwcError => new SiwcError("TRANSFER_REFUSED", { detail });
const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function text(record: Record<string, unknown>, name: string): string {
	const value = record[name];
	if (typeof value !== "string" || value === "") throw refuse(name);
	return value;
}

function count(record: Record<string, unknown>, name: string): number {
	const value = record[name];
	if (typeof value !== "number" || !Number.isFinite(value)) throw refuse(name);
	return value;
}

// A copied host ID never replaces the hub's.
export function acceptTransfer(
	bundle: string,
	hub: { readonly hostId: string; readonly issuer: string; readonly saved?: Registration | null },
): Credential {
	let parsed: unknown;
	try {
		parsed = JSON.parse(bundle);
	} catch {
		throw refuse("not JSON");
	}
	const credential = isRecord(parsed) && parsed.v === 1 ? parsed.credential : undefined;
	if (!isRecord(credential) || !isRecord(credential.tokens)) throw refuse("credential");
	const tokens = credential.tokens;
	const hostId = text(credential, "hostId");
	const clientId = text(credential, "clientId");
	const subject = text(credential, "subject");
	if (!isHostId(hostId) || hostId !== hub.hostId) throw refuse("hostId");
	if (text(credential, "issuer") !== hub.issuer) throw refuse("issuer");
	if (clientId === REGISTRATION_CLIENT) throw refuse("clientId");
	if (hub.saved && (hub.saved.clientId !== clientId || hub.saved.subject !== subject)) {
		throw refuse("another registration");
	}
	const scopes = tokens.scopes;
	if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string")) {
		throw refuse("scopes");
	}
	const optional = (name: string): Record<string, string> =>
		typeof credential[name] === "string" ? { [name]: credential[name] as string } : {};
	const earliest = tokens.earliestRefreshAt;
	return {
		issuer: hub.issuer,
		clientId,
		subject,
		...optional("email"),
		hostId,
		...optional("idTokenHint"),
		tokens: {
			accessToken: text(tokens, "accessToken"),
			refreshToken: text(tokens, "refreshToken"),
			scopes: [...scopes],
			expiresAt: count(tokens, "expiresAt"),
			...(typeof earliest === "number" && { earliestRefreshAt: earliest }),
			savedAt: count(tokens, "savedAt"),
		},
	};
}
