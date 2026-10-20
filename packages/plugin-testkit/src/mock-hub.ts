import { jsonCopy } from "@draftyak/protocol/host-channel";
import { validateManifest } from "@draftyak/protocol/manifest";
import {
	type CanonicalToolName,
	canonicalToolsV1,
	checkToolResult,
} from "@draftyak/protocol/tool-v1";
import { createMockHost } from "./host.ts";
import { createInMemory } from "./in-memory.ts";
import { type MockHub, MockHubError, type MockHubOptions } from "./types.ts";

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

/** In-memory policy fixtures only. Process dispatch belongs to the process-mode adapter. */
export function createMockHub(options: MockHubOptions): MockHub {
	if (options.mode !== "in-memory") throw new MockHubError("PROCESS_MODE_UNAVAILABLE");
	const checked = validateManifest(options.plugin.manifest);
	if (!checked.ok) throw new MockHubError(checked.problems[0]?.code ?? "MANIFEST_INVALID");
	const manifest = freeze(checked.manifest);
	const entry = options.plugin.entry;
	if (
		entry.plugin !== manifest.id ||
		entry.version !== manifest.version ||
		!Object.hasOwn(entry.extensions, manifest.contract.extension)
	)
		throw new MockHubError("PLUGIN_IDENTITY_MISMATCH");
	if (
		entry.account !== options.account?.id ||
		(options.account && !["read_only", "full"].includes(options.account.mode))
	)
		throw new MockHubError("ACCOUNT_MISMATCH");
	const account = options.account ? Object.freeze({ ...options.account }) : undefined;
	const instance = options.instance;
	if (
		typeof instance === "object" &&
		instance.config !== undefined &&
		(instance.config === null ||
			typeof instance.config !== "object" ||
			Array.isArray(instance.config) ||
			Object.keys(instance.config).length !== 0)
	)
		throw new MockHubError("INSTANCE_CONFIG_UNAVAILABLE");
	const bridge = createMockHost({
		manifest,
		...(account ? { account } : {}),
		instance:
			(typeof instance === "string" ? instance : instance?.id) ?? "00000000000000000000000001",
		upstreams: options.upstreams,
		...(options.secrets ? { secrets: options.secrets } : {}),
	});
	const memory = createInMemory(entry, bridge.host, manifest.kind === "tool");
	let closed = false;
	const available = (): void => {
		if (closed || bridge.host.disabled)
			throw new MockHubError(closed ? "HOST_CLOSED" : "PLUGIN_DISABLED");
	};
	const hub: MockHub = {
		host: bridge.host,
		manifest,
		async discover() {
			available();
			return memory.request("server/discover");
		},
		async listTools() {
			available();
			return memory.request("tools/list");
		},
		async call(name, args, metadata = {}) {
			available();
			if (manifest.kind === "tool" && !Object.hasOwn(canonicalToolsV1, name))
				throw new MockHubError("TOOL_NAME_UNDECLARED");
			const kind =
				manifest.kind === "tool"
					? manifest.tool.kinds.find((item) => item.kind === name)
					: undefined;
			if (manifest.kind === "tool" && !kind && !["tool_describe", "tool_probe"].includes(name))
				throw new MockHubError("TOOL_NAME_UNDECLARED");
			const params = jsonCopy({ name, arguments: args, _meta: metadata });
			return bridge.lookup(async (signal) => {
				const result = await memory.request("tools/call", params, signal);
				if (manifest.kind === "tool") {
					const outcome = checkToolResult(
						name as CanonicalToolName,
						result,
						kind ? { maxBytes: kind.output.maxBytes } : {},
					);
					if (outcome.status === "refused") throw new MockHubError(outcome.refusal);
				}
				return result;
			}, kind?.kind);
		},
		async close() {
			if (closed) return;
			closed = true;
			bridge.host.close();
		},
	};
	return Object.freeze(hub);
}
