import * as z from "zod";
import { ContextIds } from "../draft-output.ts";
import { Provenance, untrustedText, wellFormedText } from "../entities/common.ts";
import { DraftAuthor } from "../entities/draft.ts";
import { StateReason } from "../entities/outbox.ts";
import { IanaZone } from "../entities/settings.ts";
import { Flags } from "../flags.ts";
import { Alias, Ulid, UtcMs } from "../scalars.ts";

export const DRAFT_VIEW_URI = "ui://draftyak/draft-v1";
export const SEND_STATUS_VIEW_URI = "ui://draftyak/send-status-v1";
export const DRAFT_RELIABILITY_NOTICE = "AI can make mistakes. Review this draft before approving.";
export const SEND_APPROVAL_NOTICE = "Approve on your paired desktop with your PIN";
export const McpFlags: z.ZodType<z.infer<typeof Flags>> = Flags.max(64)
	.refine(
		(flags) =>
			flags.every((flag) => !flag.code.startsWith("TOOL_") || !Object.hasOwn(flag, "detail")),
		"tool flags carry codes and severity only",
	)
	.meta({
		id: "draftyak.mcp.McpFlags",
		allOf: [
			{ items: { not: { required: ["detail"], properties: { code: { pattern: "^TOOL_" } } } } },
		],
	});

export const SEND_REQUEST_STATES = [
	"pending_approval",
	"approved",
	"scheduled",
	"sending",
	"retry_wait",
	"unknown",
	"sent",
	"failed",
	"needs_reapproval",
	"cancelled",
	"rejected",
	"superseded",
	"expired",
] as const;
Object.freeze(SEND_REQUEST_STATES);
export type SendRequestState = (typeof SEND_REQUEST_STATES)[number];
export const SendRequestState: z.ZodEnum<z.core.util.ToEnum<SendRequestState>> =
	z.enum(SEND_REQUEST_STATES);
export const SendRequestFingerprint: z.ZodString = z
	.string()
	.length(8)
	.regex(/^[0-9A-F]{8}$/);

export interface SendStatusViewInput {
	readonly sendRequestId: string;
	readonly status: SendRequestState;
	readonly fingerprint: string;
	readonly reason?: StateReason;
	readonly notBefore?: number;
	readonly deliverBy?: number;
	readonly zone?: string;
	readonly approvalNotice: typeof SEND_APPROVAL_NOTICE;
}

export const SendStatusViewInput: z.ZodType<SendStatusViewInput> = z
	.strictObject({
		sendRequestId: Ulid,
		status: SendRequestState,
		fingerprint: SendRequestFingerprint,
		reason: StateReason.optional(),
		notBefore: UtcMs.optional(),
		deliverBy: UtcMs.optional(),
		zone: IanaZone.optional(),
		approvalNotice: z.literal(SEND_APPROVAL_NOTICE),
	})
	.superRefine((value, ctx) => {
		if ((value.status === "needs_reapproval") !== (value.reason !== undefined))
			ctx.addIssue({
				code: "custom",
				path: ["reason"],
				message: "reason belongs only to needs_reapproval",
			});
		if ((value.notBefore !== undefined) !== (value.zone !== undefined))
			ctx.addIssue({
				code: "custom",
				path: ["zone"],
				message: "scheduled instant and zone are paired",
			});
		if (
			value.deliverBy !== undefined &&
			(value.notBefore === undefined || value.deliverBy <= value.notBefore)
		)
			ctx.addIssue({
				code: "custom",
				path: ["deliverBy"],
				message: "deadline must follow scheduled instant",
			});
		if (
			value.status === "scheduled" &&
			(value.notBefore === undefined || value.deliverBy === undefined)
		)
			ctx.addIssue({
				code: "custom",
				path: ["status"],
				message: "scheduled state needs a complete window",
			});
	})
	.meta({
		id: "draftyak.mcp.SendStatusViewInput",
		description:
			"Passive send status, not approval authority. Scheduled proposal creation may omit deliverBy until a window is frozen.",
		allOf: [
			{
				if: { properties: { status: { const: "needs_reapproval" } } },
				// biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
				then: { required: ["reason"] },
				else: { not: { required: ["reason"] } },
			},
			{
				dependentRequired: {
					notBefore: ["zone"],
					zone: ["notBefore"],
					deliverBy: ["notBefore", "zone"],
				},
			},
			{
				if: { properties: { status: { const: "scheduled" } } },
				// biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
				then: { required: ["notBefore", "deliverBy", "zone"] },
			},
		],
	});

export interface WordDiffPart {
	readonly op: "equal" | "insert" | "delete";
	readonly text: { untrusted: true; text: string };
}
export interface WordDiff {
	readonly kind: "word";
	readonly fromRevision: number;
	readonly toRevision: number;
	readonly parts: readonly WordDiffPart[];
}

const part = z.strictObject({
	op: z.enum(["equal", "insert", "delete"]),
	text: z.strictObject({ untrusted: z.literal(true), text: wellFormedText(40_000).min(1) }),
});

function wholeWords(parts: readonly WordDiffPart[], omit: WordDiffPart["op"]): boolean {
	const selected = parts.filter((item) => item.op !== omit);
	return selected.every(
		(item, index) =>
			index === 0 ||
			!(
				/[\p{L}\p{M}\p{N}_]$/u.test(selected[index - 1]?.text.text ?? "") &&
				/^[\p{L}\p{M}\p{N}_]/u.test(item.text.text)
			),
	);
}

