import { createHash } from "node:crypto";
import type { VectorFile } from "../vectors.ts";

export interface RelayCase extends Record<string, unknown> {
	readonly id: string;
	readonly action: string;
	readonly valid: boolean;
}
type ObjectValue = Record<string, unknown>;

export interface RouteVector {
	readonly id: string;
	readonly method: string;
	readonly path: string;
	readonly role: string;
	readonly confirmation: string;
	readonly capability: string;
	readonly request: string;
	readonly requestBytes: number;
	readonly responseBytes: number;
	readonly response: string;
}
// The wire catalogue, transcribed from the contract independently of src/.
const routeVector = (
	id: string,
	request: string,
	requestBytes: number,
	response: string,
): RouteVector => ({
	id,
	method: "POST",
	path: `/device/v1/accounts/gmail/flow/${id}`,
	role: "device",
	confirmation: "confirmed",
	capability: "admin",
	request,
	requestBytes,
	responseBytes: 8192,
	response,
});
export const routes: readonly RouteVector[] = [
	routeVector("client", "GmailFlowClientRequest", 32768, "GmailFlowView"),
	routeVector("authorize", "GmailFlowAuthorizeRequest", 512, "GmailFlowAuthorization"),
	routeVector("relay", "GmailFlowRelayRequest", 2048, "GmailFlowView"),
];

// Synthetic values only: no real client, secret, state or code.
export const FLOW_ID = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
export const REDIRECT_URI = "http://127.0.0.1:54321/oauth/google/callback";
export const CLIENT_ID = "DYTEST-google-desktop";
export const CLIENT_SECRET = "DYTEST-client-secret";
export const CODE = "DYTEST-authorization-code";
const counting = (length: number): Buffer =>
	Buffer.from(Array.from({ length }, (_, index) => index % 256));
export const STATE: string = counting(32).toString("base64url");
export const AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const query = new URLSearchParams({
	client_id: CLIENT_ID,
	redirect_uri: REDIRECT_URI,
	response_type: "code",
	scope: "openid email https://www.googleapis.com/auth/gmail.modify",
	state: STATE,
	code_challenge: createHash("sha256").update("DYTEST-verifier").digest("base64url"),
	code_challenge_method: "S256",
	access_type: "offline",
}).toString();
export const AUTHORIZATION_URL: string = `${AUTHORIZATION_ENDPOINT}?${query}`;
const EXPIRES_AT = 1_767_225_600_000;

export const clientRequest = (): ObjectValue => ({
	flowId: FLOW_ID,
	client: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
	redirectUri: REDIRECT_URI,
});
export const authorizeRequest = (): ObjectValue => ({ flowId: FLOW_ID });
export const relayRequest = (): ObjectValue => ({
	flowId: FLOW_ID,
	state: STATE,
	code: CODE,
	redirectUri: REDIRECT_URI,
});
export const authorization = (): ObjectValue => ({
	id: FLOW_ID,
	authorizationUrl: AUTHORIZATION_URL,
	expiresAt: EXPIRES_AT,
	remainingMs: 600_000,
});
// The flow view's members are the hub's; the relay checks only the outer JSON object.
export const flowView = (): ObjectValue => ({ id: FLOW_ID, phase: "awaiting-google" });

const REMOVE = Symbol("remove");
function changed(value: ObjectValue, path: string, replacement: unknown): ObjectValue {
	const copy = structuredClone(value);
	const parts = path.split(".");
	let cursor = copy;
	for (const part of parts.slice(0, -1)) cursor = cursor[part] as ObjectValue;
	const last = parts.at(-1) as string;
	if (replacement === REMOVE) delete cursor[last];
	else cursor[last] = replacement;
	return copy;
}
const hex = (text: string | Uint8Array): string => Buffer.from(text).toString("hex");

