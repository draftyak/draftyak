import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import type * as z from "zod";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { community } from "../scripts/vectors/manifests/core.ts";
import { JsonTemplate } from "../src/json-template.ts";
import { PluginAuth } from "../src/manifest/auth.ts";
import {
	FIELD_NAME,
	ManifestHost,
	PathSegment,
	PathTemplate,
	RequestPathTemplate,
} from "../src/manifest/egress.ts";
import { manifestJson } from "../src/manifest/json.ts";
import { ManifestToolRule } from "../src/manifest/tool.ts";
import { PluginManifestV1, validateManifest } from "../src/manifest.ts";
import { SendUrl } from "../src/send-ticket.ts";
import { ENGINE_DEPENDENT, patternBody, patterns } from "./vectors.ts";

const validator = (schema: z.ZodType): Validator =>
	new Validator(jsonSchemaOf(schema) as Schema, "2020-12", false);
const manifestValidator = validator(PluginManifestV1);
function agree(value: unknown, accepted: boolean): void {
	expect(PluginManifestV1.safeParse(value).success).toBe(accepted);
	expect(validateManifest(value).ok).toBe(accepted);
	expect(manifestValidator.validate(value).valid).toBe(accepted);
}
function withText(field: "label" | "help" | "license", text: string): unknown {
	const value = structuredClone(community);
	if (field === "license") return { ...value, license: text };
	value.credentials.urlSecrets = [{ name: "secret", label: "Label", help: "Help", [field]: text }];
	return value;
}

