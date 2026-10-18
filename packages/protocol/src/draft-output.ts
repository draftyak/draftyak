import * as z from "zod";
import { wellFormedText, zodProblems } from "./extension.ts";

// A draft job's context ids, one per lookup that ran (§5 Prompt layout).
export const CONTEXT_IDS = ["c1", "c2", "c3"] as const;
export type ContextId = (typeof CONTEXT_IDS)[number];
export const ContextId: z.ZodEnum<z.core.util.ToEnum<ContextId>> = z.enum(CONTEXT_IDS);
// Distinct context ids, as a job lists them and a draft refers to them.
export const ContextIds: z.ZodType<ContextId[]> = z
	.array(ContextId)
	.max(CONTEXT_IDS.length)
	.refine((ids) => new Set(ids).size === ids.length, "repeats a context id")
	.meta({ uniqueItems: true });

// Structured outputs enforce no lengths, so these are stated in the instructions and checked here,
// in code points (M0.30's provisional limits).
export const DRAFT_OUTPUT_LIMITS = {
	body: 8_000,
	ownerNotes: 1_000,
	needsOwnerInput: 5,
	needsOwnerInputItem: 300,
} as const;

export interface DraftOutputV1 {
	readonly body: string;
	readonly ownerNotes: string;
	readonly needsOwnerInput: readonly string[];
	readonly suspectedInstructions: boolean;
	readonly contextRefs: readonly ContextId[];
}

// Body only: the hub computes recipients, the subject, threading and attachments (§5 Output).
export const DraftOutputV1: z.ZodType<DraftOutputV1> = z
	.strictObject({
		body: wellFormedText(DRAFT_OUTPUT_LIMITS.body),
		ownerNotes: wellFormedText(DRAFT_OUTPUT_LIMITS.ownerNotes),
		needsOwnerInput: z
			.array(wellFormedText(DRAFT_OUTPUT_LIMITS.needsOwnerInputItem))
			.max(DRAFT_OUTPUT_LIMITS.needsOwnerInput),
		suspectedInstructions: z.boolean(),
		contextRefs: ContextIds,
	})
	.meta({
		title: "DraftOutputV1",
		description: "A model's draft: the reply body and notes for the owner.",
	});

export type DraftOutputCheck =
	| { readonly ok: true; readonly output: DraftOutputV1 }
	| { readonly ok: false; readonly problems: readonly string[] };

// An invalid outcome carries at most this many problems.
export const MAX_DRAFT_PROBLEMS = 20;

// Problems name paths and issue codes, never the content: the first MAX_DRAFT_PROBLEMS of them,
// as an invalid outcome carries them.
export function validateDraftOutput(value: unknown): DraftOutputCheck {
	const result = DraftOutputV1.safeParse(value);
	if (result.success) return { ok: true, output: result.data };
	const problems = zodProblems(result.error.issues, "output");
	return { ok: false, problems: problems.slice(0, MAX_DRAFT_PROBLEMS) };
}

// contextRefs is informational, so it never fails a draft: what isn't one of the job's ids, with
// case ignored, is dropped, repeats too, and the rest follow the job's order; a missing or
// malformed list becomes empty. Everything else is left for validateDraftOutput.
export function normalizeDraftOutput<T>(value: T, contextIds: readonly ContextId[]): T {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const refs: unknown = (value as { contextRefs?: unknown }).contextRefs;
	const named = new Set(
		(Array.isArray(refs) ? refs : []).flatMap((ref) =>
			typeof ref === "string" ? [ref.toLowerCase()] : [],
		),
	);
	return { ...value, contextRefs: contextIds.filter((id) => named.has(id)) };
}
