import { createHash, randomBytes } from "node:crypto";
import { types } from "node:util";
import { parseBearerChallenge } from "./connector-client/challenge.ts";
import {
	CONNECTOR_DEADLINE_MS,
	ConnectorClientError,
	copyChunk,
	jsonObject,
	MAX_CONNECTOR_RESPONSE_BYTES,
	optionData,
	refused,
	syntheticUrl,
	text,
} from "./connector-client/data.ts";
import {
	type ConnectorProfileName,
	type ConnectorProfileOptions,
	normalizeConnectorProfile,
} from "./connector-client/profiles.ts";
import { type Fake, resolveFakeTransport } from "./server.ts";

export {
	CONNECTOR_DEADLINE_MS,
	ConnectorClientError,
	MAX_CONNECTOR_RESPONSE_BYTES,
} from "./connector-client/data.ts";
export {
	createNodeConnectorTransport,
	type NodeConnectorTransportOptions,
} from "./connector-client/node-transport.ts";
export type { ConnectorProfileName } from "./connector-client/profiles.ts";

export interface ConnectorClientOptions {
	readonly profile: ConnectorProfileName;
	readonly issuer: string;
	readonly resource: string;
	readonly clientId?: string;
	readonly redirectUri: string;
	readonly transport: Fake;
	readonly metadata?: unknown;
	readonly privateKey?: ConnectorProfileOptions["privateKey"];
	readonly assertionAudience?: string;
	/** Omit to use advertised scopes, or select "none" for a deliberately scope-less request. */
	readonly scope?: readonly string[] | "none";
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

function scopes(value: unknown): readonly string[] {
	if (
		types.isProxy(value) ||
		!Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Array.prototype ||
		value.length > 64 ||
		Reflect.ownKeys(value).length !== value.length + 1
	)
		refused();
	const copied: string[] = [];
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refused();
		const item: unknown = descriptor.value;
		if (typeof item !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u.test(item)) refused();
		if (copied.includes(item)) refused();
		copied.push(item);
	}
	if (copied.join(" ").length > 2048) refused();
	return Object.freeze(copied);
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
	readonly #options: {
		readonly issuer: string;
		readonly resource: string;
		readonly clientId: string;
		readonly redirectUri: string;
	};
	readonly #profile: ReturnType<typeof normalizeConnectorProfile>;
	readonly #requestedScopes: readonly string[] | undefined;
	#defaultScopes: readonly string[] = Object.freeze([]);
	readonly #fetch: Fake["fetch"];
	#discovered: ConnectorDiscovery | undefined;
	#pending: { state: string; verifier: string } | undefined;
	#busy = false;
	#timedOut = false;

	constructor(raw: ConnectorClientOptions) {
		const options = optionData(
			raw,
			["profile", "issuer", "resource", "redirectUri", "transport"],
			["clientId", "metadata", "privateKey", "assertionAudience", "scope"],
		);
		const issuer = syntheticUrl(text(options.issuer) + "/").slice(0, -1);
		if (issuer !== options.issuer || new URL(issuer).origin !== issuer) refused();
		const resource = syntheticUrl(options.resource, issuer);
		const profileOptions: Record<string, unknown> = {
			profile: options.profile,
			redirectUri: options.redirectUri,
		};
		for (const key of ["clientId", "metadata", "privateKey", "assertionAudience"])
			if (Object.hasOwn(options, key)) profileOptions[key] = options[key];
		this.#profile = normalizeConnectorProfile(profileOptions as unknown as ConnectorProfileOptions);
		this.#requestedScopes = !Object.hasOwn(options, "scope")
			? undefined
			: options.scope === "none"
				? Object.freeze([])
				: scopes(options.scope);
		const transport = resolveFakeTransport(options.transport);
		if (!transport || transport.host !== new URL(issuer).host) refused();
		this.#fetch = transport.fetch;
		this.#options = Object.freeze({
			issuer,
			resource,
			clientId: this.#profile.clientId,
			redirectUri: this.#profile.redirectUri,
		});
	}

	/** Metadata for the test to serve itself; this does not register or trust a client. */
	clientMetadata(): Readonly<Record<string, unknown>> {
		return this.#profile.clientMetadata();
	}

	/** Public signing material for the test's fake metadata host; never contains private key data. */
	clientJwks(): Readonly<Record<string, unknown>> | undefined {
		return this.#profile.clientJwks();
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

	async #response(operation: Operation, url: string, init: RequestInit = {}): Promise<Response> {
		operation.fresh();
		const response = await abortable(
			this.#fetch(url, { ...init, redirect: "manual", signal: operation.signal }),
			operation.signal,
		);
		operation.fresh();
		if (!(response instanceof Response)) refused();
		if (response.status >= 300 && response.status < 400) {
			void response.body?.cancel().catch(() => {});
			refused();
		}
		return response;
	}

	async #request(
		operation: Operation,
		url: string,
		init: RequestInit = {},
	): Promise<{ response: Response; body: Readonly<Record<string, unknown>> }> {
		const response = await this.#response(operation, url, init);
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

	async #probe(operation: Operation, accessToken?: string): Promise<Response> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (accessToken !== undefined) headers.authorization = "Bearer " + token(accessToken);
		const response = await this.#response(operation, this.#options.resource, {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-06-18",
					capabilities: {},
					clientInfo: { name: "DYTEST-connector", version: "0.0.0" },
				},
			}),
		});
		void response.body?.cancel().catch(() => {});
		operation.fresh();
		return response;
	}

	async #discover(operation: Operation): Promise<ConnectorDiscovery> {
		if (this.#discovered) return this.#discovered;
		const { issuer, resource } = this.#options;
		const challenge = await this.#probe(operation);
		const header = challenge.headers.get("www-authenticate") ?? "";
		if (challenge.status !== 401) refused();
		const attributes = parseBearerChallenge(header);
		const resourceMetadata = await this.#request(
			operation,
			syntheticUrl(attributes.resource_metadata, issuer),
		);
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
			!advertised(metadata.body.token_endpoint_auth_methods_supported, this.#profile.authMethod) ||
			metadata.body.authorization_response_iss_parameter_supported !== true ||
			(this.#profile.requirements.cimd &&
				metadata.body.client_id_metadata_document_supported !== true)
		)
			refused();
		this.#defaultScopes =
			attributes.scope !== undefined
				? scopes(attributes.scope.split(" "))
				: resourceMetadata.body.scopes_supported === undefined
					? Object.freeze([])
					: scopes(resourceMetadata.body.scopes_supported);
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
			const requestedScopes = this.#requestedScopes ?? this.#defaultScopes;
			if (requestedScopes.length > 0) query.set("scope", requestedScopes.join(" "));
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
		this.#profile.authenticateForm(form, discovered[endpoint]);
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
			const configured = new URL(this.#options.redirectUri);
			const prefix = this.#options.redirectUri + (configured.search === "" ? "?" : "&");
			if (
				raw.includes("#") ||
				!raw.startsWith(prefix) ||
				callback.origin + callback.pathname !== configured.origin + configured.pathname
			)
				refused();
			const fields = new URLSearchParams(raw.slice(prefix.length));
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
		return (await this.#probe(operation, accessToken)).status;
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