describe("portable manifest declarations", () => {
	it("classifies byte inputs without walking an untrusted prototype chain", () => {
		let invoked = 0;
		const prototype = new Proxy(
			{},
			{
				getPrototypeOf() {
					invoked++;
					throw new Error("PRIVATE_PROTOTYPE_CANARY");
				},
			},
		);
		const input = Object.create(prototype, Object.getOwnPropertyDescriptors(community));
		expect(validateManifest(input)).toEqual({
			ok: false,
			problems: [{ code: "MANIFEST_INVALID" }],
		});
		expect(() => manifestJson(input)).toThrow(/^Manifest JSON refused$/);
		expect(invoked).toBe(0);
		const bytes = new TextEncoder().encode(JSON.stringify(community));
		Object.setPrototypeOf(bytes, prototype);
		expect(validateManifest(bytes).ok).toBe(true);
		expect(invoked).toBe(0);
	});
	it("uses portable pattern classes and preserves explicit full-string guards", () => {
		for (const pattern of patterns(jsonSchemaOf(PluginManifestV1))) {
			expect(pattern).not.toMatch(ENGINE_DEPENDENT);
			expect(pattern).not.toMatch(/\\[pP]\{/);
		}
		for (const schema of [FIELD_NAME, ManifestHost, PathTemplate, PathSegment, RequestPathTemplate])
			expect(jsonSchemaOf(schema)).toMatchObject({ not: { pattern: "\\n" } });
	});

	it("retains LF guards beside every exported template and request-path pattern", () => {
		const expected = new Set(
			[JsonTemplate, PathTemplate, RequestPathTemplate]
				.flatMap((schema) => patterns(jsonSchemaOf(schema)))
				.filter((pattern) => pattern.endsWith("$")),
		);
		const seen = new Set<string>();
		function walk(value: unknown): void {
			if (Array.isArray(value)) {
				for (const item of value) walk(item);
				return;
			}
			if (!value || typeof value !== "object") return;
			const node = value as Record<string, unknown>;
			if (typeof node.pattern === "string" && expected.has(patternBody(node.pattern))) {
				expect(node).toMatchObject({ not: { pattern: "\\n" } });
				seen.add(patternBody(node.pattern));
			}
			for (const child of Object.values(node)) walk(child);
		}
		walk(jsonSchemaOf(PluginManifestV1));
		expect(expected.size).toBeGreaterThan(0);
		expect([...seen].sort()).toEqual([...expected].sort());
	});

	it("shares canonical SendUrl segments for literal, wildcard and send-binding matches", () => {
		const document = validator(PathSegment);
		for (const value of [
			"!abc:example.org",
			"!abc%3Aexample.org",
			"a@b",
			"$room",
			".hidden",
			"%20",
			"%00",
			"%FF",
			"%3A".repeat(256),
		]) {
			expect(SendUrl.safeParse(`https://chat.example.com/${value}`).success).toBe(true);
			expect(PathSegment.safeParse(value).success).toBe(true);
			expect(document.validate(value).valid).toBe(true);
		}
		for (const value of [
			"",
			".",
			"..",
			"/",
			"a/b",
			"a\\b",
			"%2F",
			"%5C",
			"%2f",
			"%41",
			"%2E",
			"bad%",
			"a?b",
			"a#b",
		]) {
			expect(PathSegment.safeParse(value).success).toBe(false);
			expect(document.validate(value).valid).toBe(false);
		}
		for (const path of [
			"/room/!abc%3Aexample.org/messages",
			"/room/.hidden/messages",
			"/room/{chat.channelId}/messages",
		])
			expect(PathTemplate.safeParse(path).success).toBe(true);
		for (const path of ["/room/../messages", "/room/%2F/messages", "/room/%5C/messages"])
			for (const schema of [PathTemplate, RequestPathTemplate]) {
				expect(schema.safeParse(path).success).toBe(false);
				expect(validator(schema).validate(path).valid).toBe(false);
			}
	});

	it.each([
		["label", 128],
		["help", 1024],
		["license", 256],
	] as const)("counts the %s bound in Unicode code points", (field, max) => {
		agree(withText(field, "😀".repeat(max)), true);
		agree(withText(field, `${"😀".repeat(max)}x`), false);
		agree(withText(field, ""), false);
		for (const control of ["\u0000", "\t", "\n", "\r", "\u001f", "\u007f", "\u0085", "\u009f"])
			agree(withText(field, `Text${control}`), false);
		const malformed = withText(field, "\ud800");
		expect(PluginManifestV1.safeParse(malformed).success).toBe(false);
		expect(validateManifest(malformed).ok).toBe(false);
	});

	it("keeps end-anchored manifest names and classes closed to final LF", () => {
		for (const patch of [
			{ id: "example\n" },
			{ version: "1.2.3\n" },
			{ sdk: "1.0.0\n" },
			{ dataClasses: ["community.content\n"] },
			{
				credentials: {
					mode: "brokered",
					urlSecrets: [{ name: "secret\n", label: "Label", help: "Help" }],
				},
			},
		])
			agree({ ...community, ...patch }, false);
	});

	it("exports the same field-name restrictions used by the template grammar", () => {
		const document = validator(FIELD_NAME);
		for (const [value, accepted] of [
			["reply", true],
			["Reply_1", true],
			["reply\n", false],
			["constructor", false],
			["prototype", false],
		] as const) {
			expect(FIELD_NAME.safeParse(value).success).toBe(accepted);
			expect(document.validate(value).valid).toBe(accepted);
		}
	});

	it("exports full-consumption guards for scope and endpoint declarations", () => {
		const document = validator(PluginAuth);
		const valid = {
			kind: "oauth2-pkce-loopback",
			scopes: ["read"],
			requiredGrantedScopes: ["read"],
			endpoints: {
				authorization: "https://auth.example.com/",
				token: "https://auth.example.com/token",
			},
		};
		for (const [value, accepted] of [
			[valid, true],
			[{ ...valid, scopes: ["read\n"], requiredGrantedScopes: [] }, false],
			[
				{
					...valid,
					endpoints: { ...valid.endpoints, authorization: "https://auth.example.com/\n" },
				},
				false,
			],
		] as const) {
			expect(PluginAuth.safeParse(value).success).toBe(accepted);
			expect(document.validate(value).valid).toBe(accepted);
		}
	});

	it("keeps both tool egress alternatives and path templates closed to final LF", () => {
		const document = validator(ManifestToolRule);
		const common = { class: "read", method: "GET", maxBytes: 1024, timeoutMs: 1000 };
		for (const [destination, accepted] of [
			[{ host: "api.example.com" }, true],
			[{ url: "secret://calendarUrl" }, true],
			[{ host: "api.example.com\n" }, false],
			[{ url: "secret://calendarUrl\n" }, false],
		] as const) {
			const value = { ...common, ...destination };
			expect(ManifestToolRule.safeParse(value).success).toBe(accepted);
			expect(document.validate(value).valid).toBe(accepted);
		}
		const paths = validator(PathTemplate);
		for (const [value, accepted] of [
			["/v1/{chat.channelId}", true],
			["/v1/{chat.channelId}\n", false],
		] as const) {
			expect(PathTemplate.safeParse(value).success).toBe(accepted);
			expect(paths.validate(value).valid).toBe(accepted);
		}
	});
});
