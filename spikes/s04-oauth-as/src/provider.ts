import { generateKeyPairSync, randomBytes } from "node:crypto";
import Provider, {
	type Client,
	type ClientMetadata,
	type Configuration,
	errors,
	interactionPolicy,
	type Jwks,
	type KoaContext,
	type StoredToken,
} from "oidc-provider";
import MemoryAdapter from "oidc-provider/lib/adapters/memory_adapter.js";
import { RecordStore } from "./store.ts";

// One owner, no passwords: consent on the paired desktop stands in for login (§6).
export const OWNER = "owner";
// §6 agent scopes; the resource server knows only these, and no send, admin or plugin scope.
export const SCOPES: readonly string[] = [
	"inbox:read",
	"inbox:organize",
	"drafts:write",
	"outbox:propose",
];

export const MCP_PATH = "/mcp";
export const INTERACTION_PATH = "/oauth/interaction";
// Every provider route sits under /oauth; Hono forwards only the enabled ones (routes.ts).
export const ROUTES = {
	authorization: "/oauth/authorize",
	token: "/oauth/token",
	revocation: "/oauth/revoke",
	jwks: "/oauth/jwks",
	registration: "/oauth/register",
	end_session: "/oauth/session/end",
	userinfo: "/oauth/userinfo",
	introspection: "/oauth/introspect",
	pushed_authorization_request: "/oauth/par",
	device_authorization: "/oauth/device/auth",
	code_verification: "/oauth/device",
	backchannel_authentication: "/oauth/backchannel",
	challenge: "/oauth/challenge",
	credential: "/oauth/credential",
} as const;

// Seconds. Access tokens are §6's; the rest are spike choices recorded for ADR 0006.
export const TTL: Readonly<
	Record<
		"AccessToken" | "AuthorizationCode" | "Interaction" | "Session" | "RefreshToken" | "Grant",
		number
	>
> = {
	AccessToken: 60 * 60,
	AuthorizationCode: 60,
	Interaction: 10 * 60,
	Session: 10 * 60,
	RefreshToken: 30 * 24 * 60 * 60,
	Grant: 90 * 24 * 60 * 60,
};

export interface AsOptions {
	// https://<publicBaseUrl>, the only issuer (no path, query or fragment).
	readonly issuer: string;
	readonly clients?: readonly ClientMetadata[];
	// The hub's own signing keys, unwrapped; generated here when absent.
	readonly jwks?: Jwks;
	readonly cookieKeys?: readonly string[];
	// Later items (CIMD, private_key_jwt fetches, the DCR window) adjust the configuration here.
	readonly configure?: (configuration: Configuration) => void;
}

export function resourceFor(issuer: string): string {
	return new URL(MCP_PATH, issuer).href;
}

// A fresh RS256 signing key. The hub keeps it wrapped by its master key; the kid is the thumbprint.
export function generateJwks(): Jwks {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	return { keys: [{ ...privateKey.export({ format: "jwk" }), alg: "RS256", use: "sig" }] };
}

export const escapeHtml = (value: unknown): string =>
	String(value).replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The default error page imports a web font; this one loads nothing.
