import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";
import {
	CONNECTOR_DEADLINE_MS,
	ConnectorClientError,
	copyChunk,
	data,
	jsonObject,
	MAX_CONNECTOR_RESPONSE_BYTES,
	refused,
	syntheticUrl,
	text,
} from "./connector-client/data.ts";
import type { Fake } from "./server.ts";

export {
	CONNECTOR_DEADLINE_MS,
	ConnectorClientError,
	MAX_CONNECTOR_RESPONSE_BYTES,
} from "./connector-client/data.ts";

export interface ConnectorClientOptions {
	readonly profile: "cimd-public" | "issuer-resource";
	readonly issuer: string;
	readonly resource: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly transport: Fake;
}

export interface ConnectorDiscovery {
	readonly issuer: string;
	readonly resource: string;
	readonly authorizationEndpoint: string;
	readonly tokenEndpoint: string;
	readonly revocationEndpoint: string;
}

export interface ConnectorReply {
	readonly status: number;
	readonly body: Readonly<Record<string, unknown>>;
}

export type ConnectorCallback =
	| { readonly kind: "exchange"; readonly reply: ConnectorReply }
	| { readonly kind: "error"; readonly error: string };

export interface ReuseObservation {
	readonly retiredRefreshRejected: boolean;
	readonly currentRefreshRejected: boolean;
	readonly previousAccessStatus: number;
	readonly currentAccessStatus: number;
}

interface Operation {
	readonly signal: AbortSignal;
	fresh(): void;
}

function advertised(value: unknown, member: string): boolean {
	return Array.isArray(value) && value.includes(member);
}