export const WordDiff: z.ZodType<WordDiff> = z
	.strictObject({
		kind: z.literal("word"),
		fromRevision: z.int().min(1),
		toRevision: z.int().min(2),
		parts: z.array(part).max(4096),
	})
	.superRefine((value, ctx) => {
		if (value.toRevision !== value.fromRevision + 1)
			ctx.addIssue({
				code: "custom",
				path: ["fromRevision"],
				message: "diff must name the previous revision",
			});
		if (value.parts.some((item, index) => index > 0 && item.op === value.parts[index - 1]?.op))
			ctx.addIssue({
				code: "custom",
				path: ["parts"],
				message: "merge adjacent spans of the same operation",
			});
		if (!wholeWords(value.parts, "insert") || !wholeWords(value.parts, "delete"))
			ctx.addIssue({
				code: "custom",
				path: ["parts"],
				message: "diff boundaries must not split words",
			});
		if (value.parts.reduce((sum, item) => sum + [...item.text.text].length, 0) > 40_000)
			ctx.addIssue({ code: "custom", path: ["parts"], message: "diff exceeds its text bound" });
	})
	.meta({
		id: "draftyak.mcp.WordDiff",
		description:
			"Complete word-level spans against the immediately preceding immutable revision; all text is untrusted data.",
	});

export interface DraftViewInput {
	readonly draftId: string;
	readonly accountId: string;
	readonly account: string;
	readonly channel: "email" | "chat";
	readonly revision: number;
	readonly body: { untrusted: true; text: string; truncated?: true };
	readonly flags: z.infer<typeof Flags>;
	readonly contextRefs: z.infer<typeof ContextIds>;
	readonly provenance: { readonly author: DraftAuthor; readonly source?: Provenance };
	readonly reliabilityNotice: typeof DRAFT_RELIABILITY_NOTICE | null;
	readonly sendRequest?: SendStatusViewInput;
	readonly diff?: WordDiff;
}

/** The producer must supply both actual persisted revisions, never bodies from the requester. */
export function checkWordDiffSources(
	diff: unknown,
	previousBody: string,
	currentBody: string,
): boolean {
	const checked = WordDiff.safeParse(diff);
	if (!checked.success) return false;
	const source = (omit: WordDiffPart["op"]): string =>
		checked.data.parts
			.filter((item) => item.op !== omit)
			.map((item) => item.text.text)
			.join("");
	return source("insert") === previousBody && source("delete") === currentBody;
}

export const DraftViewInput: z.ZodType<DraftViewInput> = z
	.strictObject({
		draftId: Ulid,
		accountId: Ulid,
		account: Alias,
		channel: z.enum(["email", "chat"]),
		revision: z.int().min(1),
		body: untrustedText(40_000),
		flags: McpFlags,
		contextRefs: ContextIds,
		provenance: z.strictObject({ author: DraftAuthor, source: Provenance.optional() }),
		reliabilityNotice: z.literal(DRAFT_RELIABILITY_NOTICE).nullable(),
		sendRequest: SendStatusViewInput.optional(),
		diff: WordDiff.optional(),
	})
	.superRefine((value, ctx) => {
		if (
			value.provenance.author.kind === "agent" &&
			!value.flags.some((flag) => flag.code === "AGENT_AUTHORED")
		)
			ctx.addIssue({
				code: "custom",
				path: ["flags"],
				message: "agent revision requires AGENT_AUTHORED",
			});
		const automated =
			value.provenance.author.kind === "ai" || value.provenance.author.kind === "agent";
		if (automated !== (value.reliabilityNotice !== null))
			ctx.addIssue({
				code: "custom",
				path: ["reliabilityNotice"],
				message: "notice must match revision provenance",
			});
		if (
			value.diff &&
			(value.diff.toRevision !== value.revision ||
				value.body.truncated === true ||
				value.diff.parts
					.filter((item) => item.op !== "delete")
					.map((item) => item.text.text)
					.join("") !== value.body.text)
		)
			ctx.addIssue({
				code: "custom",
				path: ["diff"],
				message: "diff must reconstruct the complete current revision",
			});
	})
	.meta({
		id: "draftyak.mcp.DraftViewInput",
		description:
			"Passive draft projection. Context is limited to contextRefs and closed TOOL_* flags; lookup results, owner notes and controls have no field. Known fields alone may be projected into a future text-only view.",
		allOf: [
			{
				if: {
					properties: {
						provenance: {
							properties: { author: { properties: { kind: { enum: ["ai", "agent"] } } } },
						},
					},
				},
				// biome-ignore lint/suspicious/noThenProperty: JSON Schema conditional keyword, not a thenable.
				then: { properties: { reliabilityNotice: { const: DRAFT_RELIABILITY_NOTICE } } },
				else: { properties: { reliabilityNotice: { type: "null" } } },
			},
		],
	});

// Namespaced schema exports are kept together for the shared declarative schema exporter.
export const McpViewSchemas: Readonly<Record<string, z.ZodType>> = Object.freeze({
	McpFlags,
	SendRequestState,
	SendRequestFingerprint,
	SendStatusViewInput,
	WordDiff,
	DraftViewInput,
});
