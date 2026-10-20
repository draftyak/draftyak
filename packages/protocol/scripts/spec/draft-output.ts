import type * as z from "zod";
import { DraftOutputV1 } from "../../src/draft-output.ts";

export const path = "schemas/draft-output-v1.schema.json";
export const schema: z.ZodType = DraftOutputV1;
