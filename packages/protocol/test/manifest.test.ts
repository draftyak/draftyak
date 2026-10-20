import { readFileSync } from "node:fs";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { jsonSchemaOf } from "../scripts/export-spec.ts";
import { schema } from "../scripts/spec/manifest.ts";
import { bindingCases, generate as bindingVectors } from "../scripts/vectors/manifests/bindings.ts";
import { community, manifestCases } from "../scripts/vectors/manifests/core.ts";
import { generate as pythonVectors } from "../scripts/vectors/manifests/python.ts";
import {
	egressDigest,
	manifestDigest,
	sendTemplateDigest,
	surfaceDigest,
	toolKindsDigest,
} from "../src/digests.ts";
import { jcsSha256 } from "../src/hash.ts";
import { validateTemplate } from "../src/json-template.ts";
import { manifestJson } from "../src/manifest/json.ts";
import { PluginManifestV1, validateManifest } from "../src/manifest.ts";

const document = JSON.parse(
	readFileSync(new URL("../../../spec/plugin-manifest-v1.schema.json", import.meta.url), "utf8"),
) as Schema;
const validator = new Validator(document, "2020-12", false);

describe("manifest declarations", () => {
	it("rejects closed namespaces even through direct shape and JSON Schema checks", () => {
		for (const dataClass of ["sms.content", "sms.metadata", "credentials", "hub.state"]) {
			const sample = { ...community, dataClasses: [dataClass] };
			expect(PluginManifestV1.safeParse(sample).success).toBe(false);
			expect(validator.validate(sample).valid).toBe(false);
		}
	});
	for (const item of manifestCases())
		it(item.id, () => {
			const result = validateManifest(item.manifest);
			expect(result.ok ? null : result.problems[0]?.code).toBe(item.code);
			if (item.code === null || item.structural)
				expect(validator.validate(item.manifest).valid).toBe(item.code === null);
		});
	it("keeps the normative schema and hostile vectors reproducible", () => {
		const { $schema: _schema, $id: _id, ...committed } = document;
		const { $schema: _generatedSchema, ...generated } = jsonSchemaOf(schema);
		expect(committed).toEqual(generated);
		const vector = JSON.parse(
			readFileSync(new URL("../../../spec/vectors/manifests/core.json", import.meta.url), "utf8"),
		);
		expect(vector.cases).toEqual(manifestCases());
		expect(
			JSON.parse(
				readFileSync(
					new URL("../../../spec/vectors/manifests/bindings.json", import.meta.url),
					"utf8",
				),
			),
		).toEqual(bindingVectors()[0]?.content);
		const python = pythonVectors()[0];
		expect(
			JSON.parse(
				readFileSync(
					new URL("../../../spec/vectors/manifests/python.json", import.meta.url),
					"utf8",
				),
			),
		).toEqual(python?.content);
	});
	it("accepts the declarations for every frozen-binding rendering vector", () => {
		for (const item of bindingCases()) {
			const value = item as { template: unknown; rules: unknown; constants: unknown };
			expect(validateTemplate(value.template, value.rules, value.constants)).toEqual([]);
		}
	});
	it("preserves omitted Node without inserting digest-changing defaults", () => {
		const { runtime: _runtime, ...omitted } = community;
		const result = validateManifest(omitted);
		expect(result.ok).toBe(true);
		if (result.ok) expect(Object.hasOwn(result.manifest, "runtime")).toBe(false);
		expect(manifestDigest(omitted)).not.toBe(manifestDigest(community));
		for (const runtime of ["python", "bun", null, 1]) {
			const checked = validateManifest({ ...community, runtime });
			expect(checked).toEqual({ ok: false, problems: [{ code: "RUNTIME_UNSUPPORTED" }] });
			expect(validator.validate({ ...community, runtime }).valid).toBe(false);
		}
	});
	it("requires each OAuth mode's required scopes to belong to its own request", () => {
		const base = structuredClone(
			manifestCases().find(({ id }) => id === "gmail-read-only-scopes")?.manifest,
		) as typeof community;
		const auth = base.auth as unknown as {
			requiredGrantedScopes: string[];
			modes: { read_only: { requiredGrantedScopes: string[] } };
		};
		auth.modes.read_only.requiredGrantedScopes = ["unrequested"];
		expect(validateManifest(base)).toEqual({ ok: false, problems: [{ code: "MANIFEST_INVALID" }] });
	});
	it("rejects OAuth endpoints for non-OAuth and private endpoint names", () => {
		expect(
			PluginManifestV1.safeParse({
				...community,
				auth: {
					...community.auth,
					endpoints: {
						authorization: "https://auth.example.com/",
						token: "https://auth.example.com/token",
					},
				},
			}).success,
		).toBe(false);
		const oauth = {
			kind: "oauth2-pkce-loopback",
			scopes: [],
			requiredGrantedScopes: [],
			endpoints: { authorization: "https://auth.example.com/", token: "https://auth.local/token" },
		};
		expect(validateManifest({ ...community, auth: oauth }).ok).toBe(false);
		for (const authorization of [
			"not a URL",
			"",
			"http://auth.example.com/",
			"https://auth.example.com/\n",
		]) {
			const sample = {
				...community,
				auth: { ...oauth, endpoints: { ...oauth.endpoints, authorization } },
			};
			expect(validateManifest(sample)).toEqual({
				ok: false,
				problems: [{ code: "MANIFEST_INVALID" }],
			});
		}
	});
	it("rejects constant-only URLs even when a body binding is valid", () => {
		const rule = { ...community.egress.rules[0], pathTemplate: "/v1/messages", query: {} };
		const template = { ...community.send.template, path: ["v1", "messages"], query: {} };
		expect(validateTemplate(template, [rule], community.send.constants)).toEqual([
			{ code: "TEMPLATE_BINDING_INVALID" },
		]);
	});
	it("refuses credential and request-routing header constants", () => {
		for (const name of [
			"authorization",
			"x-api-key",
			"proxy-authorization",
			"cookie",
			"host",
			"content-length",
			"connection",
			"forwarded",
			"x-forwarded-host",
			"x-http-method-override",
		]) {
			expect(
				validateTemplate(
					{ ...community.send.template, headers: { [name]: "fixed" } },
					community.egress.rules,
					community.send.constants,
				),
			).toEqual([{ code: "TEMPLATE_INVALID" }]);
		}
	});
});

