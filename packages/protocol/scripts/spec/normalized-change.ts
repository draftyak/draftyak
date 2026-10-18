import type * as z from "zod";
import { NormalizedChange } from "../../src/normalized-change.ts";

export const path = "schemas/normalized-change-v1.schema.json";
export const schema: z.ZodType = NormalizedChange;
