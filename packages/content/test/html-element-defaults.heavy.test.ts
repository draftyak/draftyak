import { expect, it } from "vitest";
import { buildDraftRequest } from "../src/prompt.ts";
import { parseMailInWorker } from "../src/worker.ts";
import { elementCases, visibleTail } from "./fixtures/html-element-cases.ts";

it.each(elementCases)(
	"preserves $label at the mail-to-prompt boundary",
	async ({ source, hidden }) => {
		const raw = Buffer.from(
			[
				"From: sender@example.test",
				"To: owner@example.test",
				"Subject: Synthetic element defaults",
				"MIME-Version: 1.0",
				"Content-Type: text/html; charset=utf-8",
				"Content-Transfer-Encoding: 8bit",
				"",
				source + visibleTail,
			].join("\r\n"),
		);
		const parsed = await parseMailInWorker(raw, {
			provider: "gmail",
			ownerAddresses: ["owner@example.test"],
		});
		expect(parsed.bodyRefusal).toBeUndefined();
		expect(parsed.body.text.includes("DYTEST-CANARY")).toBe(!hidden);
		expect(parsed.body.text).toContain("Visible");
		const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		const prepared = buildDraftRequest({
			model: "synthetic-model",
			conversationId,
			messages: [
				{
					id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
					conversationId,
					body: parsed.body,
					direction: parsed.direction,
					dmarc: parsed.auth.dmarc,
				},
			],
		});
		expect(prepared.request.prompt.includes("DYTEST-CANARY")).toBe(!hidden);
		expect(prepared.request.prompt).not.toMatch(/DYTEST-private|https?:|DYTEST-REMOVED/);
		if (hidden) {
			expect(parsed.body.links).toEqual([]);
			expect(prepared.request.prompt).not.toContain("hidden.example");
		} else if (source.includes("href=")) {
			expect(parsed.body.links).toEqual([{ index: 1, host: "hidden.example" }]);
			expect(prepared.request.prompt).toContain("hidden.example");
		}
	},
);
