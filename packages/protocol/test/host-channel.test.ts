import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import {
	HostCancel,
	HostMessage,
	HostNotification,
	jsonCopy,
	parseHostParams,
	parseHostResult,
} from "../src/host-channel.ts";

describe("host channel contracts", () => {
	it("admits only an ID-bound child cancellation without making it a parent notification or RPC", () => {
		const validator = new Validator(
			z.toJSONSchema(HostMessage, { target: "draft-2020-12", io: "input" }) as Schema,
			"2020-12",
		);
		const valid = { jsonrpc: "2.0", method: "host/cancel", params: { requestId: "original-1" } };
		expect(HostCancel.parse(valid)).toEqual(valid);
		expect(validator.validate(valid).valid).toBe(true);
		expect(HostNotification.safeParse(valid).success).toBe(false);
		for (const invalid of [
			{ ...valid, id: "rpc" },
			{ ...valid, params: { requestId: "" } },
			{ ...valid, params: { requestId: "x\ny" } },
			{ ...valid, params: { requestId: "x".repeat(129) } },
			{ ...valid, params: { requestId: "original-1", reason: "detail" } },
			{ ...valid, params: { streamId: "stream" } },
		]) {
			expect(HostMessage.safeParse(invalid).success).toBe(false);
			expect(validator.validate(invalid).valid).toBe(false);
		}
	});
	it("exports the same typed host method restrictions without widening the ack-only surface", () => {
		const validator = new Validator(
			z.toJSONSchema(HostMessage, { target: "draft-2020-12", io: "input" }) as Schema,
			"2020-12",
		);
		for (const [method, params, valid] of [
			["host/ws.send", { socketId: "s", envelopeId: "e" }, true],
			["host/ws.send", { socketId: "s", data: "write" }, false],
			["host/fetch", { method: "GET", url: "secret://feed", headers: [] }, true],
			["host/fetch", { method: "CONNECT", url: "https://example.invalid/", headers: [] }, false],
			[
				"host/fetch",
				{ method: "GET", url: "https://example.invalid/", headers: [["accept", "ok\n"]] },
				false,
			],
			["host/nope", {}, false],
		] as const) {
			const message = { jsonrpc: "2.0", id: "test", method, params };
			expect(HostMessage.safeParse(message).success).toBe(valid);
			expect(validator.validate(message).valid).toBe(valid);
		}
	});
	it("refuses aggregate oversized headers, non-JSON tickets and bad response variants", () => {
		expect(() =>
			parseHostParams("host/fetch", {
				method: "GET",
				url: "https://example.invalid/",
				headers: Array.from({ length: 3 }, () => ["accept", "x".repeat(8000)]),
			}),
		).toThrow();
		expect(() =>
			parseHostParams("host/fetch", {
				method: "GET",
				url: "https://example.invalid/",
				headers: [],
				sendTicket: { hidden: undefined },
			}),
		).toThrow();
		expect(() =>
			parseHostResult("host/fetch", {
				status: 200,
				headers: [],
				body: { base64: "" },
				streamId: "s",
			}),
		).toThrow();
		expect(() => jsonCopy(new Date())).toThrow();
	});
});
