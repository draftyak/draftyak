import { readFileSync } from "node:fs";
import path from "node:path";
import { type Schema, Validator } from "@cfworker/json-schema";
import { expect, it } from "vitest";
import * as z from "zod";
import { IanaZone } from "../src/entities/settings.ts";
import * as mcp from "../src/mcp.ts";

const document = JSON.parse(
	readFileSync(
		path.resolve(import.meta.dirname, "../../../spec/schemas/mcp-surface-v1.schema.json"),
		"utf8",
	),
) as Schema;
function named(name: string): Validator {
	return new Validator(
		{ $defs: document.$defs, $ref: `#/$defs/draftyak.mcp.${name}` },
		"2020-12",
		false,
	);
}

it("publishes the public MCP definitions under owner IDs without promoting foreign schemas into its root", () => {
	const root = document as { anyOf: { $ref: string }[]; $defs: Record<string, unknown> };
	const refs = new Set(root.anyOf.map((entry) => entry.$ref));
	expect(refs.size).toBe(root.anyOf.length);
	for (const [name, value] of Object.entries(mcp)) {
		if (!(value instanceof z.ZodType)) continue;
		const id = value.meta()?.id ?? `draftyak.mcp.${name}`;
		expect(Object.hasOwn(root.$defs, id), name).toBe(true);
		expect(refs.has(`#/$defs/${id}`), name).toBe(id.startsWith("draftyak.mcp."));
	}
	for (const ref of refs) expect(ref).toMatch(/^#\/\$defs\/draftyak\.mcp\./);
	const zoneId = IanaZone.meta()?.id;
	expect(zoneId).toBe("draftyak.tool-v1.IanaZone");
	expect(Object.hasOwn(root.$defs, zoneId as string)).toBe(true);
	expect(refs.has(`#/$defs/${zoneId}`)).toBe(false);
	expect(Object.keys(root.$defs)).not.toContain("draftyak.entities.IanaZone");
	const names = named("McpToolName");
	for (const name of Object.keys(mcp.MCP_TOOLS))
		expect(names.validate(name).valid, name).toBe(true);
	expect(names.validate("PRIVATE_DISCOVERY_CANARY").valid).toBe(false);
});

it("keeps every resource's advertised scope, read class and annotations consistent with its actual tool policy", () => {
	const id = "01JC0000000000000000000001";
	for (const template of mcp.RESOURCE_TEMPLATES) {
		const policy = mcp.MCP_TOOLS[template.handler];
		expect(template.scope).toBe(policy.scope);
		expect(template.toolClass).toBe(policy.toolClass);
		expect(policy.annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: false,
		});
		expect(mcp.resourceReadTarget(template.uriTemplate.replace("{id}", id))).toEqual({
			handler: template.handler,
			id,
			scope: policy.scope,
			toolClass: policy.toolClass,
		});
	}
});

it("keeps generated application-error shapes closed against caller text and matched to runtime validators", () => {
	const schema = named("McpAppError");
	const errors = [
		{
			code: 1001,
			message: "Approve on the paired desktop, then retry.",
			data: { code: "AGENT_SESSION_REQUIRED" },
		},
		{ code: 1002, message: "Required scope unavailable.", data: { code: "SCOPE_REQUIRED" } },
		{ code: 1003, message: "Retry later.", data: { code: "RATE_LIMITED", retryAfterMs: 1000 } },
	];
	for (const value of errors) {
		expect(mcp.McpAppError.safeParse(value).success).toBe(true);
		expect(schema.validate(value).valid).toBe(true);
		const astral = { ...value, message: "\u{1f600}".repeat(512) };
		expect(mcp.McpAppError.safeParse(astral).success).toBe(true);
		expect(schema.validate(astral).valid).toBe(true);
		for (const refused of [
			{ ...value, context: "PRIVATE_MAILBOX_CANARY" },
			{ ...value, data: { ...value.data, token: "PRIVATE_CREDENTIAL_CANARY" } },
			{ ...value, code: -32000 },
			{ ...value, message: "x".repeat(513) },
			{ ...value, message: "\u{1f600}".repeat(513) },
			{
				...value,
				data: { code: value.code === 1001 ? "SCOPE_REQUIRED" : "AGENT_SESSION_REQUIRED" },
			},
		]) {
			expect(mcp.McpAppError.safeParse(refused).success).toBe(false);
			expect(schema.validate(refused).valid).toBe(false);
		}
		expect(mcp.McpAppError.safeParse({ ...value, message: "\ud800" }).success).toBe(false);
	}
});

it("uses fixed public-helper refusal messages without leaking unknown fields or URI credentials", () => {
	const scopes = mcp.McpScope.options;
	const completion: mcp.CompletionRequest = {
		ref: { type: "ref/prompt", name: "triage_inbox" },
		argument: { name: "account", value: "" },
	};
	const invalidCompletion = { ...completion, PRIVATE_PREFIX_CANARY: true };
	for (const name of mcp.PromptName.options) {
		expect(() => mcp.parsePromptArguments(name, { PRIVATE_MAILBOX_CANARY: true }, scopes)).toThrow(
			/^Prompt unavailable$/,
		);
	}
	expect(() => mcp.parsePromptArguments("PRIVATE_PROMPT_CANARY", {}, scopes)).toThrow(
		/^Prompt unavailable$/,
	);
	expect(() => mcp.parsePromptArguments("draft_reply", {}, [])).toThrow(/^Prompt unavailable$/);
	expect(() => mcp.completionTarget(invalidCompletion, scopes)).toThrow(/^Completion unavailable$/);
	expect(() =>
		mcp.completeArgument(
			completion,
			{ aliases: [], PRIVATE_ALIAS_CANARY: true } as mcp.AuthorizedAliases,
			scopes,
		),
	).toThrow(/^Completion unavailable$/);
	expect(() =>
		mcp.parseResourceUri("draftyak://PRIVATE_CREDENTIAL_CANARY@message/PRIVATE_PATH_CANARY"),
	).toThrow(/^Resource URI refused$/);
});
