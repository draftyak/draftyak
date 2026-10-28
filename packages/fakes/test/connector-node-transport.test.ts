import { createHash } from "node:crypto";
import dns from "node:dns";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createAdaptorServer, type HttpBindings } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, expect, it, vi } from "vitest";
import {
	ConnectorClient,
	ConnectorClientError,
	createNodeConnectorTransport,
} from "../src/connector-client.ts";
import { RESERVED_PORTS } from "../src/server.ts";

const ISSUER = "https://as.draftyak.example";
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT = "https://connector.draftyak.example/client.json";
const REDIRECT = "https://connector.draftyak.example/callback";
const servers: Server[] = [];

async function close(server: Server): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
		server.closeAllConnections();
	});
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(servers.splice(0).map(close));
});

async function fixture() {
	const seen = {
		paths: [] as string[],
		forms: [] as URLSearchParams[],
		initializations: [] as unknown[],
		authorization: undefined as URLSearchParams | undefined,
		closedStreams: 0,
		heldRequests: 0,
		closedHeld: 0,
	};
	const app = new Hono<{ Bindings: HttpBindings }>();
	app.use("*", async (c, next) => {
		// These bindings are required: a Fetch-only invocation cannot serve this fixture.
		expect(c.env.incoming.socket.localAddress).toBe("127.0.0.1");
		expect(c.env.outgoing.req).toBe(c.env.incoming);
		c.env.outgoing.setHeader("x-dytest-node-bindings", "present");
		seen.paths.push(c.req.path);
		await next();
	});
	app.get("/.well-known/oauth-protected-resource", (c) =>
		c.json({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["read"] }),
	);
	app.get("/.well-known/oauth-authorization-server", (c) =>
		c.json({
			issuer: ISSUER,
			authorization_endpoint: `${ISSUER}/authorize`,
			token_endpoint: `${ISSUER}/token`,
			revocation_endpoint: `${ISSUER}/revoke`,
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			authorization_response_iss_parameter_supported: true,
			client_id_metadata_document_supported: true,
		}),
	);
	app.get("/authorize", (c) => {
		const fields = new URL(c.req.url).searchParams;
		expect(fields.get("client_id")).toBe(CLIENT);
		expect(fields.get("redirect_uri")).toBe(REDIRECT);
		expect(fields.get("resource")).toBe(RESOURCE);
		expect(fields.get("scope")).toBe("read");
		expect(fields.get("code_challenge_method")).toBe("S256");
		seen.authorization = fields;
		return c.redirect(
			REDIRECT +
				"?" +
				new URLSearchParams({
					iss: ISSUER,
					state: fields.get("state") ?? "",
					code: "DYTEST-native-code",
				}),
			302,
		);
	});
	app.post("/token", async (c) => {
		const form = new URLSearchParams(await c.req.text());
		seen.forms.push(form);
		expect(form.get("client_id")).toBe(CLIENT);
		expect(form.get("resource")).toBe(RESOURCE);
		expect(form.has("client_secret")).toBe(false);
		expect(c.env.incoming.headers.authorization).toBeUndefined();
		if (form.get("grant_type") === "authorization_code") {
			expect(form.get("code")).toBe("DYTEST-native-code");
			expect(form.get("redirect_uri")).toBe(REDIRECT);
			expect(
				createHash("sha256")
					.update(form.get("code_verifier") ?? "")
					.digest("base64url"),
			).toBe(seen.authorization?.get("code_challenge"));
			return c.json({
				access_token: "DYTEST-native-access",
				refresh_token: "DYTEST-native-refresh",
				token_type: "Bearer",
			});
		}
		expect(form.get("grant_type")).toBe("refresh_token");
		expect(form.get("refresh_token")).toBe("DYTEST-native-refresh");
		return c.json({
			access_token: "DYTEST-native-access-next",
			refresh_token: "DYTEST-native-refresh-next",
			token_type: "Bearer",
		});
	});
	app.post("/revoke", (c) => c.json({}));
	const stream = (outgoing: HttpBindings["outgoing"]): Response => {
		outgoing.once("close", () => seen.closedStreams++);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode('data: {"fixture":"DYTEST-stream"}\n\n'));
				},
			}),
			{ headers: { "content-type": "text/event-stream" } },
		);
	};
	app.post("/mcp", async (c) => {
		expect(c.req.header("content-type")).toBe("application/json");
		expect(c.req.header("accept")).toBe("application/json, text/event-stream");
		seen.initializations.push(await c.req.json());
		if (c.req.header("authorization") === undefined)
			return c.json({}, 401, {
				"www-authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
			});
		expect(c.req.header("authorization")).toBe("Bearer DYTEST-native-access-next");
		return stream(c.env.outgoing);
	});
	app.all("/inspect", async (c) =>
		c.json({ headers: c.env.incoming.headers, body: await c.req.text() }),
	);
	app.get("/stream", (c) => stream(c.env.outgoing));
	app.get("/redirect", (c) => c.redirect("https://outside.draftyak.example/unused", 302));
	app.get("/held", (c) => {
		seen.heldRequests++;
		c.env.outgoing.once("close", () => seen.closedHeld++);
		return new Promise<Response>(() => {});
	});
	for (let attempt = 0; attempt < 10; attempt++) {
		const server = createAdaptorServer({
			overrideGlobalObjects: false,
			fetch: (request, env) => app.fetch(request, env as HttpBindings),
		}) as Server;
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const { port } = server.address() as AddressInfo;
		if (RESERVED_PORTS.has(port)) {
			await close(server);
			continue;
		}
		servers.push(server);
		const origin = `http://127.0.0.1:${port}`;
		return { seen, origin, transport: createNodeConnectorTransport({ issuer: ISSUER, origin }) };
	}
	throw new Error("No available nonreserved loopback port");
}

