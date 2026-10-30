import { describe, expect, it } from "vitest";
import type { RelayCase } from "../scripts/vectors/oauth-relay.ts";
import { canonicalize } from "../src/jcs.ts";
import {
	checkOAuthRelayLength,
	checkOAuthRelayRequest,
	checkOAuthRelayRequestBytes,
	checkOAuthRelayResponse,
	checkOAuthRelayResponseBytes,
	OAUTH_RELAY_ROUTES,
	oauthRelayRouteAllows,
} from "../src/oauth-relay.ts";
import { vectorFiles } from "./vectors.ts";

interface RelayFile {
	readonly format: string;
	readonly routes?: unknown;
	readonly cases: readonly RelayCase[];
}
const files = vectorFiles<RelayFile>("oauth-relay");
const cases = files.flatMap(([, file]) => file.cases);

// The bytes a case stands for: hex as given, or value's compact JSON padded with spaces.
function receivedBytes(vector: RelayCase): Uint8Array | undefined {
	if (typeof vector.receivedHex === "string") return Buffer.from(vector.receivedHex, "hex");
	if (typeof vector.padToBytes !== "number") return undefined;
	const json = Buffer.from(JSON.stringify(vector.value));
	if (vector.padToBytes < json.length) throw new Error(`${vector.id}: padding would truncate`);
	return Buffer.concat([json, Buffer.alloc(vector.padToBytes - json.length, 0x20)]);
}

function evaluate(vector: RelayCase): boolean {
	const route = vector.route as string;
	switch (vector.action) {
		case "access":
			return oauthRelayRouteAllows(route, vector.peer);
		case "cap":
			return checkOAuthRelayLength(
				route,
				vector.direction as "request" | "response",
				vector.length as number,
			);
		case "request":
		case "response": {
			const bytes = receivedBytes(vector);
			if (bytes !== undefined)
				return vector.action === "request"
					? checkOAuthRelayRequestBytes(route, bytes)
					: checkOAuthRelayResponseBytes(route, bytes);
			const byValue =
				vector.action === "request"
					? checkOAuthRelayRequest(route, vector.value)
					: checkOAuthRelayResponse(route, vector.value);
			// The same value as compact received JSON gets the same answer.
			const json = Buffer.from(JSON.stringify(vector.value));
			const byBytes =
				vector.action === "request"
					? checkOAuthRelayRequestBytes(route, json)
					: checkOAuthRelayResponseBytes(route, json);
			expect(byBytes, `${vector.id} as received JSON`).toBe(byValue);
			return byValue;
		}
		default:
			throw new Error(`unhandled OAuth relay action ${vector.action}`);
	}
}

describe("shared OAuth relay vectors", () => {
	it("hold the route catalogue and both case files", () => {
		expect(files.map(([name]) => name)).toEqual(["cases.json", "routes.json"]);
		for (const [, file] of files) expect(file.format).toBe("draftyak.vectors.oauth-relay.v1");
		const [, routes] = files.find(([name]) => name === "routes.json") ?? [];
		expect(OAUTH_RELAY_ROUTES).toEqual(routes?.routes);
		expect(OAUTH_RELAY_ROUTES.map((route) => route.id)).toEqual(["client", "authorize", "relay"]);
		expect(new Set(cases.map((vector) => vector.id)).size).toBe(cases.length);
	});

	it("admit a confirmed admin device and refuse one missing admin, on every route", () => {
		for (const route of OAUTH_RELAY_ROUTES) {
			const ids = cases.filter((vector) => vector.route === route.id).map((vector) => vector.id);
			expect(ids).toContain(`access-${route.id}-confirmed-admin`);
			expect(ids).toContain(`access-${route.id}-missing-admin`);
		}
	});

	it("pin UTF-8 byte caps even when the character count fits", () => {
		for (const route of OAUTH_RELAY_ROUTES.filter((entry) => entry.response === "GmailFlowView")) {
			for (const boundary of ["at", "over"]) {
				const vector = cases.find(
					(entry) => entry.id === `response-${route.id}-view-utf8-${boundary}-cap`,
				);
				if (vector === undefined) throw new Error("missing UTF-8 response vector");
				const text = canonicalize(vector.value);
				expect(text.length).toBeLessThanOrEqual(route.responseBytes);
				if (boundary === "at") expect(Buffer.byteLength(text)).toBe(route.responseBytes);
				else expect(Buffer.byteLength(text)).toBeGreaterThan(route.responseBytes);
			}
		}
	});

	for (const vector of cases) it(vector.id, () => expect(evaluate(vector)).toBe(vector.valid));
});
