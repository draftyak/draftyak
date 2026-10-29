import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ApiCase } from "../scripts/vectors/device-api/cases.ts";
import {
	checkApiError,
	checkApiErrorBytes,
	checkChallenge,
	checkEventStream,
	checkFrameLength,
	checkRouteLength,
	checkRouteRequest,
	checkRouteRequestBytes,
	checkRouteResponse,
	checkRouteResponseBytes,
	checkStatementLength,
	DEVICE_API_CAPABILITIES,
	DEVICE_API_ERRORS,
	DEVICE_API_ROUTES,
	DEVICE_API_SCHEMAS,
	requiredCapability,
	routeAllows,
} from "../src/device-api.ts";
import { CONFIRMATION_PRESETS } from "../src/entities/device.ts";

const directory = path.resolve(import.meta.dirname, "../../../spec/vectors/device-api");
const read = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(path.join(directory, name), "utf8"));
const vectors = readdirSync(directory)
	.filter((name) => name.endsWith(".json"))
	.flatMap((name) => (read(name).cases ?? []) as ApiCase[]);
function evaluate(vector: ApiCase): boolean {
	const route = vector.route as string;
	const value = vector.present === false ? undefined : vector.value;
	switch (vector.action) {
		case "schema":
			return (
				(DEVICE_API_SCHEMAS as Record<string, { safeParse(value: unknown): { success: boolean } }>)[
					vector.schema as string
				]?.safeParse(value).success ?? false
			);
		case "request":
		case "response": {
			if (typeof vector.padToBytes === "number" || typeof vector.receivedHex === "string") {
				const json =
					typeof vector.receivedHex === "string"
						? Buffer.alloc(0)
						: Buffer.from(JSON.stringify(value));
				const bytes =
					typeof vector.receivedHex === "string"
						? Buffer.from(vector.receivedHex, "hex")
						: Buffer.concat([json, Buffer.alloc((vector.padToBytes as number) - json.length, 32)]);
				return vector.action === "request"
					? checkRouteRequestBytes(route, bytes)
					: checkRouteResponseBytes(route, bytes);
			}
			return vector.action === "request"
				? checkRouteRequest(route, value)
				: checkRouteResponse(route, value);
		}
		case "challenge":
			return checkChallenge(
				vector.challenge,
				vector.review,
				vector.request,
				vector.context as { hub: string; device: string },
			);
		case "stream":
			return checkEventStream(vector.frames as unknown[]);
		case "length":
			return checkStatementLength(new Uint8Array(vector.length as number));
		case "cap":
			return checkRouteLength(
				route,
				vector.direction as "request" | "response",
				vector.length as number,
			);
		case "frame-cap":
			return checkFrameLength(vector.length as number);
		case "access":
			return routeAllows(
				route,
				vector.peer,
				vector.operation as { kind?: string; preset?: string } | undefined,
			);
		case "error": {
			if (typeof vector.padToBytes === "number" || typeof vector.receivedHex === "string") {
				const json =
					typeof vector.receivedHex === "string"
						? Buffer.alloc(0)
						: Buffer.from(JSON.stringify(value));
				return checkApiErrorBytes(
					typeof vector.receivedHex === "string"
						? Buffer.from(vector.receivedHex, "hex")
						: Buffer.concat([json, Buffer.alloc((vector.padToBytes as number) - json.length, 32)]),
					vector.status as number,
				);
			}
			return checkApiError(value, vector.status as number);
		}
		default:
			throw Error(`unhandled device API action ${vector.action}`);
	}
}
describe("shared device API vectors", () => {
	it("matches the complete independent catalogue", () => {
		const vector = read("catalogue.json");
		expect(DEVICE_API_ROUTES).toEqual(vector.routes);
		expect(DEVICE_API_ERRORS).toEqual(vector.errors);
		expect(DEVICE_API_CAPABILITIES).toEqual(vector.capabilities);
		for (const [kind, capability] of Object.entries(vector.capabilities as Record<string, string>))
			expect(requiredCapability(kind), kind).toBe(capability);
		expect(requiredCapability("unknown.v1")).toBeUndefined();
		expect(CONFIRMATION_PRESETS).toEqual(vector.presets);
	});
	for (const vector of vectors) it(vector.id, () => expect(evaluate(vector)).toBe(vector.valid));
});
