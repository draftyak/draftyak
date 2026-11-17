import { Account } from "@draftyak/protocol/entities/account";
import { OwnerSettings } from "@draftyak/protocol/entities/settings";
import { canonicalize } from "@draftyak/protocol/jcs";
import { Ulid } from "@draftyak/protocol/scalars";
import createOpenApiClient, { type Client as OpenApiClient } from "openapi-fetch";
import type { components, paths } from "./generated.ts";
import { readApiJson } from "./read-json.ts";

export interface ApiTransport {
	/** The host owns authentication, route admission and response status/MIME framing. */
	fetch(request: Request): Promise<Response>;
}

export type ApiOwnerSettings = components["schemas"]["draftyak.entities.OwnerSettings"];
export type ApiAccountRecord = components["schemas"]["draftyak.native.AccountRecord"];
export type ApiAccountPage = components["schemas"]["draftyak.native.AccountPage"];

export type ApiClientErrorCode =
	| "INVALID_REQUEST"
	| "FORBIDDEN"
	| "NOT_FOUND"
	| "UNAVAILABLE"
	| "CLIENT_INVALID_REQUEST"
	| "CLIENT_INVALID_RESPONSE"
	| "CLIENT_UNAVAILABLE"
	| "CLIENT_ABORTED";

export class ApiClientError extends Error {
	readonly code: ApiClientErrorCode;
	constructor(code: ApiClientErrorCode) {
		super("API request failed");
		this.name = "ApiClientError";
		this.code = code;
	}
}

export interface ApiCallOptions {
	readonly signal?: AbortSignal;
}

export interface ApiClientOptions {
	readonly transport: ApiTransport;
	readonly baseUrl: URL;
}

export interface ApiClient {
	getOwnerSettings(options?: ApiCallOptions): Promise<ApiOwnerSettings>;
	putOwnerSettings(value: unknown, options?: ApiCallOptions): Promise<ApiOwnerSettings>;
	getAccount(accountId: string, options?: ApiCallOptions): Promise<ApiAccountRecord>;
	pageAccounts(afterId?: string | null, options?: ApiCallOptions): Promise<ApiAccountPage>;
}

const SETTINGS_BYTES = 4096;
const ACCOUNT_BYTES = 1_048_576;
const PROJECTED_BYTES = 8 * 1024 * 1024;
const encoder = new TextEncoder();
function intrinsicUrlHref(): PropertyDescriptor["get"] {
	let prototype: object | null = URL.prototype;
	while (prototype !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(prototype, "href");
		if (descriptor !== undefined) return descriptor.get;
		prototype = Object.getPrototypeOf(prototype);
	}
	return undefined;
}
const urlHref = intrinsicUrlHref();
const responseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
const signalAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get;

function fail(code: ApiClientErrorCode): never {
	throw new ApiClientError(code);
}

function aborted(signal: AbortSignal | undefined): boolean {
	try {
		return (
			signal !== undefined &&
			signalAborted !== undefined &&
			Reflect.apply(signalAborted, signal, []) === true
		);
	} catch {
		return false;
	}
}

function callSignal(options: ApiCallOptions | undefined): AbortSignal | undefined {
	try {
		if (options === undefined) return undefined;
		if (options === null || typeof options !== "object" || Array.isArray(options))
			return fail("CLIENT_INVALID_REQUEST");
		const signal: unknown = options.signal;
		if (signal === undefined) return undefined;
		if (signalAborted === undefined) return fail("CLIENT_INVALID_REQUEST");
		Reflect.apply(signalAborted, signal, []);
		return signal as AbortSignal;
	} catch {
		return fail("CLIENT_INVALID_REQUEST");
	}
}

function identifier(value: unknown, code: ApiClientErrorCode): string {
	try {
		return Ulid.parse(value);
	} catch {
		return fail(code);
	}
}

function settings(value: unknown, code: ApiClientErrorCode): ApiOwnerSettings {
	try {
		const parsed = OwnerSettings.parse(value);
		// The actual API also enforces the schema's complete zone newline exclusion.
		if (/[\r\n\u2028\u2029]/u.test(parsed.zone)) return fail(code);
		return parsed;
	} catch {
		return fail(code);
	}
}

function fields(value: unknown, expected: readonly string[]): Record<string, unknown> {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return fail("CLIENT_INVALID_RESPONSE");
	const names = Reflect.ownKeys(value);
	if (
		names.length !== expected.length ||
		names.some((key) => typeof key !== "string" || !expected.includes(key))
	)
		return fail("CLIENT_INVALID_RESPONSE");
	const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const name of expected) {
		const descriptor = Object.getOwnPropertyDescriptor(value, name);
		if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor))
			return fail("CLIENT_INVALID_RESPONSE");
		result[name] = descriptor.value;
	}
	return result;
}

