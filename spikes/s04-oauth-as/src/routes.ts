import { createHash } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";
import { type Context, Hono } from "hono";
import type { Interaction, InteractionResults, KoaContext, Provider } from "oidc-provider";
import { type ConsentEntry, type ConsentRequest, ConsentStub } from "./consent.ts";
import {
	escapeHtml,
	INTERACTION_PATH,
	MCP_PATH,
	OWNER,
	ROUTES,
	resourceFor,
	SCOPES,
	verifyAccessToken,
} from "./provider.ts";

export interface Env {
	Bindings: HttpBindings;
}

export const METADATA_PATH = "/.well-known/oauth-authorization-server";
export const PRM_PATH: string = `/.well-known/oauth-protected-resource${MCP_PATH}`;

// A provider route Hono forwards. `open` gates a route at run time (the DCR window); a closed
// route is a 404 and drops out of the metadata.
export interface ProviderRoute {
	readonly method: "GET" | "POST";
	readonly path: string;
	readonly open?: () => boolean;
}

// The only provider routes reachable through Hono. The rest of /oauth/* is a 404, including the
// confirm route oidc-provider registers with logout off (POST /oauth/session/end/confirm).
export const PROVIDER_ROUTES: readonly ProviderRoute[] = [
	{ method: "GET", path: METADATA_PATH },
	{ method: "GET", path: ROUTES.authorization },
	{ method: "GET", path: `${ROUTES.authorization}/:uid` },
	{ method: "POST", path: ROUTES.token },
	{ method: "POST", path: ROUTES.revocation },
	{ method: "GET", path: ROUTES.jwks },
];

// RFC 8414 fields, plus RFC 9207's iss flag and CIMD's. OIDC-only fields are dropped.
const METADATA_KEYS = [
	"issuer",
	"authorization_endpoint",
	"token_endpoint",
	"jwks_uri",
	"registration_endpoint",
	"scopes_supported",
	"response_types_supported",
	"response_modes_supported",
	"grant_types_supported",
	"token_endpoint_auth_methods_supported",
	"token_endpoint_auth_signing_alg_values_supported",
	"revocation_endpoint",
	"introspection_endpoint",
	"code_challenge_methods_supported",
	"authorization_response_iss_parameter_supported",
	"client_id_metadata_document_supported",
];

// An endpoint is advertised only while its path is routed, under the issuer's origin: oidc-provider
// builds endpoint URLs from the request (Koa's ctx.href), not from the issuer. The resource's
// scopes replace the provider's OIDC scope list, and revocation states the token endpoint's client
// authentication, which oidc-provider uses there too (RFC 8414 would otherwise imply
// client_secret_basic).
export function projectMetadata(
	raw: Record<string, unknown>,
	routed: (path: string) => boolean,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const key of METADATA_KEYS) {
		const value = raw[key];
		if (value === undefined) continue;
		if (key.endsWith("_endpoint") || key === "jwks_uri") {
			const { pathname } = new URL(String(value));
			if (routed(pathname)) out[key] = new URL(pathname, String(raw.issuer)).href;
		} else {
			out[key] = value;
		}
	}
	out.scopes_supported = [...SCOPES];
	if (out.revocation_endpoint !== undefined) {
		out.revocation_endpoint_auth_methods_supported = out.token_endpoint_auth_methods_supported;
		out.revocation_endpoint_auth_signing_alg_values_supported =
			out.token_endpoint_auth_signing_alg_values_supported;
	}
	return out;
}

// The forwarding app's route table travels with each request to the provider's one middleware.
const ROUTED = Symbol("routed");
type Forwarded = IncomingMessage & { [ROUTED]?: (path: string) => boolean };
const baseRouted = (path: string): boolean => PROVIDER_ROUTES.some((route) => route.path === path);
const prepared = new WeakSet<Provider>();

