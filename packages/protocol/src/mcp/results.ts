import * as z from "zod";
import {
	type UntrustedText,
	type UntrustedTextSchema,
	untrustedText,
	wellFormedText,
} from "../entities/common.ts";
import { ChatMessage } from "../entities/message/chat.ts";
import { EmailMessage } from "../entities/message/email.ts";
import { canonicalize } from "../jcs.ts";
import { MCP_MAX_PAGE_CHARS } from "./scopes.ts";
import {
	DRAFT_VIEW_URI,
	DraftViewInput,
	SEND_STATUS_VIEW_URI,
	SendStatusViewInput,
} from "./views.ts";

const ID = "[0-7][0-9A-HJKMNP-TV-Z]{25}";
export interface ResourceLink {
	readonly type: "resource_link";
	readonly uri: string;
	readonly name: string;
	readonly mimeType: "text/plain";
}

function resourceLink(kind: "draft" | "send-request"): z.ZodType<ResourceLink> {
	return z
		.strictObject({
			type: z.literal("resource_link"),
			uri: z
				.string()
				.regex(new RegExp(`^draftyak://${kind}/${ID}$`))
				.length(`draftyak://${kind}/`.length + 26),
			name: z
				.string()
				.regex(new RegExp(`^${kind}-${ID}$`))
				.length(kind.length + 27),
			mimeType: z.literal("text/plain"),
		})
		.refine(
			(value) =>
				value.uri.slice(value.uri.lastIndexOf("/") + 1) === value.name.slice(kind.length + 1),
			{
				path: ["name"],
				message: "link name must identify its resource",
			},
		);
}
export const DraftResourceLink: z.ZodType<ResourceLink> = resourceLink("draft").meta({
	id: "draftyak.mcp.DraftResourceLink",
});
export const SendRequestResourceLink: z.ZodType<ResourceLink> = resourceLink("send-request").meta({
	id: "draftyak.mcp.SendRequestResourceLink",
});

export interface TextMirror {
	readonly type: "text";
	readonly text: string;
}
export const TextMirror: z.ZodType<TextMirror> = z
	.strictObject({
		type: z.literal("text"),
		text: wellFormedText(MCP_MAX_PAGE_CHARS),
	})
	.meta({
		id: "draftyak.mcp.TextMirror",
		description:
			"The hub-produced delimited text mirror. The hub must spotlight untrusted fields and mirror any diff, using the same complete page budget.",
	});

export type McpEmailMessage = EmailMessage & { readonly body: UntrustedText };
export const McpEmailMessage: z.ZodObject<
	typeof EmailMessage.shape & { body: UntrustedTextSchema },
	z.core.$strict
> = EmailMessage.extend({ body: untrustedText(MCP_MAX_PAGE_CHARS) }).meta({
	id: "draftyak.mcp.McpEmailMessage",
	description:
		"The shared parsed email metadata and delivery provenance with its required untrusted plain-text body. A truncated body must say so; no attachment bytes or HTML are added.",
});
export type MessageGetContent = McpEmailMessage | ChatMessage;
export const MessageGetContent: z.ZodType<MessageGetContent> = z
	.discriminatedUnion("channel", [McpEmailMessage, ChatMessage])
	.meta({ id: "draftyak.mcp.MessageGetContent" });

function messageMirrorText(message: MessageGetContent): string {
	// This is deterministic JSON text, with extra escapes to keep data from closing the
	// fixed untrusted-data framing. It is not RFC 8785's canonical byte representation.
	const json = canonicalize(message)
		.replaceAll("<", "\\u003c")
		.replaceAll(">", "\\u003e")
		.replaceAll("&", "\\u0026")
		.replaceAll("\u2028", "\\u2028")
		.replaceAll("\u2029", "\\u2029");
	return `<untrusted-message-json>\n${json}\n</untrusted-message-json>`;
}

/** Construct the mirror of validated message data; the result still needs the combined cap. */
export function messageGetTextMirror(message: MessageGetContent): TextMirror {
	return TextMirror.parse({
		type: "text",
		text: messageMirrorText(MessageGetContent.parse(message)),
	});
}

function resultBudgetIssue(value: unknown): string | undefined {
	try {
		if ([...canonicalize(value)].length > MCP_MAX_PAGE_CHARS)
			return "structured data and text mirror exceed the combined page cap";
	} catch {
		return "result must contain canonical JSON data";
	}
	return undefined;
}

