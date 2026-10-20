import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalize } from "../src/jcs.ts";
import { cli, json, modulesIn, type Output, specDir, specFiles, sync } from "./lib.ts";

export interface VectorFile {
	// Under spec/vectors/, inside the generator's own area: "<area>/<name>.json".
	readonly path: string;
	readonly content: {
		readonly format: string;
		readonly description: string;
		readonly [field: string]: unknown;
	};
}

// Generators import only types from this module, which loads them while its top-level await
// runs; keys and kept signatures come from lib.ts (testKey, keptSignature).
export interface VectorContext {
	readonly check?: boolean;
	// The committed spec/vectors/<file>, parsed, so a generator can keep what it recorded.
	previous(file: string): unknown;
}

function previous(file: string): unknown {
	try {
		return JSON.parse(readFileSync(path.join(specDir, "vectors", file), "utf8"));
	} catch {
		return undefined;
	}
}

// Each scripts/vectors/<area>.ts and scripts/vectors/<area>/<part>.ts exports `generate`.
export async function generateVectors(check = false): Promise<Output[]> {
	const context: VectorContext = Object.freeze({ check, previous });
	const outputs: Output[] = [];
	for (const { file, area } of modulesIn(path.join(import.meta.dirname, "vectors"))) {
		const module: { generate?: unknown } = await import(pathToFileURL(file).href);
		if (typeof module.generate !== "function") throw new Error(`${file}: export generate()`);
		const files: VectorFile[] = await module.generate(context);
		for (const { path: name, content } of files) {
			if (!new RegExp(`^${area}/[a-z0-9.-]+\\.json$`).test(name)) {
				throw new Error(`${file}: ${name} isn't under spec/vectors/${area}/`);
			}
			if (content.format !== `draftyak.vectors.${area}.v1`) {
				throw new Error(`${file}: ${name} needs the format draftyak.vectors.${area}.v1`);
			}
			canonicalize(content);
			outputs.push({ path: `vectors/${name}`, text: json(content) });
		}
	}
	return outputs;
}

export const syncVectors = async (check: boolean): Promise<string[]> =>
	sync(await generateVectors(check), specFiles("vectors/**/*.json"), check);

if (import.meta.main) await cli("vectors", syncVectors);