// Once per provider, however many apps forward to it. No response carries an Access-Control-*
// header (no browser clients), and the RFC 8414 document lists what the forwarding app routes.
function prepare(provider: Provider): void {
	if (prepared.has(provider)) return;
	prepared.add(provider);
	provider.use(async (ctx: KoaContext, next) => {
		await next();
		for (const name of Object.keys(ctx.response.headers)) {
			if (name.startsWith("access-control-")) ctx.remove(name);
		}
		if (ctx.path === METADATA_PATH && ctx.status === 200) {
			const routed = (ctx.req as Forwarded)[ROUTED] ?? baseRouted;
			ctx.body = projectMetadata(ctx.body as Record<string, unknown>, routed);
		}
	});
}

const BASE_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	"referrer-policy": "no-referrer",
	"x-content-type-options": "nosniff",
};

// Every value of a header that may stand in for the request's authority must name the issuer's.
const names = (value: string | string[] | undefined, expected: string): boolean =>
	value === undefined ||
	String(value)
		.split(",")
		.every((part) => part.trim() === expected);

// Text the client controls is held with each consent, so it is cut short.
const clip = (value: string | undefined): string | undefined => value?.slice(0, 256).toWellFormed();

// Hono runs a GET handler for HEAD. These GETs act (the consent push, finish, the provider's
// authorize and resume), so they refuse it.
const headRefused = (c: Context<Env>) => c.body(null, 405, { allow: "GET" });

// The consent page's only script: poll the CSRF-bound status, then go to finish once decided.
const POLL_SCRIPT =
	"(()=>{const csrf=document.currentScript.dataset.csrf,base=location.pathname;" +
	"const poll=async()=>{try{const response=await fetch(base+'/status'," +
	"{headers:{'x-draftyak-csrf':csrf},cache:'no-store'});const {state}=await response.json();" +
	"if(state==='pending'){setTimeout(poll,2000);return}location.replace(base+'/finish')}" +
	"catch{setTimeout(poll,5000)}};poll()})()";
const PAGE_CSP = [
	"default-src 'none'",
	`script-src 'sha256-${createHash("sha256").update(POLL_SCRIPT).digest("base64")}'`,
	"connect-src 'self'",
	"base-uri 'none'",
	"form-action 'none'",
	"frame-ancestors 'none'",
].join("; ");
const PLAIN_CSP = "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function page(c: Context<Env>, status: 200 | 400 | 409 | 410, body: string, csp = PLAIN_CSP) {
	c.header("content-security-policy", csp);
	c.header("x-frame-options", "DENY");
	return c.html(
		`<!doctype html><html lang="en"><meta charset="utf-8"><title>DraftYak sign-in</title>${body}</html>`,
		status,
	);
}

// The public page: the self-declared client name, the redirect host, the scopes and the code.
// No account is ever shown; the owner picks accounts on the paired desktop.
function consentPage(c: Context<Env>, request: ConsentRequest, entry: ConsentEntry) {
	const scopes = request.scopes.map((scope) => `<li>${escapeHtml(scope)}</li>`).join("");
	const ask =
		entry.state === "refused"
			? "<p>Too many sign-in requests. Try again later.</p>"
			: `<p>Type this code on your paired desktop: <strong id="code">${entry.code}</strong></p>`;
	return page(
		c,
		200,
		`<h1>Approve on your paired desktop</h1><p><strong id="client">${escapeHtml(request.clientName)}</strong> (self-declared) asks for access, answered to <strong id="host">${escapeHtml(request.redirectHost)}</strong>.</p><ul id="scopes">${scopes}</ul>${ask}<script data-csrf="${entry.csrf}">${POLL_SCRIPT}</script>`,
		PAGE_CSP,
	);
}

export interface AppOptions {
	readonly provider: Provider;
	readonly consent?: ConsentStub;
	// More forwarded provider routes, such as a registration route while the DCR window is open.
	readonly routes?: readonly ProviderRoute[];
	// The requester address shown on the desktop; behind a proxy, the trusted proxy's header.
	readonly clientIp?: (incoming: IncomingMessage) => string | undefined;
}

