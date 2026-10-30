import { AI_HTTP_PROFILES } from "../../../src/manifest/ai-http.ts";
import type { PluginAuth } from "../../../src/manifest/auth.ts";
import { issuerOAuth } from "../../../src/manifest/auth-issuer.ts";
import { validateManifest } from "../../../src/manifest.ts";
import type { VectorFile } from "../../vectors.ts";
import { community, type ManifestCase, manifestCases } from "./core.ts";

export const issuerAuth: Extract<PluginAuth, { kind: typeof issuerOAuth.shape.kind.value }> = {
	kind: issuerOAuth.shape.kind.value,
	scopes: ["openid", "profile", "email", "offline_access"],
	requiredGrantedScopes: ["openid"],
	issuer: "https://auth.example.com",
	resource: "https://api.example.com/v1",
};
const { send: _send, ...channel } = community;
const base = {
	...channel,
	id: "@example/ai-plan",
	kind: "ai-provider",
	contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
	egress: { profile: "responses-plan-v1" },
	auth: issuerAuth,
};
const otherAuth: PluginAuth[] = [
	{
		kind: "oauth2-pkce-loopback",
		scopes: [],
		requiredGrantedScopes: [],
		endpoints: {
			authorization: "https://auth.example.com/authorize",
			token: "https://auth.example.com/token",
		},
	},
	...(["manifest-app", "api-key", "token-paste", "url-secret", "none"] as const).map((kind) => ({
		kind,
		scopes: [],
		requiredGrantedScopes: [],
	})),
];

const absent = Symbol("absent");
const cyrillicA = String.fromCodePoint(0x430);
type Patch = readonly [path: string, value: unknown];

