import * as z from "zod";
import { PluginErrorResult } from "./errors.ts";
import { jcsSha256 } from "./hash.ts";
import { boundedText, Sha256Hex } from "./scalars.ts";

// MCP Apps' extension; plugins never declare it, and no tool of theirs carries `_meta.ui` (§4).
export const UI_EXTENSION = "io.modelcontextprotocol/ui";

// boundedText, which refuses a lone surrogate itself, under the name the contract modules import.
export { boundedText as wellFormedText } from "./scalars.ts";

// What every tool's isError result carries.
export const PluginError: z.ZodType<PluginErrorResult> = PluginErrorResult;

export interface ToolContract<Input = unknown, Output = unknown> {
	readonly description: string;
	readonly input: z.ZodType<Input>;
	// The structuredContent of a successful result; an error result carries the contract's `error`.
	readonly output: z.ZodType<Output>;
	// What the call's `_meta` must hold beside MCP's own members.
	readonly meta?: z.ZodType;
	// A plugin may leave the tool out of tools/list; every other tool must be there.
	readonly optional?: boolean;
}

export interface ExtensionContract<
	Tools extends Readonly<Record<string, ToolContract>> = Readonly<Record<string, ToolContract>>,
> {
	readonly id: string;
	readonly version: number;
	readonly title: string;
	// The exported JSON Schema under spec/, which schemaDigest covers.
	readonly path: string;
	// The structuredContent of any tool's isError result.
	readonly error: z.ZodType;
	readonly tools: Tools;
}

export interface ProbeResult {
	readonly status: "ok" | "degraded";
	readonly detail?: string;
}
export const ProbeResult: z.ZodType<ProbeResult> = z.strictObject({
	status: z.enum(["ok", "degraded"]),
	detail: boundedText(200).optional(),
});

export interface ExtensionDeclaration {
	readonly version: number;
	readonly schemaDigest: string;
}
// The value a plugin declares in `server/discover` under capabilities.extensions[<id>].
export const ExtensionDeclaration: z.ZodType<ExtensionDeclaration> = z.strictObject({
	version: z.int().min(1),
	schemaDigest: Sha256Hex,
});

// The extension as one JSON Schema document: a member per tool holding its input, its output, its
// error result and any required `_meta`, the optional tools' members optional.
export function extensionSchema(contract: ExtensionContract): z.ZodType {
	const shape: Record<string, z.ZodType> = {};
	for (const [name, tool] of Object.entries(contract.tools)) {
		const parts = { input: tool.input, output: tool.output, error: contract.error.optional() };
		const entry = z
			.strictObject(tool.meta === undefined ? parts : { ...parts, meta: tool.meta })
			.meta({ title: name, description: tool.description });
		shape[name] = tool.optional === true ? entry.optional() : entry;
	}
	return z.strictObject(shape).meta({
		title: contract.title,
		description: `The tools of ${contract.id} version ${contract.version}.`,
	});
}

// What `pnpm --filter @draftyak/protocol spec` writes for `schema` at spec/<path>.
export function exportedSchema(path: string, schema: z.ZodType): Record<string, unknown> {
	const json = z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" });
	return { ...json, $id: `https://draftyak.com/spec/${path}` };
}

const digests = new WeakMap<ExtensionContract, string>();

// The SHA-256 of the JCS of the extension's exported JSON Schema, so an SDK in any language reads
// it from spec/.
export function schemaDigest(contract: ExtensionContract): string {
	let digest = digests.get(contract);
	if (digest === undefined) {
		digest = jcsSha256(exportedSchema(contract.path, extensionSchema(contract)));
		digests.set(contract, digest);
	}
	return digest;
}

export const extensionDeclaration = (contract: ExtensionContract): ExtensionDeclaration => ({
	version: contract.version,
	schemaDigest: schemaDigest(contract),
});

// "<path>: <issue code>", never the value: a value may be message content.
export function zodProblems(issues: readonly z.core.$ZodIssue[], root: string): string[] {
	return issues.map((issue) => {
		const path = [root, ...issue.path.map(String)].join(".");
		return `${path}: ${issue.code === "custom" ? issue.message : issue.code}`;
	});
}

const record = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

const toolOf = (contract: ExtensionContract, name: unknown): ToolContract | undefined =>
	typeof name === "string" && Object.hasOwn(contract.tools, name)
		? contract.tools[name]
		: undefined;

export type CallCheck =
	| {
			readonly ok: true;
			readonly name: string;
			readonly arguments: unknown;
			readonly meta: unknown;
	  }
	| { readonly ok: false; readonly problems: readonly string[] };

// A tools/call's params `{name, arguments?, _meta?}` against the extension's tool.
export function checkToolCall(contract: ExtensionContract, params: unknown): CallCheck {
	const call = record(params);
	const tool = toolOf(contract, call?.name);
	if (call === undefined || tool === undefined) return { ok: false, problems: ["name: unknown"] };
	const input = tool.input.safeParse(call.arguments === undefined ? {} : call.arguments);
	const meta = tool.meta?.safeParse(call._meta);
	const problems = [
		...(input.success ? [] : zodProblems(input.error.issues, "arguments")),
		...(meta === undefined || meta.success ? [] : zodProblems(meta.error.issues, "_meta")),
	];
	if (problems.length > 0) return { ok: false, problems };
	return { ok: true, name: call.name as string, arguments: input.data, meta: meta?.data };
}

