import * as z from "zod";
import { toolV1Schema } from "../../src/tool-v1.ts";

export const path = "schemas/tool-v1.schema.json";

// The exporter adds the $schema and $id that toolV1Schema already holds, so the file is that
// document and the declaration's schemaDigest is its hash.
const { title, description, $defs } = toolV1Schema;
export const schema: z.ZodType = z.unknown().meta({ title, description, $defs });
