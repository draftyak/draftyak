import * as z from "zod";
import * as mcp from "../../src/mcp.ts";

export const path = "schemas/mcp-surface-v1.schema.json";
const entries: [string, unknown][] = Object.entries(mcp);
const definitions = entries
	.toSorted(([left], [right]) => (left < right ? -1 : Number(left > right)))
	.filter((entry): entry is [string, z.ZodType] => entry[1] instanceof z.ZodType)
	.map(([name, value]) => (value.meta()?.id ? value : value.meta({ id: `draftyak.mcp.${name}` })));
export const schema: z.ZodType = z.union(definitions).meta({
	not: {},
	title: "DraftYak MCP surface v1",
	description:
		"Choose a named definition under $defs. The root refuses every document. " +
		"The hub must also run the semantic checks documented in mcp-surface-v1.md, " +
		"including current authority, exact link identity, diff reconstruction and combined page budgets.",
});
