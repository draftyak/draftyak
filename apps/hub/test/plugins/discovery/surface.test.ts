import { aiProviderV1 } from "@draftyak/protocol/ai-provider-v1";
import { channelV1 } from "@draftyak/protocol/channel-v1";
import { surfaceDigest } from "@draftyak/protocol/digests";
import { type ExtensionContract, extensionDeclaration } from "@draftyak/protocol/extension";
import { SURFACE_MAX_BYTES } from "@draftyak/protocol/manifest/json";
import { describe, expect, it } from "vitest";
import { compareSurface, validateDiscovery } from "../../../src/plugins/discovery/index.ts";

function exchange(contract: ExtensionContract = channelV1) {
	return {
		discover: {
			capabilities: { extensions: { [contract.id]: extensionDeclaration(contract) } },
		},
		toolsList: {
			tools: Object.entries(contract.tools)
				.filter(([, tool]) => tool.optional !== true)
				.map(([name]) => ({ name, inputSchema: { type: "object" } })),
		},
	};
}

describe("retained canonical plugin discovery", () => {
	it.each([
		["channel", channelV1],
		["ai-provider", aiProviderV1],
	] as const)(
		"validates %s against the merged contract and hashes its exact surface",
		(kind, contract) => {
			const { discover, toolsList } = exchange(contract);
			const result = validateDiscovery(kind, discover, toolsList);
			expect(result).toEqual({
				ok: true,
				kind,
				digest: surfaceDigest(discover.capabilities, toolsList.tools),
			});
			expect(Object.isFrozen(result)).toBe(true);
		},
	);

	it.each(["tool", "other", "", undefined, null, {}, new String("channel")])(
		"refuses unavailable kind %s without inspecting the exchange",
		(kind) => {
			const hostile = new Proxy(
				{},
				{
					get: () => {
						throw new Error("must not read");
					},
				},
			);
			expect(validateDiscovery(kind, hostile, hostile)).toEqual({
				ok: false,
				problems: ["PLUGIN_KIND_UNAVAILABLE"],
			});
		},
	);

	it.each(["prompts", "resources", "completions"])("refuses declared %s", (field) => {
		const { discover, toolsList } = exchange();
		Object.assign(discover.capabilities, { [field]: {} });
		expect(validateDiscovery("channel", discover, toolsList)).toMatchObject({ ok: false });
	});

	it.each(["extensions", "experimental"])("refuses UI through %s", (field) => {
		const { discover, toolsList } = exchange();
		if (field === "extensions") {
			Object.assign(discover.capabilities.extensions, { "io.modelcontextprotocol/ui": {} });
		} else
			Object.assign(discover.capabilities, { experimental: { "io.modelcontextprotocol/ui": {} } });
		expect(validateDiscovery("channel", discover, toolsList)).toEqual({
			ok: false,
			problems: ["SURFACE_UI"],
		});
	});

	it.each(["ui", "ui/resourceUri", "io.modelcontextprotocol/ui"])(
		"refuses tool metadata %s",
		(key) => {
			const { discover, toolsList } = exchange();
			const first = toolsList.tools[0];
			if (first === undefined) throw new Error("Missing fixture tool");
			Object.assign(first, { _meta: { [key]: "private" } });
			expect(validateDiscovery("channel", discover, toolsList)).toEqual({
				ok: false,
				problems: ["SURFACE_TOOL_UI"],
			});
		},
	);

	it("refuses missing, incompatible and mismatched extension declarations", () => {
		for (const declaration of [
			undefined,
			{ version: 1 },
			{ version: 2, schemaDigest: "0".repeat(64) },
			{ version: 1, schemaDigest: "0".repeat(64) },
		]) {
			const { discover, toolsList } = exchange();
			if (declaration === undefined)
				delete (discover.capabilities.extensions as Record<string, unknown>)[channelV1.id];
			else Object.assign(discover.capabilities.extensions, { [channelV1.id]: declaration });
			expect(validateDiscovery("channel", discover, toolsList)).toMatchObject({ ok: false });
		}
	});

	it("refuses unknown, missing, duplicate and paginated tools without echoing names", () => {
		const { discover, toolsList } = exchange();
		const variants = [
			{ tools: [...toolsList.tools, { name: "private-content", inputSchema: {} }] },
			{ tools: toolsList.tools.slice(1) },
			{ tools: [...toolsList.tools, toolsList.tools[0]] },
			{ ...toolsList, nextCursor: "next" },
		];
		for (const list of variants) {
			const result = validateDiscovery("channel", discover, list);
			expect(result).toMatchObject({ ok: false });
			expect(JSON.stringify(result)).not.toContain("private-content");
		}
	});

	it("refuses a channel contract presented as a provider", () => {
		const { discover, toolsList } = exchange();
		expect(validateDiscovery("ai-provider", discover, toolsList)).toMatchObject({ ok: false });
	});

	it("hashes tool schema and array-order changes while ignoring envelope metadata", () => {
		const { discover, toolsList } = exchange();
		const original = validateDiscovery("channel", discover, toolsList);
		expect(
			validateDiscovery("channel", { ...discover, serverInfo: { name: "example" } }, toolsList),
		).toEqual(original);
		const first = toolsList.tools[0];
		if (first === undefined) throw new Error("Missing fixture tool");
		Object.assign(first.inputSchema, { description: "changed" });
		const changedSchema = validateDiscovery("channel", discover, toolsList);
		expect(changedSchema).not.toEqual(original);
		toolsList.tools.reverse();
		expect(validateDiscovery("channel", discover, toolsList)).not.toEqual(changedSchema);
	});

	it("takes detached snapshots and returns immutable fixed-code failures", () => {
		const { discover, toolsList } = exchange();
		const result = validateDiscovery("channel", discover, toolsList);
		toolsList.tools.length = 0;
		expect(result.ok).toBe(true);
		const failed = validateDiscovery("channel", discover, toolsList);
		expect(failed.ok).toBe(false);
		if (!failed.ok) {
			expect(Object.isFrozen(failed.problems)).toBe(true);
			expect(new Set(failed.problems).size).toBe(failed.problems.length);
		}
	});

	it("accepts the exact canonical surface byte bound and refuses one additional byte", () => {
		const { discover, toolsList } = exchange();
		const padding = { value: "" };
		Object.assign(discover.capabilities, { experimental: padding });
		const baseBytes = Buffer.byteLength(
			JSON.stringify({ capabilities: discover.capabilities, tools: toolsList.tools }),
		);
		padding.value = "x".repeat(SURFACE_MAX_BYTES - baseBytes);
		expect(validateDiscovery("channel", discover, toolsList)).toMatchObject({ ok: true });
		padding.value += "x";
		expect(validateDiscovery("channel", discover, toolsList)).toEqual({
			ok: false,
			problems: ["SURFACE_MALFORMED"],
		});
	});

	it("never invokes accessors, proxies or serialization hooks", () => {
		let calls = 0;
		const accessor = Object.defineProperty({}, "capabilities", {
			enumerable: true,
			get() {
				calls++;
				return {};
			},
		});
		const proxy = new Proxy(
			{},
			{
				get() {
					calls++;
					return {};
				},
				ownKeys() {
					calls++;
					return [];
				},
			},
		);
		const toJSON = {
			toJSON() {
				calls++;
				return {};
			},
		};
		for (const value of [accessor, proxy, toJSON]) {
			const { discover, toolsList } = exchange();
			expect(validateDiscovery("channel", value, toolsList)).toEqual({
				ok: false,
				problems: ["SURFACE_MALFORMED"],
			});
			expect(validateDiscovery("channel", discover, { tools: [value] })).toEqual({
				ok: false,
				problems: ["SURFACE_MALFORMED"],
			});
		}
		expect(calls).toBe(0);
	});

	it("refuses cyclic, sparse, non-JSON, malformed and over-bound exchanges", () => {
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		for (const value of [
			null,
			"{}",
			[],
			new Date(),
			cycle,
			{ capabilities: { value: "\ud800" } },
			{ capabilities: { value: "x".repeat(SURFACE_MAX_BYTES) } },
		]) {
			expect(validateDiscovery("channel", value, exchange().toolsList)).toEqual({
				ok: false,
				problems: ["SURFACE_MALFORMED"],
			});
		}
		const { discover } = exchange();
		for (const tools of [new Array(2), [undefined], [1n], [Number.NaN]]) {
			expect(validateDiscovery("channel", discover, { tools })).toEqual({
				ok: false,
				problems: ["SURFACE_MALFORMED"],
			});
		}
	});
});

describe("surface pin comparison", () => {
	const digest = "a".repeat(64);
	it("distinguishes the first pin from a stable pin and drift", () => {
		expect(compareSurface(null, digest)).toEqual({ ok: true, status: "pin", digest });
		expect(compareSurface(digest, digest)).toEqual({ ok: true, status: "match", digest });
		expect(compareSurface("b".repeat(64), digest)).toEqual({ ok: false, code: "SURFACE_DRIFT" });
	});
	it.each([
		undefined,
		"",
		"A".repeat(64),
		`${"a".repeat(64)}\n`,
		"a".repeat(63),
		{},
		new String(digest),
	])("refuses malformed pins and observed digests %s", (value) => {
		expect(compareSurface(value, digest)).toEqual({ ok: false, code: "SURFACE_PIN_INVALID" });
		expect(compareSurface(null, value)).toEqual({ ok: false, code: "SURFACE_PIN_INVALID" });
	});
});
