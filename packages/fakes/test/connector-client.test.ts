import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
	ConnectorClient,
	ConnectorClientError,
	type ConnectorClientOptions,
	MAX_CONNECTOR_RESPONSE_BYTES,
} from "../src/connector-client.ts";
import { createFake } from "../src/server.ts";

const ISSUER = "https://as.draftyak.example";
const RESOURCE = ISSUER + "/mcp";
const CLIENT = "https://connector.draftyak.example/client.json";
const REDIRECT = "https://connector.draftyak.example/callback";
const METADATA = {
	issuer: ISSUER,
	authorization_endpoint: ISSUER + "/authorize",
	token_endpoint: ISSUER + "/token",
	revocation_endpoint: ISSUER + "/revoke",
	code_challenge_methods_supported: ["S256"],
	token_endpoint_auth_methods_supported: ["none"],
	authorization_response_iss_parameter_supported: true,
	client_id_metadata_document_supported: true,
};
function fixture(profile: ConnectorClientOptions["profile"] = "cimd-public") {
	const responses = new Map<string, () => Response>();
	responses.set("/mcp", () =>
		Response.json(
			{},
			{
				status: 401,
				headers: {
					"www-authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
				},
			},
		),
	);
	responses.set("/.well-known/oauth-protected-resource", () =>
		Response.json({ resource: RESOURCE, authorization_servers: [ISSUER] }),
	);
	responses.set("/.well-known/oauth-authorization-server", () => Response.json(METADATA));
	responses.set("/token", () =>
		Response.json({
			access_token: "DYTEST-access",
			refresh_token: "DYTEST-refresh",
			token_type: "Bearer",
		}),
	);
	responses.set("/revoke", () => Response.json({}));
	const transport = createFake(
		{
			fetch(request) {
				return (
					responses.get(new URL(request.url).pathname) ??
					(() => new Response(null, { status: 404 }))
				)();
			},
		},
		{ host: "as.draftyak.example" },
	);
	const options: ConnectorClientOptions = {
		profile,
		issuer: ISSUER,
		resource: RESOURCE,
		clientId: CLIENT,
		redirectUri: REDIRECT,
		transport,
	};
	return { responses, transport, options, client: new ConnectorClient(options) };
}
const callback = (authorization: string, changes: Record<string, string> = {}) => {
	const state = new URL(authorization).searchParams.get("state") ?? "";
	return (
		REDIRECT + "?" + new URLSearchParams({ iss: ISSUER, state, code: "DYTEST-code", ...changes })
	);
};
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

it.each(["cimd-public", "issuer-resource"] as const)(
	"%s uses actual Fake.fetch, fixed discovery and explicit none-auth forms",
	async (profile) => {
		const outbound = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new Error("DYTEST-no-network"));
		const { client, transport } = fixture(profile);
		const authorization = await client.beginAuthorization();
		const request = new URL(authorization);
		expect(request.origin + request.pathname).toBe(ISSUER + "/authorize");
		expect(request.searchParams.get("resource")).toBe(RESOURCE);
		expect(request.searchParams.get("client_id")).toBe(CLIENT);
		expect(request.searchParams.get("redirect_uri")).toBe(REDIRECT);
		expect(request.searchParams.get("code_challenge_method")).toBe("S256");
		const result = await client.acceptCallback(callback(authorization));
		expect(result.kind).toBe("exchange");
		if (result.kind !== "exchange") throw new Error("Expected the token endpoint response");
		expect(result.reply.status).toBe(200);
		expect(result.reply.body.access_token).toBe("DYTEST-access");
		await client.refresh("DYTEST-refresh");
		await client.revoke("DYTEST-refresh");
		const records = transport.recorder.takeRequests();
		expect(records.map((record) => record.path)).toEqual([
			"/mcp",
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-authorization-server",
			"/token",
			"/token",
			"/revoke",
		]);
		for (const record of records.slice(3)) {
			expect(record.method).toBe("POST");
			expect(record.headerNames).toContain("content-type");
			expect(record.headerNames).not.toContain("authorization");
			const form = new URLSearchParams(new TextDecoder().decode(record.body));
			expect(form.get("client_id")).toBe(CLIENT);
			expect(form.has("client_secret")).toBe(false);
			expect(form.has("client_assertion")).toBe(false);
			if (record.path === "/token") expect(form.get("resource")).toBe(RESOURCE);
		}
		const form = new URLSearchParams(new TextDecoder().decode(records[3]?.body));
		expect(
			createHash("sha256")
				.update(form.get("code_verifier") ?? "")
				.digest("base64url"),
		).toBe(request.searchParams.get("code_challenge"));
		expect(outbound).not.toHaveBeenCalled();
	},
);

