import type * as z from "zod";
import { SchedulingStatus } from "../../src/hub-runtime.ts";

export const path = "schemas/hub-runtime-v1.schema.json";
export const schema: z.ZodType = SchedulingStatus;
