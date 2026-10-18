import { describe, expect, it, vi } from "vitest";
import { generateDraft, verifyRequest } from "../src/index.ts";
import { CANARY, input, message } from "./helpers.ts";

describe("injected completed-response transport", () => {
	it("calls the injected transport once with a verifiable request and parses its completed response", async () => {
		const controller = new AbortController();
		const transport = vi.fn(async (request, options) => {
			expect(verifyRequest(request, { model: input.model }).ok).toBe(true);
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
			code: "TRANSPORT_FAILED",
			message: "responses: TRANSPORT_FAILED",
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
});
