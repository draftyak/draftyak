import type * as z from "zod";
import { SendSnapshotV1 } from "../../src/snapshot.ts";
export const path = "schemas/snapshot-v1.schema.json";
export const schema: z.ZodType = SendSnapshotV1;
