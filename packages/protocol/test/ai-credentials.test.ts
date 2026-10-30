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
		expect((AI_HTTP_PROFILES as readonly string[]).includes("responses-plan-v1")).toBe(true);
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
			if (item.code === null || item.structural)
				expect(validator.validate(item.manifest).valid).toBe(item.code === null);
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
	it("pins the accepted declaration and the refused hostile ones", () => {
		const cases = new Map(issuerOAuthCases().map((item) => [item.id, item]));
		expect(cases.get("issuer-oauth-ai-provider")?.code).toBeNull();
		for (const id of [
			"issuer-oauth-unknown-member",
			"issuer-oauth-http-endpoint",
			"issuer-oauth-duplicate-required-scope",
			"issuer-oauth-http-issuer",
			"issuer-oauth-issuer-text-before-scheme",
			"issuer-oauth-issuer-leading-space",
			"issuer-oauth-http-resource",
			"issuer-oauth-resource-query",
			"issuer-oauth-resource-single-label",
		]) {
			expect(cases.get(id)?.code, id).toBe("MANIFEST_INVALID");
			expect(cases.get(id)?.structural, id).toBe(true);
		}
		expect(cases.get("issuer-oauth-tool")?.code).toBe("MANIFEST_POLICY_INVALID");
	});
	it("keeps the committed vectors as generated", () => {
		const [output] = generate();
		expect(output?.path).toBe("manifests/oauth.json");
		expect(jcsSha256(read("vectors/manifests/oauth.json"))).toBe(jcsSha256(output?.content));
	});
});
