import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it, vi } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { exampleSummary } from "../scripts/vectors/scheduled-summary.ts";
import * as runtime from "../src/hub-runtime.ts";
import * as jcs from "../src/jcs.ts";

interface RuntimeCase extends Record<string, unknown> {
	id: string;
	action: string;
	valid: boolean;
}
const directory = path.resolve(import.meta.dirname, "../../../spec/vectors/hub-runtime");
const read = (name: string): Record<string, unknown> =>
	JSON.parse(readFileSync(path.join(directory, name), "utf8"));
const files = readdirSync(directory).filter((name) => name.endsWith(".json"));
const vectors = files.flatMap((name) => (read(name).cases ?? []) as RuntimeCase[]);

function received(vector: RuntimeCase): Uint8Array | undefined {
	if (typeof vector.receivedHex === "string") return Buffer.from(vector.receivedHex, "hex");
	if (typeof vector.padToBytes !== "number") return undefined;
	const json = Buffer.from(JSON.stringify(vector.value));
	return Buffer.concat([json, Buffer.alloc(vector.padToBytes - json.length, 32)]);
}
function evaluate(vector: RuntimeCase): boolean {
	const route = vector.route as string;
	switch (vector.action) {
		case "schema":
			return (
				vector.schema === "SchedulingStatus" &&
				runtime.SchedulingStatus.safeParse(vector.value).success
			);
		case "access":
			return runtime.hubRuntimeRouteAllows(route, vector.peer);
		case "cap":
			return runtime.checkHubRuntimeRouteLength(
				route,
				vector.direction as "request" | "response",
				vector.length as number,
			);
		case "request":
			return runtime.checkHubRuntimeRequestBytes(
				route,
				vector.present === false ? undefined : received(vector),
			);
		case "response": {
			const bytes = received(vector);
			return bytes === undefined
				? runtime.checkHubRuntimeResponse(route, vector.value)
				: runtime.checkHubRuntimeResponseBytes(route, bytes);
		}
		default:
			throw Error(`unhandled hub runtime action ${vector.action}`);
	}
}
const peer = {
	role: "device",
	known: true,
	revoked: false,
	epoch: 1,
	confirmedEpoch: 1,
	capabilities: ["read"],
	sidecarClaim: false,
	bootstrapDone: false,
};
const status = { mode: "sidecar", scheduler: "running", syncPaused: true };

describe("shared hub runtime vectors", () => {
	it("pins exactly the two read-only scheduling routes", () => {
		expect(files.toSorted()).toEqual(["routes.json", "status.json"]);
		expect(runtime.HUB_RUNTIME_ROUTES).toEqual(read("routes.json").routes);
		expect(runtime.HUB_RUNTIME_ROUTES.map((route) => [route.method, route.path])).toEqual([
			["GET", "/device/v1/scheduling"],
			["GET", "/device/v1/scheduling/outbox"],
		]);
		for (const route of runtime.HUB_RUNTIME_ROUTES)
			expect(route).toMatchObject({
				role: "device",
				capability: "read",
				confirmation: "confirmed",
				request: "none",
				requestBytes: 0,
			});
	});
	for (const vector of vectors) it(vector.id, () => expect(evaluate(vector)).toBe(vector.valid));
});

describe("the scheduling status", () => {
	it("needs a boolean syncPaused beside the mode and scheduler state", () => {
		expect(runtime.SchedulingStatus.parse(status)).toEqual(status);
		const { syncPaused: _, ...withoutPause } = status;
		expect(runtime.SchedulingStatus.safeParse(withoutPause).success).toBe(false);
		for (const syncPaused of ["true", 1, null, undefined])
			expect(runtime.SchedulingStatus.safeParse({ ...status, syncPaused }).success).toBe(false);
	});

	it("exports a JSON Schema that decides every status vector as zod does", () => {
		const validator = new Validator(
			jsonSchemaOf(runtime.SchedulingStatus) as Schema,
			"2020-12",
			false,
		);
		const cases = (read("status.json").cases as RuntimeCase[]).filter(
			(vector) => vector.action === "schema",
		);
		expect(cases.length).toBeGreaterThan(10);
		for (const vector of cases)
			expect(validator.validate(vector.value).valid, vector.id).toBe(vector.valid);
	});
});

describe("route admission and received bytes", () => {
	it("admits a known, current-epoch, confirmed device only while it holds read", () => {
		for (const route of runtime.HUB_RUNTIME_ROUTES) {
			expect(runtime.hubRuntimeRouteAllows(route.id, peer)).toBe(true);
			for (const patch of [
				{ capabilities: ["draft", "organize", "approve", "admin"] },
				{ confirmedEpoch: null },
				{ confirmedEpoch: 2 },
				{ revoked: true },
				{ known: false },
				{ role: "host:sms" },
			])
				expect(runtime.hubRuntimeRouteAllows(route.id, { ...peer, ...patch })).toBe(false);
		}
		expect(runtime.hubRuntimeRouteAllows("events", peer)).toBe(false);
		expect(runtime.hubRuntimeRouteAllows("scheduling", null)).toBe(false);
	});

	it("refuses every request body, an empty one included", () => {
		for (const route of runtime.HUB_RUNTIME_ROUTES) {
			expect(runtime.checkHubRuntimeRequestBytes(route.id, undefined)).toBe(true);
			expect(runtime.checkHubRuntimeRequestBytes(route.id, new Uint8Array(0))).toBe(false);
			expect(runtime.checkHubRuntimeRequestBytes(route.id, Buffer.from("{}"))).toBe(false);
		}
		expect(runtime.checkHubRuntimeRequestBytes("status", undefined)).toBe(false);
	});

	it("checks each received answer's cap before parsing it", () => {
		const parse = vi.spyOn(jcs, "parseStrict");
		try {
			for (const [route, value, cap] of [
				["scheduling", status, 4096],
				["scheduling-outbox", exampleSummary(), 8192],
			] as const) {
				const body = JSON.stringify(value);
				expect(
					runtime.checkHubRuntimeResponseBytes(route, Buffer.from(body.padEnd(cap, " "))),
				).toBe(true);
				expect(parse).toHaveBeenCalledOnce();
				parse.mockClear();
				expect(
					runtime.checkHubRuntimeResponseBytes(route, Buffer.from(body.padEnd(cap + 1, " "))),
				).toBe(false);
				expect(parse).not.toHaveBeenCalled();
			}
		} finally {
			parse.mockRestore();
		}
	});

	it("refuses a received answer that isn't strict JSON of the route's own answer type", () => {
		const body = JSON.stringify(status);
		expect(runtime.checkHubRuntimeResponseBytes("scheduling", Buffer.from(body))).toBe(true);
		expect(
			runtime.checkHubRuntimeResponseBytes(
				"scheduling",
				Buffer.from(body.replace("{", '{"mode":"service",')),
			),
		).toBe(false);
		expect(runtime.checkHubRuntimeResponseBytes("scheduling-outbox", Buffer.from(body))).toBe(
			false,
		);
		expect(runtime.checkHubRuntimeResponse("scheduling", status)).toBe(true);
		expect(runtime.checkHubRuntimeResponse("scheduling-outbox", status)).toBe(false);
	});
});
