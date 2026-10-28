import { types } from "node:util";
import { canonicalize } from "@draftyak/protocol/jcs";
import {
	type CanonicalToolName,
	canonicalToolsList,
	canonicalToolsV1,
	type JsonObject,
	TOOL_EXTENSION_ID,
	type ToolArgumentsV1,
	type ToolKind,
	type ToolResultsV1,
	toolExtensionDeclaration,
	toolKindsV1,
} from "@draftyak/protocol/tool-v1";
import type { PluginContext, PluginInstance } from "./context.ts";
import { capture, dataCopy, fields, freezeJson, manifest } from "./definitions.ts";
import { PluginError } from "./errors.ts";
import type { HostFetch, HostFetchInit } from "./fetch.ts";
import type { PluginEntry, PluginTool } from "./serve.ts";

export interface ToolFetchInit
	extends Omit<HostFetchInit, "method" | "body" | "sendTicket" | "saveAs"> {
	readonly method?: "GET" | "HEAD";
}
export type ToolFetch = (input: RequestInfo | URL, init?: ToolFetchInit) => ReturnType<HostFetch>;
export interface ToolContext {
	readonly plugin: string;
	readonly instance: PluginInstance;
	readonly signal: AbortSignal;
	readonly fetch: ToolFetch;
	readonly kv: PluginContext["kv"];
	readonly log: PluginContext["log"];
}
type ToolHandler<N extends CanonicalToolName> = (
	args: ToolArgumentsV1[N],
	context: ToolContext,
) => ToolResultsV1[N] | Promise<ToolResultsV1[N]>;
interface DeclaredKinds {
	readonly tool: { readonly kinds: readonly { readonly kind: ToolKind }[] };
}
export interface ToolPluginDefinition<M extends DeclaredKinds> {
	readonly manifest: M;
	readonly probe: ToolHandler<"tool_probe">;
	readonly lookup: { readonly [K in M["tool"]["kinds"][number]["kind"]]: ToolHandler<K> };
}
const fetchKeys = new Set([
	"method",
	"headers",
	"signal",
	"cache",
	"credentials",
	"integrity",
	"keepalive",
	"mode",
	"redirect",
	"referrer",
	"referrerPolicy",
	"stream",
	"priority",
	"duplex",
]);
function restrictedFetch(fetch: HostFetch): ToolFetch {
	return async (input, init = {}) => {
		const slots = fields(init);
		if (Object.keys(slots).some((key) => !fetchKeys.has(key)))
			throw new PluginError("PERMISSION_DENIED");
		if (
			typeof input !== "string" &&
			(!input || types.isProxy(input) || !(input instanceof Request || input instanceof URL))
		)
			throw new PluginError("INVALID_INPUT");
		const method = slots.method?.value ?? (input instanceof Request ? input.method : "GET");
		if (method !== "GET" && method !== "HEAD") throw new PluginError("PERMISSION_DENIED");
		const url =
			typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
		if (url.startsWith("secret:") && !/^secret:\/\/[a-z][A-Za-z0-9]{0,31}$/.test(url))
			throw new PluginError("INVALID_INPUT");
		const options = Object.fromEntries(
			Object.entries(slots).map(([key, slot]) => [key, slot.value]),
		);
		return fetch(input, { ...options, method });
	};
}
function toolContext(context: PluginContext): ToolContext {
	if (!context.instance) throw new PluginError("INVALID_INPUT");
	return Object.freeze({
		plugin: context.plugin,
		instance: context.instance,
		signal: context.signal,
		fetch: restrictedFetch(context.fetch),
		kv: context.kv,
		log: context.log,
	});
}

/** Definitions describe lookups; the instance label and configuration come only from local serving options. */
export function defineToolPlugin<const M extends DeclaredKinds>(
	options: ToolPluginDefinition<M>,
): PluginEntry {
	const captured = capture(options, ["manifest", "probe", "lookup"]);
	const declared = manifest(captured.manifest, "tool");
	const kinds = declared.tool.kinds.map((item) => item.kind);
	const slots = fields(captured.lookup);
	if (
		Object.keys(slots).length !== kinds.length ||
		Object.keys(slots).some((key) => !kinds.includes(key as ToolKind))
	)
		throw new TypeError("Lookup kinds refused");
	for (const kind of kinds)
		if (typeof slots[kind]?.value !== "function" || types.isProxy(slots[kind]?.value))
			throw new TypeError("Lookup handler refused");
	const literal = canonicalToolsList(kinds);
	const tools: PluginTool[] = literal.map(({ name }) => {
		const schema = canonicalToolsV1[name];
		const maxBytes =
			declared.tool.kinds.find((item) => item.kind === name)?.output.maxBytes ?? schema.maxBytes;
		return Object.freeze({
			name,
			description: schema.entry.description,
			inputSchema: schema.arguments,
			outputSchema: schema.result,
			timeoutMs: name in toolKindsV1 ? toolKindsV1[name as ToolKind].timeoutMs : 5000,
			async handler(args: unknown, context: PluginContext): Promise<unknown> {
				const restricted = toolContext(context);
				const parsed = schema.arguments.safeParse(dataCopy(args));
				if (!parsed.success) throw new PluginError("INVALID_INPUT");
				const value =
					name === "tool_describe"
						? { kinds }
						: await Reflect.apply(
								(name === "tool_probe" ? captured.probe : slots[name]?.value) as (
									...args: never[]
								) => unknown,
								undefined,
								[parsed.data, restricted],
							);
				const result = dataCopy(value);
				if (
					Buffer.byteLength(canonicalize(result)) > maxBytes ||
					!schema.result.safeParse(result).success
				)
					throw new PluginError("TRANSIENT");
				return result;
			},
		});
	});
	return Object.freeze({
		name: declared.id,
		plugin: declared.id,
		version: declared.version,
		extensions: freezeJson({
			[TOOL_EXTENSION_ID]: structuredClone(toolExtensionDeclaration) as unknown as JsonObject,
		}),
		tools: Object.freeze(tools),
		canonicalTools: freezeJson(literal),
	});
}
