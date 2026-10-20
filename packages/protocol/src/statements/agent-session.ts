import * as z from "zod";
import { canonicalize } from "../jcs.ts";
import { ResourceUri, resourceReadTarget } from "../mcp/resources.ts";
import { AgentPrincipalRef, AgentToolClass } from "../mcp/scopes.ts";
import { MCP_TOOLS, McpToolName } from "../mcp/tools.ts";
import { Sha256Hex, Ulid } from "../scalars.ts";
import { baseFields, type DeviceStatementBase, withLifetime } from "./common.ts";

export const AGENT_SESSION_DURATIONS_MS: readonly [900_000, 3_600_000, 28_800_000] = Object.freeze([
	900_000, 3_600_000, 28_800_000,
] as const);
export const AGENT_CALL_TTL_MS = 600_000;

export const AgentSessionPrincipal: z.ZodType<AgentPrincipalRef> = AgentPrincipalRef;
export type AgentSessionPrincipal = AgentPrincipalRef;

// The signed grant starts when the hub accepts the statement, never from the challenge exp.
export type AgentSessionAuthorization =
	| { readonly kind: "session"; readonly durationMs: (typeof AGENT_SESSION_DURATIONS_MS)[number] }
	| {
			readonly kind: "call";
			readonly method: "tools/call" | "resources/read";
			readonly paramsDigest: string;
			readonly validForMs: 600000;
			readonly singleUse: true;
	  };
export const AgentSessionAuthorization: z.ZodType<AgentSessionAuthorization> = z.discriminatedUnion(
	"kind",
	[
		z.strictObject({
			kind: z.literal("session"),
			durationMs: z.union(AGENT_SESSION_DURATIONS_MS.map((duration) => z.literal(duration))),
		}),
		z.strictObject({
			kind: z.literal("call"),
			method: z.enum(["tools/call", "resources/read"]),
			paramsDigest: Sha256Hex,
			validForMs: z.literal(AGENT_CALL_TTL_MS),
			singleUse: z.literal(true),
		}),
	],
);

export interface AgentSessionStatement extends DeviceStatementBase {
	readonly session: string;
	readonly principal: AgentSessionPrincipal;
	readonly account: string;
	readonly toolClass: z.infer<typeof AgentToolClass>;
	readonly authorization: AgentSessionAuthorization;
}
export const AgentSessionStatement: z.ZodType<AgentSessionStatement> = withLifetime(
	z.strictObject({
		...baseFields,
		session: Ulid,
		principal: AgentSessionPrincipal,
		account: Ulid,
		toolClass: AgentToolClass,
		authorization: AgentSessionAuthorization,
	}),
).refine(
	(statement) =>
		statement.authorization.kind !== "call" ||
		statement.authorization.method !== "resources/read" ||
		statement.toolClass === "read",
	{ message: "resource reads require the read class" },
);

export const AgentSessionDefinition: {
	readonly typ: "agent-session.v1";
	readonly schema: typeof AgentSessionStatement;
} = Object.freeze({ typ: "agent-session.v1", schema: AgentSessionStatement });

const sessionChoice = z.strictObject({
	kind: z.literal("session"),
	durationMs: z.union(AGENT_SESSION_DURATIONS_MS.map((duration) => z.literal(duration))),
});
const callChoice = {
	kind: z.literal("call"),
	paramsDigest: Sha256Hex,
	validForMs: z.literal(AGENT_CALL_TTL_MS),
	singleUse: z.literal(true),
};
type ReviewAuthorization =
	| Extract<AgentSessionAuthorization, { kind: "session" }>
	| (Extract<AgentSessionAuthorization, { kind: "call" }> &
			(
				| { readonly method: "tools/call"; readonly target: McpToolName }
				| { readonly method: "resources/read"; readonly target: string }
			));
const reviewAuthorization: z.ZodType<ReviewAuthorization> = z.union([
	sessionChoice,
	z.strictObject({ ...callChoice, method: z.literal("tools/call"), target: McpToolName }),
	z.strictObject({ ...callChoice, method: z.literal("resources/read"), target: ResourceUri }),
]);

// The target is derived from the same immutable params whose digest the statement signs.
// It contains a fixed tool name or canonical resource URI, never mailbox text.
export interface AgentSessionReviewSubject {
	readonly principal: AgentSessionPrincipal;
	readonly account: string;
	readonly toolClass: z.infer<typeof AgentToolClass>;
	readonly authorization: ReviewAuthorization;
}
export const AgentSessionReviewSubject: z.ZodType<AgentSessionReviewSubject> = z
	.strictObject({
		principal: AgentSessionPrincipal,
		account: Ulid,
		toolClass: AgentToolClass,
		authorization: reviewAuthorization,
	})
	.refine(
		({ authorization, toolClass }) => {
			if (authorization.kind === "session") return true;
			if (authorization.method === "tools/call")
				return MCP_TOOLS[authorization.target].toolClass === toolClass;
			return toolClass === "read" && resourceReadTarget(authorization.target) !== null;
		},
		{ message: "review target must match the tool class" },
	);

const pendingSchema = z.strictObject({ session: Ulid, subject: AgentSessionReviewSubject });

/** Matches item fields only; signature, PIN, freshness and single use remain runtime checks. */
export function matchesAgentSessionPending(statement: unknown, pending: unknown): boolean {
	const signed = AgentSessionStatement.safeParse(statement);
	const record = pendingSchema.safeParse(pending);
	if (!signed.success || !record.success) return false;
	const { session, principal, account, toolClass, authorization } = signed.data;
	const subject = record.data.subject;
	const expected =
		subject.authorization.kind === "session"
			? subject.authorization
			: (({ target: _, ...fields }) => fields)(subject.authorization);
	return (
		session === record.data.session &&
		principal.kind === subject.principal.kind &&
		principal.id === subject.principal.id &&
		account === subject.account &&
		toolClass === subject.toolClass &&
		canonicalize(authorization) === canonicalize(expected)
	);
}
