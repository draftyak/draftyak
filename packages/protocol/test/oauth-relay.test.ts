import { type Schema, Validator } from "@cfworker/json-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type * as z from "zod";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import {
	authorization,
	authorizeRequest,
	CLIENT_ID,
	clientRequest,
	FLOW_ID,
	flowView,
	type RelayCase,
	relayRequest,
	STATE,
	valueCases,
} from "../scripts/vectors/oauth-relay.ts";
import * as relay from "../src/oauth-relay.ts";
import { ENGINE_DEPENDENT, patterns } from "./vectors.ts";

const json = (value: unknown): Uint8Array => Buffer.from(JSON.stringify(value));
const cases: RelayCase[] = valueCases();

const ascii = (maxLength: number): fc.Arbitrary<string> =>
	fc.string({ unit: "binary-ascii", maxLength });
const around = (cap: number): fc.Arbitrary<string> =>
	fc.integer({ min: cap - 2, max: cap + 2 }).map((length) => "x".repeat(length));
const QUERY_UNITS = [..."azAZ09-._~!$&'()*+,;=:@/?%", "%2F", "%zz", "#", " ", '"', "\\"];
// Random strings near each field's form, so most land close to its edges.
const arbitraries: Readonly<Record<string, fc.Arbitrary<string>>> = {
	redirectUri: fc
		.tuple(
			fc.constantFrom("http://", "https://", "HTTP://", "http:/", ""),
			fc.constantFrom("", "", "", "user@", "@"),
			fc.constantFrom("127.0.0.1", "127.0.0.1", "127.0.0.2", "localhost", "[::1]"),
			fc.oneof(
				fc.integer({ min: 0, max: 70_000 }).map((port) => `:${port}`),
				fc.integer({ min: 0, max: 70_000 }).map((port) => `:0${port}`),
				fc.stringMatching(/^:[0-9]{0,6}$/),
				fc.constant(""),
			),
			fc.constantFrom("/oauth/google/callback", "/oauth/google/callback/", "/", ""),
			fc.oneof(
				fc.constant(""),
				fc.constant(""),
				ascii(4).map((text) => `?${text}`),
				ascii(4).map((text) => `#${text}`),
				ascii(2),
			),
		)
		.map((parts) => parts.join("")),
	state: fc.oneof(
		fc
			.uint8Array({ minLength: 30, maxLength: 34 })
			.map((bytes) => Buffer.from(bytes).toString("base64url")),
		fc
			.tuple(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.nat(42), ascii(2))
			.map(([bytes, at, text]) => {
				const state = Buffer.from(bytes).toString("base64url");
				return `${state.slice(0, at)}${text}${state.slice(at + 1)}`;
			}),
	),
	code: fc.oneof(ascii(16), around(256), fc.string({ maxLength: 4 })),
	clientId: fc.oneof(ascii(16), around(512), fc.string({ maxLength: 4 })),
	clientSecret: fc.oneof(ascii(16), around(4096), fc.string({ maxLength: 4 })),
	authorizationUrl: fc
		.tuple(
			fc.constantFrom(
				"https://accounts.google.com",
				"https://accounts.google.com",
				"http://accounts.google.com",
				"https://accounts.google.com:443",
				"https://user@accounts.google.com",
				"https://accounts.google.com.evil.example",
				"",
			),
			fc.constantFrom("/o/oauth2/v2/auth", "/o/oauth2/v2/auth", "/o/oauth2/v2/auth/", "", "/x"),
			fc.option(fc.string({ unit: fc.constantFrom(...QUERY_UNITS), maxLength: 12 }), {
				nil: undefined,
			}),
			fc.oneof(
				{ arbitrary: fc.constant(undefined), weight: 3 },
				{ arbitrary: ascii(3), weight: 1 },
			),
		)
		.map(
			([origin, path, query, fragment]) =>
				`${origin}${path}${query === undefined ? "" : `?${query}`}${fragment === undefined ? "" : `#${fragment}`}`,
		),
};
const fields: readonly (readonly [string, z.ZodString, (value: unknown) => boolean])[] = [
	["redirectUri", relay.LoopbackRedirectUri, relay.checkLoopbackRedirectUri],
	["state", relay.OAuthState, relay.checkOAuthState],
	["code", relay.AuthorizationCode, relay.checkAuthorizationCode],
	["clientId", relay.OAuthClientId, relay.checkOAuthClientId],
	["clientSecret", relay.OAuthClientSecret, relay.checkOAuthClientSecret],
	["authorizationUrl", relay.GoogleAuthorizationUrl, relay.checkGoogleAuthorizationUrl],
];

