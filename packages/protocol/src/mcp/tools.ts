import * as z from "zod";
import type { AgentToolClass, McpScope } from "./scopes.ts";

const names = [
	"accounts_list",
	"contacts_search",
	"conversation_get",
	"conversations_list",
	"draft_get",
	"drafts_list",
	"message_get",
	"messages_search",
	"conversation_archive",
	"conversation_label",
	"conversation_mark_read",
	"draft_create",
	"draft_update",
	"draft_discard",
	"send_request_create",
	"send_request_cancel",
	"send_request_status",
] as const;
export type McpToolName = (typeof names)[number];
export const McpToolName: z.ZodEnum<z.core.util.ToEnum<McpToolName>> = z.enum(names);
export interface McpToolHints {
	readonly readOnlyHint: boolean;
	readonly destructiveHint: boolean;
	readonly idempotentHint: boolean;
	readonly openWorldHint: boolean;
}
export interface McpToolPolicy {
	readonly title: string;
	readonly scope: McpScope;
	readonly toolClass: AgentToolClass;
	readonly annotations: McpToolHints;
}
const hints = (read: boolean, destructive = false, open = false): McpToolHints =>
	Object.freeze({
		readOnlyHint: read,
		destructiveHint: destructive,
		idempotentHint: true,
		openWorldHint: open,
	});
const read = hints(true),
	write = hints(false),
	discard = hints(false, true),
	propose = hints(false, true, true);
const policy = (
	title: string,
	scope: McpScope,
	toolClass: AgentToolClass,
	annotations: McpToolHints,
): McpToolPolicy => Object.freeze({ title, scope, toolClass, annotations });

// The catalogue grants no authority: the hub must intersect the scope, account routing,
// current device-approved session and budgets for every invocation, including resources.
export const MCP_TOOLS: Readonly<Record<McpToolName, McpToolPolicy>> = Object.freeze({
	accounts_list: policy("List accounts", "inbox:read", "read", read),
	contacts_search: policy("Search contacts", "inbox:read", "read", read),
	conversation_get: policy("Read conversation", "inbox:read", "read", read),
	conversations_list: policy("List conversations", "inbox:read", "read", read),
	draft_get: policy("Read draft", "inbox:read", "read", read),
	drafts_list: policy("List drafts", "inbox:read", "read", read),
	message_get: policy("Read message", "inbox:read", "read", read),
	messages_search: policy("Search messages", "inbox:read", "read", read),
	conversation_archive: policy("Archive conversation", "inbox:organize", "organize", write),
	conversation_label: policy("Label conversation", "inbox:organize", "organize", write),
	conversation_mark_read: policy("Mark conversation read", "inbox:organize", "organize", write),
	draft_create: policy("Create draft", "drafts:write", "draft", write),
	draft_update: policy("Update draft", "drafts:write", "draft", write),
	draft_discard: policy("Discard draft", "drafts:write", "draft", discard),
	send_request_create: policy("Request send approval", "outbox:propose", "draft", propose),
	send_request_cancel: policy("Cancel own send request", "outbox:propose", "draft", write),
	send_request_status: policy("Read send request status", "outbox:propose", "read", read),
});
