import type * as z from "zod";
import { aiProviderV1 } from "../../src/ai-provider-v1.ts";
import { extensionSchema } from "../../src/extension.ts";

export const path: string = aiProviderV1.path;
export const schema: z.ZodType = extensionSchema(aiProviderV1);