function patched(source: unknown, ...patches: Patch[]): unknown {
	const manifest = structuredClone(source);
	for (const [path, value] of patches) {
		const segments = path.split("/");
		let parent = manifest as Record<string, unknown>;
		for (const key of segments.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
		const key = segments.at(-1);
		if (key === undefined) throw new Error("fixture path");
		if (value === absent) delete parent[key];
		else parent[key] = value;
	}
	return manifest;
}

export function issuerOAuthCases(): ManifestCase[] {
	const cases: ManifestCase[] = [];
	const add = (
		id: string,
		code: ManifestCase["code"],
		structural: boolean,
		...patches: Patch[]
	): void => {
		cases.push({ id: `issuer-oauth-${id}`, manifest: patched(base, ...patches), code, structural });
	};
	const refused = (id: string, ...patches: Patch[]): void =>
		add(id, "MANIFEST_INVALID", true, ...patches);
	add("ai-provider", null, false);
	refused("unknown-member", ["auth/extra", true]);
	refused("endpoints", [
		"auth/endpoints",
		{
			authorization: "https://auth.example.com/authorize",
			token: "https://auth.example.com/token",
		},
	]);
	refused("http-endpoint", [
		"auth/endpoints",
		{ authorization: "http://auth.example.com/authorize", token: "http://auth.example.com/token" },
	]);
	refused("read-only-mode", [
		"auth/modes",
		{ read_only: { scopes: ["openid"], requiredGrantedScopes: ["openid"] } },
	]);
	refused("unknown-kind", ["auth/kind", "oauth2-agent"]);
	refused("duplicate-scope", ["auth/scopes", ["openid", "openid"]]);
	refused("duplicate-required-scope", ["auth/requiredGrantedScopes", ["openid", "openid"]]);
	refused("missing-issuer", ["auth/issuer", absent]);
	refused("issuer-not-string", ["auth/issuer", 443]);
	refused("http-issuer", ["auth/issuer", "http://auth.example.com"]);
	refused("issuer-text-before-scheme", [
		"auth/issuer",
		"http://evil.example/https://auth.example.com",
	]);
	refused("issuer-leading-space", ["auth/issuer", " https://auth.example.com"]);
	refused("issuer-slash", ["auth/issuer", "https://auth.example.com/"]);
	refused("issuer-path", ["auth/issuer", "https://auth.example.com/oauth"]);
	refused("issuer-port", ["auth/issuer", "https://auth.example.com:8443"]);
	refused("issuer-port-443", ["auth/issuer", "https://auth.example.com:443"]);
	refused("issuer-userinfo", ["auth/issuer", "https://user@auth.example.com"]);
	refused("issuer-query", ["auth/issuer", "https://auth.example.com?tenant=1"]);
	refused("issuer-fragment", ["auth/issuer", "https://auth.example.com#top"]);
	refused("issuer-upper-case", ["auth/issuer", "https://Auth.example.com"]);
	refused("issuer-homograph", ["auth/issuer", `https://${cyrillicA}uth.example.com`]);
	refused("issuer-ip", ["auth/issuer", "https://192.0.2.1"]);
	refused("issuer-single-label", ["auth/issuer", "https://auth"]);
	refused("issuer-trailing-dot", ["auth/issuer", "https://auth.example.com."]);
	refused("issuer-line-feed", ["auth/issuer", "https://auth.example.com\n"]);
	refused("issuer-too-long", [
		"auth/issuer",
		`https://${Array(4).fill("a".repeat(63)).join(".")}.com`,
	]);
	refused("missing-resource", ["auth/resource", absent]);
	refused("resource-not-string", ["auth/resource", ["https://api.example.com/v1"]]);
	refused("http-resource", ["auth/resource", "http://api.example.com/v1"]);
	refused("resource-origin", ["auth/resource", "https://api.example.com"]);
	refused("resource-fragment", ["auth/resource", "https://api.example.com/v1#x"]);
	refused("resource-userinfo", ["auth/resource", "https://user@api.example.com/v1"]);
	refused("resource-query", ["auth/resource", "https://api.example.com/v1?tenant=1"]);
	refused("resource-single-label", ["auth/resource", "https://api/v1"]);
	refused("resource-long-label", ["auth/resource", `https://api.${"a".repeat(64)}.com/v1`]);
	add("private-issuer", "MANIFEST_INVALID", false, ["auth/issuer", "https://auth.internal"]);
	add("private-resource", "MANIFEST_INVALID", false, ["auth/resource", "https://api.local/v1"]);
	add("resource-port-443", "MANIFEST_INVALID", false, [
		"auth/resource",
		"https://api.example.com:443/v1",
	]);
	add("resource-dot-segment", "MANIFEST_INVALID", false, [
		"auth/resource",
		"https://api.example.com/v1/../v2",
	]);
	add("unrequested-scope", "MANIFEST_INVALID", false, [
		"auth/requiredGrantedScopes",
		["unrequested"],
	]);
	const policy = (id: string, source: unknown, ...patches: Patch[]): void => {
		cases.push({
			id: `issuer-oauth-${id}`,
			manifest: patched(source, ...patches),
			code: "MANIFEST_POLICY_INVALID",
			structural: false,
		});
	};
	const tool = manifestCases().find((item) => item.id === "tool-auth-oauth");
	if (tool === undefined) throw new Error("manifest vector tool-auth-oauth");
	policy("tool", tool.manifest, ["auth", issuerAuth]);
	policy("channel", community, ["auth", issuerAuth]);
	for (const profile of AI_HTTP_PROFILES)
		if (profile !== base.egress.profile)
			policy(`profile-${profile}`, base, ["egress/profile", profile]);
	for (const auth of otherAuth) policy(`plan-profile-auth-${auth.kind}`, base, ["auth", auth]);
	return cases;
}

export function generate(): VectorFile[] {
	const cases = issuerOAuthCases();
	for (const item of cases) {
		const result = validateManifest(item.manifest);
		if ((result.ok ? null : result.problems[0]?.code) !== item.code)
			throw new Error(`manifest vector ${item.id}`);
	}
	return [
		{
			path: "manifests/oauth.json",
			content: {
				format: "draftyak.vectors.manifests.v1",
				description:
					"Issuer-discovered OAuth declarations only; validation grants no sign-in, credential or network access.",
				cases,
			},
		},
	];
}
