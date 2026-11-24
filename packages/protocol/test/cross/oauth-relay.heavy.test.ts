import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	AUTHORIZATION_ENDPOINT,
	authorization,
	FLOW_ID,
	REDIRECT_URI,
	type RelayCase,
	STATE,
} from "../../scripts/vectors/oauth-relay.ts";
import { canonicalize } from "../../src/jcs.ts";
import * as relay from "../../src/oauth-relay.ts";
import { vectorFiles } from "../vectors.ts";
import { startXcheck, type Xcheck } from "./xcheck.ts";

const files = vectorFiles<{ routes?: unknown; cases: RelayCase[] }>("oauth-relay");
const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const ascii = (maxLength: number): fc.Arbitrary<string> =>
	fc.string({ unit: "binary-ascii", maxLength });
const around = (cap: number): fc.Arbitrary<string> =>
	fc.integer({ min: cap - 2, max: cap + 2 }).map((length) => "x".repeat(length));

const redirectUri = fc
	.tuple(
		fc.constantFrom("http://", "http://", "https://", ""),
		fc.constantFrom("", "", "user@"),
		fc.constantFrom("127.0.0.1", "127.0.0.1", "localhost"),
		fc.oneof(
			fc.integer({ min: 0, max: 70_000 }).map((port) => `:${port}`),
			fc.stringMatching(/^:0?[0-9]{0,6}$/),
		),
		fc.constantFrom("/oauth/google/callback", "/oauth/google/callback", "/oauth/google/"),
		fc.constantFrom("", "", "", "?", "#", "?code=x", " ", "\n"),
	)
	.map((parts) => parts.join(""));
const state = fc.oneof(
	fc.constant(STATE),
	fc
		.uint8Array({ minLength: 31, maxLength: 33 })
		.map((bytes) => Buffer.from(bytes).toString("base64url")),
	fc
		.tuple(fc.uint8Array({ minLength: 32, maxLength: 32 }), fc.nat(42), ascii(1))
		.map(([bytes, at, text]) => {
			const encoded = Buffer.from(bytes).toString("base64url");
			return `${encoded.slice(0, at)}${text}${encoded.slice(at + 1)}`;
		}),
);
const visible = (cap: number): fc.Arbitrary<string> =>
	fc.oneof(ascii(12), around(cap), fc.string({ maxLength: 3 }), fc.constant("DYTEST-value"));
const authorizationUrl = fc
	.tuple(
		fc.constantFrom(
			"https://accounts.google.com",
			"https://accounts.google.com",
			"https://user@accounts.google.com",
			"https://accounts.google.com:443",
			"http://accounts.google.com",
		),
		fc.constantFrom("/o/oauth2/v2/auth", "/o/oauth2/v2/auth", "/o/oauth2/v2/auth/", ""),
		fc.option(
			fc.string({
				unit: fc.constantFrom(..."azAZ09-._~!$&'()*+,;=:@/?%", "%2F", "%zz", " ", "#", "\\"),
				maxLength: 16,
			}),
			{ nil: undefined },
		),
	)
	.map(([origin, path, query]) => `${origin}${path}${query === undefined ? "" : `?${query}`}`);
const fields: Readonly<Record<string, readonly [fc.Arbitrary<string>, (text: string) => boolean]>> =
	{
		redirectUri: [redirectUri, relay.checkLoopbackRedirectUri],
		state: [state, relay.checkOAuthState],
		code: [visible(256), relay.checkAuthorizationCode],
		clientId: [visible(512), relay.checkOAuthClientId],
		clientSecret: [visible(4096), relay.checkOAuthClientSecret],
		authorizationUrl: [authorizationUrl, relay.checkGoogleAuthorizationUrl],
	};
const flowId = fc.oneof(
	{ arbitrary: fc.constant(FLOW_ID), weight: 3 },
	fc.constant(FLOW_ID.toLowerCase()),
	ascii(26),
);

