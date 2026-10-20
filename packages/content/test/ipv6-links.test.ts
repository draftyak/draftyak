import { describe, expect, it } from "vitest";
import { cleanText, hygienePrefix } from "../src/hygiene.ts";
import { buildDraftRequest } from "../src/prompt.ts";

describe("IPv6 authority punctuation", () => {
	it.each([
		["http://[::1]", "[::1]", ""],
		["https://[2001:db8::1]", "[2001:db8::1]", ""],
		["https://[2001:0db8::0001].", "[2001:db8::1]", "."],
		["http://[::1]),", "[::1]", "),"],
		["http://[::1]]", "[::1]", "]"],
		["http://[::1]/", "[::1]", ""],
		["http://[::1]:8080/private?q=secret].", "[::1]", "]."],
		["https://example.test/private].", "example.test", "]."],
	])("preserves the hostname and ordinary trailing punctuation in %s", (uri, host, tail) => {
		const result = cleanText(`Before ${uri} After`);
		expect(result.text).toBe(`Before [link 1: ${host}]${tail} After`);
		expect(result.links).toEqual([{ index: 1, host }]);
		expect(result.removals.uris).toBe(0);
		expect(JSON.stringify(result)).not.toMatch(/private|secret|https?:\/\//);
	});
	it("keeps the complete IPv6 annotation, reference table and prompt consistent", () => {
		const body = cleanText("Before http://[::1]");
		expect(hygienePrefix(body.text, body.text.length - 1, body.links)).toBe("Before ");
		expect(cleanText("Before http://[::1]", { maxChars: body.text.length - 1 })).toMatchObject({
			text: "Before",
			links: [],
		});
		const conversationId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		const prompt = buildDraftRequest({
			model: "synthetic-model",
			conversationId,
			messages: [
				{
					id: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
					conversationId,
					body,
					direction: "inbound",
					dmarc: "none",
				},
			],
		});
		expect(prompt.request.prompt).toContain("Before [link 1: [::1]]");
		expect(prompt.includedMessages).toBe(1);
	});
});
