import { expect, it } from "vitest";
import { buildDraftRequest } from "../src/prompt.ts";
import { parseMailInWorker } from "../src/worker.ts";
import { flatStyles, nestedRuleHtml, nestedStyles } from "./html-nested-rules-fixtures.ts";

const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const messageId = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const evidence = { provider: "gmail", ownerAddresses: ["owner@example.test"] } as const;

function mail(css: string): Buffer {
	return Buffer.from(
		[
			"From: sender@example.test",
			"To: owner@example.test",
			"Subject: Synthetic nested stylesheet",
			"MIME-Version: 1.0",
			'Content-Type: multipart/alternative; boundary="DYTEST-alternative"',
			"",
			"--DYTEST-alternative",
			"Content-Type: text/plain; charset=utf-8",
			"",
			"DYTEST-PLAINTEXT-CANARY https://plaintext.example/DYTEST-private",
			"--DYTEST-alternative",
			"Content-Type: text/html; charset=utf-8",
			"",
			nestedRuleHtml(css),
			"--DYTEST-alternative--",
			"",
		].join("\r\n"),
	);
}

async function thread(css: string) {
	const parsed = await parseMailInWorker(mail(css), evidence);
	const prepared = buildDraftRequest({
		model: "synthetic-model",
		conversationId,
		messages: [
			{
				id: messageId,
				conversationId,
				body: parsed.body,
				direction: parsed.direction,
				dmarc: parsed.auth.dmarc,
			},
		],
	});
	return { parsed, prompt: prepared.request.prompt };
}

it.each(nestedStyles)("withholds %s through the parsing worker and prompt", async (_label, css) => {
	const { parsed, prompt } = await thread(css);
	expect(parsed.bodyRefusal).toBe("STRUCTURE_LIMIT");
	expect(parsed.body.text).toBe("");
	expect(parsed.body.links).toEqual([]);
	expect(prompt).not.toMatch(
		/DYTEST-CANARY|hidden\.example|DYTEST-PLAINTEXT-CANARY|plaintext\.example/,
	);
});

it.each(flatStyles)("keeps the worker and prompt usable for %s", async (_label, css, hidden) => {
	const { parsed, prompt } = await thread(css);
	expect(parsed.bodyRefusal).toBeUndefined();
	expect(parsed.body.text).toBe(hidden ? "" : "DYTEST-CANARY [link 1: hidden.example]");
	expect(parsed.body.links).toEqual(hidden ? [] : [{ index: 1, host: "hidden.example" }]);
	expect(prompt.includes("DYTEST-CANARY")).toBe(!hidden);
	expect(prompt.includes("hidden.example")).toBe(!hidden);
	expect(prompt).not.toMatch(/DYTEST-PLAINTEXT-CANARY|plaintext\.example|DYTEST-private/);
});