const validPorts = [
	1, 9, 10, 99, 100, 999, 1000, 9999, 10000, 54321, 59999, 60000, 64999, 65000, 65499, 65500, 65529,
	65530, 65535,
];
export const redirectRefusals: readonly (readonly [string, string])[] = [
	["other-path", "http://127.0.0.1:54321/oauth/google/other"],
	["root-path", "http://127.0.0.1:54321/"],
	["no-path", "http://127.0.0.1:54321"],
	["trailing-slash", "http://127.0.0.1:54321/oauth/google/callback/"],
	["longer-path", "http://127.0.0.1:54321/oauth/google/callbacks"],
	["encoded-path", "http://127.0.0.1:54321/oauth/google/%63allback"],
	["upper-case-path", "http://127.0.0.1:54321/oauth/Google/callback"],
	["dot-segment", "http://127.0.0.1:54321/oauth/x/../google/callback"],
	["port-0", "http://127.0.0.1:0/oauth/google/callback"],
	["port-65536", "http://127.0.0.1:65536/oauth/google/callback"],
	["port-65540", "http://127.0.0.1:65540/oauth/google/callback"],
	["port-65600", "http://127.0.0.1:65600/oauth/google/callback"],
	["port-66000", "http://127.0.0.1:66000/oauth/google/callback"],
	["port-70000", "http://127.0.0.1:70000/oauth/google/callback"],
	["port-99999", "http://127.0.0.1:99999/oauth/google/callback"],
	["port-six-digits", "http://127.0.0.1:100000/oauth/google/callback"],
	["leading-zero", "http://127.0.0.1:080/oauth/google/callback"],
	["leading-zero-one", "http://127.0.0.1:01/oauth/google/callback"],
	["leading-zero-five-digits", "http://127.0.0.1:01234/oauth/google/callback"],
	["double-zero", "http://127.0.0.1:00/oauth/google/callback"],
	["empty-port", "http://127.0.0.1:/oauth/google/callback"],
	["no-port", "http://127.0.0.1/oauth/google/callback"],
	["signed-port", "http://127.0.0.1:+80/oauth/google/callback"],
	["two-ports", "http://127.0.0.1:80:80/oauth/google/callback"],
	["userinfo", "http://user@127.0.0.1:54321/oauth/google/callback"],
	["userinfo-password", "http://user:pass@127.0.0.1:54321/oauth/google/callback"],
	["empty-userinfo", "http://@127.0.0.1:54321/oauth/google/callback"],
	["query", "http://127.0.0.1:54321/oauth/google/callback?code=x"],
	["empty-query", "http://127.0.0.1:54321/oauth/google/callback?"],
	["fragment", "http://127.0.0.1:54321/oauth/google/callback#x"],
	["empty-fragment", "http://127.0.0.1:54321/oauth/google/callback#"],
	["https", "https://127.0.0.1:54321/oauth/google/callback"],
	["upper-case-scheme", "HTTP://127.0.0.1:54321/oauth/google/callback"],
	["no-scheme", "//127.0.0.1:54321/oauth/google/callback"],
	["localhost", "http://localhost:54321/oauth/google/callback"],
	["other-loopback", "http://127.0.0.2:54321/oauth/google/callback"],
	["ipv6-loopback", "http://[::1]:54321/oauth/google/callback"],
	["line-feed", "http://127.0.0.1:54321/oauth/google/callback\n"],
	["space", "http://127.0.0.1:54321/oauth/google/callback "],
	["backslashes", "http://127.0.0.1:54321\\oauth\\google\\callback"],
	["empty", ""],
];
// Visible ASCII: 0x21-0x7e, so no space, control character or anything beyond ASCII.
const invisible: readonly (readonly [string, string])[] = [
	["space", "DYTEST value"],
	["tab", "DYTEST\tvalue"],
	["line-feed", "DYTEST-value\n"],
	["nul", "DYTEST\u0000value"],
	["del", "DYTEST\u007fvalue"],
	["latin", "DYTEST-välue"],
	["empty", ""],
];
const authorizationRefusals: readonly (readonly [string, string])[] = [
	["origin-http", `http://accounts.google.com/o/oauth2/v2/auth?${query}`],
	["origin-port", `https://accounts.google.com:443/o/oauth2/v2/auth?${query}`],
	["origin-upper-case-host", `https://ACCOUNTS.GOOGLE.COM/o/oauth2/v2/auth?${query}`],
	["origin-upper-case-scheme", `HTTPS://accounts.google.com/o/oauth2/v2/auth?${query}`],
	["origin-trailing-dot", `https://accounts.google.com./o/oauth2/v2/auth?${query}`],
	["origin-suffix", `https://accounts.google.com.evil.example/o/oauth2/v2/auth?${query}`],
	["origin-subdomain", `https://evil.accounts.google.com/o/oauth2/v2/auth?${query}`],
	["origin-sibling", `https://accounts.google.co/o/oauth2/v2/auth?${query}`],
	["origin-other", `https://evil.example/o/oauth2/v2/auth?${query}`],
	["origin-none", `//accounts.google.com/o/oauth2/v2/auth?${query}`],
	["path-v1", `https://accounts.google.com/o/oauth2/auth?${query}`],
	["path-trailing-slash", `https://accounts.google.com/o/oauth2/v2/auth/?${query}`],
	["path-longer", `https://accounts.google.com/o/oauth2/v2/authorize?${query}`],
	["path-child", `https://accounts.google.com/o/oauth2/v2/auth/x?${query}`],
	["path-upper-case", `https://accounts.google.com/O/oauth2/v2/auth?${query}`],
	["path-encoded", `https://accounts.google.com/o/oauth2/v2/%61uth?${query}`],
	["path-parameter", `https://accounts.google.com/o/oauth2/v2/auth;x=1?${query}`],
	["path-dot-segment", `https://accounts.google.com/o/oauth2/v3/../v2/auth?${query}`],
	["path-double-slash", `https://accounts.google.com//o/oauth2/v2/auth?${query}`],
	["path-none", `https://accounts.google.com?${query}`],
	["userinfo", `https://user@accounts.google.com/o/oauth2/v2/auth?${query}`],
	["userinfo-password", `https://user:pass@accounts.google.com/o/oauth2/v2/auth?${query}`],
	["userinfo-empty", `https://@accounts.google.com/o/oauth2/v2/auth?${query}`],
	["userinfo-host", `https://accounts.google.com@evil.example/o/oauth2/v2/auth?${query}`],
	["fragment", `${AUTHORIZATION_URL}#x`],
	["fragment-empty", `${AUTHORIZATION_URL}#`],
	["fragment-without-query", `${AUTHORIZATION_ENDPOINT}#x`],
	["fragment-holding-query", `${AUTHORIZATION_ENDPOINT}#?${query}`],
	...(
		[
			["space", " "],
			["quote", '"'],
			["less-than", "<"],
			["greater-than", ">"],
			["backslash", "\\"],
			["caret", "^"],
			["backtick", "`"],
			["left-brace", "{"],
			["pipe", "|"],
			["right-brace", "}"],
			["left-bracket", "["],
			["right-bracket", "]"],
			["lone-percent", "%"],
			["short-escape", "%2"],
			["non-hex-escape", "%zz"],
			["latin", "é"],
			["tab", "\t"],
			["line-feed", "\n"],
		] as const
	).map(([name, text]) => [`query-${name}`, `${AUTHORIZATION_URL}&x=${text}`] as const),
];
// The last character with its two unused low bits set: the same 32 bytes, not canonical.
const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const nonCanonicalState = `${STATE.slice(0, 42)}${BASE64URL[BASE64URL.indexOf(STATE.slice(42)) + 1]}`;