export interface MessageGetResult {
	readonly structuredContent: MessageGetContent;
	readonly content: readonly [TextMirror];
}
export const MessageGetResult: z.ZodType<MessageGetResult> = z
	.strictObject({ structuredContent: MessageGetContent, content: z.tuple([TextMirror]) })
	.superRefine((value, ctx) => {
		const budgetIssue = resultBudgetIssue(value);
		if (budgetIssue) ctx.addIssue({ code: "custom", message: budgetIssue });
		try {
			if (value.content[0].text !== messageMirrorText(value.structuredContent))
				ctx.addIssue({
					code: "custom",
					path: ["content", 0, "text"],
					message: "message text mirror must encode the complete returned message",
				});
		} catch {
			if (!budgetIssue)
				ctx.addIssue({ code: "custom", message: "result must contain canonical JSON data" });
		}
	})
	.meta({ id: "draftyak.mcp.MessageGetResult" });

export interface ResultMeta {
	readonly ui: {
		readonly resourceUri: typeof DRAFT_VIEW_URI | typeof SEND_STATUS_VIEW_URI;
		readonly visibility: readonly ["model"];
	};
}
const resultMeta = z.strictObject({
	ui: z.strictObject({
		resourceUri: z.enum([DRAFT_VIEW_URI, SEND_STATUS_VIEW_URI]),
		visibility: z.tuple([z.literal("model")]),
	}),
});
export interface SingleObjectResult<T> {
	readonly structuredContent: T;
	readonly content: readonly [TextMirror, ResourceLink];
	readonly _meta?: ResultMeta;
}

function result<T extends DraftViewInput | SendStatusViewInput>(
	data: z.ZodType<T>,
	kind: "draft" | "send-request",
): z.ZodType<SingleObjectResult<T>> {
	const link = kind === "draft" ? DraftResourceLink : SendRequestResourceLink;
	return z
		.strictObject({
			structuredContent: data,
			content: z.tuple([TextMirror, link]),
			_meta: resultMeta.optional(),
		})
		.superRefine((value, ctx) => {
			const body = value.structuredContent;
			const id = "draftId" in body ? body.draftId : body.sendRequestId;
			if (
				value.content[1].uri !== `draftyak://${kind}/${id}` ||
				value.content[1].name !== `${kind}-${id}`
			)
				ctx.addIssue({
					code: "custom",
					path: ["content", 1],
					message: "single-object link must identify its own result",
				});
			const view = kind === "draft" ? DRAFT_VIEW_URI : SEND_STATUS_VIEW_URI;
			if (value._meta && value._meta.ui.resourceUri !== view)
				ctx.addIssue({
					code: "custom",
					path: ["_meta", "ui", "resourceUri"],
					message: "view must match result kind",
				});
			const budgetIssue = resultBudgetIssue(value);
			if (budgetIssue) ctx.addIssue({ code: "custom", message: budgetIssue });
		});
}

export type DraftResult = SingleObjectResult<DraftViewInput>;
export const DraftResult: z.ZodType<DraftResult> = result(DraftViewInput, "draft").meta({
	id: "draftyak.mcp.DraftResult",
});
export const DraftUpdateResult: z.ZodType<DraftResult> = DraftResult.refine(
	(value) => value.structuredContent.diff !== undefined,
	{
		path: ["structuredContent", "diff"],
		message: "draft_update requires a word diff",
	},
).meta({
	id: "draftyak.mcp.DraftUpdateResult",
	allOf: [{ properties: { structuredContent: { required: ["diff"] } } }],
});

export type SendRequestResult = SingleObjectResult<SendStatusViewInput>;
export const SendRequestStatusResult: z.ZodType<SendRequestResult> = result(
	SendStatusViewInput,
	"send-request",
).meta({ id: "draftyak.mcp.SendRequestStatusResult" });
export const SendRequestCreateResult: z.ZodType<SendRequestResult> = SendRequestStatusResult.refine(
	(value) => value.structuredContent.status === "pending_approval",
	{
		path: ["structuredContent", "status"],
		message: "creation is a pending proposal only",
	},
).meta({
	id: "draftyak.mcp.SendRequestCreateResult",
	allOf: [
		{
			properties: { structuredContent: { properties: { status: { const: "pending_approval" } } } },
		},
	],
});
export const SendRequestCancelResult: z.ZodType<SendRequestResult> = SendRequestStatusResult.refine(
	(value) => value.structuredContent.status === "cancelled",
	{
		path: ["structuredContent", "status"],
		message: "cancellation cannot claim another state",
	},
).meta({
	id: "draftyak.mcp.SendRequestCancelResult",
	allOf: [
		{ properties: { structuredContent: { properties: { status: { const: "cancelled" } } } } },
	],
});

export const McpResultSchemas: Readonly<Record<string, z.ZodType>> = Object.freeze({
	DraftResourceLink,
	SendRequestResourceLink,
	TextMirror,
	McpEmailMessage,
	MessageGetContent,
	MessageGetResult,
	DraftResult,
	DraftUpdateResult,
	SendRequestCreateResult,
	SendRequestStatusResult,
	SendRequestCancelResult,
});
