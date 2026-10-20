import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jcsSha256, sha256Hex } from "../../src/hash.ts";
import { canonicalize } from "../../src/jcs.ts";
import {
	type CanonicalToolName,
	canonicalToolsList,
	canonicalToolsV1,
	isCanonicalToolsListResult,
	TOOL_EXTENSION_ID,
	TOOL_EXTENSION_VERSION,
	type ToolKind,
	toolExtensionDeclaration,
	toolKindsV1,
	toolV1Schema,
} from "../../src/tool-v1.ts";
import { vectorFiles } from "../vectors.ts";

interface ToolsList {
	format: string;
	extension: string;
	declaration: { version: number; schemaDigest: string };
	entries: { name: CanonicalToolName; entry: unknown; jcs: string; sha256: string }[];
	kinds: { kind: ToolKind; dataClass: string; maxBytes: number; timeoutMs: number }[];
	lists: { kinds: ToolKind[]; names: string[]; sha256: string }[];
	cases: { id: string; kinds: ToolKind[]; result: unknown; canonical: boolean }[];
}

const files = vectorFiles<ToolsList>("tool-v1");
const vectors = files.find(([file]) => file === "tools-list.json")?.[1] as ToolsList;
const schemaFile = path.resolve(
	import.meta.dirname,
	"../../../../spec/schemas/tool-v1.schema.json",
);

describe("spec/vectors/tool-v1/tools-list.json", () => {
	it("is the only file of its area", () => {
		expect(files.map(([file]) => file)).toEqual(["tools-list.json"]);
		expect(vectors.format).toBe("draftyak.vectors.tool-v1.v1");
		expect(vectors.extension).toBe(TOOL_EXTENSION_ID);
	});

	it("carries every canonical entry with its exact canonical JSON and SHA-256", () => {
		expect(vectors.entries.map(({ name }) => name)).toEqual(
			Object.keys(canonicalToolsV1).toSorted(),
		);
		for (const { name, entry, jcs, sha256 } of vectors.entries) {
			expect(canonicalize(entry)).toBe(jcs);
			expect(jcs).toBe(canonicalize(canonicalToolsV1[name].entry));
			expect(sha256Hex(jcs)).toBe(sha256);
		}
	});

	it("gives each kind's class, ceiling and timeout, and each list's names and hash", () => {
		expect(vectors.kinds).toEqual(
			Object.values(toolKindsV1).map(({ kind, dataClass, maxBytes, timeoutMs }) => ({
				kind,
				dataClass,
				maxBytes,
				timeoutMs,
			})),
		);
		expect(vectors.lists).toHaveLength(7);
		for (const { kinds, names, sha256 } of vectors.lists) {
			expect(canonicalToolsList(kinds).map(({ name }) => name)).toEqual(names);
			expect(jcsSha256(canonicalToolsList(kinds))).toBe(sha256);
		}
	});

	it("agrees with isCanonicalToolsListResult on every case", () => {
		expect(vectors.cases.filter(({ canonical }) => canonical).map(({ id }) => id)).toEqual([
			"canonical",
			"other-order",
		]);
		expect(vectors.cases.map(({ id }) => id)).toContain("next-cursor");
		for (const { id, kinds, result, canonical } of vectors.cases) {
			expect(isCanonicalToolsListResult(result, kinds), id).toBe(canonical);
		}
	});

	it("records the declaration, whose digest is the schema file's", () => {
		const digest = sha256Hex(canonicalize(JSON.parse(readFileSync(schemaFile, "utf8"))));
		expect(vectors.declaration).toEqual({ version: 1, schemaDigest: digest });
		expect(toolExtensionDeclaration).toEqual(vectors.declaration);
		expect(TOOL_EXTENSION_VERSION).toBe(1);
		expect(Object.isFrozen(toolExtensionDeclaration)).toBe(true);
	});
});

describe("spec/schemas/tool-v1.schema.json", () => {
	const schema = JSON.parse(readFileSync(schemaFile, "utf8"));

	it("is toolV1Schema: each canonical entry, and each tool's arguments and result", () => {
		expect(schema).toEqual(toolV1Schema);
		const { $defs } = schema;
		const tools = Object.values(canonicalToolsV1);
		expect(Object.keys($defs)).toHaveLength(3 * tools.length);
		for (const { entry } of tools) {
			const type = entry.name
				.split(/[._]/)
				.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
				.join("");
			expect($defs[`${type}Entry`]).toEqual({ const: entry });
			expect($defs[`${type}Arguments`]).toEqual(entry.inputSchema);
			expect($defs[`${type}Result`]).toEqual(entry.outputSchema);
		}
		expect($defs.CalendarFreebusyResult).toEqual(
			toolKindsV1["calendar.freebusy"].entry.outputSchema,
		);
	});

	it("changes its digest with any byte of an entry, its description included", () => {
		const changed = structuredClone(schema);
		changed.$defs.KbLookupEntry.const.description += " ";
		expect(jcsSha256(changed)).not.toBe(toolExtensionDeclaration.schemaDigest);
	});
});