function token(value: unknown): string {
	return text(value, 4096);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	return await new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(new ConnectorClientError());
		signal.addEventListener("abort", abort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

/** Synthetic client fixture. It issues no tokens, grants, approvals or production requests. */
export class ConnectorClient {
	readonly #options: Omit<ConnectorClientOptions, "transport">;
	readonly #fetch: Fake["fetch"];
	#discovered: ConnectorDiscovery | undefined;
	#pending: { state: string; verifier: string } | undefined;
	#busy = false;
	#timedOut = false;

	constructor(raw: ConnectorClientOptions) {
		const options = data(raw, [
			"profile",
			"issuer",
			"resource",
			"clientId",
			"redirectUri",
			"transport",
		]);
		if (options.profile !== "cimd-public" && options.profile !== "issuer-resource") refused();
		const issuer = syntheticUrl(text(options.issuer) + "/").slice(0, -1);
		if (issuer !== options.issuer || new URL(issuer).origin !== issuer) refused();
		const resource = syntheticUrl(options.resource, issuer),
			clientId = syntheticUrl(options.clientId),
			redirectUri = syntheticUrl(options.redirectUri);
		const transport = options.transport;
		if (
			typeof transport !== "object" ||
			transport === null ||
			types.isProxy(transport) ||
			Object.getPrototypeOf(transport) !== Object.prototype
		)
			refused();
		const host = Object.getOwnPropertyDescriptor(transport, "host"),
			fetch = Object.getOwnPropertyDescriptor(transport, "fetch");
		if (
			!host ||
			!("value" in host) ||
			host.value !== new URL(issuer).host ||
			!fetch ||
			!("value" in fetch) ||
			typeof fetch.value !== "function" ||
			types.isProxy(fetch.value)
		)
			refused();
		const capturedFetch = fetch.value as Fake["fetch"];
		this.#fetch = (input, init) => Reflect.apply(capturedFetch, transport, [input, init]);
		this.#options = Object.freeze({
			profile: options.profile,
			issuer,
			resource,
			clientId,
			redirectUri,
		});
	}

	/** Metadata for the test to serve itself; this does not register or trust a client. */
	clientMetadata(): Readonly<Record<string, unknown>> {
		return Object.freeze({
			client_id: this.#options.clientId,
			client_name: "DYTEST synthetic connector",
			redirect_uris: Object.freeze([this.#options.redirectUri]),
			token_endpoint_auth_method: "none",
			grant_types: Object.freeze(["authorization_code", "refresh_token"]),
			response_types: Object.freeze(["code"]),
		});
	}

	async #operation<T>(work: (operation: Operation) => Promise<T>): Promise<T> {
		if (this.#busy || this.#timedOut) refused();
		const start = performance.now();
		if (!Number.isFinite(start) || start < 0) refused();
		this.#busy = true;
		const controller = new AbortController(),
			end = start + CONNECTOR_DEADLINE_MS;
		const expire = (): void => {
			this.#timedOut = true;
			controller.abort();
		};
		const fresh = (): void => {
			const now = performance.now();
			if (controller.signal.aborted || !Number.isFinite(now) || now < start || now >= end) {
				expire();
				refused();
			}
		};
		const timer = setTimeout(expire, CONNECTOR_DEADLINE_MS);
		try {
			const result = await work({ signal: controller.signal, fresh });
			fresh();
			return result;
		} catch {
			throw new ConnectorClientError();
		} finally {
			clearTimeout(timer);
			controller.abort();
			this.#busy = false;
		}
	}

	async #request(
		operation: Operation,
		url: string,
		init: RequestInit = {},
	): Promise<{ response: Response; body: Readonly<Record<string, unknown>> }> {
		operation.fresh();
		const response = await abortable(
			this.#fetch(url, { ...init, redirect: "manual", signal: operation.signal }),
			operation.signal,
		);
		operation.fresh();
		if (!(response instanceof Response) || (response.status >= 300 && response.status < 400))
			refused();
		const reader = response.body?.getReader();
		const bytes = new Uint8Array(MAX_CONNECTOR_RESPONSE_BYTES);
		let length = 0,
			ended = false;
		try {
			if (reader)
				for (;;) {
					const next = await abortable(reader.read(), operation.signal);
					operation.fresh();
					if (next.done) {
						ended = true;
						break;
					}
					const chunk = copyChunk(next.value, bytes.length - length);
					bytes.set(chunk, length);
					length += chunk.byteLength;
					operation.fresh();
				}
			const contentType = response.headers.get("content-type") ?? "";
			if (
				length > 0 &&
				!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?$/iu.test(contentType)
			)
				refused();
			const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
				bytes.subarray(0, length),
			);
			const body =
				raw === ""
					? Object.freeze(Object.create(null) as Record<string, unknown>)
					: jsonObject(raw);
			operation.fresh();
			return { response, body };
		} finally {
			if (reader && !ended) void reader.cancel().catch(() => {});
			reader?.releaseLock();
		}
	}

	async #discover(operation: Operation): Promise<ConnectorDiscovery> {
		if (this.#discovered) return this.#discovered;
		const { issuer, resource, profile } = this.#options;
		const challenge = await this.#request(operation, resource, { method: "POST" });
		const header = challenge.response.headers.get("www-authenticate") ?? "";
		if (challenge.response.status !== 401 || header.length > 2048 || !/^Bearer /iu.test(header))
			refused();
		const matches = [...header.matchAll(/(?:^|[ ,])resource_metadata="([^"\\]+)"/gu)];
		if (matches.length !== 1) refused();
		const resourceMetadata = await this.#request(operation, syntheticUrl(matches[0]?.[1], issuer));
		if (
			resourceMetadata.response.status !== 200 ||
			resourceMetadata.body.resource !== resource ||
			!Array.isArray(resourceMetadata.body.authorization_servers) ||
			resourceMetadata.body.authorization_servers.length !== 1 ||
			resourceMetadata.body.authorization_servers[0] !== issuer
		)
			refused();
		const metadata = await this.#request(
			operation,
			issuer + "/.well-known/oauth-authorization-server",
		);
		if (
			metadata.response.status !== 200 ||
			metadata.body.issuer !== issuer ||
			!advertised(metadata.body.code_challenge_methods_supported, "S256") ||
			!advertised(metadata.body.token_endpoint_auth_methods_supported, "none") ||
			metadata.body.authorization_response_iss_parameter_supported !== true ||
			(profile === "cimd-public" && metadata.body.client_id_metadata_document_supported !== true)
		)
			refused();
		const result = Object.freeze({
			issuer,
			resource,
			authorizationEndpoint: syntheticUrl(metadata.body.authorization_endpoint, issuer),
			tokenEndpoint: syntheticUrl(metadata.body.token_endpoint, issuer),
			revocationEndpoint: syntheticUrl(metadata.body.revocation_endpoint, issuer),
		});
		operation.fresh();
		this.#discovered = result;
		return result;
	}

	discover(): Promise<ConnectorDiscovery> {
		return this.#operation((operation) => this.#discover(operation));
	}

	beginAuthorization(): Promise<string> {
		return this.#operation(async (operation) => {
			if (this.#pending) refused();
			const discovered = await this.#discover(operation);
			const verifier = randomBytes(32).toString("base64url"),
				state = randomBytes(32).toString("base64url");
			const query = new URLSearchParams({
				response_type: "code",
				client_id: this.#options.clientId,
				redirect_uri: this.#options.redirectUri,
				resource: discovered.resource,
				state,
				code_challenge: createHash("sha256").update(verifier).digest("base64url"),
				code_challenge_method: "S256",
			});
			operation.fresh();
			this.#pending = { state, verifier };
			return discovered.authorizationEndpoint + "?" + query;
		});
	}

	async #post(
		operation: Operation,
		endpoint: "tokenEndpoint" | "revocationEndpoint",
		form: URLSearchParams,
	): Promise<ConnectorReply> {
		const discovered = await this.#discover(operation);
		form.set("client_id", this.#options.clientId);
		const reply = await this.#request(operation, discovered[endpoint], {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form,
		});
		return Object.freeze({ status: reply.response.status, body: reply.body });
	}

	acceptCallback(raw: string): Promise<ConnectorCallback> {
		return this.#operation(async (operation) => {
			if (!this.#pending) refused();
			text(raw, 8192);
			let callback: URL;
			try {
				callback = new URL(raw);
			} catch {
				return refused();
			}
			if (
				raw.includes("#") ||
				raw.slice(0, raw.indexOf("?")) !== this.#options.redirectUri ||
				callback.origin + callback.pathname !== this.#options.redirectUri
			)
				refused();
			const fields = callback.searchParams;
			const keys = [...fields.keys()];
			if (
				new Set(keys).size !== keys.length ||
				keys.some(
					(key) =>
						!["iss", "state", "code", "error", "error_description", "error_uri"].includes(key),
				) ||
				fields.get("iss") !== this.#options.issuer ||
				fields.get("state") !== this.#pending.state
			)
				refused();
			const code = fields.get("code"),
				error = fields.get("error");
			if ((code === null) === (error === null)) refused();
			if (error !== null) {
				if (!/^[a-z_]{1,64}$/u.test(error)) refused();
				this.#pending = undefined;
				return Object.freeze({ kind: "error", error });
			}
			const verifier = this.#pending.verifier;
			token(code);
			this.#pending = undefined;
			const reply = await this.#post(
				operation,
				"tokenEndpoint",
				new URLSearchParams({
					grant_type: "authorization_code",
					code: code ?? "",
					code_verifier: verifier,
					redirect_uri: this.#options.redirectUri,
					resource: this.#options.resource,
				}),
			);
			return Object.freeze({ kind: "exchange", reply });
		});
	}

	refresh(refreshToken: string): Promise<ConnectorReply> {
		return this.#operation((operation) =>
			this.#post(
				operation,
				"tokenEndpoint",
				new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: token(refreshToken),
					resource: this.#options.resource,
				}),
			),
		);
	}

	revoke(rawToken: string): Promise<ConnectorReply> {
		return this.#operation((operation) =>
			this.#post(operation, "revocationEndpoint", new URLSearchParams({ token: token(rawToken) })),
		);
	}

	async #resource(operation: Operation, accessToken: string): Promise<number> {
		const reply = await this.#request(operation, this.#options.resource, {
			method: "POST",
			headers: { authorization: "Bearer " + token(accessToken) },
		});
		return reply.response.status;
	}

	callResource(accessToken: string): Promise<number> {
		return this.#operation((operation) => this.#resource(operation, accessToken));
	}

	/** Records responses only: it cannot establish the server's real rotation/audience policy. */
	observeReuse(
		retiredRefresh: string,
		currentRefresh: string,
		previousAccess: string,
		currentAccess: string,
	): Promise<ReuseObservation> {
		return this.#operation(async (operation) => {
			const values = [retiredRefresh, currentRefresh, previousAccess, currentAccess].map(token);
			const old = await this.#post(
				operation,
				"tokenEndpoint",
				new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: values[0] ?? "",
					resource: this.#options.resource,
				}),
			);
			const current = await this.#post(
				operation,
				"tokenEndpoint",
				new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: values[1] ?? "",
					resource: this.#options.resource,
				}),
			);
			return Object.freeze({
				retiredRefreshRejected: old.status === 400 && old.body.error === "invalid_grant",
				currentRefreshRejected: current.status === 400 && current.body.error === "invalid_grant",
				previousAccessStatus: await this.#resource(operation, values[2] ?? ""),
				currentAccessStatus: await this.#resource(operation, values[3] ?? ""),
			});
		});
	}
}
