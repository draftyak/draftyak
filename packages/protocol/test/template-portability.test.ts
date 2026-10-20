import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { community } from "../scripts/vectors/manifests/core.ts";
import { manifestDigest, sendTemplateDigest, toolKindsDigest } from "../src/digests.ts";
import { Constants, JsonTemplate, validateTemplate } from "../src/json-template.ts";
import { patterns } from "./vectors.ts";

describe("portable template declarations", () => {
	it("counts constant string limits in code points while preserving exact declared bytes", () => {
		const json = new Validator(jsonSchemaOf(Constants) as Schema, "2020-12", false);
		for (const [count, expected] of [
			[4096, true],
			[4097, false],
		] as const) {
			const constants = { msgtype: "🦬".repeat(count) };
			expect(Constants.safeParse(constants).success).toBe(expected);
			expect(json.validate(constants).valid).toBe(expected);
			expect(validateTemplate(community.send.template, community.egress.rules, constants)).toEqual(
				expected ? [] : [{ code: "TEMPLATE_INVALID" }],
			);
		}
		expect(Constants.safeParse({ msgtype: "\ud800" }).success).toBe(false);
		const send = { ...community.send, constants: { msgtype: "é\r\n" } };
		expect(sendTemplateDigest(send)).not.toBe(
			sendTemplateDigest({ ...send, constants: { msgtype: "e\u0301\r\n" } }),
		);
		expect(sendTemplateDigest(send)).not.toBe(
			sendTemplateDigest({ ...send, constants: { msgtype: "é\n" } }),
		);
	});

	it("exports LF guards for every template pattern without engine-specific lookaround", () => {
		const json = jsonSchemaOf(JsonTemplate) as Schema;
		for (const pattern of patterns(json)) {
			expect(pattern).not.toMatch(/\(\?[=!]|\\[pP]\{/);
		}
		const validator = new Validator(json, "2020-12", false);
		for (const ending of ["\n", "\r", "\r\n", "\u2028", "\u2029"]) {
			for (const value of [
				{ ...community.send.template, path: [`v1${ending}`] },
				{
					...community.send.template,
					headers: { "content-type": "application/json", [`accept${ending}`]: "value" },
				},
				{
					...community.send.template,
					headers: { "content-type": "application/json", accept: `value${ending}` },
				},
			]) {
				expect(JsonTemplate.safeParse(value).success).toBe(false);
				expect(validator.validate(value).valid).toBe(false);
			}
		}
	});

	it("keeps declared template containers named bind or const distinct from leaves", () => {
		const body = {
			bind: { const: "msgtype" },
			const: [{ bind: "body.text" }, { bind: "body.footer" }],
		};
		expect(
			validateTemplate({ ...community.send.template, body }, community.egress.rules, {
				msgtype: "m.text",
			}),
		).toEqual([]);
		expect(
			validateTemplate({ ...community.send.template, body }, community.egress.rules, {}),
		).toEqual([{ code: "TEMPLATE_CONSTANT_UNDECLARED" }]);
	});

	it("pins exact array order and refuses hidden values without invoking getters", () => {
		expect(toolKindsDigest(["contact.notes", "kb.lookup"])).not.toBe(
			toolKindsDigest(["kb.lookup", "contact.notes"]),
		);
		let calls = 0;
		const raw = Object.defineProperty({ ...community }, "private-canary", {
			enumerable: true,
			get() {
				calls++;
				return "private-value-canary";
			},
		});
		expect(() => manifestDigest(raw)).toThrow(/^Manifest JSON refused$/);
		expect(calls).toBe(0);
	});
});
