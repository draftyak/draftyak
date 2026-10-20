import type * as z from "zod";
import { Flags } from "../../src/flags.ts";

export const path = "schemas/flags-v1.schema.json";
export const schema: z.ZodType = Flags;