const configuredDelimiters = (["resource", "clientId", "redirectUri"] as const).flatMap((field) =>
	["?", "#"].map((delimiter) => ({ field, delimiter })),
);
it.each(configuredDelimiters)(
	"refuses configured $field with a bare $delimiter before using the transport",
	({ field, delimiter }) => {
		const { options, transport } = fixture();
		expect(() => new ConnectorClient({ ...options, [field]: options[field] + delimiter })).toThrow(
			/^Connector fixture refused$/,
		);
		expect(transport.recorder.takeRequests()).toHaveLength(0);
	},
);

const advertisedDelimiters = (
	["resource_metadata", "authorization_endpoint", "token_endpoint", "revocation_endpoint"] as const
).flatMap((field) => ["?", "#"].map((delimiter) => ({ field, delimiter })));
it.each(advertisedDelimiters)(
	"refuses advertised $field with a bare $delimiter before using that destination",
	async ({ field, delimiter }) => {
		const { client, responses, transport } = fixture();
		if (field === "resource_metadata")
			responses.set("/mcp", () =>
				Response.json(
					{},
					{
						status: 401,
						headers: {
							"www-authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource${delimiter}"`,
						},
					},
				),
			);
		else
			responses.set("/.well-known/oauth-authorization-server", () =>
				Response.json({ ...METADATA, [field]: METADATA[field] + delimiter }),
			);
		await expect(client.discover()).rejects.toThrow(/^Connector fixture refused$/);
		expect(transport.recorder.takeRequests().map((record) => record.target)).toEqual(
			field === "resource_metadata"
				? ["/mcp"]
				: [
						"/mcp",
						"/.well-known/oauth-protected-resource",
						"/.well-known/oauth-authorization-server",
					],
		);
	},
);

const malformedCallbacks: ReadonlyArray<Record<string, string>> = [
	{ iss: "https://other.example" },
	{ state: "DYTEST-wrong-state" },
	{ code: "" },
	{ error: "access_denied" },
	{ unexpected: "DYTEST-unknown" },
];
it.each(malformedCallbacks)(
	"a malformed callback neither exchanges nor consumes pending state %j",
	async (changes) => {
		const { client, transport } = fixture();
		const authorization = await client.beginAuthorization();
		await expect(client.acceptCallback(callback(authorization, changes))).rejects.toThrow(
			/^Connector fixture refused$/,
		);
		expect(transport.recorder.takeRequests()).toHaveLength(3);
		expect((await client.acceptCallback(callback(authorization))).kind).toBe("exchange");
		expect(transport.recorder.takeRequests().map((record) => record.path)).toEqual(["/token"]);
		await expect(client.acceptCallback(callback(authorization))).rejects.toThrow(
			ConnectorClientError,
		);
		expect(transport.recorder.takeRequests()).toHaveLength(0);
	},
);

it("checks issuer and state on error responses without exchanging a code", async () => {
	const { client, transport } = fixture();
	const authorization = await client.beginAuthorization();
	const state = new URL(authorization).searchParams.get("state") ?? "";
	await expect(
		client.acceptCallback(REDIRECT + "?" + new URLSearchParams({ error: "access_denied", state })),
	).rejects.toThrow(ConnectorClientError);
	expect(
		await client.acceptCallback(
			REDIRECT + "?" + new URLSearchParams({ error: "access_denied", state, iss: ISSUER }),
		),
	).toEqual({ kind: "error", error: "access_denied" });
	expect(transport.recorder.takeRequests()).toHaveLength(3);
});

it.each(["duplicate", "fragment", "path-alias"])("refuses a %s callback spelling", async (mode) => {
	const { client } = fixture();
	const valid = callback(await client.beginAuthorization());
	const invalid =
		mode === "duplicate"
			? valid + "&iss=" + encodeURIComponent(ISSUER)
			: mode === "fragment"
				? valid + "#x"
				: valid.replace("/callback?", "/unused/../callback?");
	await expect(client.acceptCallback(invalid)).rejects.toThrow(ConnectorClientError);
	expect((await client.acceptCallback(valid)).kind).toBe("exchange");
});

it.each(["code", "error"])(
	"a bare fragment on a %s callback neither exchanges nor consumes pending state",
	async (kind) => {
		const { client, transport } = fixture();
		const authorization = await client.beginAuthorization();
		const state = new URL(authorization).searchParams.get("state") ?? "";
		const valid =
			kind === "code"
				? callback(authorization)
				: REDIRECT + "?" + new URLSearchParams({ iss: ISSUER, state, error: "access_denied" });
		expect(transport.recorder.takeRequests()).toHaveLength(3);
		await expect(client.acceptCallback(valid + "#")).rejects.toThrow(/^Connector fixture refused$/);
		expect(transport.recorder.takeRequests()).toHaveLength(0);
		expect((await client.acceptCallback(valid)).kind).toBe(kind === "code" ? "exchange" : "error");
		expect(transport.recorder.takeRequests().map((record) => record.path)).toEqual(
			kind === "code" ? ["/token"] : [],
		);
		await expect(client.acceptCallback(valid)).rejects.toThrow(ConnectorClientError);
		expect(transport.recorder.takeRequests()).toHaveLength(0);
	},
);

it.each(["code", "error"])(
	"accepts encoded query and fragment characters in %s values",
	async (kind) => {
		const { client, transport } = fixture();
		const authorization = await client.beginAuthorization();
		const state = new URL(authorization).searchParams.get("state") ?? "";
		const fields: Record<string, string> =
			kind === "code"
				? { code: "DYTEST-code?#" }
				: {
						error: "access_denied",
						error_description: "DYTEST-description?#",
						error_uri: "https://connector.draftyak.example/error?fixture=DYTEST#details",
					};
		const valid = REDIRECT + "?" + new URLSearchParams({ iss: ISSUER, state, ...fields });
		expect(valid).toContain("%3F%23");
		transport.recorder.takeRequests();
		expect((await client.acceptCallback(valid)).kind).toBe(kind === "code" ? "exchange" : "error");
		const records = transport.recorder.takeRequests();
		expect(records.map((record) => record.path)).toEqual(kind === "code" ? ["/token"] : []);
		if (kind === "code")
			expect(new URLSearchParams(new TextDecoder().decode(records[0]?.body)).get("code")).toBe(
				"DYTEST-code?#",
			);
	},
);

it.each(["issuer", "resource", "endpoint", "capability", "duplicate-json", "redirect"])(
	"refuses %s discovery without further authority",
	async (mode) => {
		const { client, responses, transport } = fixture();
		if (mode === "resource")
			responses.set("/.well-known/oauth-protected-resource", () =>
				Response.json({ resource: "https://other.example/mcp", authorization_servers: [ISSUER] }),
			);
		else if (mode === "redirect")
			responses.set(
				"/.well-known/oauth-authorization-server",
				() =>
					new Response(null, { status: 302, headers: { location: "https://other.example/token" } }),
			);
		else
			responses.set(
				"/.well-known/oauth-authorization-server",
				() =>
					new Response(
						mode === "duplicate-json"
							? JSON.stringify(METADATA).replace(
									'"issuer":',
									'"issuer":"https://other.example","issuer":',
								)
							: JSON.stringify({
									...METADATA,
									...(mode === "issuer"
										? { issuer: "https://other.example" }
										: mode === "endpoint"
											? { token_endpoint: "https://other.example/token" }
											: { token_endpoint_auth_methods_supported: ["client_secret_basic"] }),
								}),
						{ headers: { "content-type": "application/json" } },
					),
			);
		await expect(client.discover()).rejects.toThrow(/^Connector fixture refused$/);
		expect(
			transport.recorder
				.takeRequests()
				.every((record) => record.host === "as.draftyak.example" && record.path !== "/token"),
		).toBe(true);
	},
);

it.each([
	{ profile: "issuer-resource", support: "false" },
	{ profile: "issuer-resource", support: "missing" },
	{ profile: "registered-public", support: "false" },
	{ profile: "registered-public", support: "missing" },
] as const)("$profile discovers without CIMD support ($support)", async ({ profile, support }) => {
	const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST-no-network"));
	const { client, responses, transport } = fixture(profile);
	const metadata: Record<string, unknown> = { ...METADATA };
	if (support === "missing") delete metadata.client_id_metadata_document_supported;
	else metadata.client_id_metadata_document_supported = false;
	responses.set("/.well-known/oauth-authorization-server", () => Response.json(metadata));
	await expect(client.discover()).resolves.toEqual({
		issuer: ISSUER,
		resource: RESOURCE,
		authorizationEndpoint: ISSUER + "/authorize",
		tokenEndpoint: ISSUER + "/token",
		revocationEndpoint: ISSUER + "/revoke",
	});
	expect(
		transport.recorder.takeRequests().map(({ method, host, path }) => ({ method, host, path })),
	).toEqual([
		{ method: "POST", host: "as.draftyak.example", path: "/mcp" },
		{ method: "GET", host: "as.draftyak.example", path: "/.well-known/oauth-protected-resource" },
		{ method: "GET", host: "as.draftyak.example", path: "/.well-known/oauth-authorization-server" },
	]);
	expect(outbound).not.toHaveBeenCalled();
});

it.each([
	{ field: "code_challenge_methods_supported", value: ["plain"] },
	{ field: "authorization_response_iss_parameter_supported", value: false },
	{ field: "authorization_response_iss_parameter_supported", value: undefined },
	{ field: "client_id_metadata_document_supported", value: false },
	{ field: "client_id_metadata_document_supported", value: undefined },
])("refuses missing discovery support $field=$value", async ({ field, value }) => {
	const { client, responses, transport } = fixture();
	const metadata: Record<string, unknown> = { ...METADATA };
	if (value === undefined) delete metadata[field];
	else metadata[field] = value;
	responses.set("/.well-known/oauth-authorization-server", () => Response.json(metadata));
	await expect(client.discover()).rejects.toThrow(/^Connector fixture refused$/);
	expect(transport.recorder.takeRequests().map((record) => record.path)).toEqual([
		"/mcp",
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-authorization-server",
	]);
});

it("refuses a configured non-example issuer before any request", () => {
	const { options } = fixture();
	const transport = createFake({ fetch: () => Response.json({}) }, { host: "as.draftyak.invalid" });
	expect(
		() =>
			new ConnectorClient({
				...options,
				issuer: "https://as.draftyak.invalid",
				resource: "https://as.draftyak.invalid/mcp",
				transport,
			}),
	).toThrow(/^Connector fixture refused$/);
	expect(transport.recorder.takeRequests()).toHaveLength(0);
});

it("refuses a 307 token response without following its otherwise valid destination", async () => {
	const { client, responses, transport } = fixture();
	await client.discover();
	transport.recorder.takeRequests();
	responses.set(
		"/token",
		() => new Response(null, { status: 307, headers: { location: ISSUER + "/revoke" } }),
	);
	await expect(client.refresh("DYTEST-refresh")).rejects.toThrow(/^Connector fixture refused$/);
	expect(transport.recorder.takeRequests().map((record) => record.path)).toEqual(["/token"]);
});

it.each([8192, 8193])("bounds an otherwise valid callback at %i characters", async (length) => {
	const { client, transport } = fixture();
	const authorization = await client.beginAuthorization();
	transport.recorder.takeRequests();
	const prefix = callback(authorization) + "&error_description=";
	const value = prefix + "x".repeat(length - prefix.length);
	expect(value).toHaveLength(length);
	if (length === 8192) {
		expect((await client.acceptCallback(value)).kind).toBe("exchange");
		expect(transport.recorder.takeRequests().map((record) => record.path)).toEqual(["/token"]);
	} else {
		await expect(client.acceptCallback(value)).rejects.toThrow(/^Connector fixture refused$/);
		expect(transport.recorder.takeRequests()).toHaveLength(0);
		expect((await client.acceptCallback(callback(authorization))).kind).toBe("exchange");
	}
});

it.each([4096, 4097])(
	"bounds an otherwise valid refresh token at %i characters",
	async (length) => {
		const { client, transport } = fixture();
		await client.discover();
		transport.recorder.takeRequests();
		const value = "x".repeat(length);
		if (length === 4096) {
			expect((await client.refresh(value)).status).toBe(200);
			const records = transport.recorder.takeRequests();
			expect(records.map((record) => record.path)).toEqual(["/token"]);
			expect(
				new URLSearchParams(new TextDecoder().decode(records[0]?.body)).get("refresh_token"),
			).toBe(value);
		} else {
			await expect(client.refresh(value)).rejects.toThrow(/^Connector fixture refused$/);
			expect(transport.recorder.takeRequests()).toHaveLength(0);
		}
	},
);

it("refuses an invalid error code without consuming an otherwise valid error callback", async () => {
	const { client, transport } = fixture();
	const state = new URL(await client.beginAuthorization()).searchParams.get("state") ?? "";
	transport.recorder.takeRequests();
	const errorCallback = (error: string) =>
		REDIRECT + "?" + new URLSearchParams({ iss: ISSUER, state, error });
	await expect(client.acceptCallback(errorCallback("access.denied"))).rejects.toThrow(
		/^Connector fixture refused$/,
	);
	expect(transport.recorder.takeRequests()).toHaveLength(0);
	expect(await client.acceptCallback(errorCallback("access_denied"))).toEqual({
		kind: "error",
		error: "access_denied",
	});
});

it("observes scripted reuse outcomes without inventing revocation or token validity", async () => {
	const { client, responses } = fixture();
	responses.set("/token", () => Response.json({ error: "invalid_grant" }, { status: 400 }));
	expect(
		await client.observeReuse(
			"DYTEST-retired",
			"DYTEST-current",
			"DYTEST-old-access",
			"DYTEST-new-access",
		),
	).toEqual({
		retiredRefreshRejected: true,
		currentRefreshRejected: true,
		previousAccessStatus: 401,
		currentAccessStatus: 401,
	});
	responses.set("/token", () => Response.json({ access_token: "DYTEST-not-revoked" }));
	responses.set("/mcp", () => Response.json({ fixture: true }));
	expect(
		await client.observeReuse(
			"DYTEST-retired",
			"DYTEST-current",
			"DYTEST-old-access",
			"DYTEST-new-access",
		),
	).toEqual({
		retiredRefreshRejected: false,
		currentRefreshRejected: false,
		previousAccessStatus: 200,
		currentAccessStatus: 200,
	});
});

it.each(["over-cap", "invalid-utf8", "bom", "depth"])(
	"refuses bounded malformed response %s with a fixed error",
	async (mode) => {
		const { client, responses } = fixture();
		await client.discover();
		const body =
			mode === "invalid-utf8"
				? new Uint8Array([...Buffer.from('{"fixture":"'), 0xff, ...Buffer.from('"}')])
				: mode === "bom"
					? "\uFEFF{}"
					: mode === "depth"
						? '{"x":' + "[".repeat(17) + "0" + "]".repeat(17) + "}"
						: JSON.stringify({ x: "x".repeat(65_537 - 8) });
		if (mode === "over-cap") expect(Buffer.byteLength(body)).toBe(65_537);
		responses.set(
			"/token",
			() => new Response(body, { headers: { "content-type": "application/json" } }),
		);
		await expect(client.refresh("DYTEST-refresh")).rejects.toThrow(/^Connector fixture refused$/);
	},
);

it.each([
	{ body: '{"fixture":"\\ud800"}', contentType: "application/json", reason: "lone surrogate" },
	{ body: '{"fixture":true}', contentType: "text/plain", reason: "non-JSON content type" },
])("refuses valid JSON with $reason", async ({ body, contentType }) => {
	const { client, responses } = fixture();
	await client.discover();
	expect(() => JSON.parse(body)).not.toThrow();
	responses.set("/token", () => new Response(body, { headers: { "content-type": contentType } }));
	await expect(client.refresh("DYTEST-refresh")).rejects.toThrow(/^Connector fixture refused$/);
});

it("accepts the exact byte cap, snapshots config and captures the explicit fetch method", async () => {
	const { client, responses, options, transport } = fixture();
	expect(MAX_CONNECTOR_RESPONSE_BYTES).toBe(65_536);
	const source = JSON.stringify({ x: "x".repeat(MAX_CONNECTOR_RESPONSE_BYTES - 8) });
	expect(Buffer.byteLength(source)).toBe(MAX_CONNECTOR_RESPONSE_BYTES);
	responses.set(
		"/token",
		() =>
			new Response(source, { headers: { "content-type": 'application/json; charset="utf-8"' } }),
	);
	(options as { issuer: string }).issuer = "https://other.example";
	transport.fetch = () => {
		throw new Error("DYTEST-mutated-method");
	};
	expect((await client.refresh("DYTEST-refresh")).status).toBe(200);
	expect(client.clientMetadata()).toMatchObject({
		client_id: CLIENT,
		token_endpoint_auth_method: "none",
		redirect_uris: [REDIRECT],
	});
});

it("refuses option accessors/proxies without invoking their traps", () => {
	const { options } = fixture();
	let hooks = 0;
	const trap = () => {
		hooks++;
		throw new Error("DYTEST-private-input");
	};
	for (const value of [
		Object.defineProperty({ ...options }, "issuer", { get: trap }),
		new Proxy(options, { get: trap, ownKeys: trap, getPrototypeOf: trap }),
	])
		expect(() => new ConnectorClient(value)).toThrow(/^Connector fixture refused$/);
	expect(hooks).toBe(0);
});

it("bounds one held operation, cancels its stream and refuses future work after timeout", async () => {
	vi.useFakeTimers();
	const { client, responses, transport } = fixture();
	let cancelled = 0;
	responses.set(
		"/token",
		() =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array([0x7b]));
					},
					cancel() {
						cancelled++;
					},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	);
	const pending = client.refresh("DYTEST-refresh").catch((error: Error) => error.message);
	await vi.advanceTimersByTimeAsync(0);
	await expect(client.beginAuthorization()).rejects.toThrow(/^Connector fixture refused$/);
	await vi.advanceTimersByTimeAsync(10_000);
	expect(await pending).toBe("Connector fixture refused");
	await vi.advanceTimersByTimeAsync(0);
	expect(cancelled).toBe(1);
	expect(transport.recorder.takeRequests()).toHaveLength(4);
	await expect(client.refresh("DYTEST-again")).rejects.toThrow(/^Connector fixture refused$/);
	expect(transport.recorder.takeRequests()).toHaveLength(0);
});

it.each([9999, 10000])(
	"checks the monotonic deadline at %i ms before the timeout callback runs",
	async (elapsed) => {
		vi.useFakeTimers();
		let now = 100;
		vi.spyOn(performance, "now").mockImplementation(() => now);
		const { client, responses, transport } = fixture();
		await client.discover();
		transport.recorder.takeRequests();
		const wallTime = Date.now();
		responses.set("/token", () => {
			now += elapsed;
			return Response.json({ access_token: "DYTEST-access" });
		});
		if (elapsed === 9999) expect((await client.refresh("DYTEST-refresh")).status).toBe(200);
		else {
			await expect(client.refresh("DYTEST-refresh")).rejects.toThrow(/^Connector fixture refused$/);
			await expect(client.refresh("DYTEST-again")).rejects.toThrow(/^Connector fixture refused$/);
		}
		expect(Date.now()).toBe(wallTime);
		expect(transport.recorder.takeRequests().map((record) => record.path)).toEqual(["/token"]);
	},
);

function streaming(chunk: Uint8Array): Response {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(chunk);
				controller.close();
			},
		}),
		{ headers: { "content-type": "application/json" } },
	);
}

it("counts native bytes despite a forged length before decoding invalid UTF-8", async () => {
	const { client, responses } = fixture();
	const chunk = new Uint8Array([0xff]);
	Object.defineProperty(chunk, "byteLength", { value: 0 });
	responses.set("/token", () => streaming(chunk));
	await expect(client.refresh("DYTEST-refresh")).rejects.toThrow(/^Connector fixture refused$/);
});

it.each(["buffer", "subarray"])(
	"snapshots an exact %s view without invoking view hooks",
	async (kind) => {
		const { client, responses } = fixture();
		const encoded = Buffer.from('xx{"fixture":true}yy');
		const chunk =
			kind === "buffer"
				? encoded.subarray(2, encoded.length - 2)
				: new Uint8Array(encoded.buffer, encoded.byteOffset + 2, encoded.length - 4);
		let hooks = 0;
		const trap = () => {
			hooks++;
			throw new Error("DYTEST-private-view");
		};
		Object.defineProperties(chunk, {
			byteLength: { get: trap },
			byteOffset: { get: trap },
			buffer: { get: trap },
			[Symbol.iterator]: { get: trap },
		});
		responses.set("/token", () => streaming(chunk));
		expect((await client.refresh("DYTEST-refresh")).body).toEqual({ fixture: true });
		expect(hooks).toBe(0);
	},
);

it.each(["proxy", "subclass", "shared"])(
	"refuses a %s stream chunk without executing hooks",
	async (kind) => {
		const { client, responses } = fixture();
		let hooks = 0;
		const trap = () => {
			hooks++;
			throw new Error("DYTEST-private-view");
		};
		class CustomBytes extends Uint8Array {}
		const chunk =
			kind === "proxy"
				? new Proxy(new Uint8Array([0x7b, 0x7d]), { get: trap, getPrototypeOf: trap })
				: kind === "shared"
					? new Uint8Array(new SharedArrayBuffer(2))
					: new CustomBytes([0x7b, 0x7d]);
		if (kind === "shared") chunk.set([0x7b, 0x7d]);
		responses.set("/token", () => streaming(chunk));
		await expect(client.refresh("DYTEST-refresh")).rejects.toThrow(/^Connector fixture refused$/);
		expect(hooks).toBe(0);
	},
);
