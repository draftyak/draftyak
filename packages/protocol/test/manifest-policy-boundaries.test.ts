import { describe, expect, it } from "vitest";
import { EgressRule } from "../src/manifest/egress.ts";
import { PluginManifestV1, validateManifest } from "../src/manifest.ts";

function tool() {
	return {
		id: "@example/policy-boundary",
		version: "1.0.0",
		sdk: "1.0.0",
		runtime: "node",
		isolation: "standard",
		kind: "tool",
		contract: { extension: "io.github.draftyak/tool", version: 1 },
		auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
		credentials: { mode: "brokered", urlSecrets: [] },
		permissions: {},
		dataClasses: ["tool.kb.lookup"],
		license: "Apache-2.0",
		egress: { rules: [] },
		tool: {
			kinds: [
				{
					kind: "kb.lookup",
					inputs: ["topic"],
					output: { dataClass: "tool.kb.lookup", maxBytes: 1024 },
				},
			],
		},
	};
}

function channel(rule: unknown) {
	const { tool: _tool, ...base } = tool();
	return {
		...base,
		kind: "channel",
		contract: { extension: "io.github.draftyak/channel", version: 1 },
		dataClasses: ["community.content"],
		egress: { rules: [rule] },
	};
}

describe("manifest credential and data-class policy boundaries", () => {
	it("accepts a no-egress tool with one declared output class", () => {
		expect(validateManifest(tool()).ok).toBe(true);
	});
	it("accepts API-key auth without URL-secret declarations", () => {
		const value = tool();
		expect(validateManifest({ ...value, auth: { ...value.auth, kind: "api-key" } }).ok).toBe(true);
	});
	it("accepts a URL-secret only with matching auth and a declared secret-reference rule", () => {
		const value = tool();
		const declared = {
			...value,
			auth: { ...value.auth, kind: "url-secret" },
			credentials: {
				mode: "brokered",
				urlSecrets: [{ name: "lookupUrl", label: "Lookup address", help: "Configured address." }],
			},
			egress: {
				rules: [
					{
						class: "read",
						method: "GET",
						url: "secret://lookupUrl",
						maxBytes: 4096,
						timeoutMs: 1000,
					},
				],
			},
		};
		expect(validateManifest(declared).ok).toBe(true);
	});
	it("refuses unused URL-secret declarations under API-key auth", () => {
		const value = tool();
		const changed = {
			...value,
			auth: { ...value.auth, kind: "api-key" },
			credentials: {
				mode: "brokered",
				urlSecrets: [{ name: "lookupUrl", label: "Lookup address", help: "Configured address." }],
			},
		};
		expect(PluginManifestV1.safeParse(changed).success).toBe(true);
		expect(validateManifest(changed)).toEqual({
			ok: false,
			problems: [{ code: "MANIFEST_POLICY_INVALID" }],
		});
	});
	it("refuses a tool data class that has no declared output kind", () => {
		const changed = { ...tool(), dataClasses: ["tool.kb.lookup", "tool.contact.notes"] };
		expect(PluginManifestV1.safeParse(changed).success).toBe(true);
		expect(validateManifest(changed)).toEqual({
			ok: false,
			problems: [{ code: "MANIFEST_POLICY_INVALID" }],
		});
	});
	it("accepts both classes when each has a complete declared kind", () => {
		const value = tool();
		const changed = {
			...value,
			dataClasses: ["tool.kb.lookup", "tool.contact.notes"],
			tool: {
				kinds: [
					...value.tool.kinds,
					{
						kind: "contact.notes",
						inputs: ["participant"],
						output: { dataClass: "tool.contact.notes", maxBytes: 1024 },
					},
				],
			},
		};
		expect(validateManifest(changed).ok).toBe(true);
	});
	it("refuses duplicate data classes even when every class has a declared kind", () => {
		const changed = { ...tool(), dataClasses: ["tool.kb.lookup", "tool.kb.lookup"] };
		expect(validateManifest(changed)).toEqual({
			ok: false,
			problems: [{ code: "MANIFEST_INVALID" }],
		});
	});
});

describe("request query allowlist uniqueness", () => {
	it.each([
		["read", "GET"],
		["organize", "PATCH"],
	] as const)(
		"accepts unique query names for %s rules and refuses repeated names",
		(kind, method) => {
			const rule = {
				class: kind,
				method,
				host: "chat.example.invalid",
				pathTemplate: "/v1/rooms/{room}/messages",
				query: ["limit", "cursor"],
				maxBytes: 4096,
				timeoutMs: 1000,
			};
			expect(EgressRule.safeParse(rule).success).toBe(true);
			expect(validateManifest(channel(rule)).ok).toBe(true);
			for (const query of [
				["cursor", "cursor"],
				["limit", "cursor", "limit"],
			]) {
				const changed = { ...rule, query };
				expect(EgressRule.safeParse(changed).success).toBe(false);
				expect(validateManifest(channel(changed))).toEqual({
					ok: false,
					problems: [{ code: "MANIFEST_INVALID" }],
				});
			}
		},
	);
	it("accepts 32 distinct names and refuses a 33rd rather than deduplicating input", () => {
		const rule = {
			class: "read",
			method: "GET",
			host: "chat.example.invalid",
			pathTemplate: "/v1/messages",
			query: Array.from({ length: 32 }, (_, index) => `q${index}`),
			maxBytes: 4096,
			timeoutMs: 1000,
		};
		expect(validateManifest(channel(rule)).ok).toBe(true);
		expect(validateManifest(channel({ ...rule, query: [...rule.query, "extra"] }))).toEqual({
			ok: false,
			problems: [{ code: "MANIFEST_INVALID" }],
		});
	});
});