// Every string the shared cases hold in a field of that name.
function vectorStrings(name: string): string[] {
	const found = new Set<string>();
	for (const vector of cases) {
		const value = vector.value as Record<string, unknown> | null | undefined;
		const client = value?.client as Record<string, unknown> | null | undefined;
		for (const text of [value?.[name], client?.[name]])
			if (typeof text === "string") found.add(text);
	}
	return [...found];
}

describe("each field's exported JSON Schema", () => {
	for (const [name, schema, check] of fields) {
		const exported = jsonSchemaOf(schema);
		const validator = new Validator(exported as Schema, "2020-12", false);
		const agree = (text: string): void => {
			const expected = check(text);
			expect(schema.safeParse(text).success, `zod: ${JSON.stringify(text)}`).toBe(expected);
			expect(validator.validate(text).valid, `schema: ${JSON.stringify(text)}`).toBe(expected);
		};
		it(`${name}: agrees with its check on every vector string`, () => {
			const strings = vectorStrings(name);
			expect(strings.length).toBeGreaterThan(5);
			expect(strings.some((text) => check(text))).toBe(true);
			expect(strings.some((text) => !check(text))).toBe(true);
			for (const text of strings) agree(text);
			for (const pattern of patterns(exported)) expect(pattern).not.toMatch(ENGINE_DEPENDENT);
		});
		it(`${name}: agrees with its check on random strings`, () => {
			const arbitrary = arbitraries[name] as fc.Arbitrary<string>;
			fc.assert(fc.property(arbitrary, agree), { numRuns: 3000 });
		});
	}

	it("agrees with every request and response value the vectors hold", () => {
		const validators = new Map(
			Object.entries(relay.OAUTH_RELAY_SCHEMAS).map(([name, schema]) => [
				name,
				new Validator(jsonSchemaOf(schema) as Schema, "2020-12", false),
			]),
		);
		let compared = 0;
		for (const vector of cases) {
			if (!("value" in vector) || "padToBytes" in vector) continue;
			const route = relay.OAUTH_RELAY_ROUTES.find((entry) => entry.id === vector.route);
			const name = vector.action === "request" ? route?.request : route?.response;
			const cap = vector.action === "request" ? route?.requestBytes : route?.responseBytes;
			// A schema can't count bytes: a value over its cap stays the route check's to refuse.
			if (json(vector.value).length > (cap ?? 0)) continue;
			expect(validators.get(name ?? "")?.validate(vector.value).valid, vector.id).toBe(
				vector.valid,
			);
			compared++;
		}
		expect(compared).toBeGreaterThan(250);
	});
});