async function renderError(ctx: KoaContext, out: Record<string, unknown>): Promise<void> {
	ctx.type = "html";
	ctx.set("content-security-policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
	ctx.set("referrer-policy", "no-referrer");
	const lines = Object.entries(out)
		.map(([key, value]) => `<p>${escapeHtml(key)}: ${escapeHtml(value)}</p>`)
		.join("");
	ctx.body = `<!doctype html><meta charset="utf-8"><title>DraftYak sign-in error</title>${lines}`;
}

export function createProvider(options: AsOptions): Provider {
	const resource = resourceFor(options.issuer);
	const policy = interactionPolicy.base();
	const consent = policy.get("consent");
	if (!consent) throw new Error("oidc-provider's interaction policy has no consent prompt");
	// No silent re-authorization: every authorization request goes through typed-code consent once.
	consent.checks.add(
		new interactionPolicy.Check(
			"owner_consent",
			"every authorization needs the owner's typed-code consent",
			"consent_required",
			(ctx) => !ctx.oidc.result?.consent,
		),
		0,
	);
	const store = new RecordStore();
	const configuration: Configuration = {
		adapter: (model: string) => new MemoryAdapter(model, store),
		clients: [...(options.clients ?? [])],
		clientDefaults: {
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		},
		clientAuthMethods: ["none", "private_key_jwt"],
		// Origin never decides a token or revocation request; client authentication does. No browser
		// client is served: routes.ts strips every Access-Control-* header, so no page can read one.
		clientBasedCORS: () => true,
		enabledJWA: { clientAuthSigningAlgValues: ["RS256"] },
		cookies: {
			keys: [...(options.cookieKeys ?? [randomBytes(32).toString("base64url")])],
		},
		features: {
			devInteractions: { enabled: false },
			dPoP: { enabled: false },
			pushedAuthorizationRequests: { enabled: false },
			userinfo: { enabled: false },
			rpInitiatedLogout: { enabled: false },
			revocation: {
				enabled: true,
				// RFC 7009: a token of another client is ignored, never revoked.
				allowedPolicy: async (_ctx: KoaContext, client: Client, token: StoredToken) =>
					token.clientId === client.clientId,
			},
			resourceIndicators: {
				enabled: true,
				// One resource and one audience: requests that name none get it, others fail.
				defaultResource: async () => resource,
				useGrantedResource: async () => true,
				getResourceServerInfo: async (_ctx: KoaContext, indicator: string) => {
					if (indicator !== resource) throw new errors.InvalidTarget();
					// The lifetime comes from ttl.AccessToken alone: a number there ignores accessTokenTTL.
					return { scope: SCOPES.join(" "), audience: resource, accessTokenFormat: "opaque" };
				},
			},
		},
		findAccount: async (_ctx: KoaContext, sub: string) =>
			sub === OWNER ? { accountId: OWNER, claims: async () => ({ sub: OWNER }) } : undefined,
		interactions: {
			policy,
			url: async (_ctx: KoaContext, interaction: { uid: string }) =>
				`${INTERACTION_PATH}/${interaction.uid}`,
		},
		// Refresh tokens need neither offline_access nor prompt=consent, and outlive the browser session.
		issueRefreshToken: async (_ctx: KoaContext, client: Client) =>
			client.grantTypeAllowed("refresh_token"),
		expiresWithSession: async () => false,
		// Every refresh rotates, for public and confidential clients; a reused one revokes the grant.
		rotateRefreshToken: true,
		jwks: options.jwks ?? generateJwks(),
		pkce: { required: () => true },
		renderError,
		responseTypes: ["code"],
		routes: { ...ROUTES },
		scopes: ["openid"],
		ttl: { ...TTL },
	};
	options.configure?.(configuration);
	return new Provider(options.issuer, configuration);
}

export interface TokenInfo {
	readonly clientId: string;
	readonly grantId: string;
	readonly scope: string;
}

// In-process check of an opaque access token: live, unrevoked, issued for this resource, and its
// grant still live and the same client's and account's, as oidc-provider's own token consumers
// require. A token never outlives its grant.
export async function verifyAccessToken(
	provider: Provider,
	value: string,
): Promise<TokenInfo | undefined> {
	const token = await provider.AccessToken.find(value);
	if (!token || token.aud !== resourceFor(provider.issuer)) return undefined;
	const grant = await provider.Grant.find(token.grantId, { ignoreExpiration: true });
	if (
		!grant ||
		grant.isExpired ||
		grant.clientId !== token.clientId ||
		grant.accountId !== token.accountId
	) {
		return undefined;
	}
	return { clientId: token.clientId, grantId: token.grantId, scope: token.scope ?? "" };
}