export function valueCases(): RelayCase[] {
	const cases: RelayCase[] = [];
	const add = (id: string, action: string, fields: ObjectValue, valid: boolean): void => {
		cases.push({ id, action, ...fields, valid });
	};
	const request = (id: string, route: string, value: unknown, valid: boolean): void =>
		add(`request-${id}`, "request", { route, value }, valid);
	const response = (id: string, route: string, value: unknown, valid: boolean): void =>
		add(`response-${id}`, "response", { route, value }, valid);
	const received = (
		id: string,
		action: "request" | "response",
		route: string,
		bytes: string | Uint8Array,
		valid: boolean,
	): void => add(`${action}-${id}`, action, { route, receivedHex: hex(bytes) }, valid);

	request("client-base", "client", clientRequest(), true);
	request(
		"client-without-secret",
		"client",
		changed(clientRequest(), "client.clientSecret", null),
		true,
	);
	for (const [name, value, valid] of [
		["512", "x".repeat(512), true],
		["512-quotes", '"'.repeat(512), true],
		["513", "x".repeat(513), false],
		["number", 512, false],
		["null", null, false],
		...invisible.map(([label, text]) => [label, text, false] as const),
	] as const)
		request(
			`client-id-${name}`,
			"client",
			changed(clientRequest(), "client.clientId", value),
			valid,
		);
	for (const [name, value, valid] of [
		["4096", "x".repeat(4096), true],
		["4096-backslashes", "\\".repeat(4096), true],
		["4097", "x".repeat(4097), false],
		["number", 1, false],
		["absent", REMOVE, false],
		...invisible.map(([label, text]) => [label, text, false] as const),
	] as const)
		request(
			`client-secret-${name}`,
			"client",
			changed(clientRequest(), "client.clientSecret", value),
			valid,
		);
	for (const [name, path, value] of [
		["unknown-member", "extra", true],
		["unknown-client-member", "client.extra", true],
		["without-redirect", "redirectUri", REMOVE],
		["without-client", "client", REMOVE],
		["null-client", "client", null],
		["lower-case-flow", "flowId", FLOW_ID.toLowerCase()],
		["short-flow", "flowId", FLOW_ID.slice(1)],
	] as const)
		request(`client-${name}`, "client", changed(clientRequest(), path, value), false);
	request("client-array", "client", [], false);
	request("client-null", "client", null, false);

	request("authorize-base", "authorize", authorizeRequest(), true);
	for (const [name, value] of [
		["unknown-member", { flowId: FLOW_ID, extra: true }],
		["empty", {}],
		["lower-case-flow", { flowId: FLOW_ID.toLowerCase() }],
		["flow-out-of-range", { flowId: `8${FLOW_ID.slice(1)}` }],
		["flow-number", { flowId: 1 }],
		["string", FLOW_ID],
	] as const)
		request(`authorize-${name}`, "authorize", value, false);

	request("relay-base", "relay", relayRequest(), true);
	for (const [name, state, valid] of [
		["all-ones", Buffer.alloc(32, 0xff).toString("base64url"), true],
		["31-bytes", counting(31).toString("base64url"), false],
		["33-bytes", counting(33).toString("base64url"), false],
		["non-canonical", nonCanonicalState, false],
		["padded", `${STATE}=`, false],
		["plus", `+${STATE.slice(1)}`, false],
		["slash", `/${STATE.slice(1)}`, false],
		["space", `${STATE.slice(0, 42)} `, false],
		["line-feed", `${STATE.slice(0, 42)}\n`, false],
		["empty", "", false],
		["number", 32, false],
		["absent", REMOVE, false],
	] as const)
		request(`relay-state-${name}`, "relay", changed(relayRequest(), "state", state), valid);
	for (const [name, value, valid] of [
		["256", "x".repeat(256), true],
		["256-quotes", '"'.repeat(256), true],
		["257", "x".repeat(257), false],
		["number", 1, false],
		["absent", REMOVE, false],
		...invisible.map(([label, text]) => [label, text, false] as const),
	] as const)
		request(`relay-code-${name}`, "relay", changed(relayRequest(), "code", value), valid);
	request("relay-unknown-member", "relay", changed(relayRequest(), "extra", true), false);
	request(
		"relay-lower-case-flow",
		"relay",
		changed(relayRequest(), "flowId", FLOW_ID.toLowerCase()),
		false,
	);

	for (const [route, base, path] of [
		["client", clientRequest, "redirectUri"],
		["relay", relayRequest, "redirectUri"],
	] as const) {
		for (const port of validPorts)
			request(
				`${route}-redirect-port-${port}`,
				route,
				changed(base(), path, `http://127.0.0.1:${port}/oauth/google/callback`),
				true,
			);
		for (const [name, uri] of redirectRefusals)
			request(`${route}-redirect-${name}`, route, changed(base(), path, uri), false);
		request(`${route}-redirect-number`, route, changed(base(), path, 54321), false);
	}

	response("authorize-base", "authorize", authorization(), true);
	for (const [name, url] of [
		["without-query", AUTHORIZATION_ENDPOINT],
		["empty-query", `${AUTHORIZATION_ENDPOINT}?`],
		["query-characters", `${AUTHORIZATION_ENDPOINT}?azAZ09-._~!$&'()*+,;=:@/?%2F%2f`],
		["at-in-query", `${AUTHORIZATION_ENDPOINT}?redirect=http://user@evil.example/`],
	] as const)
		response(
			`authorize-url-${name}`,
			"authorize",
			changed(authorization(), "authorizationUrl", url),
			true,
		);
	for (const [name, url] of authorizationRefusals)
		response(
			`authorize-url-${name}`,
			"authorize",
			changed(authorization(), "authorizationUrl", url),
			false,
		);
	for (const [name, path, value, valid] of [
		["url-number", "authorizationUrl", 1, false],
		["url-null", "authorizationUrl", null, false],
		["lower-case-id", "id", FLOW_ID.toLowerCase(), false],
		["expires-zero", "expiresAt", 0, true],
		["expires-max-safe", "expiresAt", Number.MAX_SAFE_INTEGER, true],
		["expires-negative", "expiresAt", -1, false],
		["expires-fraction", "expiresAt", 1.5, false],
		["expires-unsafe", "expiresAt", 9_007_199_254_740_992, false],
		["expires-string", "expiresAt", "1", false],
		["remaining-zero", "remainingMs", 0, true],
		["remaining-negative", "remainingMs", -1, false],
		["remaining-fraction", "remainingMs", 0.5, false],
		["remaining-null", "remainingMs", null, false],
		["remaining-absent", "remainingMs", REMOVE, false],
		["unknown-member", "extra", true, false],
	] as const)
		response(`authorize-${name}`, "authorize", changed(authorization(), path, value), valid);

	// Received number forms: each is the double it denotes, so 1.0 and 1e0 are the integer 1.
	for (const [field, label] of [
		["expiresAt", "expires"],
		["remainingMs", "remaining"],
	] as const)
		for (const [name, literal, valid] of [
			["zero-float", "0.0", true],
			["negative-zero", "-0.0", true],
			["integral-float", "1.0", true],
			["integral-exponent", "1e0", true],
			["max-safe-float", "9007199254740991.0", true],
			["negative-float", "-1.0", false],
			["fraction", "1.5", false],
			["unsafe-float", "9007199254740992.0", false],
			["overflow", "1e309", false],
		] as const) {
			const expiresAt = field === "expiresAt" ? literal : "1";
			const remainingMs = field === "remainingMs" ? literal : "1";
			received(
				`authorize-received-${label}-${name}`,
				"response",
				"authorize",
				`{"id":"${FLOW_ID}","authorizationUrl":"${AUTHORIZATION_ENDPOINT}","expiresAt":${expiresAt},"remainingMs":${remainingMs}}`,
				valid,
			);
		}

	for (const route of ["client", "relay"]) {
		response(`${route}-view`, route, flowView(), true);
		response(`${route}-view-empty`, route, {}, true);
		response(`${route}-view-nested`, route, { a: { b: [1, "x", null, true] } }, true);
		// A "__proto__" member is an ordinary member, counted like any other.
		response(`${route}-view-proto-member`, route, JSON.parse('{"__proto__":{"phase":"x"}}'), true);
		response(
			`${route}-view-proto-over-cap`,
			route,
			JSON.parse(`{"__proto__":"${"x".repeat(8192)}"}`),
			false,
		);
		response(`${route}-view-over-cap`, route, { phase: "x".repeat(8192) }, false);
		response(`${route}-view-utf8-at-cap`, route, { phase: "\u00e9".repeat(4090) }, true);
		response(`${route}-view-utf8-over-cap`, route, { phase: "\u00e9".repeat(4096) }, false);
		for (const [name, value] of [
			["null", null],
			["array", []],
			["string", "view"],
			["number", 0],
			["boolean", true],
		] as const)
			response(`${route}-view-${name}`, route, value, false);
		for (const [name, text, valid] of [
			["spaced", ' {"phase":"failed"} ', true],
			["duplicate-member", '{"phase":"ready","phase":"failed"}', false],
			["trailing-text", "{} {}", false],
			["lone-surrogate", '{"a":"\\ud800"}', false],
			["array", "[]", false],
			["empty", "", false],
			["blank", "   ", false],
		] as const)
			received(`${route}-view-received-${name}`, "response", route, text, valid);
		received(
			`${route}-view-received-invalid-utf8`,
			"response",
			route,
			Buffer.concat([Buffer.from('{"a":"'), Buffer.from([0xff]), Buffer.from('"}')]),
			false,
		);
	}

	const relayText = JSON.stringify(relayRequest());
	received(
		"relay-received-duplicate-code",
		"request",
		"relay",
		relayText.replace('"code":', '"code":"x","code":'),
		false,
	);
	received(
		"authorize-received-escaped",
		"request",
		"authorize",
		`{"flowId":"\\u0030\\u0031${FLOW_ID.slice(2)}"}`,
		true,
	);
	received(
		"authorize-received-trailing-text",
		"request",
		"authorize",
		`${JSON.stringify(authorizeRequest())}x`,
		false,
	);
	received("authorize-received-empty", "request", "authorize", "", false);
	received(
		"client-received-invalid-utf8",
		"request",
		"client",
		Buffer.concat([
			Buffer.from(JSON.stringify(clientRequest()).slice(0, -2)),
			Buffer.from([0xc3, 0x28]),
			Buffer.from('"}'),
		]),
		false,
	);
	// A received "__proto__" member is an ordinary member, so each strict form refuses it.
	const withProto = (value: ObjectValue): string =>
		`{"__proto__":{},${JSON.stringify(value).slice(1)}`;
	for (const [name, action, route, text] of [
		["client-received-proto-member", "request", "client", withProto(clientRequest())],
		[
			"client-received-proto-client-member",
			"request",
			"client",
			JSON.stringify(clientRequest()).replace('"client":{', '"client":{"__proto__":{},'),
		],
		["authorize-received-proto-member", "request", "authorize", withProto(authorizeRequest())],
		["relay-received-proto-member", "request", "relay", withProto(relayRequest())],
		["authorize-received-proto-member", "response", "authorize", withProto(authorization())],
	] as const)
		received(name, action, route, text, false);

	// Each cap counts the received bytes: legal whitespace up to the cap, then one byte more.
	for (const route of routes) {
		const requestValue = {
			client: clientRequest,
			authorize: authorizeRequest,
			relay: relayRequest,
		}[route.id as "client" | "authorize" | "relay"]();
		const responseValue = route.id === "authorize" ? authorization() : flowView();
		for (const [direction, value, cap] of [
			["request", requestValue, route.requestBytes],
			["response", responseValue, route.responseBytes],
		] as const) {
			for (const length of [cap, cap + 1]) {
				add(
					`${direction}-${route.id}-received-${length}`,
					direction,
					{ route: route.id, value, padToBytes: length },
					length === cap,
				);
				add(
					`cap-${route.id}-${direction}-${length}`,
					"cap",
					{ route: route.id, direction, length },
					length === cap,
				);
			}
		}
	}
	// A legal compact number keeps the received bytes within the cap though the canonical form
	// would pass it, and the cap still holds one byte later.
	const long = authorization();
	const canonicalLength = (url: string): number =>
		Buffer.byteLength(JSON.stringify({ ...long, authorizationUrl: url }));
	let url = `${AUTHORIZATION_URL}&p=`;
	url += "x".repeat(8193 - canonicalLength(url));
	const compact = JSON.stringify({ ...long, authorizationUrl: url }).replace(
		`"expiresAt":${EXPIRES_AT}`,
		'"expiresAt":1.7672256e12',
	);
	received("authorize-received-compact-number", "response", "authorize", compact, true);
	received("authorize-received-compact-number-over", "response", "authorize", `${compact} `, false);
	return cases;
}