function accountRecord(value: unknown, requestedId?: string): ApiAccountRecord {
	try {
		const row = fields(value, ["account", "generation"]);
		if (
			typeof row.generation !== "number" ||
			!Number.isSafeInteger(row.generation) ||
			row.generation < 1
		)
			return fail("CLIENT_INVALID_RESPONSE");
		const account = Account.parse(row.account);
		if (requestedId !== undefined && account.id !== requestedId)
			return fail("CLIENT_INVALID_RESPONSE");
		// Canonical Account validation includes the status/deletion-deadline correlation.
		return { account, generation: row.generation } as ApiAccountRecord;
	} catch {
		return fail("CLIENT_INVALID_RESPONSE");
	}
}

function accountPage(value: unknown): ApiAccountPage {
	try {
		const page = fields(value, ["accounts", "nextId"]);
		if (!Array.isArray(page.accounts) || page.accounts.length > 100)
			return fail("CLIENT_INVALID_RESPONSE");
		const accounts = page.accounts.map((row: unknown) => accountRecord(row));
		const nextId = page.nextId === null ? null : identifier(page.nextId, "CLIENT_INVALID_RESPONSE");
		return { accounts, nextId };
	} catch {
		return fail("CLIENT_INVALID_RESPONSE");
	}
}

function apiError(value: unknown, status: number, allowNotFound: boolean): ApiClientErrorCode {
	try {
		const expected =
			status === 400
				? "INVALID_REQUEST"
				: status === 403
					? "FORBIDDEN"
					: status === 503
						? "UNAVAILABLE"
						: status === 404 && allowNotFound
							? "NOT_FOUND"
							: undefined;
		if (expected === undefined || fields(value, ["code"]).code !== expected)
			return fail("CLIENT_INVALID_RESPONSE");
		return expected;
	} catch {
		return fail("CLIENT_INVALID_RESPONSE");
	}
}

