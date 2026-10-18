import type * as z from "zod";
import { channelV1 } from "../../src/channel-v1.ts";
import { extensionSchema } from "../../src/extension.ts";

export const path: string = channelV1.path;
export const schema: z.ZodType = extensionSchema(channelV1);
