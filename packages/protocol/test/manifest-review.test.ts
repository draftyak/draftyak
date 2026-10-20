import { type Schema, Validator } from "@cfworker/json-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { community, manifestCases } from "../scripts/vectors/manifests/core.ts";
import { aiProviderV1 } from "../src/ai-provider-v1.ts";
import { channelV1 } from "../src/channel-v1.ts";
import {
	manifestDigest,
	sendTemplateDigest,
	surfaceDigest,
	toolKindsDigest,
} from "../src/digests.ts";
import type { ExtensionContract } from "../src/extension.ts";
import { jcsSha256 } from "../src/hash.ts";
import { canonicalize } from "../src/jcs.ts";
import { Constants, JsonTemplate, validateTemplate } from "../src/json-template.ts";
import { AI_HTTP_PROFILES } from "../src/manifest/ai-http.ts";
import { AUTH_VARIANTS } from "../src/manifest/auth.ts";
import { authFields, authScopesValid } from "../src/manifest/auth-fields.ts";
import { crossClassOverlap, type EgressRule } from "../src/manifest/egress.ts";
import { SURFACE_MAX_BYTES } from "../src/manifest/json.ts";
import { PluginManifestV1, type SendDeclaration, validateManifest } from "../src/manifest.ts";
import {
	DISPLAY_NAME_BLANK_RANGES,
	DISPLAY_NAME_HIDDEN_RANGES,
	DISPLAY_NAME_JOINER_RANGES,
	DisplayName,
} from "../src/pairing.ts";
import { canonicalToolsList } from "../src/tool-v1/kinds.ts";