export function createApp(options: AppOptions): Hono<Env> {
	const { provider } = options;
	const consent = options.consent ?? new ConsentStub();
	const clientIp = options.clientIp ?? ((incoming) => incoming.socket.remoteAddress);
	const issuer = new URL(provider.issuer);
	const resource = resourceFor(provider.issuer);
	const table = [...PROVIDER_ROUTES, ...(options.routes ?? [])];
	const routed = (path: string): boolean =>
		table.some((route) => route.path === path && route.open?.() !== false);
	prepare(provider);
	const forward = provider.callback();

	// The interaction cookie binds every interaction route to the browser that started it.
	const interactionFor = async (c: Context<Env>): Promise<Interaction | undefined> => {
		try {
			const interaction = await provider.interactionDetails(c.env.incoming, c.env.outgoing);
			return interaction.uid === c.req.param("uid") ? interaction : undefined;
		} catch (error) {
			if ((error as Error).name === "SessionNotFound") return undefined;
			throw error;
		}
	};

	const grantFor = async (
		interaction: Interaction,
		granted: readonly string[],
	): Promise<string> => {
		const grant = new provider.Grant({
			accountId: OWNER,
			clientId: interaction.params.client_id ?? "",
		});
		const requested = (interaction.params.scope ?? "").split(" ").filter(Boolean);
		const rejected = requested.filter((s) => SCOPES.includes(s) && !granted.includes(s));
		if (granted.length) grant.addResourceScope(resource, granted.join(" "));
		if (rejected.length) grant.rejectResourceScope(resource, rejected.join(" "));
		// An OAuth-only AS: no ID token, so openid is never granted.
		if (requested.includes("openid")) grant.rejectOIDCScope("openid");
		return grant.save();
	};

	const resultFor = async (
		interaction: Interaction,
		entry: ConsentEntry,
	): Promise<InteractionResults> => {
		if (entry.state === "approved") {
			const grantId = await grantFor(interaction, entry.granted);
			return { login: { accountId: OWNER, remember: false }, consent: { grantId } };
		}
		return entry.state === "refused"
			? { error: "temporarily_unavailable", error_description: "consent is paused or rate limited" }
			: { error: "access_denied", error_description: "the owner did not approve the request" };
	};

	const app = new Hono<Env>();
	// §6 L3: oidc-provider builds its URLs, and the client-assertion audiences it accepts, from Koa's
	// ctx.href: an absolute-form target as sent, else the Host, or X-Forwarded-Host and -Proto once
	// provider.proxy is on. Only origin-form requests whose headers all name the issuer get through;
	// with provider.proxy on, a proxy may rewrite Host as long as X-Forwarded-Host names the issuer.
	const scheme = issuer.protocol.slice(0, -1);
	app.use("*", async (c, next) => {
		const { headers, url = "" } = c.env.incoming;
		const forwardedHost = headers["x-forwarded-host"];
		const host = provider.proxy && forwardedHost !== undefined ? forwardedHost : headers.host;
		if (
			!url.startsWith("/") ||
			host === undefined ||
			!names(host, issuer.host) ||
			!names(forwardedHost, issuer.host) ||
			!names(headers["x-forwarded-proto"], scheme)
		) {
			return c.json({ error: "invalid_request", error_description: "unknown host" }, 421);
		}
		for (const [name, value] of Object.entries(BASE_HEADERS)) c.header(name, value);
		await next();
	});

	app.get(PRM_PATH, (c) =>
		c.json({
			resource,
			authorization_servers: [provider.issuer],
			scopes_supported: [...SCOPES],
			bearer_methods_supported: ["header"],
		}),
	);

	// Stand-in for the MCP endpoint's auth step: 401 with resource_metadata, or the token's grant.
	app.all(MCP_PATH, async (c) => {
		const presented = /^Bearer ([\w.~+/-]+=*)$/i.exec(c.req.header("authorization") ?? "")?.[1];
		const token = presented ? await verifyAccessToken(provider, presented) : undefined;
		if (!token) {
			const challenge = `Bearer resource_metadata="${issuer.origin}${PRM_PATH}"`;
			const error = presented ? `, error="invalid_token"` : "";
			c.header("www-authenticate", `${challenge}${error}`);
			return c.json({ error: presented ? "invalid_token" : "unauthorized" }, 401);
		}
		return c.json({ client_id: token.clientId, scope: token.scope });
	});

	// Hono answers /oauth/interaction/* itself, ahead of every forwarded provider route.
	app.get(`${INTERACTION_PATH}/:uid`, async (c) => {
		if (c.req.method === "HEAD") return headRefused(c);
		const interaction = await interactionFor(c);
		if (!interaction)
			return page(c, 400, "<p>Open this page in the browser that started the sign-in.</p>");
		const params = interaction.params;
		const client = await provider.Client.find(params.client_id ?? "");
		const request: ConsentRequest = {
			uid: interaction.uid,
			clientId: params.client_id ?? "",
			clientName: clip(client?.clientName ?? params.client_id) ?? "",
			redirectHost: URL.parse(params.redirect_uri ?? "")?.host ?? "",
			scopes: SCOPES.filter((scope) => (params.scope ?? "").split(" ").includes(scope)),
			ip: clientIp(c.env.incoming),
			userAgent: clip(c.req.header("user-agent")),
		};
		return consentPage(c, request, consent.open(request, interaction.exp * 1000 - Date.now()));
	});

	app.get(`${INTERACTION_PATH}/:uid/status`, async (c) => {
		const uid = c.req.param("uid");
		if (!(await interactionFor(c)) || !consent.csrfMatches(uid, c.req.header("x-draftyak-csrf"))) {
			return c.json({ error: "forbidden" }, 403);
		}
		return c.json({ state: consent.state(uid) ?? "expired" });
	});

	app.get(`${INTERACTION_PATH}/:uid/finish`, async (c) => {
		if (c.req.method === "HEAD") return headRefused(c);
		const interaction = await interactionFor(c);
		if (!interaction)
			return page(c, 400, "<p>Open this page in the browser that started the sign-in.</p>");
		if (consent.state(interaction.uid) === "pending") {
			return page(c, 409, "<p>Approve the request on your paired desktop first.</p>");
		}
		const entry = consent.take(interaction.uid);
		if (!entry) return page(c, 410, "<p>This sign-in request has finished or expired.</p>");
		const result = await resultFor(interaction, entry);
		const returnTo = await provider.interactionResult(c.env.incoming, c.env.outgoing, result, {
			mergeWithLastSubmission: false,
		});
		// returnTo is built from the request (ctx.href); the path keeps the browser's origin.
		return c.redirect(new URL(returnTo).pathname, 303);
	});

	for (const route of table) {
		app.on(route.method, route.path, async (c) => {
			if (route.open?.() === false) return c.notFound();
			if (c.req.method === "HEAD") return headRefused(c);
			for (const [name, value] of Object.entries(BASE_HEADERS)) {
				c.env.outgoing.setHeader(name, value);
			}
			(c.env.incoming as Forwarded)[ROUTED] = routed;
			await forward(c.env.incoming, c.env.outgoing);
			return RESPONSE_ALREADY_SENT;
		});
	}

	app.notFound((c) => c.json({ error: "not_found" }, 404));
	app.onError((error, c) => {
		console.error(error);
		return c.json({ error: "server_error" }, 500);
	});
	return app;
}

export interface Running {
	readonly origin: string;
	close(): Promise<void>;
}

// Serves on 127.0.0.1; `build` gets the bound origin, which local runs use as the issuer.
export async function listen(build: (origin: string) => Hono<Env>, port = 0): Promise<Running> {
	let app: Hono<Env> | undefined;
	const server = createAdaptorServer({
		fetch: (request, env) =>
			app ? app.fetch(request, env as HttpBindings) : new Response(null, { status: 503 }),
		overrideGlobalObjects: false,
	}) as Server;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject).listen(port, "127.0.0.1", () => resolve());
	});
	const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	app = build(origin);
	return {
		origin,
		close: () =>
			new Promise<void>((done) => {
				server.close(() => done());
				server.closeAllConnections();
			}),
	};
}