function forbidExternalTransport() {
	const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST-no-fetch"));
	const lookup = vi.spyOn(dns, "lookup").mockImplementation(() => {
		throw new Error("DYTEST-no-DNS");
	});
	return { fetch, lookup };
}

it("runs discovery, code exchange, refresh and an SSE resource against Node-bound Hono", async () => {
	const { transport, seen } = await fixture();
	const external = forbidExternalTransport();
	const client = new ConnectorClient({
		profile: "cimd-public",
		issuer: ISSUER,
		resource: RESOURCE,
		clientId: CLIENT,
		redirectUri: REDIRECT,
		transport,
	});
	const authorization = await client.beginAuthorization();
	const redirect = await transport.fetch(authorization, { redirect: "manual" });
	expect(redirect.status).toBe(302);
	expect(redirect.headers.get("x-dytest-node-bindings")).toBe("present");
	await redirect.body?.cancel();
	const exchanged = await client.acceptCallback(redirect.headers.get("location") ?? "");
	expect(exchanged).toMatchObject({
		kind: "exchange",
		reply: { status: 200, body: { access_token: "DYTEST-native-access" } },
	});
	expect(await client.refresh("DYTEST-native-refresh")).toMatchObject({
		status: 200,
		body: { access_token: "DYTEST-native-access-next" },
	});
	expect(await client.callResource("DYTEST-native-access-next")).toBe(200);
	await expect.poll(() => seen.closedStreams).toBe(1);
	expect(seen.initializations).toHaveLength(2);
	for (const body of seen.initializations)
		expect(body).toMatchObject({
			jsonrpc: "2.0",
			id: expect.any(Number),
			method: "initialize",
			params: {
				protocolVersion: expect.any(String),
				capabilities: {},
				clientInfo: { name: expect.any(String), version: expect.any(String) },
			},
		});
	expect(seen.forms).toHaveLength(2);
	expect(external.fetch).not.toHaveBeenCalled();
	expect(external.lookup).not.toHaveBeenCalled();
});

it("pins native authority, forwards only request headers and snapshots bridge configuration", async () => {
	const { seen, origin } = await fixture();
	const external = forbidExternalTransport();
	const options = { issuer: ISSUER, origin };
	const transport = createNodeConnectorTransport(options);
	options.issuer = "https://changed.draftyak.example";
	options.origin = "http://127.0.0.1:1";
	const response = await transport.fetch(`${ISSUER}/inspect`, {
		method: "POST",
		redirect: "manual",
		headers: {
			host: "changed.draftyak.example",
			"x-forwarded-host": "changed.draftyak.example",
			"x-forwarded-proto": "http",
			accept: "application/json",
			authorization: "Bearer DYTEST-direct",
			"content-type": "text/plain",
			cookie: "DYTEST-discarded",
			"x-dytest-discarded": "DYTEST-discarded",
		},
		body: "DYTEST-body",
	});
	expect(response.headers.get("x-dytest-node-bindings")).toBe("present");
	const body = await response.json();
	expect(body).toMatchObject({
		body: "DYTEST-body",
		headers: {
			host: "as.draftyak.example",
			"x-forwarded-host": "as.draftyak.example",
			"x-forwarded-proto": "https",
			"content-length": String(Buffer.byteLength("DYTEST-body")),
			accept: "application/json",
			authorization: "Bearer DYTEST-direct",
			"content-type": "text/plain",
		},
	});
	expect(body.headers.cookie).toBeUndefined();
	expect(body.headers["x-dytest-discarded"]).toBeUndefined();
	expect((await transport.fetch("https://other.draftyak.example/inspect")).status).toBe(421);
	await expect(transport.fetch("http://as.draftyak.example/inspect")).rejects.toThrow(
		ConnectorClientError,
	);
	const redirected = await transport.fetch("/redirect", { redirect: "manual" });
	expect(redirected.status).toBe(302);
	expect(redirected.headers.get("location")).toBe("https://outside.draftyak.example/unused");
	await redirected.body?.cancel();
	expect(seen.paths).toEqual(["/inspect", "/redirect"]);
	expect(external.fetch).not.toHaveBeenCalled();
	expect(external.lookup).not.toHaveBeenCalled();
});