describe("manifest declarations and template boundaries", () => {
	it("allows constants only for json-template, in the public type and exported schema", () => {
		const validator = new Validator(jsonSchemaOf(PluginManifestV1) as Schema, "2020-12", false);
		const native: SendDeclaration = { render: "gmail-rfc5322" };
		// @ts-expect-error Native renderers do not declare plugin-supplied constants.
		const forbidden: SendDeclaration = { render: "gmail-rfc5322", constants: {} };
		void forbidden;
		expect(native).toEqual({ render: "gmail-rfc5322" });
		for (const [render, profile, dataClass] of [
			["gmail-rfc5322", "gmail-v1", "gmail.content"],
			["slack-postmessage", "slack-v1", "slack.content"],
		] as const) {
			const manifest = {
				...community,
				egress: { profile },
				dataClasses: [dataClass],
				send: { render },
			};
			expect(validateManifest(manifest).ok).toBe(true);
			expect(validator.validate(manifest).valid).toBe(true);
			for (const constants of [{}, { footer: "Set by plugin" }]) {
				const changed = { ...manifest, send: { render, constants } };
				expect(validateManifest(changed)).toEqual({
					ok: false,
					problems: [{ code: "MANIFEST_INVALID" }],
				});
				expect(validator.validate(changed).valid).toBe(false);
			}
		}
		expect(validateManifest(community).ok).toBe(true);
		expect(validator.validate(community).valid).toBe(true);
		const { constants: _constants, ...withoutConstants } = community.send;
		const missing = { ...community, send: withoutConstants };
		expect(validateManifest(missing).ok).toBe(false);
		expect(validator.validate(missing).valid).toBe(false);
	});
	it("shares deeply frozen display ranges without changing DisplayName through public data", () => {
		for (const ranges of [
			DISPLAY_NAME_HIDDEN_RANGES,
			DISPLAY_NAME_BLANK_RANGES,
			DISPLAY_NAME_JOINER_RANGES,
		]) {
			expect(Object.isFrozen(ranges)).toBe(true);
			expect(Reflect.set(ranges, "0", [0, 0x10ffff])).toBe(false);
			for (const range of ranges) {
				expect(Object.isFrozen(range)).toBe(true);
				expect(Reflect.set(range, "1", 0x10ffff)).toBe(false);
			}
		}
		expect(DisplayName.safeParse("My device").success).toBe(true);
		expect(DisplayName.safeParse("My\u200ddevice").success).toBe(true);
		expect(DisplayName.safeParse("My\u202edevice").success).toBe(false);
	});
	it("keeps exactly one merged lone-surrogate issue on presentation constants", () => {
		const result = Constants.safeParse({ literal: "\ud800" });
		expect(result.success).toBe(false);
		if (!result.success)
			expect(result.error.issues.map(({ message }) => message)).toEqual(["lone surrogate"]);
	});
	it("exports one immutable API-shape catalog consumed by both schema and validation", () => {
		expect(Object.isFrozen(AI_HTTP_PROFILES)).toBe(true);
		expect(Object.isFrozen(AUTH_VARIANTS)).toBe(true);
		const validator = new Validator(jsonSchemaOf(PluginManifestV1) as Schema, "2020-12", false);
		const { send: _send, ...base } = community;
		for (const profile of [...AI_HTTP_PROFILES, "unregistered-v1"]) {
			const value = {
				...base,
				kind: "ai-provider",
				contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
				egress: { profile },
			};
			expect(validateManifest(value).ok).toBe(profile !== "unregistered-v1");
			expect(validator.validate(value).valid).toBe(profile !== "unregistered-v1");
		}
	});
	it("accepts an additional module schema with its own fields and inferred type through one variant entry", () => {
		const additional = z.strictObject({
			kind: z.literal("fixture-future"),
			...authFields,
			customField: z.boolean(),
		});
		const schema = z
			.discriminatedUnion("kind", [...AUTH_VARIANTS, additional])
			.refine(authScopesValid);
		type Extended = z.infer<typeof schema>;
		const value: Extract<Extended, { kind: "fixture-future" }> = {
			kind: "fixture-future",
			scopes: [],
			requiredGrantedScopes: [],
			customField: true,
		};
		expect(schema.parse(value)).toEqual(value);
		expect(schema.safeParse({ ...value, customField: "wrong" }).success).toBe(false);
		for (const scopes of [
			["duplicate", "duplicate"],
			["line\nfeed"],
			["x".repeat(257)],
			Array.from({ length: 129 }, (_, i) => `scope${i}`),
		])
			expect(schema.safeParse({ ...value, scopes }).success).toBe(false);
		expect(schema.safeParse({ ...value, requiredGrantedScopes: ["not-requested"] }).success).toBe(
			false,
		);
		expect(
			schema.safeParse({
				...value,
				modes: { read_only: { scopes: [], requiredGrantedScopes: ["missing"] } },
			}).success,
		).toBe(false);
		expect(
			schema.safeParse({
				...value,
				modes: { read_only: { scopes: ["read"], requiredGrantedScopes: ["read"] } },
			}).success,
		).toBe(true);
	});
	it("detects intersecting literal/wildcard paths without using query disjointness", () => {
		const send = community.egress.rules[0] as EgressRule;
		for (const pathTemplate of [
			"/v1/channels/{id}/messages",
			"/v1/{part}/{id}/messages",
			"/v1/channels/fixed/messages",
		])
			expect(
				crossClassOverlap([
					send,
					{ ...send, class: "read", method: "POST", pathTemplate, query: ["other"] },
				]),
			).toBe(true);
		for (const other of [
			{ ...send, class: "read" as const, method: "GET" as const, query: [] },
			{ ...send, class: "read" as const, query: [], host: "other.example.com" },
			{ ...send, class: "read" as const, query: [], pathTemplate: "/v2/channels/{id}/messages" },
		])
			expect(crossClassOverlap([send, other as EgressRule])).toBe(false);
	});

	it("compares overlap literals by one octet decode and ASCII case only", () => {
		const rule = community.egress.rules[0] as EgressRule;
		const overlap = (left: string, right: string): boolean =>
			crossClassOverlap([
				{ ...rule, pathTemplate: `/v1/${left}/messages` },
				{
					...rule,
					class: "read",
					method: "POST",
					query: [],
					pathTemplate: `/v1/${right}/messages`,
				},
			]);
		expect(overlap("!abc%3Aexample.org", "!abc:example.org")).toBe(true);
		expect(overlap("!abc:example.org", "!abc%3Aexample.org")).toBe(true);
		expect(overlap("%3B", ";")).toBe(true);
		expect(overlap("%40", "@")).toBe(true);
		expect(overlap("%FF", "%FF")).toBe(true);
		expect(overlap("%253A", ":")).toBe(false);
		expect(overlap("%C0", "%E0")).toBe(false);
	});

	it("requires JSON Content-Type and the complete approved body even with direct template validation", () => {
		const template = community.send.template;
		expect(validateTemplate(template, community.egress.rules, community.send.constants)).toEqual(
			[],
		);
		for (const headers of [
			{},
			{ "content-type": "text/plain" },
			{ ...template.headers, "x-original-url": "/elsewhere" },
		])
			expect(
				validateTemplate(
					{ ...template, headers },
					community.egress.rules,
					community.send.constants,
				),
			).toEqual([{ code: "TEMPLATE_INVALID" }]);
		for (const body of [
			{ text: { bind: "body.text" } },
			{ footer: { bind: "body.footer" } },
			{ type: { const: "msgtype" } },
		])
			expect(
				validateTemplate({ ...template, body }, community.egress.rules, community.send.constants),
			).toEqual([{ code: "TEMPLATE_BINDING_INVALID" }]);
		const schema = jsonSchemaOf(JsonTemplate) as Schema;
		const definition = schema.$defs?.["draftyak.json-template.JsonTemplate"] ?? schema;
		expect(definition).toMatchObject({
			properties: {
				headers: {
					propertyNames: { enum: ["content-type", "accept"] },
					required: ["content-type"],
					additionalProperties: false,
				},
			},
		});
	});
	it("pins every changed template leaf and real tool-kind objects", () => {
		fc.assert(
			fc.property(
				fc.string({ minLength: 1, maxLength: 32 }).filter((value) => value !== "v1"),
				(value) => {
					const changed = structuredClone(community);
					changed.send.template.path[0] = value;
					expect(sendTemplateDigest(changed.send)).not.toBe(sendTemplateDigest(community.send));
					expect(manifestDigest(changed)).not.toBe(manifestDigest(community));
				},
			),
			{ numRuns: 100 },
		);
		const item = manifestCases().find(({ id }) => id === "tool-url-secret");
		const parsed = validateManifest(item?.manifest);
		if (!parsed.ok || parsed.manifest.kind !== "tool")
			throw Error("valid native declaration fixture missing");
		const kinds = parsed.manifest.tool.kinds;
		expect(toolKindsDigest(kinds)).toBe(jcsSha256(kinds));
		const changed = structuredClone(kinds);
		if (changed[0]) changed[0].output.maxBytes--;
		expect(toolKindsDigest(changed)).not.toBe(toolKindsDigest(kinds));
	});
});

