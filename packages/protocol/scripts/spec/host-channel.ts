import type * as z from "zod";
import { HostMessage } from "../../src/host-channel.ts";

export const path = "schemas/host-channel-v1.schema.json";
export const schema: z.ZodType = HostMessage;
