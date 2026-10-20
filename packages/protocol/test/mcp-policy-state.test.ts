import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/jcs.ts";
import { McpAppError, McpSessionRequiredResult } from "../src/mcp/errors.ts";
import { McpRequestState, paramsDigest } from "../src/mcp/request-state.ts";
import { AgentPrincipalRef, AgentToolClass, McpScope } from "../src/mcp/scopes.ts";
import { MCP_TOOLS, McpToolName } from "../src/mcp/tools.ts";

const id = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
describe("the shared first-party tool catalogue", () => {
	it("declares exactly the seventeen tools and four restricted scopes", () => {
		expect(McpScope.options).toEqual([
			"inbox:read",
			"inbox:organize",
			"drafts:write",
			"outbox:propose",
		]);
		expect(AgentToolClass.options).toEqual(["read", "draft", "organize"]);
		expect(Object.keys(MCP_TOOLS)).toEqual(McpToolName.options);
		expect(McpToolName.options).toHaveLength(17);
		for (const name of [
			"channel_send",
			"approve",
			"device_pair",
			"send_now",
			"schedule",
			"plugin_install",
		])
			expect(McpToolName.safeParse(name).success).toBe(false);
		for (const scope of ["send", "approve", "admin", "plugins", "inbox:delete"])
			expect(McpScope.safeParse(scope).success).toBe(false);
		expect(AgentPrincipalRef.safeParse({ kind: "device", id }).success).toBe(false);
		expect(AgentPrincipalRef.safeParse({ kind: "token", id, approved: true }).success).toBe(false);
	});
	it("uses the approved annotations and session classes", () => {
		for (const [name, tool] of Object.entries(MCP_TOOLS)) {
			expect(tool.title.length).toBeGreaterThan(0);
			expect(Object.keys(tool.annotations)).toHaveLength(4);
			expect(tool.annotations.idempotentHint).toBe(true);
			expect(tool.annotations.destructiveHint).toBe(
				["draft_discard", "send_request_create"].includes(name),
			);
			expect(tool.annotations.openWorldHint).toBe(name === "send_request_create");
			expect(tool.annotations.readOnlyHint).toBe(tool.toolClass === "read");
			expect(Object.isFrozen(tool)).toBe(true);
			expect(Object.isFrozen(tool.annotations)).toBe(true);
		}
		expect(MCP_TOOLS.send_request_status).toMatchObject({
			scope: "outbox:propose",
			toolClass: "read",
		});
		expect(MCP_TOOLS.send_request_create).toMatchObject({
			scope: "outbox:propose",
			toolClass: "draft",
		});
		expect(MCP_TOOLS.conversation_label.toolClass).toBe("organize");
	});
});

describe("MCP application errors", () => {
	it("keeps the tool-side session refusal readable, closed and separate from app errors", () => {
		const result = {
			isError: true,
			content: [{ type: "text", text: "Approve a session on your paired desktop, then retry." }],
			_meta: { "io.github.draftyak/error": { code: "AGENT_SESSION_REQUIRED" } },
		};
		expect(McpSessionRequiredResult.safeParse(result).success).toBe(true);
		expect(McpAppError.safeParse(result).success).toBe(false);
		for (const refused of [
			{ ...result, isError: false },
			{ ...result, structuredContent: { approved: true } },
			{ ...result, content: [{ type: "text", text: "" }] },
			{ ...result, content: [{ type: "text", text: "\ud800" }] },
			{ ...result, content: [...result.content, ...result.content] },
			{ ...result, _meta: { "io.github.draftyak/error": { code: "SCOPE_REQUIRED" } } },
			{
				...result,
				_meta: {
					"io.github.draftyak/error": { code: "AGENT_SESSION_REQUIRED", token: "PRIVATE_CANARY" },
				},
			},
		])
			expect(McpSessionRequiredResult.safeParse(refused).success).toBe(false);
	});
	it.each([
		{
			code: 1001,
			message: "Approve an agent session on your paired desktop, then retry.",
			data: { code: "AGENT_SESSION_REQUIRED" },
		},
		{ code: 1002, message: "This scope is required.", data: { code: "SCOPE_REQUIRED" } },
		{ code: 1003, message: "Retry later.", data: { code: "RATE_LIMITED", retryAfterMs: 1000 } },
	])("accepts $code with its matching data code", (value) => {
		expect(McpAppError.safeParse(value).success).toBe(true);
		expect(McpAppError.safeParse({ ...value, code: -32000 }).success).toBe(false);
		expect(
			McpAppError.safeParse({ ...value, data: { code: "SCOPE_REQUIRED", token: "secret" } })
				.success,
		).toBe(false);
	});
	it("refuses mismatches, missing retry delays and unknown values", () => {
		for (const value of [
			{ code: 1004, message: "x", data: { code: "AGENT_SESSION_REQUIRED" } },
			{ code: -32768, message: "x", data: { code: "AGENT_SESSION_REQUIRED" } },
			{ code: 1001, message: "x", data: { code: "SCOPE_REQUIRED" } },
			{ code: 1003, message: "x", data: { code: "RATE_LIMITED" } },
			{ code: 1003, message: "x", data: { code: "RATE_LIMITED", retryAfterMs: -1 } },
			{ code: 1003, message: "", data: { code: "RATE_LIMITED", retryAfterMs: 1 } },
		])
			expect(McpAppError.safeParse(value).success).toBe(false);
	});
});

