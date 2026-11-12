import { readFileSync } from "node:fs";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
	HostFetchParams,
	HostMessage,
	LOOKUP_PERMIT_META_KEY,
	LookupPermit,
	parseHostParams,
} from "../src/host-channel.ts";

const permit = "A".repeat(43);
const base = { method: "GET", url: "https://example.invalid/", headers: [] };
const validator = new Validator(
	z.toJSONSchema(HostMessage, { target: "draft-2020-12", io: "input" }) as Schema,
	"2020-12",
);
const exported = new Validator(
	JSON.parse(
		readFileSync(
			new URL("../../../spec/schemas/host-channel-v1.schema.json", import.meta.url),
			"utf8",
		),
	) as Schema,
	"2020-12",
);
const vectors = JSON.parse(
	readFileSync(
		new URL("../../../spec/vectors/host-channel/lookup-permit.json", import.meta.url),
		"utf8",
	),
) as {
	scalars: { id: string; value: unknown; valid: boolean }[];
	requests: { id: string; params: unknown; valid: boolean }[];
};

describe("lookup membership host contract", () => {
	it("pins the reserved metadata key independently of the producer", () => {
		expect(LOOKUP_PERMIT_META_KEY).toBe("io.github.draftyak/lookup-permit");
	});
	it.each(vectors.scalars)("$id has the exact scalar form", ({ value, valid }) => {
		expect(LookupPermit.safeParse(value).success).toBe(valid);
	});
	it.each(vectors.requests)(
		"$id agrees across runtime and both structural schemas",
		({ params, valid }) => {
			const message = { jsonrpc: "2.0", id: "request", method: "host/fetch", params };
			expect(HostFetchParams.safeParse(params).success).toBe(valid);
			expect(HostMessage.safeParse(message).success).toBe(valid);
			expect(validator.validate(message).valid).toBe(valid);
			expect(exported.validate(message).valid).toBe(valid);
		},
	);
	it("accepts exactly zero unused bits for all 64 possible terminal symbols", () => {
		const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
		for (let index = 0; index < alphabet.length; index++) {
			const value = "_".repeat(42) + alphabet[index];
			const valid = index % 4 === 0;
			expect(LookupPermit.safeParse(value).success, value).toBe(valid);
			const params = { ...base, lookupPermit: value };
			const message = { jsonrpc: "2.0", id: "request", method: "host/fetch", params };
			expect(HostFetchParams.safeParse(params).success, value).toBe(valid);
			expect(HostMessage.safeParse(message).success, value).toBe(valid);
			expect(validator.validate(message).valid, value).toBe(valid);
			expect(exported.validate(message).valid, value).toBe(valid);
			if (valid) {
				expect(Buffer.from(value, "base64url")).toHaveLength(32);
				expect(Buffer.from(value, "base64url").toString("base64url")).toBe(value);
			}
		}
	});
	it("does not coerce boxed strings or arbitrary objects", () => {
		for (const value of [new String(permit), { toString: () => permit }, [permit]]) {
			expect(LookupPermit.safeParse(value).success).toBe(false);
		}
	});
	it("preserves the parsed permit with detached fetch fields", () => {
		const headerRow: [string, string] = ["accept", "text/plain"];
		const input = { ...base, headers: [headerRow], lookupPermit: permit };
		const parsed = parseHostParams("host/fetch", input);
		input.lookupPermit = "_".repeat(42) + "8";
		headerRow[1] = "changed";
		expect(parsed.lookupPermit).toBe(permit);
		expect(parsed.headers).toEqual([["accept", "text/plain"]]);
	});
	it("keeps the four-member request envelope and other host methods strict", () => {
		const message = { jsonrpc: "2.0", id: "request", method: "host/fetch", params: base };
		for (const candidate of [
			{ ...message, lookupPermit: permit },
			{ ...message, _meta: { [LOOKUP_PERMIT_META_KEY]: permit } },
			{ ...message, method: "host/ws.open", params: { url: base.url, lookupPermit: permit } },
			{ ...message, method: "host/kv.get", params: { key: "test", lookupPermit: permit } },
			{
				...message,
				method: "host/log",
				params: { level: "info", message: "test", lookupPermit: permit },
			},
		]) {
			expect(HostMessage.safeParse(candidate).success).toBe(false);
			expect(validator.validate(candidate).valid).toBe(false);
			expect(exported.validate(candidate).valid).toBe(false);
		}
	});

	it.each([
		["host/ws.open", { url: "wss://example.invalid/" }],
		["host/ws.send", { socketId: "socket", envelopeId: "envelope" }],
		["host/ws.close", { socketId: "socket" }],
		["host/kv.get", { key: "test" }],
		["host/kv.set", { key: "test", value: null }],
		["host/kv.delete", { key: "test" }],
		["host/changed", { cursor: "cursor" }],
		["host/log", { level: "info", message: "test" }],
		["host/progress", { token: 0, progress: 0 }],
	] as const)("keeps %s valid without a fetch permit field", (method, params) => {
		const message = { jsonrpc: "2.0", id: "request", method, params };
		expect(HostMessage.safeParse(message).success).toBe(true);
		expect(validator.validate(message).valid).toBe(true);
		expect(exported.validate(message).valid).toBe(true);
		const withPermit = { ...message, params: { ...params, lookupPermit: permit } };
		expect(HostMessage.safeParse(withPermit).success).toBe(false);
		expect(validator.validate(withPermit).valid).toBe(false);
		expect(exported.validate(withPermit).valid).toBe(false);
	});
});