describe("cross-language OAuth relay", () => {
	let checker: Xcheck;
	beforeAll(async () => {
		checker = await startXcheck();
	});
	afterAll(async () => {
		await checker?.close();
	});
	const run = (fields: Readonly<Record<string, unknown>>) => checker.run("oauth-relay", fields);

	it("matches the route table and every shared vector", { tags: ["requires:cargo"] }, async () => {
		const [, routes] = files.find(([name]) => name === "routes.json") ?? [];
		expect(await run({ action: "catalogue" })).toEqual({ routes: routes?.routes });
		let compared = 0;
		for (const [, file] of files)
			for (const vector of file.cases) {
				const fields: Record<string, unknown> = { ...vector };
				if (typeof fields.padToBytes === "number") {
					const json = Buffer.from(JSON.stringify(fields.value));
					fields.receivedHex = hex(
						Buffer.concat([json, Buffer.alloc(fields.padToBytes - json.length, 0x20)]),
					);
					delete fields.padToBytes;
				}
				expect(await run(fields), vector.id).toEqual({ valid: vector.valid });
				compared++;
			}
		expect(compared).toBeGreaterThan(300);
	});

	it("checks random field values alike", { tags: ["requires:cargo"] }, async () => {
		const pairs = Object.entries(fields).map(([field, [arbitrary]]) =>
			arbitrary.map((value) => [field, value] as const),
		);
		let accepted = 0;
		await fc.assert(
			fc.asyncProperty(fc.oneof(...pairs), async ([field, value]) => {
				const [, check] = fields[field] as (typeof fields)[string];
				const valid = check(value);
				if (valid) accepted++;
				expect(await run({ action: "field", field, value })).toEqual({ valid });
			}),
			{ numRuns: 3000 },
		);
		expect(accepted).toBeGreaterThan(300);
	});

	it("accepts the bodies Rust writes, and Rust refuses what TS refuses", {
		tags: ["requires:cargo"],
	}, async () => {
		const requests = fc.oneof(
			fc
				.record({
					flowId,
					clientId: visible(512),
					clientSecret: fc.option(visible(4096), { nil: null }),
					redirectUri: fc.oneof(fc.constant(REDIRECT_URI), redirectUri),
				})
				.map((fields) => ["client", fields] as const),
			fc.record({ flowId }).map((fields) => ["authorize", fields] as const),
			fc
				.record({
					flowId,
					state,
					code: visible(256),
					redirectUri: fc.oneof(fc.constant(REDIRECT_URI), redirectUri),
				})
				.map((fields) => ["relay", fields] as const),
		);
		let built = 0;
		await fc.assert(
			fc.asyncProperty(requests, async ([route, fields]) => {
				const value =
					route === "client"
						? {
								flowId: fields.flowId,
								client: { clientId: fields.clientId, clientSecret: fields.clientSecret },
								redirectUri: fields.redirectUri,
							}
						: fields;
				const answer = await run({ action: "build", route, ...fields });
				if (!relay.checkOAuthRelayRequest(route, value)) {
					expect(answer).toEqual({ refused: true });
					return;
				}
				const bytes = Buffer.from(answer.hex as string, "hex");
				expect(bytes.toString()).toBe(canonicalize(value));
				expect(relay.parseOAuthRelayRequestBytes(route, bytes)).toEqual(value);
				built++;
			}),
			{ numRuns: 1500 },
		);
		expect(built).toBeGreaterThan(150);
	});

	it("reads the authorization views TS accepts, and only those", {
		tags: ["requires:cargo"],
	}, async () => {
		const views = fc.record({
			id: flowId,
			authorizationUrl: fc.oneof(
				{ arbitrary: fc.constant(`${AUTHORIZATION_ENDPOINT}?a=b`), weight: 2 },
				authorizationUrl,
			),
			expiresAt: fc.oneof(
				{ arbitrary: fc.nat(), weight: 3 },
				fc.constant(Number.MAX_SAFE_INTEGER),
				fc.constant(-1),
			),
			remainingMs: fc.oneof({ arbitrary: fc.nat(600_000), weight: 3 }, fc.constant(0.5)),
		});
		let read = 0;
		await fc.assert(
			fc.asyncProperty(views, fc.nat(64), async (view, spaces) => {
				const bytes = Buffer.from(`${JSON.stringify(view)}${" ".repeat(spaces)}`);
				const answer = await run({ action: "authorization", receivedHex: hex(bytes) });
				if (!relay.checkOAuthRelayResponseBytes("authorize", bytes)) {
					expect(answer).toEqual({ refused: true });
					return;
				}
				expect(answer).toEqual(relay.parseOAuthRelayResponseBytes("authorize", bytes));
				read++;
			}),
			{ numRuns: 1500 },
		);
		expect(read).toBeGreaterThan(100);
		const base = Buffer.from(JSON.stringify(authorization()));
		for (const length of [8192, 8193]) {
			const padded = Buffer.concat([base, Buffer.alloc(length - base.length, 0x20)]);
			const answer = await run({ action: "authorization", receivedHex: hex(padded) });
			expect(answer).toEqual(length === 8192 ? authorization() : { refused: true });
		}
	});
});
