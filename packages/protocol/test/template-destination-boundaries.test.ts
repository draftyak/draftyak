import { describe, expect, it } from "vitest";
import { type JsonTemplate, validateTemplate } from "../src/json-template.ts";
import type { EgressRule } from "../src/manifest/egress.ts";
import { validateManifest } from "../src/manifest.ts";

function declaration() {
	const rule: EgressRule = {
		class: "send",
		method: "POST",
		host: "chat.example.invalid",
		pathTemplate: "/v1/outbox/{outbox.id}/messages",
		query: { channel: "chat.channelId" },
		maxBytes: 4096,
		timeoutMs: 1000,
	};
	const template: JsonTemplate = {
		rule: 0,
		path: ["v1", "outbox", { bind: "outbox.id" }, "messages"],
		query: { channel: { bind: "chat.channelId" } },
		headers: { "content-type": "application/json" },
		body: { text: { bind: "body.textWithFooter" } },
	};
	return { rule, template };
}

function manifest(template: JsonTemplate, rule: EgressRule) {
	return {
		id: "@example/destination-boundary",
		version: "1.0.0",
		sdk: "1.0.0",
		runtime: "node",
		isolation: "standard",
		kind: "channel",
		contract: { extension: "io.github.draftyak/channel", version: 1 },
		auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
		credentials: { mode: "brokered", urlSecrets: [] },
		permissions: {},
		dataClasses: ["community.content"],
		license: "Apache-2.0",
		egress: { rules: [rule] },
		send: { render: "json-template", constants: {}, template },
	};
}

describe("template path and destination correspondence", () => {
	it("accepts the exact declared path and distinct outbox/channel bindings", () => {
		const { rule, template } = declaration();
		expect(validateTemplate(template, [rule], {})).toEqual([]);
		expect(validateManifest(manifest(template, rule)).ok).toBe(true);
	});
	it.each([1, 2])("refuses %i extra path segments without ignoring their suffix", (count) => {
		const { rule, template } = declaration();
		const changed = {
			...template,
			path: [...template.path, ...Array<string>(count).fill("extra")],
		};
		expect(validateTemplate(changed, [rule], {})).toEqual([{ code: "TEMPLATE_RULE_MISMATCH" }]);
		expect(validateManifest(manifest(changed, rule))).toEqual({
			ok: false,
			problems: [{ code: "TEMPLATE_RULE_MISMATCH" }],
		});
	});
	it("refuses a path shorter than its declared rule", () => {
		const { rule, template } = declaration();
		expect(validateTemplate({ ...template, path: template.path.slice(0, -1) }, [rule], {})).toEqual(
			[{ code: "TEMPLATE_RULE_MISMATCH" }],
		);
	});
	it("refuses a valid destination name substituted for the declared outbox binding", () => {
		const { rule, template } = declaration();
		const changed: JsonTemplate = {
			...template,
			path: ["v1", "outbox", { bind: "chat.channelId" }, "messages"],
		};
		expect(validateTemplate(changed, [rule], {})).toEqual([{ code: "TEMPLATE_BINDING_INVALID" }]);
		expect(validateManifest(manifest(changed, rule))).toEqual({
			ok: false,
			problems: [{ code: "TEMPLATE_BINDING_INVALID" }],
		});
	});
	it("accepts the same channel binding when both rule and template actually declare it", () => {
		const { rule, template } = declaration();
		const changedRule = { ...rule, pathTemplate: "/v1/channels/{chat.channelId}/messages" };
		const changed: JsonTemplate = {
			...template,
			path: ["v1", "channels", { bind: "chat.channelId" }, "messages"],
		};
		expect(validateTemplate(changed, [changedRule], {})).toEqual([]);
	});
});
