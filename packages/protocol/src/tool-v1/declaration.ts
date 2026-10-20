import { jcsSha256 } from "../hash.ts";
import { canonicalToolsV1, type JsonObject, TOOL_EXTENSION_ID } from "./kinds.ts";

export const TOOL_EXTENSION_VERSION = 1;

export interface ToolV1Schema {
	readonly $schema: string;
	readonly $id: string;
	readonly title: string;
	readonly description: string;
	readonly $defs: { readonly [name: string]: JsonObject };
}

const typeName = (name: string): string =>
	name
		.split(/[._]/)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");

// spec/schemas/tool-v1.schema.json, whose digest the declaration carries: each canonical entry as a
// const, so any change to a tool's bytes changes the digest, and each tool's arguments and result
// for SDKs that generate types.
export const toolV1Schema: ToolV1Schema = Object.freeze({
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$id: "https://draftyak.com/spec/schemas/tool-v1.schema.json",
	title: "tool-v1",
	description: `The canonical tools of ${TOOL_EXTENSION_ID} v${TOOL_EXTENSION_VERSION}: each tools/list entry as a const, and each tool's arguments and result. A tool plugin declares the SHA-256 of this document's canonical JSON as its schemaDigest.`,
	$defs: Object.freeze(
		Object.fromEntries(
			Object.values(canonicalToolsV1)
				.map(({ entry }) => entry)
				.toSorted((a, b) => (a.name < b.name ? -1 : 1))
				.flatMap((entry) => [
					[`${typeName(entry.name)}Arguments`, entry.inputSchema],
					[
						`${typeName(entry.name)}Entry`,
						Object.freeze({ const: entry as unknown as JsonObject }),
					],
					[`${typeName(entry.name)}Result`, entry.outputSchema],
				]),
		),
	),
});

export interface ToolExtensionDeclaration {
	readonly version: number;
	readonly schemaDigest: string;
}

// What a tool plugin declares in server/discover under capabilities.extensions[TOOL_EXTENSION_ID].
export const toolExtensionDeclaration: ToolExtensionDeclaration = Object.freeze({
	version: TOOL_EXTENSION_VERSION,
	schemaDigest: jcsSha256(toolV1Schema),
});