/** Four document-backed operations; configuration and returned entities confer no authority. */
export function createApiClient(options: ApiClientOptions): ApiClient {
	let base: URL;
	let transport: ApiTransport;
	let fetch: ApiTransport["fetch"];
	try {
		if (urlHref === undefined) return fail("CLIENT_INVALID_REQUEST");
		base = new URL(Reflect.apply(urlHref, options.baseUrl, []) as string);
		if (
			(base.protocol !== "http:" && base.protocol !== "https:") ||
			base.pathname !== "/" ||
			base.username !== "" ||
			base.password !== "" ||
			base.search !== "" ||
			base.hash !== ""
		)
			return fail("CLIENT_INVALID_REQUEST");
		transport = options.transport;
		fetch = transport.fetch;
		if (typeof fetch !== "function") return fail("CLIENT_INVALID_REQUEST");
	} catch {
		return fail("CLIENT_INVALID_REQUEST");
	}

	interface LibraryOutcome {
		readonly response: Response;
		readonly data?: unknown;
		readonly error?: unknown;
	}
	type Invoke = (
		client: OpenApiClient<paths>,
		signal: AbortSignal | undefined,
	) => Promise<LibraryOutcome>;

	async function request<T>(
		maxBytes: number,
		validate: (value: unknown) => T,
		allowNotFound: boolean,
		callOptions: ApiCallOptions | undefined,
		invoke: Invoke,
	): Promise<T> {
		const signal = callSignal(callOptions);
		if (aborted(signal)) return fail("CLIENT_ABORTED");
		let bridgeStarted = false;
		let finished = false;
		let finishBridge!: () => void;
		const bridgeJoined = new Promise<void>((resolve) => {
			finishBridge = resolve;
		});
		let bridgeFailure: ApiClientErrorCode | undefined;
		let capture:
			| { readonly status: number; readonly value: T }
			| { readonly status: number; readonly error: ApiClientErrorCode }
			| undefined;
		const stopped = new Error("API response adapter failed");
		function stop(code: ApiClientErrorCode): never {
			bridgeFailure ??= code;
			throw stopped;
		}
		async function boundedFetch(outgoing: Request): Promise<Response> {
			// A library call never gains permission to repeat the underlying operation.
			if (finished || bridgeStarted) return stop("CLIENT_UNAVAILABLE");
			bridgeStarted = true;
			try {
				let original: Response;
				try {
					original = (await Reflect.apply(fetch, transport, [outgoing])) as Response;
				} catch {
					return stop(aborted(signal) ? "CLIENT_ABORTED" : "CLIENT_UNAVAILABLE");
				}
				try {
					if (responseStatus === undefined) return stop("CLIENT_INVALID_RESPONSE");
					const status = Reflect.apply(responseStatus, original, []) as number;
					// Own every original body, including an abort-ignoring transport's late response.
					const value = await readApiJson(original, { maxBytes, signal });
					if (aborted(signal)) return stop("CLIENT_ABORTED");
					let projected: unknown;
					if (status === 200) {
						let valid: T;
						try {
							valid = validate(value);
						} catch {
							return stop("CLIENT_INVALID_RESPONSE");
						}
						capture = { status, value: valid };
						projected = valid;
					} else {
						const code = apiError(value, status, allowNotFound);
						if (code === "CLIENT_INVALID_RESPONSE") return stop(code);
						capture = { status, error: code };
						projected = { code };
					}
					// Validate original DATA before normalization; nonfinite invalid fields cannot become null.
					const serialized = JSON.stringify(projected);
					if (typeof serialized !== "string") return stop("CLIENT_INVALID_RESPONSE");
					const bytes = encoder.encode(serialized);
					if (bytes.byteLength > PROJECTED_BYTES) return stop("CLIENT_INVALID_RESPONSE");
					// The library receives only bounded owned JSON, with the actual status, never the raw body.
					return new Response(bytes, { status, headers: { "content-type": "application/json" } });
				} catch {
					return stop(
						bridgeFailure ?? (aborted(signal) ? "CLIENT_ABORTED" : "CLIENT_INVALID_RESPONSE"),
					);
				}
			} finally {
				finishBridge();
			}
		}
		let result: LibraryOutcome | undefined;
		let rejected = false;
		try {
			const client = createOpenApiClient<paths>({
				baseUrl: base.href,
				fetch: boundedFetch,
				headers: { accept: "application/json" },
			});
			result = await invoke(client, signal);
		} catch {
			rejected = true;
		} finally {
			if (bridgeStarted) await bridgeJoined;
			finished = true;
		}
		if (bridgeFailure !== undefined) return fail(bridgeFailure);
		if (aborted(signal)) return fail("CLIENT_ABORTED");
		if (rejected) return fail(bridgeStarted ? "CLIENT_INVALID_RESPONSE" : "CLIENT_INVALID_REQUEST");
		if (!bridgeStarted || capture === undefined || result === undefined)
			return fail("CLIENT_INVALID_RESPONSE");
		try {
			if (
				responseStatus === undefined ||
				Reflect.apply(responseStatus, result.response, []) !== capture.status
			)
				return fail("CLIENT_INVALID_RESPONSE");
			if ("value" in capture) {
				validate(result.data);
				// Preserve the original validated value rather than letting projection alter number details.
				return capture.value;
			}
			if (apiError(result.error, capture.status, allowNotFound) !== capture.error)
				return fail("CLIENT_INVALID_RESPONSE");
		} catch {
			return fail("CLIENT_INVALID_RESPONSE");
		}
		return fail(capture.error);
	}

	return Object.freeze({
		getOwnerSettings(callOptions?: ApiCallOptions): Promise<ApiOwnerSettings> {
			return request(
				SETTINGS_BYTES,
				(value) => settings(value, "CLIENT_INVALID_RESPONSE"),
				true,
				callOptions,
				(client, signal) =>
					client.GET("/api/v1/settings", { ...(signal === undefined ? {} : { signal }) }),
			);
		},
		async putOwnerSettings(
			value: unknown,
			callOptions?: ApiCallOptions,
		): Promise<ApiOwnerSettings> {
			let prepared: ApiOwnerSettings;
			let body: string;
			try {
				prepared = settings(value, "CLIENT_INVALID_REQUEST");
				body = canonicalize(prepared);
				if (encoder.encode(body).byteLength > SETTINGS_BYTES) return fail("CLIENT_INVALID_REQUEST");
			} catch {
				return fail("CLIENT_INVALID_REQUEST");
			}
			return request(
				SETTINGS_BYTES,
				(result) => settings(result, "CLIENT_INVALID_RESPONSE"),
				false,
				callOptions,
				(client, signal) =>
					client.PUT("/api/v1/settings", {
						...(signal === undefined ? {} : { signal }),
						body: prepared,
						bodySerializer: () => body,
						headers: { "content-type": "application/json" },
					}),
			);
		},
		async getAccount(accountId: string, callOptions?: ApiCallOptions): Promise<ApiAccountRecord> {
			const id = identifier(accountId, "CLIENT_INVALID_REQUEST");
			return request(
				ACCOUNT_BYTES,
				(value) => accountRecord(value, id),
				true,
				callOptions,
				(client, signal) =>
					client.GET("/api/v1/accounts/{accountId}", {
						...(signal === undefined ? {} : { signal }),
						params: { path: { accountId: id } },
					}),
			);
		},
		async pageAccounts(
			afterId: string | null = null,
			callOptions?: ApiCallOptions,
		): Promise<ApiAccountPage> {
			const id = afterId === null ? null : identifier(afterId, "CLIENT_INVALID_REQUEST");
			return request(ACCOUNT_BYTES, accountPage, false, callOptions, (client, signal) =>
				client.GET("/api/v1/accounts", {
					...(signal === undefined ? {} : { signal }),
					...(id === null ? {} : { params: { query: { afterId: id } } }),
				}),
			);
		},
	});
}
