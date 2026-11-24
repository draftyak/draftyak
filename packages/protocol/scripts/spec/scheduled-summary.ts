import type * as z from "zod";
import { ScheduledSummary } from "../../src/scheduled-summary.ts";

export const path = "schemas/scheduled-summary-v1.schema.json";
export const schema: z.ZodType = ScheduledSummary;