export function accessCases(): RelayCase[] {
	const cases: RelayCase[] = [];
	const peer = {
		role: "device",
		known: true,
		revoked: false,
		epoch: 2,
		confirmedEpoch: 2,
		capabilities: ["read", "draft", "organize", "approve", "admin"],
		sidecarClaim: false,
		bootstrapDone: false,
	};
	const add = (id: string, route: string, value: unknown, valid: boolean): void => {
		cases.push({ id: `access-${id}`, action: "access", route, peer: value, valid });
	};
	for (const { id: route } of routes) {
		add(`${route}-confirmed-admin`, route, peer, true);
		add(`${route}-admin-only`, route, { ...peer, capabilities: ["admin"] }, true);
		for (const [name, patch] of [
			["missing-admin", { capabilities: ["read", "draft", "organize", "approve"] }],
			["no-capabilities", { capabilities: [] }],
			["pending", { confirmedEpoch: null, capabilities: [] }],
			["pending-holding-admin", { confirmedEpoch: null }],
			["earlier-epoch", { confirmedEpoch: 1 }],
			["revoked", { revoked: true }],
			["unknown-device", { known: false }],
			["host-role", { role: "host:sms" }],
		] as const)
			add(`${route}-${name}`, route, { ...peer, ...patch }, false);
	}
	add("unknown-route", "start", peer, false);
	add("peer-unknown-member", "client", { ...peer, extra: true }, false);
	const { bootstrapDone: _, ...partial } = peer;
	add("peer-missing-member", "client", partial, false);
	add("peer-repeated-capability", "client", { ...peer, capabilities: ["admin", "admin"] }, false);
	add("peer-unknown-capability", "client", { ...peer, capabilities: ["admin", "unknown"] }, false);
	// A capability is its name: an externally tagged object such as {"read": null} isn't one.
	for (const [name, capabilities] of [
		["tagged-capability", ["admin", { read: null }]],
		["tagged-admin", [{ admin: null }]],
	] as const)
		add(`peer-${name}`, "client", { ...peer, capabilities }, false);
	// Every member keeps its type, even one these routes don't read.
	for (const [name, patch] of [
		["known-number", { known: 1 }],
		["revoked-zero", { revoked: 0 }],
		["null-epochs", { epoch: null, confirmedEpoch: null }],
		["sidecar-claim-string", { sidecarClaim: "false" }],
		["bootstrap-done-null", { bootstrapDone: null }],
	] as const)
		add(`peer-${name}`, "client", { ...peer, ...patch }, false);
	add("peer-null", "client", null, false);
	return cases;
}

export const generate = (): VectorFile[] => [
	{
		path: "oauth-relay/routes.json",
		content: {
			format: "draftyak.vectors.oauth-relay.v1",
			description:
				"The three Gmail code relay routes and their admission cases. A case's peer is the device API's peer form; valid says whether the route admits it.",
			routes,
			cases: accessCases(),
		},
	},
	{
		path: "oauth-relay/cases.json",
		content: {
			format: "draftyak.vectors.oauth-relay.v1",
			description:
				"Request and response cases per route. value is checked as a JSON value, receivedHex as received bytes, and padToBytes as value's compact JSON padded with spaces to that many received bytes; cap cases check a byte length alone. valid says whether the route accepts it.",
			cases: valueCases(),
		},
	},
];
