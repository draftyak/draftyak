import { addAbortListener } from "node:events";
import { request } from "node:https";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { Ulid } from "@draftyak/protocol/scalars";
import {
	CredentialError,
	type CredentialRefresh,
	type CredentialUse,
	type CredentialValue,
	type CredentialVault,
} from "../../../credentials/vault.ts";
import type { EventLog } from "../../../events/log.ts";
import type { WorkDatabase, WorkScope } from "../../../jobs/database.ts";
import {
	captureEgressPolicy,
	createPinnedHttpsConnection,
	type EgressPolicy,
	resolveEgress,
} from "../../../plugins/broker/network/index.ts";
import type { HubStore } from "../../../store/store.ts";

export const GMAIL_CREDENTIAL_MIGRATIONS: string = fileURLToPath(
	new URL("./credential-migrations/", import.meta.url),
);
export const GMAIL_DELETION_DELAY_MS: number = 30 * 24 * 60 * 60_000;
const HOST = "oauth2.googleapis.com";
const MAX_RESPONSE_BYTES = 24_576;
const unavailable = (): CredentialError => new CredentialError();
type GoogleTokens = Extract<CredentialValue, { kind: "gmail-oauth" }>;
export interface GoogleDesktopClient {
	readonly clientId: string;
	readonly clientSecret?: string;
}
export interface GmailCredentialOptions {
	readonly store: HubStore;
	readonly vault: CredentialVault;
	readonly database: WorkDatabase;
	readonly events: EventLog;
	/** Native BYO-client lookup. Never supplied by a plugin or WebView. */
	readonly clientFor: (accountId: string) => GoogleDesktopClient;
	readonly egressPolicy: EgressPolicy;
	readonly now?: () => number;
	readonly deletionDelayMs?: number;
	readonly timeoutMs?: number;
}
export interface GmailCredentialDeadline {
	readonly invalidAt: number;
	readonly deleteAt: number;
}
interface Binding {
	account_id: string;
	user_id: string;
	credential_ref: string;
	invalid_at: number | null;
	delete_at: number | null;
}
function id(value: string): string {
	if (!Ulid.safeParse(value).success) throw unavailable();
	return value;
}
function integer(value: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
	if (!Number.isSafeInteger(value) || value < min || value > max) throw unavailable();
	return value;
}
function text(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value) > 8192 ||
		/\p{Cc}/u.test(value)
	)
		throw unavailable();
	return value;
}
function client(raw: GoogleDesktopClient): GoogleDesktopClient {
	if (!raw || typeof raw !== "object" || types.isProxy(raw)) throw unavailable();
	if (![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw unavailable();
	const keys = Reflect.ownKeys(raw);
	if (keys.some((key) => key !== "clientId" && key !== "clientSecret")) throw unavailable();
	const read = (key: string): unknown => {
		const d = Object.getOwnPropertyDescriptor(raw, key);
		if (d && (!d.enumerable || !("value" in d))) throw unavailable();
		return d?.value;
	};
	const clientId = text(read("clientId")),
		secret = read("clientSecret");
	return Object.freeze({
		clientId,
		...(secret === undefined ? {} : { clientSecret: text(secret) }),
	});
}

/** Fixed native token exchange: DNS pinning, TLS, cancellation, bounded body and no redirects. */
async function exchange(
	form: Buffer,
	policy: EgressPolicy,
	signal: AbortSignal,
): Promise<{ status: number; body: unknown }> {
	const pin = await resolveEgress(HOST, 443, policy, signal);
	signal.throwIfAborted();
	const connection = createPinnedHttpsConnection(HOST, 443, pin, policy);
	return new Promise((resolve, reject) => {
		let settled = false,
			length = 0;
		const chunks: Buffer[] = [];
		const finish = (result?: { status: number; body: unknown }): void => {
			if (settled) return;
			settled = true;
			abort[Symbol.dispose]();
			req.destroy();
			connection.destroy();
			for (const chunk of chunks) chunk.fill(0);
			if (result && !signal.aborted) resolve(result);
			else reject(unavailable());
		};
		const req = request({
			...connection.options,
			method: "POST",
			path: "/token",
			headers: {
				...connection.options.headers,
				"content-type": "application/x-www-form-urlencoded",
				"content-length": form.length,
			},
		});
		const abort = addAbortListener(signal, () => finish());
		req.once("error", () => finish());
		connection.guard(
			req,
			() => settled || signal.aborted,
			() => req.end(form),
			() => finish(),
		);
		req.once("response", (response) => {
			if (
				settled ||
				signal.aborted ||
				![200, 400, 401, 503].includes(response.statusCode ?? 0) ||
				(response.headers["content-encoding"] &&
					response.headers["content-encoding"] !== "identity") ||
				!/^application\/json(?:;|$)/i.test(response.headers["content-type"] ?? "")
			) {
				response.destroy();
				return finish();
			}
			response.on("data", (chunk: Buffer) => {
				if (!Buffer.isBuffer(chunk) || chunk.length > MAX_RESPONSE_BYTES - length) {
					response.destroy();
					return finish();
				}
				length += chunk.length;
				chunks.push(Buffer.from(chunk));
			});
			response.once("error", () => finish());
			response.once("aborted", () => finish());
			response.once("end", () => {
				const bytes = Buffer.concat(chunks);
				try {
					if (!response.complete) throw unavailable();
					finish({
						status: response.statusCode as number,
						body: JSON.parse(bytes.toString("utf8")),
					});
				} catch {
					finish();
				} finally {
					bytes.fill(0);
				}
			});
		});
	});
}

/** Hub-only Gmail adapter. Native account/admin authorization precedes every lifecycle call. */
export class GmailCredentials {
	readonly #options: GmailCredentialOptions;
	readonly #policy: EgressPolicy;
	readonly #now: () => number;
	readonly #delay: number;
	readonly #timeout: number;
	readonly refresh: CredentialRefresh;
	constructor(options: GmailCredentialOptions) {
		this.#options = Object.freeze({ ...options });
		this.#policy = captureEgressPolicy({
			...captureEgressPolicy(options.egressPolicy),
			allowLocal: false,
		});
		this.#now = options.now ?? Date.now;
		this.#delay = integer(options.deletionDelayMs ?? GMAIL_DELETION_DELAY_MS, 1);
		this.#timeout = integer(options.timeoutMs ?? 15_000, 1, 60_000);
		this.refresh = (value, context) => this.#refresh(value, context);
	}
	#notify(scope: WorkScope, row: Pick<Binding, "user_id" | "account_id">): void {
		this.#options.events.append(scope, {
			userId: row.user_id,
			accountId: row.account_id,
			dataClass: "gmail.metadata",
			kind: "accounts.changed",
			ids: [row.account_id],
		});
	}
	createInTransaction(
		scope: WorkScope,
		accountId: string,
		userId: string,
		value: GoogleTokens,
	): string {
		try {
			return this.#create(scope, accountId, userId, value);
		} catch {
			this.#options.database.abort(scope);
			throw unavailable();
		}
	}
	#create(scope: WorkScope, accountId: string, userId: string, value: GoogleTokens): string {
		const sql = this.#options.database.sql(scope);
		accountId = id(accountId);
		userId = id(userId);
		const reference = this.#options.vault.createInTransaction(
			sql,
			{ ownerKind: "account", ownerId: accountId, kind: "gmail-oauth" },
			value,
		);
		sql.run("INSERT INTO main.gmail_credentials(account_id,user_id,credential_ref) VALUES(?,?,?)", [
			accountId,
			userId,
			reference,
		]);
		this.#notify(scope, { account_id: accountId, user_id: userId });
		return reference;
	}
	replaceInTransaction(scope: WorkScope, accountId: string, value: GoogleTokens): void {
		try {
			this.#replace(scope, accountId, value);
		} catch {
			this.#options.database.abort(scope);
			throw unavailable();
		}
	}
	#replace(scope: WorkScope, accountId: string, value: GoogleTokens): void {
		const sql = this.#options.database.sql(scope);
		const row = sql.get<Binding>("SELECT * FROM main.gmail_credentials WHERE account_id=?", [
			id(accountId),
		]);
		if (!row) throw unavailable();
		this.#options.vault.replaceInTransaction(
			sql,
			row.credential_ref,
			{ ownerKind: "account", ownerId: accountId, kind: "gmail-oauth" },
			value,
		);
		sql.run("UPDATE main.gmail_credentials SET invalid_at=NULL,delete_at=NULL WHERE account_id=?", [
			accountId,
		]);
		this.#notify(scope, row);
	}
	deadline(accountId: string): GmailCredentialDeadline | null {
		const row = this.#options.store.read((db) =>
			db.get<Binding>("SELECT * FROM main.gmail_credentials WHERE account_id=?", [id(accountId)]),
		);
		if (!row) throw unavailable();
		if (row.invalid_at === null && row.delete_at === null) return null;
		return Object.freeze({
			invalidAt: integer(row.invalid_at as number),
			deleteAt: integer(row.delete_at as number),
		});
	}
	async #refresh(value: CredentialValue, context: CredentialUse): Promise<GoogleTokens> {
		let body: Buffer | undefined;
		try {
			if (
				value.kind !== "gmail-oauth" ||
				context.binding.kind !== "gmail-oauth" ||
				context.binding.ownerKind !== "account"
			)
				throw unavailable();
			const row = this.#options.store.read((db) =>
				db.get<Binding>(
					"SELECT * FROM main.gmail_credentials WHERE account_id=? AND credential_ref=?",
					[context.binding.ownerId, context.reference],
				),
			);
			if (!row || row.invalid_at !== null) throw unavailable();
			const selected = client(this.#options.clientFor(row.account_id));
			body = Buffer.from(
				new URLSearchParams({
					grant_type: "refresh_token",
					client_id: selected.clientId,
					...(selected.clientSecret === undefined ? {} : { client_secret: selected.clientSecret }),
					refresh_token: text(value.refreshToken),
				}).toString(),
			);
			const signal = AbortSignal.any([context.signal, AbortSignal.timeout(this.#timeout)]);
			const response = await exchange(body, this.#policy, signal);
			signal.throwIfAborted();
			const result = response.body;
			if (!result || typeof result !== "object" || Array.isArray(result)) throw unavailable();
			if (response.status === 400 && "error" in result && result.error === "invalid_grant") {
				this.#options.database.write((scope) => {
					const sql = this.#options.database.sql(scope);
					const current = sql.get<{ generation: number; status: string }>(
						"SELECT generation,status FROM main.credentials WHERE id=? AND owner_id=? AND kind='gmail-oauth'",
						[context.reference, row.account_id],
					);
					if (
						signal.aborted ||
						current?.generation !== context.generation ||
						current.status !== "refreshing"
					)
						throw unavailable();
					const at = integer(this.#now()),
						until = integer(at + this.#delay);
					if (
						sql.run(
							"UPDATE main.gmail_credentials SET invalid_at=?,delete_at=? WHERE account_id=? AND credential_ref=? AND invalid_at IS NULL",
							[at, until, row.account_id, context.reference],
						).changes !== 1
					)
						throw unavailable();
					this.#notify(scope, row);
				});
				throw unavailable();
			}
			if (
				response.status !== 200 ||
				!("access_token" in result) ||
				!("expires_in" in result) ||
				!("token_type" in result) ||
				result.token_type !== "Bearer"
			)
				throw unavailable();
			const seconds = integer(result.expires_in as number, 1, 31_536_000);
			const refreshToken =
				"refresh_token" in result ? text(result.refresh_token) : value.refreshToken;
			return Object.freeze({
				kind: "gmail-oauth",
				accessToken: text(result.access_token),
				refreshToken,
				expiresAt: integer(integer(this.#now()) + seconds * 1000),
			});
		} catch {
			throw unavailable();
		} finally {
			body?.fill(0);
		}
	}
	toJSON(): string {
		return "[REDACTED]";
	}
}
