import * as z from "zod";
import { canonicalize, JcsError } from "../jcs.ts";
import { boundedText } from "../scalars.ts";
import { guardExportedPatterns } from "../schema-patterns.ts";
import { DNS_NAME } from "./egress.ts";

export const TOOL_EXTENSION_ID = "io.github.draftyak/tool";

const toolKinds = ["calendar.freebusy", "contact.notes", "kb.lookup"] as const;
export type ToolKind = (typeof toolKinds)[number];
export const ToolKind: z.ZodEnum<z.core.util.ToEnum<ToolKind>> = z.enum(toolKinds);

export type CanonicalToolName = ToolKind | "tool_describe" | "tool_probe";

export type Json = null | boolean | number | string | readonly Json[] | JsonObject;
export type JsonObject = { readonly [key: string]: Json };

// One entry of a tool plugin's tools/list, exactly as the hub authors it.
export interface ToolEntry {
	readonly name: CanonicalToolName;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: JsonObject;
	readonly outputSchema: JsonObject;
}

// Patterns use ASCII classes and no lookaround, so every regex engine reads them alike.
const ZONE = "^[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z0-9_+-]+)*$";
const ATOM = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const PARTICIPANT = `^(?:${ATOM}(?:\\.${ATOM})*@${DNS_NAME}|[UW][A-Z0-9]{2,20})$`;
const TOPIC = "^[a-z0-9][a-z0-9-]{0,63}$";
// Any kind's name, so tool_describe's entry stays the same when a kind is added.
const KIND = "^[a-z][a-z0-9]*(?:\\.[a-z][a-z0-9]*)+$";

// The owner's settings use it too. Python's re lets `$` match before a final line feed, so its
// JSON Schema also refuses one.
export const IanaZone: z.ZodString = z
	.string()
	.max(64)
	.regex(new RegExp(ZONE))
	.meta({
		id: "draftyak.tool-v1.IanaZone",
		description: "An IANA time zone name, such as America/Chicago; Temporal checks that it exists.",
		not: { pattern: "\\n" },
	});
export const Participant: z.ZodString = z.string().max(254).regex(new RegExp(PARTICIPANT));
export const TopicId: z.ZodString = z.string().regex(new RegExp(TOPIC));

// The literal JSON Schemas (2020-12) of the canonical entries.
const nonNegative: JsonObject = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const text = (maxLength: number): JsonObject => ({ type: "string", maxLength });

// Every property required and nothing else allowed.
function closed(properties: { readonly [name: string]: JsonObject }, description?: string) {
	const required = Object.keys(properties);
	return guardExportedPatterns({
		type: "object",
		...(description === undefined ? {} : { description }),
		properties,
		...(required.length === 0 ? {} : { required }),
		additionalProperties: false,
	}) satisfies JsonObject;
}

const textItems = (maxLength: number): JsonObject => ({
	type: "array",
	items: closed({ label: text(64), text: text(maxLength) }),
	maxItems: 5,
});

const entries: { readonly [N in CanonicalToolName]: ToolEntry } = {
	tool_describe: {
		name: "tool_describe",
		title: "Describe",
		description: "The lookup kinds this tool instance serves.",
		inputSchema: closed({}),
		outputSchema: closed({
			kinds: {
				type: "array",
				items: { type: "string", maxLength: 64, pattern: KIND },
				minItems: 1,
				maxItems: 16,
				uniqueItems: true,
			},
		}),
	},
	tool_probe: {
		name: "tool_probe",
		title: "Probe",
		description:
			"Checks the instance's configuration and returns its status and sizes, never data.",
		inputSchema: closed({}),
		outputSchema: closed({
			status: {
				type: "string",
				enum: ["ok", "degraded"],
				description:
					"degraded when the upstream answered with something the plugin can't fully use.",
			},
			bytes: { ...nonNegative, description: "Bytes the upstream returned." },
			items: { ...nonNegative, description: "Items found, such as events, notes or entries." },
		}),
	},
	"calendar.freebusy": {
		name: "calendar.freebusy",
		title: "Calendar free/busy",
		description:
			"Busy times in a UTC window. Returns intervals only, never event titles, attendees, locations or other event text.",
		inputSchema: closed({
			window: closed(
				{ start: nonNegative, end: nonNegative },
				"UTC milliseconds; start is before end.",
			),
			tz: {
				type: "string",
				maxLength: 64,
				pattern: ZONE,
				description: "The owner's IANA time zone, for floating times.",
			},
		}),
		outputSchema: closed({
			busy: {
				type: "array",
				description:
					"UTC milliseconds, sorted: each interval starts before it ends and ends before the next one starts.",
				items: closed({
					start: nonNegative,
					end: nonNegative,
					status: { type: "string", enum: ["busy", "tentative"] },
				}),
				maxItems: 200,
			},
		}),
	},
	"contact.notes": {
		name: "contact.notes",
		title: "Contact notes",
		description: "The owner's notes about one participant.",
		inputSchema: closed({
			participant: {
				type: "string",
				maxLength: 254,
				pattern: PARTICIPANT,
				description:
					"A verified email address or Slack user id that the hub binds, never a display name or a phone number.",
			},
		}),
		outputSchema: closed({ notes: textItems(1000) }),
	},
	"kb.lookup": {
		name: "kb.lookup",
		title: "Knowledge base lookup",
		description: "Entries for one owner-defined topic.",
		inputSchema: closed({
			topic: { type: "string", pattern: TOPIC, description: "An owner-defined topic id." },
		}),
		outputSchema: closed({ entries: textItems(2000) }),
	},
};

