import path from "node:path";
import { pathToFileURL } from "node:url";
import * as z from "zod";
import { guardExportedPatterns } from "../src/schema-patterns.ts";
import { cli, json, modulesIn, type Output, specFiles, sync } from "./lib.ts";

const SCHEMA_PATH = /^(?:[a-z0-9-]+\/)*[a-z0-9-]+-v\d+\.schema\.json$/;

// Input mode: the JSON Schema accepts what the zod validator accepts, as other languages check
// documents as they arrive, so a defaulted field may be left out and a stripping object stays open.
export const jsonSchemaOf = (schema: z.ZodType): z.core.JSONSchema.BaseSchema =>
	guardExportedPatterns(z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }));

// Each scripts/spec/*.ts and scripts/spec/<area>/*.ts exports `path` (under spec/) and `schema`.
// Exported schemas stay declarative: refinements don't reach JSON Schema.
export async function exportSpec(): Promise<Output[]> {
	const outputs: Output[] = [];
	for (const { file } of modulesIn(path.join(import.meta.dirname, "spec"))) {
		const module: { path?: unknown; schema?: unknown } = await import(pathToFileURL(file).href);
		if (typeof module.path !== "string" || !SCHEMA_PATH.test(module.path)) {
			throw new Error(`${file}: export a path such as "schemas/<name>-v1.schema.json"`);
		}
		if (!(module.schema instanceof z.ZodType)) throw new Error(`${file}: export a zod schema`);
		const { $schema, ...rest } = jsonSchemaOf(module.schema);
		const $id = `https://draftyak.com/spec/${module.path}`;
		outputs.push({ path: module.path, text: json({ $schema, $id, ...rest }) });
	}
	return outputs;
}

export const syncSpec = async (check: boolean): Promise<string[]> =>
	sync(await exportSpec(), specFiles("**/*.schema.json", ["vectors/**"]), check);

if (import.meta.main) await cli("spec", syncSpec);
