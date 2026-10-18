// oidc-provider 9.12.2 ships no types and no @types package is pinned: the parts S4 uses.
declare module "oidc-provider" {
	import type { IncomingMessage, ServerResponse } from "node:http";

	export type Jwk = Record<string, unknown>;
	export interface Jwks {
		keys: Jwk[];
	}
	export type ClientMetadata = Record<string, unknown>;

	export interface Client {
		readonly clientId: string;
		readonly clientName?: string;
		readonly clientAuthMethod: string;
		readonly redirectUris: string[];
		readonly grantTypes: string[];
		readonly jwksUri?: string;
		// Set on clients resolved from a client ID metadata document.
		readonly clientIdMetadataDocument?: true;
		grantTypeAllowed(type: string): boolean;
		redirectUriAllowed(value: string): boolean;
	}

	// The per-request context (ctx.oidc); one class per provider.
	export interface OIDCContext {
		readonly route: string;
		clientJwtAuthExpectedAudience(): Set<string>;
	}

	export interface InteractionResults {
		login?: { accountId: string; remember?: boolean };
		consent?: { grantId: string };
		error?: string;
		error_description?: string;
	}

	export interface KoaContext {
		readonly req: IncomingMessage;
		readonly path: string;
		readonly method: string;
		readonly response: { readonly headers: Readonly<Record<string, unknown>> };
		status: number;
		body: unknown;
		type: string;
		set(field: string, value: string): void;
		remove(field: string): void;
		readonly oidc: {
			readonly provider: Provider;
			readonly route?: string;
			readonly result?: InteractionResults;
			readonly client?: Client;
		};
	}
	export type Middleware = (ctx: KoaContext, next: () => Promise<void>) => Promise<void>;

	export interface Interaction {
		readonly uid: string;
		readonly exp: number;
		readonly returnTo: string;
		readonly params: Record<string, string | undefined>;
		readonly prompt: { readonly name: string };
	}

	export interface StoredToken {
		readonly jti: string;
		readonly clientId: string;
		readonly accountId: string;
		readonly grantId: string;
		readonly exp: number;
		readonly aud?: string;
		readonly scope?: string;
		readonly expiresWithSession?: boolean;
		destroy(): Promise<void>;
	}

	export class Grant {
		constructor(properties: { accountId: string; clientId: string });
		readonly jti: string;
		readonly accountId: string;
		readonly clientId: string;
		readonly exp: number;
		readonly isExpired: boolean;
		addResourceScope(resource: string, scope: string): void;
		rejectResourceScope(resource: string, scope: string): void;
		rejectOIDCScope(scope: string): void;
		getResourceScope(resource: string): string;
		save(): Promise<string>;
	}

	// A model's stored payloads, by id; the value of an opaque token is its id.
	export interface Adapter {
		find(id: string): Promise<Record<string, unknown> | undefined>;
		upsert(id: string, payload: Record<string, unknown>, expiresIn: number): Promise<void>;
		destroy(id: string): Promise<void>;
	}

	export interface Finder<T> {
		find(id: string, options?: { ignoreExpiration?: boolean }): Promise<T | undefined>;
		readonly adapter: Adapter;
	}

	export type Configuration = Record<string, unknown>;

	export class Provider {
		constructor(issuer: string, configuration: Configuration);
		readonly issuer: string;
		proxy: boolean;
		readonly OIDCContext: { readonly prototype: OIDCContext };
		// A route's URL under the issuer, whatever the request named.
		urlFor(name: string): string;
		callback(): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
		use(middleware: Middleware): this;
		on(event: string, listener: (...args: unknown[]) => void): this;
		interactionDetails(req: IncomingMessage, res: ServerResponse): Promise<Interaction>;
		interactionResult(
			req: IncomingMessage,
			res: ServerResponse,
			result: InteractionResults,
			options?: { mergeWithLastSubmission?: boolean },
		): Promise<string>;
		readonly Grant: typeof Grant & Finder<Grant>;
		readonly Client: Finder<Client> & { readonly prototype: Client };
		readonly AccessToken: Finder<StoredToken>;
		readonly AuthorizationCode: Finder<StoredToken>;
		readonly RefreshToken: Finder<StoredToken & { readonly consumed?: number }>;
		readonly Interaction: Finder<{ readonly exp: number }>;
		readonly Session: Finder<{ readonly exp: number; destroy(): Promise<void> }>;
	}

	export class Check {
		constructor(
			reason: string,
			description: string,
			error: string,
			check: (ctx: KoaContext) => boolean | Promise<boolean>,
		);
	}
	export interface Prompt {
		readonly name: string;
		readonly checks: { add(check: Check, index?: number): void };
	}
	export const interactionPolicy: {
		base(): Prompt[] & { get(name: string): Prompt | undefined };
		Check: typeof Check;
	};

	export const errors: {
		InvalidTarget: new (description?: string) => Error;
		InvalidClientAuth: new (description?: string) => Error;
		OIDCProviderError: new (status: number, error: string) => Error;
	};

	export default Provider;
}

declare module "oidc-provider/lib/adapters/memory_adapter.js" {
	export interface Store {
		get(key: string): unknown;
		set(key: string, value: unknown, options?: { readonly maxAge?: number }): void;
		delete(key: string): void;
	}
	export default class MemoryAdapter {
		constructor(model: string, store: Store, clockTolerance?: number);
	}
}