// Freezes plain objects and arrays all the way down, leaving the zod schemas they hold alone.
function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !(value instanceof z.ZodType)) {
		for (const item of Object.values(value)) deepFreeze(item);
		Object.freeze(value);
	}
	return value;
}
deepFreeze(entries);

export interface CalendarFreebusyArguments {
	window: { start: number; end: number };
	tz: string;
}
export interface BusyInterval {
	start: number;
	end: number;
	status: "busy" | "tentative";
}
export interface CalendarFreebusyResult {
	busy: BusyInterval[];
}
export interface ContactNotesArguments {
	participant: string;
}
export interface ToolTextItem {
	label: string;
	text: string;
}
export interface ContactNotesResult {
	notes: ToolTextItem[];
}
export interface KbLookupArguments {
	topic: string;
}
export interface KbLookupResult {
	entries: ToolTextItem[];
}
export interface ToolDescribeResult {
	kinds: ToolKind[];
}
export interface ToolProbeResult {
	status: "ok" | "degraded";
	bytes: number;
	items: number;
}
export type NoArguments = Record<string, never>;

export interface ToolArgumentsV1 {
	tool_describe: NoArguments;
	tool_probe: NoArguments;
	"calendar.freebusy": CalendarFreebusyArguments;
	"contact.notes": ContactNotesArguments;
	"kb.lookup": KbLookupArguments;
}
export interface ToolResultsV1 {
	tool_describe: ToolDescribeResult;
	tool_probe: ToolProbeResult;
	"calendar.freebusy": CalendarFreebusyResult;
	"contact.notes": ContactNotesResult;
	"kb.lookup": KbLookupResult;
}

// The validators agree with the literal schemas and add the rules JSON Schema can't express.
const instant = z.int().min(0);
const noArguments: z.ZodType<NoArguments> = z.strictObject({});
const textItem = (max: number) =>
	z.strictObject({ label: boundedText(64), text: boundedText(max) });

function sortedApart(busy: readonly BusyInterval[]): boolean {
	let previousEnd = -1;
	for (const { start, end } of busy) {
		if (start <= previousEnd || end <= start) return false;
		previousEnd = end;
	}
	return true;
}

// Busy times in the form calendar.freebusy returns them: empty intervals dropped, the rest sorted,
// and overlapping or touching ones merged into one that is busy if any part of it is busy.
export function mergeBusy(intervals: readonly BusyInterval[]): BusyInterval[] {
	const merged: BusyInterval[] = [];
	const sorted = intervals
		.filter(({ start, end }) => start < end)
		.toSorted((a, b) => a.start - b.start);
	for (const { start, end, status } of sorted) {
		const last = merged.at(-1);
		if (last === undefined || start > last.end) merged.push({ start, end, status });
		else {
			last.end = Math.max(last.end, end);
			if (status === "busy") last.status = "busy";
		}
	}
	return merged;
}

export interface CanonicalTool<N extends CanonicalToolName> {
	readonly entry: ToolEntry;
	readonly arguments: z.ZodType<ToolArgumentsV1[N]>;
	readonly result: z.ZodType<ToolResultsV1[N]>;
	// The most bytes of the result's canonical JSON.
	readonly maxBytes: number;
}

export interface ToolKindV1<K extends ToolKind> extends CanonicalTool<K> {
	readonly kind: K;
	readonly dataClass: `tool.${K}`;
	readonly timeoutMs: number;
}