describe("bounded inert manifest JSON", () => {
	it("never invokes accessors or proxy traps", () => {
		let touched = 0;
		const getter = Object.defineProperty({}, "id", {
			enumerable: true,
			get() {
				touched++;
				throw new Error("invoked");
			},
		});
		const proxy = new Proxy(
			{},
			{
				ownKeys() {
					touched++;
					throw new Error("invoked");
				},
			},
		);
		for (const value of [
			getter,
			proxy,
			{ ...community, auth: getter },
			{ ...community, send: proxy },
		])
			expect(validateManifest(value).ok).toBe(false);
		expect(touched).toBe(0);
	});
	it("uses native byte length for binary JSON without invoking shadow getters", () => {
		let touched = 0;
		const binary = new TextEncoder().encode(JSON.stringify(community));
		Object.defineProperty(binary, "byteLength", {
			get() {
				touched++;
				throw new Error("invoked");
			},
		});
		expect(validateManifest(binary).ok).toBe(true);
		expect(touched).toBe(0);
	});
	it("rejects duplicate members, prototype keys, invalid UTF-8 and hidden values", () => {
		const hidden = Object.defineProperty({}, "secret", { value: "hidden" });
		for (const value of [
			'{"id":"a","id":"b"}',
			'{"__proto__":{}}',
			Uint8Array.of(0xff),
			hidden,
			{ value: "\ud800" },
			{ value: undefined },
			new Date(),
			{ value: Infinity },
		])
			expect(() => manifestJson(value)).toThrow();
	});
	it("rejects large, sparse, cyclic and deeply nested data before validation", () => {
		const cycle: unknown[] = [];
		cycle.push(cycle);
		let deep: unknown = null;
		for (let i = 0; i < 18; i++) deep = { deep };
		for (const value of [
			cycle,
			Array(3),
			Array(1025).fill(0),
			deep,
			" ".repeat(256 * 1024 + 1),
			{ value: "x".repeat(32769) },
			Object.fromEntries(Array.from({ length: 8200 }, (_, i) => [String(i), 0])),
		])
			expect(() => manifestJson(value)).toThrow();
	});
	it("accepts inert parsed JSON and copies before returning", () => {
		const input = { ...structuredClone(community) };
		const result = validateManifest(new TextEncoder().encode(JSON.stringify(input)));
		expect(result.ok).toBe(true);
		input.id = "different";
		if (result.ok) expect(result.manifest.id).toBe(community.id);
	});
});

describe("pinned declaration digests", () => {
	it("uses exact JCS values and explicit surface fields", () => {
		expect(manifestDigest(community)).toBe(jcsSha256(community));
		expect(egressDigest(community.egress)).toBe(jcsSha256(community.egress));
		expect(sendTemplateDigest(community.send)).toBe(jcsSha256(community.send));
		expect(toolKindsDigest(["kb.lookup"])).toBe(jcsSha256(["kb.lookup"]));
		expect(surfaceDigest({ tools: {} }, [])).toBe(
			jcsSha256({ capabilities: { tools: {} }, tools: [] }),
		);
	});
	it("changes both template and manifest pins when a declared constant changes", () => {
		const changed = structuredClone(community);
		changed.send.constants.msgtype = "m.notice";
		expect(sendTemplateDigest(changed.send)).not.toBe(sendTemplateDigest(community.send));
		expect(manifestDigest(changed)).not.toBe(manifestDigest(community));
		const reordered = Object.fromEntries(Object.entries(community).reverse());
		expect(manifestDigest(reordered)).toBe(manifestDigest(community));
	});
});
