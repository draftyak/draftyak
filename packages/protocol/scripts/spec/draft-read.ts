import type * as z from "zod";
import { CurrentDraft } from "../../src/draft-read.ts";

export const path = "schemas/draft-read-v1.schema.json";
export const schema: z.ZodType = CurrentDraft;
