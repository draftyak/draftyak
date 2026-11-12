import { describe, expect, it } from "vitest";
import { cleanInWorker, parseMailInWorker } from "../src/worker.ts";

const raw = new TextEncoder().encode(
	"From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Synthetic\r\n\r\nVisible text.",
);
const evidence = { provider: "generic" as const, ownerAddresses: ["owner@example.test"] };

describe("bounded content workers", () => {
	it("parses mail and sanitizes HTML in isolated fresh worker heaps", async () => {
		const mail = await parseMailInWorker(raw, evidence);
		expect(mail.body.text).toBe("Visible text.");
		expect(mail.direction).toBe("inbound");
		const html = await cleanInWorker("html", "<p>visible</p><p hidden>HIDDEN_CANARY</p>");
		expect(html.text).toBe("visible");
		expect(JSON.stringify(html)).not.toContain("HIDDEN_CANARY");
	});
	it("honors cancellation before and during startup without leaking the reason", async () => {
		const before = AbortSignal.abort(new Error("PRIVATE_ABORT_REASON"));
		await expect(cleanInWorker("text", "input", {}, { signal: before })).rejects.toMatchObject({
			code: "ABORTED",
			message: "Content processing was cancelled.",
		});
		const during = new AbortController();
		const pending = cleanInWorker("text", "input", {}, { signal: during.signal });
		during.abort(new Error("PRIVATE_ABORT_REASON"));
		await expect(pending).rejects.toMatchObject({
			code: "ABORTED",
			message: "Content processing was cancelled.",
		});
		expect((await cleanInWorker("text", "next job")).text).toBe("next job");
	});
	it("caps concurrent jobs instead of allocating an unbounded queue", async () => {
		const a = cleanInWorker("text", "first");
		const b = cleanInWorker("text", "second");
		await expect(cleanInWorker("text", "third")).rejects.toMatchObject({ code: "BUSY" });
		expect((await Promise.all([a, b])).map(({ text }) => text)).toEqual(["first", "second"]);
	});
	it("copies a view's exact bytes and whitelists trusted context fields", async () => {
		const backing = new Uint8Array(raw.length + 1_000);
		backing.set(raw, 500);
		const result = await parseMailInWorker(backing.subarray(500, 500 + raw.length), {
			...evidence,
			extra: "PRIVATE_CANARY",
		} as typeof evidence);
		expect(result.body.text).toBe("Visible text.");
		expect(JSON.stringify(result)).not.toContain("PRIVATE_CANARY");
	});
	it("rejects invalid options and returns no parser exception or input text", async () => {
		await expect(cleanInWorker("text", "input", {}, { timeoutMs: 0 })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await expect(
			parseMailInWorker(new TextEncoder().encode("PRIVATE_MALFORMED_INPUT"), evidence),
		).rejects.toMatchObject({ code: "INVALID_INPUT", message: "Content is invalid." });
	});
});