export const toolKindsV1: { readonly [K in ToolKind]: ToolKindV1<K> } = deepFreeze({
	"calendar.freebusy": {
		kind: "calendar.freebusy",
		entry: entries["calendar.freebusy"],
		arguments: z.strictObject({
			window: z
				.strictObject({ start: instant, end: instant })
				.refine(({ start, end }) => start < end, "start must be before end"),
			tz: IanaZone,
		}),
		result: z.strictObject({
			busy: z
				.array(
					z.strictObject({ start: instant, end: instant, status: z.enum(["busy", "tentative"]) }),
				)
				.max(200)
				.refine(sortedApart, "intervals must be sorted, and none may overlap or touch"),
		}),
		dataClass: "tool.calendar.freebusy",
		maxBytes: 20_480,
		timeoutMs: 15_000,
	},
	"contact.notes": {
		kind: "contact.notes",
		entry: entries["contact.notes"],
		arguments: z.strictObject({ participant: Participant }),
		result: z.strictObject({ notes: z.array(textItem(1000)).max(5) }),
		dataClass: "tool.contact.notes",
		maxBytes: 4096,
		timeoutMs: 5000,
	},
	"kb.lookup": {
		kind: "kb.lookup",
		entry: entries["kb.lookup"],
		arguments: z.strictObject({ topic: TopicId }),
		result: z.strictObject({ entries: z.array(textItem(2000)).max(5) }),
		dataClass: "tool.kb.lookup",
		maxBytes: 4096,
		timeoutMs: 5000,
	},
});

export const canonicalToolsV1: { readonly [N in CanonicalToolName]: CanonicalTool<N> } = deepFreeze(
	{
		tool_describe: {
			entry: entries.tool_describe,
			arguments: noArguments,
			result: z.strictObject({
				kinds: z
					.array(ToolKind)
					.min(1)
					.max(16)
					.refine((kinds) => new Set(kinds).size === kinds.length, "kinds must be unique"),
			}),
			maxBytes: 4096,
		},
		tool_probe: {
			entry: entries.tool_probe,
			arguments: noArguments,
			result: z.strictObject({
				status: z.enum(["ok", "degraded"]),
				bytes: instant,
				items: instant,
			}),
			maxBytes: 4096,
		},
		...toolKindsV1,
	},
);

const canonicalJcs: ReadonlyMap<string, string> = new Map(
	Object.values(entries).map((entry) => [entry.name, canonicalize(entry)]),
);

// The tool names a plugin serving `kinds` lists, sorted by UTF-16 code units.
function toolNames(kinds: readonly ToolKind[]): CanonicalToolName[] {
	if (kinds.length === 0) throw new TypeError("a tool plugin serves at least one kind");
	for (const kind of kinds) {
		if (!ToolKind.safeParse(kind).success) throw new TypeError(`unknown tool kind: ${kind}`);
	}
	return [...new Set<CanonicalToolName>(["tool_describe", "tool_probe", ...kinds])].toSorted();
}

// The canonical tools/list entries for `kinds`, as fresh copies a caller may change.
export function canonicalToolsList(kinds: readonly ToolKind[]): ToolEntry[] {
	return toolNames(kinds).map((name) => structuredClone(entries[name]));
}

// True when `list` (a tools/list result's tools) holds exactly the canonical entries for `kinds`,
// in any order, each equal to its canonical entry as JCS.
export function isCanonicalToolsList(list: unknown, kinds: readonly ToolKind[]): boolean {
	const expected = new Set<string>(toolNames(kinds));
	if (!Array.isArray(list) || list.length !== expected.size) return false;
	const seen = new Set<string>();
	for (const tool of list) {
		const name: unknown = (tool as { name?: unknown } | null)?.name;
		if (typeof name !== "string" || !expected.has(name) || seen.has(name)) return false;
		seen.add(name);
		try {
			if (canonicalize(tool) !== canonicalJcs.get(name)) return false;
		} catch (error) {
			if (error instanceof JcsError) return false;
			throw error;
		}
	}
	return true;
}

// True when `result`, a tools/list result as the plugin sent it (parseToolFrame's message, never an
// MCP client's decoded copy, which drops members it doesn't know), is complete, holds the canonical
// entries for `kinds` and has no nextCursor, since the list comes in one page. ttlMs and cacheScope
// are ignored.
export function isCanonicalToolsListResult(result: unknown, kinds: readonly ToolKind[]): boolean {
	const page = (typeof result === "object" && result !== null ? result : {}) as {
		readonly [member: string]: unknown;
	};
	return (
		isCanonicalToolsList(page.tools, kinds) &&
		page.resultType === "complete" &&
		!Object.hasOwn(page, "nextCursor")
	);
}
