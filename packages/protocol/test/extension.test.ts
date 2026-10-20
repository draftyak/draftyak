import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as z from "zod";
import * as aiProviderSpec from "../scripts/spec/ai-provider-v1.ts";
import * as channelSpec from "../scripts/spec/channel-v1.ts";
import * as draftOutputSpec from "../scripts/spec/draft-output.ts";
import * as changeSpec from "../scripts/spec/normalized-change.ts";
import * as ticketSpec from "../scripts/spec/send-ticket.ts";
import { aiProviderV1 } from "../src/ai-provider-v1.ts";
import { CHANNEL_V1, channelV1 } from "../src/channel-v1.ts";
import {
	checkPluginSurface,
	type ExtensionContract,
	exportedSchema,
	extensionDeclaration,
	extensionSchema,
	ProbeResult,
	schemaDigest,
	type ToolContract,
	UI_EXTENSION,
} from "../src/extension.ts";
import { jcsSha256 } from "../src/hash.ts";
import { committed } from "./plugin-contracts.ts";

const contracts = [channelV1, aiProviderV1] as unknown as ExtensionContract[];

describe("the extension declaration", () => {
	it.each(contracts.map((contract) => [contract.id, contract] as const))(
		"%s declares its version and the digest of its committed schema",
		(_, contract) => {
			expect(extensionDeclaration(contract)).toEqual({
				version: 1,
				schemaDigest: jcsSha256(committed(contract.path)),
			});
			const uncached = jcsSha256(exportedSchema(contract.path, extensionSchema(contract)));
			expect(schemaDigest(contract)).toBe(uncached);
			expect(schemaDigest({ ...contract })).toBe(uncached);
		},
	);

	it("exports each schema exactly as spec/ holds it", () => {
		for (const module of [changeSpec, draftOutputSpec, ticketSpec, channelSpec, aiProviderSpec]) {
			expect(exportedSchema(module.path, module.schema), module.path).toEqual(
				committed(module.path),
			);
		}
		expect(schemaDigest(channelV1)).not.toBe(schemaDigest(aiProviderV1));
	});

	it.each(contracts.map((contract) => [contract.id, contract] as const))(
		"%s gives every tool the plugin error result as its error",
		(_, contract) => {
			const { $schema: _s, $id: _i, ...error } = committed("schemas/plugin-error-v1.schema.json");
			const { properties } = committed(contract.path) as {
				properties: Record<string, { properties: { error: unknown } }>;
			};
			for (const name of Object.keys(contract.tools)) {
				expect(properties[name]?.properties.error, name).toEqual(error);
			}
		},
	);

	// A schema changed in any part of any tool, or anywhere in the document, changes the digest.
	it.each(contracts.map((contract) => [contract.id, contract] as const))(
		"%s: schemaDigest changes when any schema changes",
		(_, contract) => {
			const base = schemaDigest(contract);
			const variants: ExtensionContract[] = [
				{ ...contract, version: 2 },
				{ ...contract, title: `${contract.title}.` },
				{ ...contract, path: contract.path.replace("-v1", "-v9") },
				{ ...contract, error: contract.error.describe("changed") },
			];
			for (const [name, tool] of Object.entries(contract.tools)) {
				const changed = (change: Partial<ToolContract>): ExtensionContract => ({
					...contract,
					tools: { ...contract.tools, [name]: { ...tool, ...change } },
				});
				variants.push(
					changed({ input: tool.input.describe("changed") }),
					changed({ output: tool.output.describe("changed") }),
					changed({ description: `${tool.description} ` }),
					changed({ optional: tool.optional !== true }),
				);
				if (tool.meta !== undefined)
					variants.push(changed({ meta: tool.meta.describe("changed") }));
			}
			const digests = variants.map(schemaDigest);
			for (const digest of digests) expect(digest).not.toBe(base);
			expect(new Set(digests).size).toBe(digests.length);
		},
	);

	it("is computed in a plugin, with code generation from strings disallowed and zod jitless", () => {
		const script = `
import * as z from "zod";
import { channelV1 } from "./src/channel-v1.ts";
import { aiProviderV1 } from "./src/ai-provider-v1.ts";
import { schemaDigest } from "./src/extension.ts";
z.config({ jitless: true });
let codegen = "allowed";
try { new Function("return 1"); } catch { codegen = "refused"; }
process.stdout.write(JSON.stringify({ codegen, digests: [schemaDigest(channelV1), schemaDigest(aiProviderV1)] }));
`;
		const result = execFileSync(
			process.execPath,
			["--disallow-code-generation-from-strings", "--input-type=module", "-e", script],
			{ cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" },
		);
		expect(JSON.parse(result)).toEqual({
			codegen: "refused",
			digests: [schemaDigest(channelV1), schemaDigest(aiProviderV1)],
		});
	});
});

// What @modelcontextprotocol/server 2.3.1 answers for a channel plugin.
const discover = {
	supportedVersions: ["2026-07-28"],
	capabilities: {
		tools: { listChanged: false },
		extensions: { [CHANNEL_V1]: extensionDeclaration(channelV1 as unknown as ExtensionContract) },
	},
	_meta: { "io.modelcontextprotocol/serverInfo": { name: "channel-hello", version: "0.0.0" } },
};
const toolEntry = (name: string, extra: object = {}) => ({
	name,
	description: `DYTEST ${name}`,
	inputSchema: { type: "object" },
	...extra,
});
const required = Object.entries(channelV1.tools as Record<string, ToolContract>)
	.filter(([, tool]) => tool.optional !== true)
	.map(([name]) => toolEntry(name));
const toolsList = { tools: required };
const withCapabilities = (capabilities: object) => ({
	...discover,
	capabilities: { ...discover.capabilities, ...capabilities },
});
const expected = channelV1 as unknown as ExtensionContract;

describe("checkPluginSurface", () => {
	it("passes a channel plugin that serves its tools and declares only what §4 allows", () => {
		expect(checkPluginSurface(discover, toolsList)).toEqual([]);
		expect(checkPluginSurface(discover, toolsList, expected)).toEqual([]);
		const listen = { tools: [...required, toolEntry("channel_listen", { _meta: { "x/y": 1 } })] };
		expect(checkPluginSurface(discover, listen, expected)).toEqual([]);
		expect(checkPluginSurface(withCapabilities({ logging: {} }), toolsList, expected)).toEqual([]);
	});

	it.each([
		["prompts", { prompts: { listChanged: false } }, "SURFACE_PROMPTS"],
		["resources", { resources: {} }, "SURFACE_RESOURCES"],
		["completions", { completions: {} }, "SURFACE_COMPLETIONS"],
		["completions declared as null", { completions: null }, "SURFACE_COMPLETIONS"],
		[
			"the UI extension",
			{ extensions: { ...discover.capabilities.extensions, [UI_EXTENSION]: { mimeTypes: [] } } },
			"SURFACE_UI",
		],
		["the UI extension as experimental", { experimental: { [UI_EXTENSION]: {} } }, "SURFACE_UI"],
	])("refuses %s", (_, capabilities, code) => {
		expect(checkPluginSurface(withCapabilities(capabilities), toolsList)).toEqual([{ code }]);
	});

	it.each([
		["_meta.ui", { ui: { resourceUri: "ui://hello/view" } }],
		["the legacy ui/resourceUri", { "ui/resourceUri": "ui://hello/view" }],
		["the UI extension's key", { [UI_EXTENSION]: { resourceUri: "ui://hello/view" } }],
	])("refuses a tool with %s", (_, meta) => {
		const tools = { tools: [...required, toolEntry("channel_listen", { _meta: meta })] };
		expect(checkPluginSurface(discover, tools)).toEqual([
			{ code: "SURFACE_TOOL_UI", tool: "channel_listen" },
		]);
	});

	it("refuses what isn't a discover result and a tools list", () => {
		const malformed: [unknown, unknown][] = [
			[null, toolsList],
			[{ capabilities: [] }, toolsList],
			[withCapabilities({ extensions: [] }), toolsList],
			[discover, { tools: {} }],
			[discover, required],
			[discover, { tools: [...required, { description: "no name" }] }],
			[discover, { tools: [...required, toolEntry("channel_probe")] }],
			[discover, { tools: [...required, toolEntry("channel_listen", { _meta: [] })] }],
			[withCapabilities({ experimental: [] }), toolsList],
			// Pages after the first would go unchecked, so the list must come whole.
			[discover, { ...toolsList, nextCursor: "page-2" }],
		];
		for (const [discovered, listed] of malformed) {
			expect(checkPluginSurface(discovered, listed).map(({ code }) => code)).toContain(
				"SURFACE_MALFORMED",
			);
		}
	});

	it("checks the expected extension's declaration and tool names", () => {
		const declared = (value: unknown) =>
			checkPluginSurface(
				withCapabilities({ extensions: { [CHANNEL_V1]: value } }),
				toolsList,
				expected,
			);
		const declaration = extensionDeclaration(expected);
		expect(checkPluginSurface(withCapabilities({ extensions: {} }), toolsList, expected)).toEqual([
			{ code: "SURFACE_EXTENSION_MISSING" },
		]);
		expect(declared({ ...declaration, version: 2 })).toEqual([
			{ code: "SURFACE_EXTENSION_VERSION" },
		]);
		expect(declared({ ...declaration, schemaDigest: "0".repeat(64) })).toEqual([
			{ code: "SURFACE_EXTENSION_DIGEST" },
		]);
		for (const invalid of [{ ...declaration, note: 1 }, { version: 1 }, null, "1"]) {
			expect(declared(invalid)).toEqual([{ code: "SURFACE_EXTENSION_INVALID" }]);
		}
		const [, ...withoutDescribe] = required;
		expect(checkPluginSurface(discover, { tools: withoutDescribe }, expected)).toEqual([
			{ code: "SURFACE_TOOL_MISSING", tool: "channel_describe" },
		]);
		const extra = { tools: [...required, toolEntry("channel_export")] };
		expect(checkPluginSurface(discover, extra, expected)).toEqual([
			{ code: "SURFACE_TOOL_UNKNOWN", tool: "channel_export" },
		]);
		const ai = aiProviderV1 as unknown as ExtensionContract;
		expect(checkPluginSurface(discover, toolsList, ai).map(({ code }) => code)).toContain(
			"SURFACE_EXTENSION_MISSING",
		);
	});

	it("reports every problem at once", () => {
		const bad = withCapabilities({
			prompts: {},
			resources: {},
			extensions: { [UI_EXTENSION]: {} },
		});
		const tools = { tools: [toolEntry("channel_x", { _meta: { ui: {} } })] };
		const codes = checkPluginSurface(bad, tools, expected).map(({ code }) => code);
		expect(codes).toEqual([
			"SURFACE_PROMPTS",
			"SURFACE_RESOURCES",
			"SURFACE_UI",
			"SURFACE_TOOL_UI",
			"SURFACE_EXTENSION_MISSING",
			...required.map(() => "SURFACE_TOOL_MISSING"),
			"SURFACE_TOOL_UNKNOWN",
		]);
	});
});

describe("ToolContract", () => {
	// MCP's tools/list takes an inputSchema only with `type: "object"` at its root.
	it("exports every input, output and error with an object root", () => {
		for (const contract of contracts) {
			for (const [name, tool] of Object.entries(contract.tools)) {
				for (const part of [tool.input, tool.output, contract.error, tool.meta]) {
					if (part === undefined) continue;
					expect(z.toJSONSchema(part, { io: "input" }).type, name).toBe("object");
				}
			}
		}
	});

	it("probes return a status and a well-formed detail, never more", () => {
		expect(ProbeResult.safeParse({ status: "ok", detail: "DYTEST slow" }).success).toBe(true);
		for (const probe of [
			{ status: "ok", detail: "\udfff" },
			{ status: "ok", data: 1 },
		]) {
			expect(ProbeResult.safeParse(probe).success).toBe(false);
		}
	});
});