it("aborts an owned pending native request and refuses pre-aborted work before the server", async () => {
	const { transport, seen } = await fixture();
	const external = forbidExternalTransport();
	const controller = new AbortController();
	const pending = transport.fetch("/held", { signal: controller.signal });
	await expect.poll(() => seen.heldRequests).toBe(1);
	controller.abort();
	await expect(pending).rejects.toThrow();
	await expect.poll(() => seen.closedHeld).toBe(1);
	await expect(transport.fetch("/inspect", { signal: controller.signal })).rejects.toThrow();
	expect(seen.paths).toEqual(["/held"]);
	expect(external.fetch).not.toHaveBeenCalled();
	expect(external.lookup).not.toHaveBeenCalled();
});

it("cancels a native response stream and bounds requests before opening a socket", async () => {
	const { transport, seen } = await fixture();
	const external = forbidExternalTransport();
	const response = await transport.fetch("/stream");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("Expected the native response stream");
	expect((await reader.read()).value).toBeInstanceOf(Uint8Array);
	await reader.cancel();
	reader.releaseLock();
	await expect.poll(() => seen.closedStreams).toBe(1);
	const oversized = await transport.fetch("/inspect", {
		method: "POST",
		body: new Uint8Array(65_537),
	});
	expect(oversized.status).toBe(413);
	expect(await oversized.json()).toMatchObject({ error: "request_body_too_large" });
	expect(seen.paths).toEqual(["/stream"]);
	expect(external.fetch).not.toHaveBeenCalled();
	expect(external.lookup).not.toHaveBeenCalled();
});

it.each([
	"http://localhost:12345",
	"http://as.draftyak.example:12345",
	"http://127.0.0.2:12345",
	"http://0.0.0.0:12345",
	"http://[::]:12345",
	"http://2130706433:12345",
	"http://127.0.0.1:0",
	"http://127.0.0.1:65536",
	"http://127.0.0.1:01234",
	"http://127.0.0.1:12345/",
	"http://127.0.0.1:12345?",
	"http://127.0.0.1:12345#",
	"http://user@127.0.0.1:12345",
	"https://127.0.0.1:12345",
	...[...RESERVED_PORTS].map((port) => `http://127.0.0.1:${port}`),
])("refuses the nonliteral, noncanonical or reserved origin %s", (origin) => {
	const external = forbidExternalTransport();
	expect(() => createNodeConnectorTransport({ issuer: ISSUER, origin })).toThrow();
	expect(external.fetch).not.toHaveBeenCalled();
	expect(external.lookup).not.toHaveBeenCalled();
});

it("refuses option accessors and proxies without executing their hooks", () => {
	const external = forbidExternalTransport();
	const options = { issuer: ISSUER, origin: "http://127.0.0.1:12345" };
	const trap = vi.fn(() => {
		throw new Error("DYTEST-option-hook");
	});
	const handler: ProxyHandler<typeof options> = {
		get: trap,
		getOwnPropertyDescriptor: trap,
		getPrototypeOf: trap,
		ownKeys: trap,
	};
	const revoked = Proxy.revocable(options, handler);
	revoked.revoke();
	for (const value of [
		Object.defineProperty({ ...options }, "issuer", { get: trap }),
		Object.defineProperty({ ...options }, "origin", { get: trap }),
		new Proxy(options, handler),
		revoked.proxy,
	])
		expect(() => createNodeConnectorTransport(value)).toThrow(ConnectorClientError);
	expect(trap).not.toHaveBeenCalled();
	expect(external.fetch).not.toHaveBeenCalled();
	expect(external.lookup).not.toHaveBeenCalled();
});