describe("discovered surface digest bounds", () => {
	// tools/list carries JSON, not Zod's nonenumerable executable ~standard metadata.
	const tools = (contract: ExtensionContract) =>
		JSON.parse(
			JSON.stringify(
				Object.entries(contract.tools).map(([name, tool]) => ({
					name,
					description: tool.description,
					inputSchema: jsonSchemaOf(tool.input),
					outputSchema: jsonSchemaOf(tool.output),
				})),
			),
		) as unknown;
	it("hashes actual channel, AI and tool discovery surfaces", () => {
		for (const [name, list] of [
			["channel", tools(channelV1)],
			["AI", tools(aiProviderV1)],
			["tools", canonicalToolsList(["calendar.freebusy", "contact.notes", "kb.lookup"])],
		] as const) {
			const capabilities = {
				tools: {},
				extensions: { "io.github.draftyak/example": { version: 1 } },
			};
			expect(
				() => surfaceDigest(capabilities, list),
				`${name}: ${Buffer.byteLength(JSON.stringify({ capabilities, tools: list }))} bytes`,
			).not.toThrow();
			expect(surfaceDigest(capabilities, list)).toBe(jcsSha256({ capabilities, tools: list }));
		}
	});
	it("permits deeper JSON Schemas and ordinary constructor/prototype property names", () => {
		let schema: unknown = { type: "string" };
		for (let i = 0; i < 20; i++)
			schema = { properties: { constructor: schema, prototype: { type: "string" } } };
		const list = [{ name: "inspect", inputSchema: schema }];
		expect(surfaceDigest({}, list)).toBe(jcsSha256({ capabilities: {}, tools: list }));
	});
	it("enforces an exact one-MiB canonical byte cap without changing manifest bounds", () => {
		const overhead = Buffer.byteLength(
			canonicalize({ capabilities: { description: "" }, tools: [] }),
		);
		const capabilities = { description: "x".repeat(SURFACE_MAX_BYTES - overhead) };
		expect(surfaceDigest(capabilities, [])).toBe(jcsSha256({ capabilities, tools: [] }));
		expect(() => surfaceDigest({ description: `${capabilities.description}x` }, [])).toThrow(
			/^Surface JSON refused$/,
		);
		let deep: unknown = null;
		for (let i = 0; i < 65; i++) deep = { nested: deep };
		expect(() => surfaceDigest({}, deep)).toThrow(/^Surface JSON refused$/);
	});
	it("refuses surface hooks without invoking them or exposing their values", () => {
		let calls = 0;
		const value = Object.defineProperty({}, "constructor", {
			enumerable: true,
			get() {
				calls++;
				return "PRIVATE_SURFACE_CANARY";
			},
		});
		expect(() => surfaceDigest({}, value)).toThrow(/^Surface JSON refused$/);
		expect(calls).toBe(0);
	});
});
