import { readFileSync } from "node:fs";
import { type Schema, Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { community } from "../scripts/vectors/manifests/core.ts";
import { generate, issuerAuth, issuerOAuthCases } from "../scripts/vectors/manifests/oauth.ts";
import type { StatementVector } from "../scripts/vectors/statements/shared.ts";
import { ADMIN_REVIEW_KINDS, requiredCapability } from "../src/device-api.ts";
import { jcsSha256, sha256Hex } from "../src/hash.ts";
import { AI_HTTP_PROFILES } from "../src/manifest/ai-http.ts";
import { AUTH_VARIANTS } from "../src/manifest/auth.ts";
import { scopes } from "../src/manifest/auth-fields.ts";
import { issuerOAuth } from "../src/manifest/auth-issuer.ts";
import { validateManifest } from "../src/manifest.ts";
import { ADMIN_GROUPS, ADMIN_KINDS, AdminStatement } from "../src/statements.ts";

const read = (file: string): unknown =>
	JSON.parse(readFileSync(new URL(`../../../spec/${file}`, import.meta.url), "utf8"));
const document = read("plugin-manifest-v1.schema.json") as Schema;
const validator = new Validator(document, "2020-12", false);
const adminCases = (read("vectors/statements/admin.v1.json") as { cases: StatementVector[] }).cases;
const aiKinds = ["ai.credential-connect", "ai.credential-disconnect"];
const fields = ["scopes", "requiredGrantedScopes", "kind", "issuer", "resource"];
const otherKinds = [
	"oauth2-pkce-loopback",
	"manifest-app",
	"api-key",
	"token-paste",
	"url-secret",
	"none",
];
const kindSha256 = "e92f25d694a740fe2531fbded26e9d7b9f720c3b581ae63e9a0c4cec3f9af121";

describe("the ai admin group", () => {
	it("sits between data and sms and holds the two credential kinds", () => {
		const groups = Object.keys(ADMIN_GROUPS);
		expect(groups[groups.indexOf("data") + 1]).toBe("ai");
		expect(groups[groups.indexOf("ai") + 1]).toBe("sms");
		expect(ADMIN_GROUPS.ai).toEqual(aiKinds);
	});
	it("keeps every ai kind in the ai group and every other kind out of it", () => {
		for (const [group, kinds] of Object.entries(ADMIN_GROUPS))
			for (const kind of kinds) expect(kind.startsWith("ai."), kind).toBe(group === "ai");
	});
	for (const kind of aiKinds)
		it(`signs ${kind} as an admin kind that no review admits yet`, () => {
			const vector = adminCases.find((item) => item.id === `kind-${kind}`);
			expect(vector?.valid).toBe(true);
			expect(AdminStatement.safeParse(vector?.statement).success).toBe(true);
			expect(requiredCapability(kind)).toBe("admin");
			expect((ADMIN_REVIEW_KINDS as readonly string[]).includes(kind)).toBe(false);
		});
	it("refuses near-miss ai kinds", () => {
		const statement = adminCases[0]?.statement as Record<string, unknown>;
		for (const kind of ["ai.connect", "ai.credential-revoke", "ai.credential-transfer"]) {
			expect((ADMIN_KINDS as readonly string[]).includes(kind), kind).toBe(false);
			expect(AdminStatement.safeParse({ ...statement, kind }).success, kind).toBe(false);
		}
	});
});

describe("the plan profile", () => {
	const { send: _send, ...channel } = community;
	it("is listed in the frozen profile table", () => {
		expect(Object.isFrozen(AI_HTTP_PROFILES)).toBe(true);
		expect(AI_HTTP_PROFILES).toEqual([
			"messages-api-v1",
			"responses-api-v1",
			"chat-completions-v1",
			"responses-plan-v1",
		]);
	});
	it("is an ai-provider egress profile and never a channel one", () => {
		const provider = {
			...channel,
			kind: "ai-provider",
			contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
			egress: { profile: "responses-plan-v1" },
			auth: issuerAuth,
		};
		expect(validateManifest(provider).ok).toBe(true);
		expect(validator.validate(provider).valid).toBe(true);
		const other = { ...channel, egress: { profile: "responses-plan-v1" } };
		expect(validateManifest(other)).toEqual({
			ok: false,
			problems: [{ code: "MANIFEST_INVALID" }],
		});
		expect(validator.validate(other).valid).toBe(false);
	});
});

describe("issuer OAuth", () => {
	it("is one closed auth variant in the frozen list and the exported schema", () => {
		expect(Object.isFrozen(AUTH_VARIANTS)).toBe(true);
		expect(AUTH_VARIANTS.includes(issuerOAuth)).toBe(true);
		const kind = issuerOAuth.shape.kind.value;
		const oneOf: Schema[] = document.$defs?.["draftyak.manifest.PluginAuth"]?.oneOf ?? [];
		const branches = oneOf.filter((branch) => {
			const property = branch.properties?.kind;
			return typeof property === "object" && property.const === kind;
		});
		expect(branches.length).toBe(1);
		const branch = branches[0];
		expect(branch?.additionalProperties).toBe(false);
		expect(Object.keys(branch?.properties ?? {})).toEqual(fields);
		expect(branch?.required).toEqual(fields);
	});
	it("keeps its recorded kind and the shared scope fields", () => {
		expect(sha256Hex(issuerOAuth.shape.kind.value) === kindSha256).toBe(true);
		expect(issuerOAuth.shape.scopes === scopes).toBe(true);
		expect(issuerOAuth.shape.requiredGrantedScopes === scopes).toBe(true);
	});
	for (const item of issuerOAuthCases())
		it(item.id, () => {
			const result = validateManifest(item.manifest);
			expect(result.ok ? null : result.problems[0]?.code).toBe(item.code);
			expect(validator.validate(item.manifest).valid).toBe(!item.structural);
		});
	it("is valid only on the plan profile of an ai-provider manifest, and that profile only with it", () => {
		const cases = new Map(issuerOAuthCases().map((item) => [item.id, item]));
		expect(validateManifest(cases.get("issuer-oauth-ai-provider")?.manifest).ok).toBe(true);
		for (const id of [
			"issuer-oauth-tool",
			"issuer-oauth-channel",
			...AI_HTTP_PROFILES.filter((profile) => profile !== "responses-plan-v1").map(
				(profile) => `issuer-oauth-profile-${profile}`,
			),
			...otherKinds.map((kind) => `issuer-oauth-plan-profile-auth-${kind}`),
		]) {
			const manifest = cases.get(id)?.manifest;
			const result = validateManifest(manifest);
			expect(result.ok ? null : result.problems[0]?.code, id).toBe("MANIFEST_POLICY_INVALID");
			expect(validator.validate(manifest).valid, id).toBe(true);
		}
	});
	it("pins every case and its outcome", () => {
		const spellings = [
			"no-slashes",
			"one-slash",
			"three-slashes",
			"four-slashes",
			"backslashes",
			"slash-backslash",
			"backslash-slash",
			"slashes-backslash",
			"tab-in-separator",
			"upper-case-scheme",
			"empty-userinfo",
			"leading-space",
			"leading-tab",
			"trailing-space",
			"trailing-tab",
			"line-feed",
		];
		const outcomes: Record<string, string[]> = {
			accepted: ["ai-provider", "issuer-longest-host", "resource-port", "resource-longest-host"],
			"MANIFEST_INVALID structural": [
				"unknown-member",
				"endpoints",
				"http-endpoint",
				"read-only-mode",
				"unknown-kind",
				"duplicate-scope",
				"duplicate-required-scope",
				"missing-issuer",
				"issuer-not-string",
				"http-issuer",
				"issuer-text-before-scheme",
				...spellings.flatMap((spelling) => [`issuer-${spelling}`, `resource-${spelling}`]),
				"issuer-slash",
				"issuer-path",
				"issuer-port",
				"issuer-port-443",
				"issuer-empty-port",
				"issuer-userinfo",
				"issuer-query",
				"issuer-fragment",
				"issuer-upper-case",
				"issuer-homograph",
				"issuer-ip",
				"issuer-single-label",
				"issuer-trailing-dot",
				"issuer-too-long",
				"missing-resource",
				"resource-not-string",
				"http-resource",
				"resource-empty-port",
				"resource-origin",
				"resource-fragment",
				"resource-userinfo",
				"resource-query",
				"resource-single-label",
				"resource-upper-case",
				"resource-homograph",
				"resource-ip",
				"resource-trailing-dot",
				"resource-long-label",
			],
			MANIFEST_INVALID: [
				"private-issuer",
				"private-resource",
				"resource-port-443",
				"resource-dot-segment",
				"resource-dot-segment-same-url",
				"resource-too-long",
				"unrequested-scope",
			],
			MANIFEST_POLICY_INVALID: [
				"tool",
				"channel",
				...AI_HTTP_PROFILES.filter((profile) => profile !== "responses-plan-v1").map(
					(profile) => `profile-${profile}`,
				),
				...otherKinds.map((kind) => `plan-profile-auth-${kind}`),
			],
		};
		const expected = Object.entries(outcomes)
			.flatMap(([outcome, ids]) => ids.map((id) => `issuer-oauth-${id} ${outcome}`))
			.sort();
		const actual = issuerOAuthCases()
			.map(
				({ id, code, structural }) =>
					`${id} ${code ?? "accepted"}${structural ? " structural" : ""}`,
			)
			.sort();
		expect(actual).toEqual(expected);
	});
	it("accepts a host of 253 characters and refuses one of 254", () => {
		const cases = new Map(issuerOAuthCases().map((item) => [item.id, item]));
		for (const [id, field, length, code, structural] of [
			["issuer-oauth-issuer-longest-host", "issuer", 253, null, false],
			["issuer-oauth-issuer-too-long", "issuer", 254, "MANIFEST_INVALID", true],
			["issuer-oauth-resource-longest-host", "resource", 253, null, false],
			["issuer-oauth-resource-too-long", "resource", 254, "MANIFEST_INVALID", false],
		] as const) {
			const item = cases.get(id);
			if (item === undefined) throw new Error(`manifest vector ${id}`);
			const auth = (item.manifest as { auth: Record<string, string> }).auth;
			expect(new URL(auth[field] ?? "").hostname.length, id).toBe(length);
			expect(item.code, id).toBe(code);
			expect(item.structural, id).toBe(structural);
		}
	});
	it("keeps the committed vectors as generated", () => {
		const [output] = generate();
		expect(output?.path).toBe("manifests/oauth.json");
		expect(jcsSha256(read("vectors/manifests/oauth.json"))).toBe(jcsSha256(output?.content));
	});
});
