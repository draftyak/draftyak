import { readFileSync } from "node:fs";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
	HOST_JSON_MEMBER_MAX_DECODED_BYTES,
	HOST_JSON_MEMBER_MAX_DEPTH,
	HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
	HOST_JSON_MEMBER_MAX_ERROR_BYTES,
	HOST_JSON_MEMBER_MAX_NODES,
	HOST_MAX_FRAME_BYTES,
	HostFetchParams,
	HostMessage,
	parseHostParams,
} from "../src/host-channel.ts";

const vectors = JSON.parse(
	readFileSync(
		new URL("../../../spec/vectors/host-channel/decoded-member.json", import.meta.url),
		"utf8",
	),
) as { requests: { id: string; params: unknown; valid: boolean }[] };
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

describe("decoded JSON-member host contract", () => {
	it.each(vectors.requests)(
		"$id agrees across runtime and generated schema",
		({ params, valid }) => {
			const message = { jsonrpc: "2.0", id: "test", method: "host/fetch", params };
			expect(HostFetchParams.safeParse(params).success).toBe(valid);
			expect(HostMessage.safeParse(message).success).toBe(valid);
			expect(validator.validate(message).valid).toBe(valid);
			expect(exported.validate(message).valid).toBe(valid);
		},
	);
	it("refuses every non-GET method, stream mode and option extension", () => {
		const params = {
			method: "GET",
			url: "https://example.invalid/",
			headers: [],
			saveAs: { kind: "base64url-json-member", member: "raw" },
		};
		for (const method of ["HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "CONNECT"])
			expect(() => parseHostParams("host/fetch", { ...params, method })).toThrow();
		for (const saveAs of [
			"json",
			{},
			{ ...params.saveAs, member: "Raw" },
			{ ...params.saveAs, encoding: "base64" },
		])
			expect(() => parseHostParams("host/fetch", { ...params, saveAs })).toThrow();
	});
	it("detaches options and leaves ordinary fetch and raw blob requests intact", () => {
		const params = {
			method: "GET",
			url: "https://example.invalid/",
			headers: [],
			saveAs: { kind: "base64url-json-member", member: "data" },
		};
		const parsed = parseHostParams("host/fetch", params);
		params.saveAs.member = "raw";
		expect(parsed.saveAs).toEqual({ kind: "base64url-json-member", member: "data" });
		for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
			expect(
				HostFetchParams.safeParse({ ...params, method, saveAs: "blob", stream: true }).success,
			).toBe(true);
	});
	it("pins independent native ceilings without increasing the host frame", () => {
		expect([
			HOST_JSON_MEMBER_MAX_ENTITY_BYTES,
			HOST_JSON_MEMBER_MAX_DECODED_BYTES,
			HOST_JSON_MEMBER_MAX_DEPTH,
			HOST_JSON_MEMBER_MAX_NODES,
			HOST_JSON_MEMBER_MAX_ERROR_BYTES,
			HOST_MAX_FRAME_BYTES,
		]).toEqual([50_331_648, 33_554_432, 64, 65_536, 65_536, 1_048_576]);
	});
});
