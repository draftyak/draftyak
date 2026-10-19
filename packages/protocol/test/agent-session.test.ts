import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { example } from "../scripts/vectors/statements/agent-session.ts";
import { canonicalize } from "../src/jcs.ts";
import { MCP_TOOLS } from "../src/mcp/tools.ts";
import { signStatement } from "../src/sign.ts";
import {
	AGENT_CALL_TTL_MS,
	AGENT_SESSION_DURATIONS_MS,
	AgentSessionReviewSubject,
	AgentSessionStatement,
	matchesAgentSessionPending,
} from "../src/statements/agent-session.ts";
import {
	isFresh,
	openTypedStatement,
	parseStatement,
	StatementSchemas,
} from "../src/statements.ts";

const base = AgentSessionStatement.parse(example());
const call = {
	kind: "call",
	method: "tools/call",
	paramsDigest: "b".repeat(64),
	validForMs: AGENT_CALL_TTL_MS,
	singleUse: true,
};

describe("signed agent session authorization", () => {
	it("keeps the accepted duration choices and statement catalog immutable", () => {
		expect(Object.isFrozen(AGENT_SESSION_DURATIONS_MS)).toBe(true);
		expect(Reflect.set(AGENT_SESSION_DURATIONS_MS, 0, 600_000)).toBe(false);
		expect(Reflect.set(AGENT_SESSION_DURATIONS_MS, 3, 86_400_000)).toBe(false);
		expect(AGENT_SESSION_DURATIONS_MS).toEqual([900_000, 3_600_000, 28_800_000]);
		expect(Object.isFrozen(StatementSchemas)).toBe(true);
		expect(Reflect.set(StatementSchemas, "agent-session.v1", undefined)).toBe(false);
	});
	it("binds principal, operation, account, class and exact-call data to the typed signature", () => {
		const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const statement = AgentSessionStatement.parse({ ...base, authorization: call });
		const signature = signStatement("agent-session.v1", statement, key.privateKey);
		const open = (value: unknown) =>
			openTypedStatement(
				"agent-session.v1",
				Buffer.from(canonicalize(value)),
				signature,
				key.publicKey,
			);
		expect(open(statement)).toEqual(statement);
		for (const change of [
			{ session: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
			{ principal: { kind: "token", id: base.session } },
			{ principal: { kind: "grant", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } },
			{ account: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
			{ toolClass: "draft" },
			{ epoch: 2 },
			{ device: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
			{ authorization: { ...call, method: "resources/read" } },
			{ authorization: { ...call, paramsDigest: "c".repeat(64) } },
		])
			expect(open({ ...statement, ...change })).toBeUndefined();
		expect(
			openTypedStatement(
				"login.v1",
				Buffer.from(canonicalize(statement)),
				signature,
				key.publicKey,
			),
		).toBeUndefined();
	});
	it("never extends signing freshness to the chosen access duration or per-call lifetime", () => {
		for (const authorization of [{ kind: "session", durationMs: 28_800_000 }, call]) {
			const statement = AgentSessionStatement.parse({ ...base, authorization });
			expect(isFresh(statement, statement.iat - 1)).toBe(false);
			expect(isFresh(statement, statement.iat)).toBe(true);
			expect(isFresh(statement, statement.exp)).toBe(true);
			for (const now of [
				statement.exp + 1,
				statement.iat + 600_000,
				statement.iat + 28_800_000,
				-1,
				0.5,
				NaN,
				Infinity,
				Number.MAX_SAFE_INTEGER + 1,
			])
				expect(isFresh(statement, now)).toBe(false);
		}
	});
	for (const kind of ["grant", "token"] as const) {
		for (const toolClass of ["read", "draft", "organize"] as const) {
			for (const durationMs of AGENT_SESSION_DURATIONS_MS) {
				it(`binds ${kind}/${toolClass} for ${durationMs}ms without extending challenge expiry`, () => {
					const body = AgentSessionStatement.parse({
						...base,
						principal: { kind, id: base.session },
						toolClass,
						authorization: { kind: "session", durationMs },
					});
					expect(body.exp - body.iat).toBe(120000);
					expect(isFresh(body, body.exp)).toBe(true);
					expect(isFresh(body, body.exp + 1)).toBe(false);
					expect(parseStatement("agent-session.v1", Buffer.from(canonicalize(body)))).toEqual(body);
				});
			}
		}
	}
	it.each(["read", "draft", "organize"])("accepts a single tools/call bound to %s", (toolClass) => {
		expect(
			AgentSessionStatement.safeParse({ ...base, toolClass, authorization: call }).success,
		).toBe(true);
	});
	it("accepts resources/read only in the read class", () => {
		for (const toolClass of ["read", "draft", "organize"]) {
			expect(
				AgentSessionStatement.safeParse({
					...base,
					toolClass,
					authorization: { ...call, method: "resources/read" },
				}).success,
			).toBe(toolClass === "read");
		}
	});
	it.each([
		{ session: "not-an-id" },
		{ account: "not-an-id" },
		{ principal: { kind: "device", id: base.session } },
		{ principal: { kind: "host:sms", id: base.session } },
		{ principal: { kind: "token", id: "not-an-id" } },
		{ principal: { kind: "token", id: base.session, scopes: ["inbox:read"] } },
		{ toolClass: "send" },
		{ toolClass: "admin" },
		{ exp: Number(base.iat) + 120001 },
		{ iat: -1 },
		{ iat: 0.5 },
		{ exp: Number(base.iat) - 1 },
		{ exp: Number.MAX_SAFE_INTEGER + 1 },
		{ scopes: ["approve"] },
		{ approved: true },
		{ authorization: { kind: "session", durationMs: 900000, approved: true } },
		{ principal: { kind: "token", id: base.session, accounts: [base.account] } },
		{ authorization: { kind: "session", durationMs: 0 } },
		{ authorization: { kind: "session", durationMs: 900001 } },
		{ authorization: { kind: "session", durationMs: 28800001 } },
		{ authorization: { kind: "session", durationMs: Infinity } },
		{ authorization: { kind: "session", durationMs: 900000, paramsDigest: "b".repeat(64) } },
		{ authorization: { ...call, singleUse: false } },
		{ authorization: { ...call, validForMs: 599999 } },
		{ authorization: { ...call, validForMs: 600001 } },
		{ authorization: { ...call, paramsDigest: "B".repeat(64) } },
		{ authorization: { ...call, method: "prompts/get" } },
		{ authorization: { ...call, method: "channel_send" } },
		{ authorization: { ...call, durationMs: 900000 } },
		{ authorization: { kind: "call", method: "tools/call", validForMs: 600000, singleUse: true } },
		{
			authorization: {
				kind: "call",
				method: "tools/call",
				paramsDigest: "b".repeat(64),
				singleUse: true,
			},
		},
		{
			authorization: {
				kind: "call",
				method: "tools/call",
				paramsDigest: "b".repeat(64),
				validForMs: 600000,
			},
		},
	])("refuses malformed or widening authorization %j", (change) => {
		expect(AgentSessionStatement.safeParse({ ...base, ...change }).success).toBe(false);
	});
});

describe("session review and pending-record binding", () => {
	const subject = {
		principal: base.principal,
		account: base.account,
		toolClass: "read",
		authorization: { ...call, target: "message_get" },
	};
	const pending = { session: base.session, subject };
	const statement = { ...base, authorization: call };
	it("accepts the displayed duration or exact method and target without mailbox text", () => {
		for (const durationMs of AGENT_SESSION_DURATIONS_MS) {
			const authorization = { kind: "session", durationMs };
			const review = { ...subject, authorization };
			expect(AgentSessionReviewSubject.safeParse(review).success).toBe(true);
			expect(
				matchesAgentSessionPending({ ...base, authorization }, { ...pending, subject: review }),
			).toBe(true);
		}
		for (const [target, policy] of Object.entries(MCP_TOOLS)) {
			const review = {
				...subject,
				toolClass: policy.toolClass,
				authorization: { ...call, target },
			};
			expect(AgentSessionReviewSubject.safeParse(review).success).toBe(true);
			expect(
				matchesAgentSessionPending(
					{ ...statement, toolClass: policy.toolClass },
					{ ...pending, subject: review },
				),
			).toBe(true);
		}
		for (const kind of ["conversation", "message", "draft", "send-request"]) {
			const authorization = { ...call, method: "resources/read" };
			const review = {
				...subject,
				authorization: { ...authorization, target: `draftyak://${kind}/${base.account}` },
			};
			expect(AgentSessionReviewSubject.safeParse(review).success).toBe(true);
			expect(
				matchesAgentSessionPending(
					{ ...statement, authorization },
					{ ...pending, subject: review },
				),
			).toBe(true);
		}
	});
	it("refuses unknown or inconsistent review fields and targets", () => {
		for (const review of [
			{ ...subject, context: "PRIVATE_BODY_CANARY" },
			{ ...subject, authorization: { ...subject.authorization, context: "PRIVATE_BODY_CANARY" } },
			{ ...subject, authorization: { ...subject.authorization, target: "PRIVATE_SUBJECT_CANARY" } },
			{ ...subject, authorization: { ...subject.authorization, target: "draft_update" } },
			{ ...subject, authorization: call },
			{ ...subject, authorization: { kind: "session", durationMs: 900000, target: "message_get" } },
			{
				...subject,
				authorization: { ...call, method: "resources/read", target: "draftyak://guide/agents" },
			},
			{
				...subject,
				authorization: { ...call, method: "resources/read", target: "ui://draftyak/draft-v1" },
			},
			{
				...subject,
				authorization: {
					...call,
					method: "resources/read",
					target: `draftyak://message/${base.account}?content=x`,
				},
			},
		]) {
			expect(AgentSessionReviewSubject.safeParse(review).success).toBe(false);
			expect(matchesAgentSessionPending(statement, { ...pending, subject: review })).toBe(false);
		}
	});
	it("matches every signed item field against the pending record", () => {
		expect(matchesAgentSessionPending(statement, pending)).toBe(true);
		for (const change of [
			{ session: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
			{ principal: { kind: "token", id: subject.principal.id } },
			{ principal: { kind: "grant", id: "01ARZ3NDEKTSV4RRFFQ69G5FAV" } },
			{ account: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
			{ toolClass: "organize" },
			{ authorization: { ...call, method: "resources/read" } },
			{ authorization: { ...call, paramsDigest: "c".repeat(64) } },
			{ authorization: { kind: "session", durationMs: 900000 } },
			{ approved: true },
		])
			expect(matchesAgentSessionPending({ ...statement, ...change }, pending)).toBe(false);
		expect(matchesAgentSessionPending(statement, { ...pending, approved: true })).toBe(false);
		const authorization = { kind: "session", durationMs: 900000 };
		const durationPending = { ...pending, subject: { ...subject, authorization } };
		expect(matchesAgentSessionPending({ ...base, authorization }, durationPending)).toBe(true);
		expect(
			matchesAgentSessionPending(
				{ ...base, authorization: { ...authorization, durationMs: 3600000 } },
				durationPending,
			),
		).toBe(false);
	});
});
