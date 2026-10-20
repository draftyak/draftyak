import type * as z from "zod";
import { PluginManifestV1 } from "../../src/manifest.ts";

export const path = "plugin-manifest-v1.schema.json";
export const schema: z.ZodType = PluginManifestV1;
