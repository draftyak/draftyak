import * as z from "zod";
import { Draft, DraftRevision } from "./entities/draft.ts";

export interface CurrentDraft {
	readonly draft: Draft;
	readonly revision: DraftRevision;
}

/** A draft header and its current revision from one read, without granting authority. */
export const CurrentDraft: z.ZodType<CurrentDraft> = z
	.strictObject({ draft: Draft, revision: DraftRevision })
	.superRefine((current, context) => {
		if (current.draft.id !== current.revision.draftId) {
			context.addIssue({
				code: "custom",
				path: ["revision", "draftId"],
				message: "revision belongs to another draft",
			});
		}
		if (current.draft.rev !== current.revision.rev) {
			context.addIssue({
				code: "custom",
				path: ["revision", "rev"],
				message: "revision is not the draft's current revision",
			});
		}
	})
	.meta({
		id: "draftyak.draft-read.CurrentDraft",
		description:
			"A draft header and its current revision from one read. The draft ids and revision " +
			"numbers must match; the runtime validator checks that join. This data grants no authority.",
	});