describe("refusals", () => {
	const SECRET = "DYTEST-secret-canary-7f3a";
	const CODE = "DYTEST-code-canary-91b2";
	function refusal(attempt: () => unknown): Error {
		try {
			attempt();
		} catch (error) {
			return error as Error;
		}
		throw new Error("accepted");
	}

	it("carry one fixed message and nothing that was submitted", () => {
		const attempts: (() => unknown)[] = [
			() =>
				relay.parseOAuthRelayRequestBytes(
					"client",
					json({ ...clientRequest(), client: { clientId: CLIENT_ID, clientSecret: `${SECRET} ` } }),
				),
			() => relay.parseOAuthRelayRequestBytes("client", json({ ...clientRequest(), [SECRET]: 1 })),
			() =>
				relay.parseOAuthRelayRequestBytes("client", Buffer.from(`{"${SECRET}":1,"${SECRET}":2}`)),
			() =>
				relay.parseOAuthRelayRequestBytes("relay", json({ ...relayRequest(), code: `${CODE} ` })),
			() =>
				relay.parseOAuthRelayRequestBytes(
					"relay",
					json({ ...relayRequest(), state: `${STATE}=`, code: CODE }),
				),
			() =>
				relay.parseOAuthRelayRequestBytes(
					"relay",
					Buffer.from(`${JSON.stringify({ ...relayRequest(), code: CODE })}${SECRET}`),
				),
			() =>
				relay.parseOAuthRelayResponseBytes(
					"authorize",
					json({
						...authorization(),
						authorizationUrl: `https://evil.example/?s=${STATE}${SECRET}`,
					}),
				),
			() => relay.parseOAuthRelayResponseBytes("relay", Buffer.from(`["${SECRET}","${CODE}"]`)),
			() => relay.parseOAuthRelayRequestBytes("start" as "client", json(clientRequest())),
		];
		for (const attempt of attempts) {
			const error = refusal(attempt);
			expect(error).toBeInstanceOf(relay.OAuthRelayRefused);
			expect(error.message).toBe("OAuth relay data refused");
			expect(error.cause).toBeUndefined();
			const own = Object.getOwnPropertyNames(error).map((key) => [
				key,
				(error as unknown as Record<string, unknown>)[key],
			]);
			const shown = [String(error), error.stack ?? "", JSON.stringify(own)].join("\n");
			for (const text of [SECRET, CODE, STATE]) expect(shown).not.toContain(text);
		}
	});

	it("answer false and never throw for hostile values", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const trap = (): never => {
			throw new Error(SECRET);
		};
		const proxy = new Proxy({}, { get: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
		const getter = Object.defineProperty({}, "phase", { enumerable: true, get: trap });
		for (const value of [cyclic, proxy, getter, Object.create(Array.prototype), new Date(0), 1n])
			for (const route of ["client", "authorize", "relay", "start"]) {
				expect(relay.checkOAuthRelayRequest(route, value)).toBe(false);
				expect(relay.checkOAuthRelayResponse(route, value)).toBe(false);
			}
	});

	it("check what a value's JSON holds, so valid members on a value that isn't plain data fail", () => {
		class Shown {
			toJSON(): unknown {
				return { flowId: "DYTEST-other" };
			}
		}
		const strict = [
			[relay.checkOAuthRelayRequest, "client", clientRequest()],
			[relay.checkOAuthRelayRequest, "authorize", authorizeRequest()],
			[relay.checkOAuthRelayRequest, "relay", relayRequest()],
			[relay.checkOAuthRelayResponse, "authorize", authorization()],
		] as const;
		for (const [check, route, plain] of strict) {
			expect(check(route, plain), route).toBe(true);
			const [first] = Object.keys(plain) as [string];
			const hidden = Object.defineProperty({ ...plain }, first, { enumerable: false });
			for (const value of [
				Object.assign(new Date(0), plain),
				Object.assign(new Shown(), plain),
				Object.create(plain),
				hidden,
			])
				expect(check(route, value), route).toBe(false);
		}
		const client = clientRequest();
		const nested = { ...client, client: Object.assign(new Date(0), client.client) };
		expect(relay.checkOAuthRelayRequest("client", nested)).toBe(false);
	});
});

describe("received bytes", () => {
	it("parse into the route's own values", () => {
		expect(relay.parseOAuthRelayRequestBytes("client", json(clientRequest()))).toEqual(
			clientRequest(),
		);
		expect(relay.parseOAuthRelayRequestBytes("authorize", json({ flowId: FLOW_ID }))).toEqual({
			flowId: FLOW_ID,
		});
		expect(relay.parseOAuthRelayRequestBytes("relay", json(relayRequest()))).toEqual(
			relayRequest(),
		);
		expect(relay.parseOAuthRelayResponseBytes("authorize", json(authorization()))).toEqual(
			authorization(),
		);
		expect(relay.parseOAuthRelayResponseBytes("relay", json(flowView()))).toEqual(flowView());
		const view = relay.parseOAuthRelayResponseBytes(
			"client",
			Buffer.from('{"__proto__":{"phase":"x"}}'),
		);
		expect(Object.getPrototypeOf(view)).toBe(Object.prototype);
		expect(Object.keys(view)).toEqual(["__proto__"]);
	});

	it("are read only through the received view's own extent", () => {
		const body = json(relayRequest());
		const backing = new Uint8Array(body.length + 16);
		backing.fill(0x7b);
		backing.set(body, 8);
		expect(relay.checkOAuthRelayRequestBytes("relay", backing.subarray(8, 8 + body.length))).toBe(
			true,
		);
		const copy = Uint8Array.from(body);
		for (const other of [
			JSON.stringify(relayRequest()),
			copy.buffer,
			new DataView(copy.buffer),
			Array.from(copy),
			new Uint16Array(copy.buffer, 0, Math.floor(copy.length / 2)),
			undefined,
			null,
		])
			expect(relay.checkOAuthRelayRequestBytes("relay", other as unknown as Uint8Array)).toBe(
				false,
			);
	});

	it("count only byte lengths of the known routes and directions", () => {
		for (const length of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])
			expect(relay.checkOAuthRelayLength("relay", "request", length)).toBe(false);
		expect(relay.checkOAuthRelayLength("relay", "request", 0)).toBe(true);
		expect(relay.checkOAuthRelayLength("start", "request", 0)).toBe(false);
		expect(relay.checkOAuthRelayLength("relay", "body" as "request", 0)).toBe(false);
	});
});

describe("the route table", () => {
	it("is frozen and names only exported schemas", () => {
		expect(Object.isFrozen(relay.OAUTH_RELAY_ROUTES)).toBe(true);
		expect(Object.isFrozen(relay.OAUTH_RELAY_SCHEMAS)).toBe(true);
		for (const route of relay.OAUTH_RELAY_ROUTES) {
			expect(Object.isFrozen(route)).toBe(true);
			expect(relay.OAUTH_RELAY_SCHEMAS[route.request]).toBeDefined();
			expect(relay.OAUTH_RELAY_SCHEMAS[route.response]).toBeDefined();
		}
		expect(Object.keys(relay.OAUTH_RELAY_SCHEMAS).toSorted()).toEqual([
			"GmailFlowAuthorization",
			"GmailFlowAuthorizeRequest",
			"GmailFlowClientRequest",
			"GmailFlowRelayRequest",
			"GmailFlowView",
		]);
	});
});