describe("request-state identity and parameter binding", () => {
	it("accepts ids-only state and refuses authority, content and unknown methods", () => {
		const state = {
			v: 1,
			epoch: 1,
			principal: { kind: "grant", id },
			method: "prompts/get",
			paramsDigest: "a".repeat(64),
			pendingId: id,
			exp: 1_800_000_000_000,
		};
		expect(McpRequestState.safeParse(state).success).toBe(true);
		for (const epoch of [0, Number.MAX_SAFE_INTEGER])
			expect(McpRequestState.safeParse({ ...state, epoch }).success).toBe(true);
		for (const patch of [
			{ approved: true },
			{ account: "secret subject" },
			{ params: {} },
			{ epoch: -1 },
			{ epoch: 1.5 },
			{ epoch: Number.MAX_SAFE_INTEGER + 1 },
			{ principal: { kind: "device", id } },
			{ method: "approval/send" },
			{ exp: -1 },
			{ paramsDigest: "A".repeat(64) },
		])
			expect(McpRequestState.safeParse({ ...state, ...patch }).success).toBe(false);
	});
	it("hashes JCS with exactly the three retry fields omitted at the top level", () => {
		const params = {
			name: "draft_update",
			arguments: { draftId: id, body: "café", _meta: "bound" },
		};
		const expected = createHash("sha256").update(canonicalize(params)).digest("hex");
		expect(paramsDigest(params)).toBe(expected);
		expect(
			paramsDigest({
				inputResponses: [1],
				requestState: "opaque",
				_meta: { extra: true },
				...params,
			}),
		).toBe(expected);
		expect(
			paramsDigest({ ...params, arguments: { ...params.arguments, _meta: "changed" } }),
		).not.toBe(expected);
		expect(paramsDigest({ ...params, extra: 1 })).not.toBe(expected);
	});
	it("is stable over member order and preserves every non-reserved JSON member (500 runs)", () => {
		fc.assert(
			fc.property(fc.jsonValue(), (value) => {
				const input = { name: "conversation_get", arguments: value };
				expect(paramsDigest({ _meta: 1, ...input, inputResponses: null, requestState: "x" })).toBe(
					createHash("sha256").update(canonicalize(input)).digest("hex"),
				);
				expect(paramsDigest({ arguments: value, name: "conversation_get" })).toBe(
					paramsDigest(input),
				);
			}),
			{ numRuns: 500, seed: 1919 },
		);
	});
	it("handles __proto__ as ordinary bound data", () => {
		expect(paramsDigest(JSON.parse('{"__proto__":{"x":1}}'))).not.toBe(paramsDigest({}));
		expect(({} as { x?: number }).x).toBeUndefined();
	});
	it("refuses array properties and proxies that could hide unbound parameters", () => {
		const values = Object.assign([1], { mailboxText: "CANARY_UNBOUND" });
		expect(() => paramsDigest({ values })).toThrow(/^Invalid MCP params$/);
		let reflected = false;
		const proxy = new Proxy(
			{ name: "conversation_get" },
			{
				getPrototypeOf() {
					reflected = true;
					return Object.prototype;
				},
				getOwnPropertyDescriptor() {
					reflected = true;
					return { enumerable: true, configurable: true, value: "conversation_get" };
				},
				get() {
					reflected = true;
					return "draft_discard";
				},
			},
		);
		expect(() => paramsDigest(proxy)).toThrow(/^Invalid MCP params$/);
		expect(() => paramsDigest({ nested: proxy })).toThrow(/^Invalid MCP params$/);
		expect(reflected).toBe(false);
	});
	it("rejects malformed or oversized data with fixed errors and never invokes getters", () => {
		let invoked = false;
		const accessor = Object.defineProperty({}, "body", {
			enumerable: true,
			get() {
				invoked = true;
				return "secret";
			},
		});
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const value of [
			null,
			[],
			1,
			new Date(),
			{ value: undefined },
			{ value: NaN },
			{ value: 1n },
			accessor,
			{ nested: accessor },
			cycle,
			{ body: "x".repeat(1_048_577) },
			{ body: "\ud800" },
			{ values: Array(3) },
		]) {
			expect(() => paramsDigest(value)).toThrow(/^Invalid MCP params$/);
		}
		expect(invoked).toBe(false);
		expect(
			paramsDigest(
				Object.defineProperty({}, "_meta", {
					enumerable: true,
					get() {
						invoked = true;
						return "ignored";
					},
				}),
			),
		).toBe(paramsDigest({}));
		expect(invoked).toBe(false);
	});
});
