import * as z from "zod";
import { valuesByName } from "../../src/entities/fields.ts";
import * as entities from "../../src/entities.ts";

export const path = "schemas/entities-v1.schema.json";

// A definition the entity modules re-export from another module keeps that module's id, so it
// sits under $defs only where an entity uses it, never in the root's list.
const foreign = (schema: z.ZodType): boolean =>
	/^draftyak\.(?!entities\.)/.test(z.globalRegistry.get(schema)?.id ?? "");

// Every exported schema sits under $defs by its id. The root refuses every document, so a
// validator always picks the definition that names what it checks.
const definitions = valuesByName(entities)
	.filter((value) => value instanceof z.ZodType)
	.filter((schema) => !foreign(schema));

export const schema: z.ZodType = z.union(definitions).meta({
	not: {},
	title: "DraftYak entities v1",
	description:
		"The shapes the hub stores and shows across its API, MCP and the desktop. The root accepts " +
		"nothing: validate a document against the definition under $defs that names it.",
});
