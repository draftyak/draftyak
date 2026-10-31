import { expect, it } from "vitest";
import { buildDraftRequest } from "../src/prompt.ts";
import { parseMailInWorker } from "../src/worker.ts";
import { cases } from "./html-tree-construction-cases.ts";

const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const evidence = { provider: "gmail", ownerAddresses: ["owner@example.test"] } as const;
function mail(body: string): Buffer {
	return Buffer.from(
		[
			"From: sender@example.test",
			"To: owner@example.test",
			"Subject: Synthetic tree construction",
			"MIME-Version: 1.0",
			"Content-Type: text/html; charset=utf-8",
			"Content-Transfer-Encoding: 8bit",
			"",
			body,
		].join("\r\n"),
	);
}

it.each(cases)(
	"keeps the browser tree through the parsing thread: $label",
	async ({ body, hidden }) => {
		const parsed = await parseMailInWorker(mail(body), evidence);
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
		expect(parsed.bodyRefusal).toBeUndefined();
		expect(parsed.body.text).toBe(hidden ? "" : "CANARY [link 1: hidden.example]");
		expect(prepared.request.prompt.includes("CANARY")).toBe(!hidden);
		expect(prepared.request.prompt.includes("hidden.example")).toBe(!hidden);
	},
);

it.each([
	["nodes", "<!---->".repeat(19_998)],
	["depth", `${"<div>".repeat(126)}CANARY${"</div>".repeat(126)}`],
	[
		"attributes",
		`<body ${Array.from({ length: 128 }, (_, i) => `data-x${i}="x"`).join(" ")}>CANARY<body data-overflow="x">`,
	],
])("withholds over-budget %s through the parsing thread", async (_label, body) => {
	const parsed = await parseMailInWorker(mail(body), evidence);
	expect(parsed.bodyRefusal).toBe("STRUCTURE_LIMIT");
	expect(parsed.body.text).toBe("");
	expect(parsed.body.links).toEqual([]);
});
