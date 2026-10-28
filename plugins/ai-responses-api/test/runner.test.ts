import { PluginErrorCode } from "@draftyak/protocol/errors";
import { afterEach, describe, expect, it, vi } from "vitest";
import { API_URL, generateDraft, ResponsesError } from "../src/index.ts";
import { CANARY, input, message } from "./helpers.ts";

afterEach(() => vi.restoreAllMocks());

async function transportError(value: unknown): Promise<ResponsesError> {
	const error: unknown = await generateDraft(input, {}, async () => {
		throw value;
	}).catch((failure: unknown) => failure);
	expect(error).toBeInstanceOf(ResponsesError);
	const normalized = error as ResponsesError;
	expect(PluginErrorCode.safeParse(normalized.code).success).toBe(true);
	expect(normalized.message).toBe(`responses: ${normalized.code}`);
	expect(String(normalized)).not.toContain(CANARY);
	expect(JSON.stringify(normalized)).not.toContain(CANARY);
	expect(normalized).not.toHaveProperty("cause");
	expect(normalized).not.toHaveProperty("detail");
	return normalized;
}

describe("injected completed-response transport", () => {
	it("calls the injected transport once with the literal request shape and parses its completed response", async () => {
		const controller = new AbortController();
		const transport = vi.fn(async (request, options) => {
			expect(request).toEqual({
				method: "POST",
				url: API_URL,
				headers: { "content-type": "application/json", authorization: "Bearer brokered" },
				body: {
					model: input.model,
					instructions: input.system,
					input: [{ role: "user", content: input.prompt }],
					store: false,
					stream: true,
					text: {
						format: {
							type: "json_schema",
							name: "draft_output",
							strict: true,
							schema: expect.any(Object),
						},
					},
				},
			});
			expect(options.signal).toBe(controller.signal);
			return message();
		});
		expect((await generateDraft(input, {}, transport, controller.signal)).kind).toBe("draft");
		expect(transport).toHaveBeenCalledTimes(1);
	});
	it("performs no call after cancellation and exposes no transport error details", async () => {
		const transport = vi.fn(async () => {
			throw new Error(CANARY);
		});
		await expect(generateDraft(input, {}, transport)).rejects.toMatchObject({
			code: "TRANSIENT",
			message: "responses: TRANSIENT",
		});
		expect(transport).toHaveBeenCalledTimes(1);
		transport.mockClear();
		await expect(generateDraft(input, {}, transport, AbortSignal.abort())).rejects.toMatchObject({
			code: "ABORTED",
		});
		expect(transport).not.toHaveBeenCalled();
	});
	it("does not accept a response after mid-call cancellation", async () => {
		const controller = new AbortController();
		await expect(
			generateDraft(
				input,
				{},
				async () => {
					controller.abort(CANARY);
					return message();
				},
				controller.signal,
			),
		).rejects.toMatchObject({ code: "ABORTED" });
	});
	it.each([
		[{ status: 401, message: CANARY }, "AUTH_REVOKED"],
		[{ status: 403, detail: CANARY }, "PERMISSION_DENIED"],
		[{ status: 429, headers: { "retry-after": "2" } }, "RATE_LIMITED"],
		[{ status: 429, code: "insufficient_quota" }, "QUOTA_EXCEEDED"],
		[{ status: 503, cause: CANARY }, "TRANSIENT"],
		[{ name: "APIConnectionTimeoutError", message: CANARY }, "TRANSIENT"],
		[{ code: "ECONNRESET", message: CANARY }, "TRANSIENT"],
		[{ name: "AbortError", message: CANARY }, "TRANSIENT"],
		[{ code: "ABORTED", message: CANARY }, "TRANSIENT"],
		[{ error: { code: "rate_limit_exceeded", message: CANARY } }, "RATE_LIMITED"],
		[{ error: { code: "insufficient_quota", message: CANARY } }, "QUOTA_EXCEEDED"],
	])("normalizes transport failure %j to %s", async (value, code) => {
		expect((await transportError(value)).code).toBe(code);
	});
	it.each(PluginErrorCode.options)(
		"preserves canonical %s without provider details",
		async (code) => {
			const value = {
				code,
				status: 503,
				retryAfterMs: 17,
				message: CANARY,
				detail: CANARY,
				cause: new Error(CANARY),
			};
			const result = await transportError(value);
			expect(result).toMatchObject({ code, retryAfterMs: 17 });
			expect(result).not.toBe(value);
		},
	);
	it("preserves the SDK result envelope without exposing its detail or identity", async () => {
		const value = {
			result: { code: "RATE_LIMITED", retryAfterMs: 17, detail: CANARY },
			message: CANARY,
		};
		const result = await transportError(value);
		expect(result).toMatchObject({ code: "RATE_LIMITED", retryAfterMs: 17 });
		expect(result).not.toBe(value);
		expect(result).not.toHaveProperty("result");
	});
	it.each([0, Number.MAX_SAFE_INTEGER])(
		"preserves the safe direct retry boundary %s",
		async (retryAfterMs) => {
			const value = { code: "RATE_LIMITED", retryAfterMs };
			Object.defineProperty(value, "headers", {
				get: () => {
					throw new Error(CANARY);
				},
			});
			expect(await transportError(value)).toMatchObject({ code: "RATE_LIMITED", retryAfterMs });
		},
	);
	it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1, "2"])(
		"omits malformed retry hint %s without losing its valid code",
		async (retryAfterMs) => {
			const error = await transportError({ code: "QUOTA_EXCEEDED", retryAfterMs });
			expect(error.code).toBe("QUOTA_EXCEEDED");
			expect(error).not.toHaveProperty("retryAfterMs");
		},
	);
	it("parses integer and canonical HTTP-date retry metadata against a reference clock", async () => {
		const now = Date.UTC(2026, 0, 1);
		vi.spyOn(Date, "now").mockReturnValue(now);
		for (const [hint, retryAfterMs] of [
			["0", 0],
			[" \t2\t ", 2000],
			[new Date(now + 10_000).toUTCString(), 10_000],
			[new Date(now - 10_000).toUTCString(), 0],
		] as const) {
			for (const headers of [
				{ "retry-after": hint },
				{ "rEtRy-AfTeR": hint },
				new Headers({ "Retry-After": hint }),
			])
				expect(await transportError({ status: 429, headers })).toMatchObject({
					code: "RATE_LIMITED",
					retryAfterMs,
				});
		}
	});
	it("bounds plain header lookup and omits ambiguous case aliases", async () => {
		const headers = Object.fromEntries(
			Array.from({ length: 63 }, (_, index) => [`x-example-${index}`, "unused"]),
		);
		headers["RETRY-AFTER"] = "2";
		expect(await transportError({ status: 429, headers })).toMatchObject({ retryAfterMs: 2000 });
		for (const invalid of [
			{ ...headers, extra: "unused" },
			{ "retry-after": "1", "Retry-After": "2" },
		])
			expect(await transportError({ status: 429, headers: invalid })).not.toHaveProperty(
				"retryAfterMs",
			);
	});
	it.each([
		"1.5",
		"1e3",
		"+2",
		"-1",
		"Infinity",
		"9007199254740991",
		"2026-01-01",
		"Fri, 01 Jan 2026 00:00:10 GMT",
		"Thu, 32 Jan 2026 00:00:10 GMT",
		"Thu, 01 Jan 2026 00:00:10 GMT\r\n",
	])("omits unsupported Retry-After %s", async (hint) => {
		vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
		const error = await transportError({ status: 429, headers: { "retry-after": hint } });
		expect(error.code).toBe("RATE_LIMITED");
		expect(error).not.toHaveProperty("retryAfterMs");
	});
	it("keeps actual signal cancellation local even when transport throws a coded error", async () => {
		const controller = new AbortController();
		await expect(
			generateDraft(
				input,
				{},
				async () => {
					controller.abort(CANARY);
					throw { code: "RATE_LIMITED", detail: CANARY };
				},
				controller.signal,
			),
		).rejects.toMatchObject({ code: "ABORTED", message: "responses: ABORTED" });
	});
});
