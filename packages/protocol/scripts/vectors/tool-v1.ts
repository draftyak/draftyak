import { jcsSha256, sha256Hex } from "../../src/hash.ts";
import { canonicalize } from "../../src/jcs.ts";
import {
	canonicalToolsList,
	isCanonicalToolsListResult,
	TOOL_EXTENSION_ID,
	ToolKind,
	toolExtensionDeclaration,
	toolKindsV1,
} from "../../src/tool-v1.ts";
import type { VectorFile } from "../vectors.ts";

const calendar: ToolKind = "calendar.freebusy";
const contact: ToolKind = "contact.notes";
const kb: ToolKind = "kb.lookup";
const kindSets: ToolKind[][] = [
	[calendar],
	[contact],
	[kb],
	[calendar, contact],
	[calendar, kb],
	[contact, kb],
	[calendar, contact, kb],
];

type Tools = Record<string, unknown>[];
type Page = Record<string, unknown> & { tools: Tools };

// Every object's members in reverse order, arrays as they are.
const reversed = (value: unknown): unknown => {
	if (Array.isArray(value)) return value.map(reversed);
	if (value === null || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value)
			.reverse()
			.map(([key, item]) => [key, reversed(item)]),
	);
};

const withTools = (edit: (tools: Tools) => unknown[]) => (page: Page) => ({
	...page,
	tools: edit(page.tools),
});
const editKb = (edit: (tool: Record<string, unknown>) => unknown) =>
	withTools((tools) => tools.map((tool) => (tool.name === kb ? edit(tool) : tool)));

// kb.lookup's canonical tools/list result as `change` leaves it, with the answer a canonical-list
// check gives.
function listCase(id: string, canonical: boolean, change: (page: Page) => unknown): object {
	const kinds = [kb];
	const tools = canonicalToolsList(kinds) as unknown as Tools;
	const result = change({ resultType: "complete", ttlMs: 0, cacheScope: "private", tools });
	if (isCanonicalToolsListResult(result, kinds) !== canonical) throw new Error(`tool-v1 ${id}`);
	return { id, kinds, result, canonical };
}

export function generate(): VectorFile[] {
	const entries = canonicalToolsList(ToolKind.options).map((entry) => {
		const jcs = canonicalize(entry);
		return { name: entry.name, entry, jcs, sha256: sha256Hex(jcs) };
	});
	const kinds = Object.values(toolKindsV1).map(({ kind, dataClass, maxBytes, timeoutMs }) => ({
		kind,
		dataClass,
		maxBytes,
		timeoutMs,
	}));
	const lists = kindSets.map((set) => ({
		kinds: set,
		names: canonicalToolsList(set).map(({ name }) => name),
		sha256: jcsSha256(canonicalToolsList(set)),
	}));
	const extra = canonicalToolsList([contact]).filter(({ name }) => name === contact);
	const cases = [
		listCase("canonical", true, (page) => page),
		listCase("other-order", true, (page) =>
			withTools((tools) => tools.map(reversed).reverse())({
				...page,
				ttlMs: 60_000,
				cacheScope: "public",
			}),
		),
		listCase(
			"changed-description",
			false,
			editKb((tool) => ({
				...tool,
				description: `${tool.description}`.replace("topic", "topics"),
			})),
		),
		listCase(
			"changed-schema",
			false,
			editKb((tool) => JSON.parse(JSON.stringify(tool).replace("{0,63}", "{0,64}"))),
		),
		listCase(
			"extra-field",
			false,
			editKb((tool) => ({ ...tool, annotations: { readOnlyHint: true } })),
		),
		listCase(
			"extra-tool",
			false,
			withTools((tools) => [...tools, ...extra]),
		),
		listCase(
			"missing-tool",
			false,
			withTools((tools) => tools.filter(({ name }) => name !== "tool_probe")),
		),
		listCase(
			"renamed-tool",
			false,
			withTools((tools) =>
				tools.map((tool) => (tool.name === "tool_probe" ? { ...tool, name: "tool_check" } : tool)),
			),
		),
		listCase(
			"repeated-tool",
			false,
			withTools((tools) => tools.map((tool) => (tool.name === "tool_probe" ? tools[0] : tool))),
		),
		listCase("next-cursor", false, (page) => ({ ...page, nextCursor: "2" })),
		listCase("no-result-type", false, ({ resultType: _, ...page }) => page),
	];
	const description =
		`The canonical tools/list entries of ${TOOL_EXTENSION_ID} v1. A plugin serving some kinds ` +
		"lists tool_describe, tool_probe and one entry per kind, each equal to its entry here as " +
		'RFC 8785 JSON: "jcs" is that canonical form (UTF-8) and "sha256" its hash. "declaration" is ' +
		"what a tool plugin declares in server/discover; its schemaDigest is the SHA-256 of the " +
		'canonical JSON of spec/schemas/tool-v1.schema.json. "kinds" gives each kind\'s data class, ' +
		'output ceiling (bytes of the result\'s canonical JSON) and lookup timeout. "lists" gives, for ' +
		"each set of kinds, the names in order (UTF-16 code units) and the SHA-256 of the canonical " +
		'JSON of the entries in that order. In "cases", "result" is a tools/list result as a plugin ' +
		'sent it: it is canonical for "kinds" when its resultType is "complete", it has no ' +
		"nextCursor, and its tools equal the canonical entries by name, in any order, each as " +
		'canonical JSON; "canonical" is the expected answer.';
	return [
		{
			path: "tool-v1/tools-list.json",
			content: {
				format: "draftyak.vectors.tool-v1.v1",
				description,
				extension: TOOL_EXTENSION_ID,
				declaration: toolExtensionDeclaration,
				entries,
				kinds,
				lists,
				cases,
			},
		},
	];
}