describe("peer member admission", () => {
	const confirmed = () => ({
		role: "device",
		known: true,
		revoked: false,
		epoch: 2,
		confirmedEpoch: 2,
		capabilities: ["admin"],
		sidecarClaim: false,
		bootstrapDone: false,
	});
	const members = [
		"role",
		"known",
		"revoked",
		"epoch",
		"confirmedEpoch",
		"capabilities",
		"sidecarClaim",
		"bootstrapDone",
	] as const;

	it("admits own data members on plain and null-prototype peers", () => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			expect(relay.oauthRelayRouteAllows(id, confirmed())).toBe(true);
			expect(relay.oauthRelayRouteAllows(id, Object.assign(Object.create(null), confirmed()))).toBe(
				true,
			);
		}
	});

	it("refuses a peer whose complete authority comes from its prototype", () => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES)
			expect(relay.oauthRelayRouteAllows(id, Object.create(confirmed()))).toBe(false);
	});

	it.each(members)("refuses inherited %s even when every other member is own data", (name) => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			const peer = confirmed();
			const inherited = { [name]: peer[name] };
			Reflect.deleteProperty(peer, name);
			Object.setPrototypeOf(peer, inherited);
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(false);
		}
	});

	it.each(members)("refuses accessor %s without executing its getter", (name) => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			const peer = confirmed();
			const value = peer[name];
			let reads = 0;
			Object.defineProperty(peer, name, {
				enumerable: true,
				get() {
					reads++;
					return value;
				},
			});
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(false);
			expect(reads).toBe(0);
		}
	});

	it.each(members)("refuses non-enumerable %s", (name) => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			const peer = confirmed();
			Object.defineProperty(peer, name, { enumerable: false });
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(false);
		}
	});

	it("refuses proxy peers without running property traps", () => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			let traps = 0;
			const peer = new Proxy(confirmed(), {
				get(target, name, receiver) {
					traps++;
					return Reflect.get(target, name, receiver);
				},
				getOwnPropertyDescriptor(target, name) {
					traps++;
					return Reflect.getOwnPropertyDescriptor(target, name);
				},
				ownKeys(target) {
					traps++;
					return Reflect.ownKeys(target);
				},
			});
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(false);
			expect(traps).toBe(0);
		}
	});

	it("refuses capability getters before they can change the peer", () => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			const peer = confirmed();
			let reads = 0;
			Object.defineProperty(peer.capabilities, "0", {
				get() {
					reads++;
					peer.revoked = true;
					return "admin";
				},
			});
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(false);
			expect(reads).toBe(0);
			expect(peer.revoked).toBe(false);
		}
	});

	it("refuses inherited capability entries without reading them", () => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			const peer = confirmed();
			peer.capabilities = new Array<string>(1);
			const inherited = Object.create(Array.prototype);
			let reads = 0;
			Object.defineProperty(inherited, "0", {
				get() {
					reads++;
					return "admin";
				},
			});
			Object.setPrototypeOf(peer.capabilities, inherited);
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(false);
			expect(reads).toBe(0);
		}
	});

	it("refuses proxy capability arrays without running their traps", () => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			const peer = confirmed();
			let traps = 0;
			peer.capabilities = new Proxy(peer.capabilities, {
				get(target, name, receiver) {
					traps++;
					return Reflect.get(target, name, receiver);
				},
				getOwnPropertyDescriptor(target, name) {
					traps++;
					return Reflect.getOwnPropertyDescriptor(target, name);
				},
			});
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(false);
			expect(traps).toBe(0);
		}
	});

	it("bounds capability length before inspecting any entries", () => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			const peer = confirmed();
			peer.capabilities = new Array<string>(100);
			let reads = 0;
			Object.defineProperty(peer.capabilities, "0", {
				get() {
					reads++;
					return "admin";
				},
			});
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(false);
			expect(reads).toBe(0);
		}
	});

	it("copies native capability entries without consulting custom array methods", () => {
		for (const { id } of relay.OAUTH_RELAY_ROUTES) {
			const peer = confirmed();
			let calls = 0;
			Object.defineProperty(peer.capabilities, Symbol.iterator, {
				value() {
					calls++;
					throw new Error("DYTEST custom capability iterator");
				},
			});
			Object.defineProperty(peer.capabilities, "0", { enumerable: false });
			expect(relay.oauthRelayRouteAllows(id, peer)).toBe(true);
			expect(calls).toBe(0);
		}
	});
});
