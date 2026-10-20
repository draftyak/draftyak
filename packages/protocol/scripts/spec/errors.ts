import type * as z from "zod";
import { PluginErrorResult } from "../../src/errors.ts";

export const path = "schemas/plugin-error-v1.schema.json";
export const schema: z.ZodType = PluginErrorResult;
