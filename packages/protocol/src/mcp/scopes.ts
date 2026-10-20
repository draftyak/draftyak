import * as z from "zod";
import { Ulid } from "../scalars.ts";

const scopes = ["inbox:read", "inbox:organize", "drafts:write", "outbox:propose"] as const;
export type McpScope = (typeof scopes)[number];
export const McpScope: z.ZodEnum<z.core.util.ToEnum<McpScope>> = z.enum(scopes);
const classes = ["read", "draft", "organize"] as const;
export type AgentToolClass = (typeof classes)[number];
export const AgentToolClass: z.ZodEnum<z.core.util.ToEnum<AgentToolClass>> = z.enum(classes);

export interface AgentPrincipalRef {
	readonly kind: "grant" | "token";
	readonly id: string;
}
export const AgentPrincipalRef: z.ZodType<AgentPrincipalRef> = z.strictObject({
	kind: z.enum(["grant", "token"]),
	id: Ulid,
});

export const MCP_MAX_PAGE_CHARS = 40_000;
export const MCP_MAX_PAGE_ESTIMATED_TOKENS = 20_000;
export const MCP_MAX_REQUEST_BYTES = 1_048_576;