export type ResultCheck =
	| { readonly ok: true; readonly isError: boolean; readonly value: unknown }
	| { readonly ok: false; readonly problems: readonly string[] };

// A tools/call result: only structuredContent counts, as the tool's output or, with isError, as
// the contract's error; a result that asks for input is refused (§4).
export function checkToolResult(
	contract: ExtensionContract,
	name: string,
	result: unknown,
): ResultCheck {
	const tool = toolOf(contract, name);
	const body = record(result);
	if (tool === undefined || body === undefined) return { ok: false, problems: ["result: unknown"] };
	if (body.resultType !== undefined && body.resultType !== "complete") {
		return { ok: false, problems: ["resultType: not complete"] };
	}
	const isError = body.isError === true;
	const parsed = (isError ? contract.error : tool.output).safeParse(body.structuredContent);
	if (!parsed.success) {
		return { ok: false, problems: zodProblems(parsed.error.issues, "structuredContent") };
	}
	return { ok: true, isError, value: parsed.data };
}

export type SurfaceProblemCode =
	| "SURFACE_MALFORMED"
	| "SURFACE_PROMPTS"
	| "SURFACE_RESOURCES"
	| "SURFACE_COMPLETIONS"
	| "SURFACE_UI"
	| "SURFACE_TOOL_UI"
	| "SURFACE_EXTENSION_MISSING"
	| "SURFACE_EXTENSION_INVALID"
	| "SURFACE_EXTENSION_VERSION"
	| "SURFACE_EXTENSION_DIGEST"
	| "SURFACE_TOOL_MISSING"
	| "SURFACE_TOOL_UNKNOWN";

export interface SurfaceProblem {
	readonly code: SurfaceProblemCode;
	readonly tool?: string;
}

const forbidden = [
	["prompts", "SURFACE_PROMPTS"],
	["resources", "SURFACE_RESOURCES"],
	["completions", "SURFACE_COMPLETIONS"],
] as const;

const isUiKey = (key: string): boolean =>
	key === "ui" || key.startsWith("ui/") || key === UI_EXTENSION;

function checkExpected(
	contract: ExtensionContract,
	declared: unknown,
	names: readonly string[],
): SurfaceProblem[] {
	const problems: SurfaceProblem[] = [];
	const declaration = ExtensionDeclaration.safeParse(declared);
	if (declared === undefined) problems.push({ code: "SURFACE_EXTENSION_MISSING" });
	else if (!declaration.success) problems.push({ code: "SURFACE_EXTENSION_INVALID" });
	else if (declaration.data.version !== contract.version) {
		problems.push({ code: "SURFACE_EXTENSION_VERSION" });
	} else if (declaration.data.schemaDigest !== schemaDigest(contract)) {
		problems.push({ code: "SURFACE_EXTENSION_DIGEST" });
	}
	for (const [name, tool] of Object.entries(contract.tools)) {
		if (tool.optional !== true && !names.includes(name)) {
			problems.push({ code: "SURFACE_TOOL_MISSING", tool: name });
		}
	}
	for (const name of names) {
		if (!Object.hasOwn(contract.tools, name)) {
			problems.push({ code: "SURFACE_TOOL_UNKNOWN", tool: name });
		}
	}
	return problems;
}

// Everything §4 refuses in a plugin's `server/discover` result and `tools/list` result: prompts,
// resources, completions, the UI extension (under `extensions` or `experimental`) and any tool
// `_meta.ui` (or its legacy "ui/…" keys). The tools list must be whole, without `nextCursor`. With
// `expected`, also its extension declaration and tool names. An empty list means none.
export function checkPluginSurface(
	discover: unknown,
	toolsList: unknown,
	expected?: ExtensionContract,
): SurfaceProblem[] {
	const capabilities = record(record(discover)?.capabilities);
	const declaredIn = (key: string) =>
		capabilities?.[key] === undefined ? {} : record(capabilities[key]);
	const extensions = declaredIn("extensions");
	const experimental = declaredIn("experimental");
	const list = record(toolsList);
	const tools = list?.tools;
	if (
		capabilities === undefined ||
		extensions === undefined ||
		experimental === undefined ||
		!Array.isArray(tools) ||
		Object.hasOwn(list ?? {}, "nextCursor")
	) {
		return [{ code: "SURFACE_MALFORMED" }];
	}
	const problems: SurfaceProblem[] = [];
	for (const [key, code] of forbidden) {
		if (Object.hasOwn(capabilities, key)) problems.push({ code });
	}
	if (Object.hasOwn(extensions, UI_EXTENSION) || Object.hasOwn(experimental, UI_EXTENSION)) {
		problems.push({ code: "SURFACE_UI" });
	}
	const names: string[] = [];
	for (const tool of tools) {
		const entry = record(tool);
		const name = entry?.name;
		const meta = entry?._meta === undefined ? {} : record(entry._meta);
		if (typeof name !== "string" || meta === undefined || names.includes(name)) {
			problems.push({ code: "SURFACE_MALFORMED" });
			continue;
		}
		names.push(name);
		if (Object.keys(meta).some(isUiKey)) problems.push({ code: "SURFACE_TOOL_UI", tool: name });
	}
	if (expected === undefined) return problems;
	const declared = Object.hasOwn(extensions, expected.id) ? extensions[expected.id] : undefined;
	return [...problems, ...checkExpected(expected, declared, names)];
}
