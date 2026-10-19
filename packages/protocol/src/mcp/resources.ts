import * as z from "zod";
import { boundedText, Ulid } from "../scalars.ts";
import type { McpScope } from "./scopes.ts";

export const GUIDE_URI = "draftyak://guide/agents";
export const UI_RESOURCE_URIS: readonly ["ui://draftyak/draft-v1", "ui://draftyak/send-status-v1"] =
	Object.freeze(["ui://draftyak/draft-v1", "ui://draftyak/send-status-v1"]);
export const AgentGuideText: z.ZodString = boundedText(8000);
export type ResourceKind = "conversation" | "message" | "draft" | "send-request";
export interface ResourceTemplate {
	readonly kind: ResourceKind;
	readonly uriTemplate: string;
	readonly handler: "conversation_get" | "message_get" | "draft_get" | "send_request_status";
	readonly scope: "inbox:read" | "outbox:propose";
	readonly toolClass: "read";
}
const templates: readonly ResourceTemplate[] = [
	{
		kind: "conversation",
		uriTemplate: "draftyak://conversation/{id}",
		handler: "conversation_get",
		scope: "inbox:read",
		toolClass: "read",
	},
	{
		kind: "message",
		uriTemplate: "draftyak://message/{id}",
		handler: "message_get",
		scope: "inbox:read",
		toolClass: "read",
	},
	{
		kind: "draft",
		uriTemplate: "draftyak://draft/{id}",
		handler: "draft_get",
		scope: "inbox:read",
		toolClass: "read",
	},
	{
		kind: "send-request",
		uriTemplate: "draftyak://send-request/{id}",
		handler: "send_request_status",
		scope: "outbox:propose",
		toolClass: "read",
	},
];
export const RESOURCE_TEMPLATES: readonly ResourceTemplate[] = Object.freeze(
	templates.map((template) => Object.freeze(template)),
);
export type ResourceReference =
	| { readonly kind: "guide" }
	| { readonly kind: "ui"; readonly view: "draft-v1" | "send-status-v1" }
	| { readonly kind: ResourceKind; readonly id: string };

// Check the bytes before any WHATWG URL normalization can erase forbidden spellings.
const ITEM =
	/^draftyak:\/\/(conversation|message|draft|send-request)\/([0-7][0-9A-HJKMNP-TV-Z]{25})$/;
const itemUri = (kind: ResourceKind) =>
	z
		.string()
		.length(`draftyak://${kind}/`.length + 26)
		.regex(new RegExp(`^draftyak://${kind}/[0-7][0-9A-HJKMNP-TV-Z]{25}$`));
export const ResourceUri: z.ZodType<string> = z.union([
	z.literal(GUIDE_URI),
	z.enum(UI_RESOURCE_URIS),
	itemUri("conversation"),
	itemUri("message"),
	itemUri("draft"),
	itemUri("send-request"),
]);
export type ResourceUri = z.infer<typeof ResourceUri>;
export const ResourceReadRequest: z.ZodType<{ uri: string }> = z.strictObject({ uri: ResourceUri });

export function parseResourceUri(raw: unknown): ResourceReference {
	const parsed = ResourceUri.safeParse(raw);
	if (!parsed.success) throw new Error("Resource URI refused");
	const value = parsed.data;
	if (value === GUIDE_URI) return { kind: "guide" };
	if (value === UI_RESOURCE_URIS[0]) return { kind: "ui", view: "draft-v1" };
	if (value === UI_RESOURCE_URIS[1]) return { kind: "ui", view: "send-status-v1" };
	const match = ITEM.exec(value);
	if (!match) throw new Error("Resource URI refused");
	return { kind: match[1] as ResourceKind, id: Ulid.parse(match[2]) };
}

/** Authentication and account/session policy remain mandatory at the hub. */
export function resourceTemplatesFor(
	scopes: readonly McpScope[],
): (typeof RESOURCE_TEMPLATES)[number][] {
	return RESOURCE_TEMPLATES.filter((template) => scopes.includes(template.scope));
}

export interface ResourceReadTarget {
	readonly handler: (typeof RESOURCE_TEMPLATES)[number]["handler"];
	readonly id: string;
	readonly scope: McpScope;
	readonly toolClass: "read";
}
export function resourceReadTarget(raw: unknown): ResourceReadTarget | null {
	const reference = parseResourceUri(raw);
	if (reference.kind === "guide" || reference.kind === "ui") return null;
	const template = RESOURCE_TEMPLATES.find((item) => item.kind === reference.kind);
	if (!template) throw new Error("Resource URI refused");
	return {
		handler: template.handler,
		id: reference.id,
		scope: template.scope,
		toolClass: template.toolClass,
	};
}

// Only the guide is enumerable. Views are fetched by URI after their separate capability gate.
export const LISTED_RESOURCE_URIS: readonly ["draftyak://guide/agents"] = Object.freeze([
	GUIDE_URI,
]);
export const RESOURCE_SUBSCRIPTIONS = false;
