import { isProxy } from "node:util/types";
import { jsonCopy, LOOKUP_PERMIT_META_KEY } from "@draftyak/protocol/host-channel";
import { validateManifest } from "@draftyak/protocol/manifest";
import {
	type CanonicalToolName,
	canonicalToolsV1,
	checkToolResult,
} from "@draftyak/protocol/tool-v1";
import type { PluginInstance } from "@draftyak/sdk";
import { createMockHost } from "./host.ts";
import { createInMemory } from "./in-memory.ts";
import { createProcess } from "./process.ts";
import {
	copyMockCallOptions,
	copyResponsesHttpInputs,
	type MockHub,
	MockHubError,
	type MockHubOptions,
} from "./types.ts";

function freeze<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) freeze(child);
		Object.freeze(value);
	}
	return value;
}

function ownOption(
	options: MockHubOptions,
	name: "instance" | "responsesHttp",
	code: string,
): unknown {
	const slot = Object.getOwnPropertyDescriptor(options, name);
	if (slot && (!slot.enumerable || !Object.hasOwn(slot, "value"))) throw new MockHubError(code);
	return slot?.value;
}

function dataFields(value: unknown, maximum: number): Record<string, PropertyDescriptor> {
	if (
		value === null ||
		typeof value !== "object" ||
		isProxy(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	)
		throw new MockHubError("INSTANCE_CONFIG_UNAVAILABLE");
	const keys = Reflect.ownKeys(value);
	if (keys.length > maximum || keys.some((key) => typeof key !== "string"))
		throw new MockHubError("INSTANCE_CONFIG_UNAVAILABLE");
	const slots = Object.getOwnPropertyDescriptors(value);
	if (Object.values(slots).some((slot) => !slot.enumerable || !Object.hasOwn(slot, "value")))
		throw new MockHubError("INSTANCE_CONFIG_UNAVAILABLE");
	return slots;
}

function servingInstance(raw: unknown): PluginInstance {
	const fallback = "00000000000000000000000001";
	if (raw === undefined || typeof raw === "string") return { id: raw ?? fallback, config: {} };
	const fields = dataFields(raw, 2);
	if (
		!Object.hasOwn(fields, "id") ||
		Object.keys(fields).some((key) => !["id", "config"].includes(key))
	)
		throw new MockHubError("INSTANCE_CONFIG_UNAVAILABLE");
	if (typeof fields.id?.value !== "string") throw new MockHubError("INVALID_INSTANCE");
	const config: unknown = fields.config?.value === undefined ? {} : fields.config.value;
	const slots = dataFields(config, 4096);
	// Fixed top-level fields keep later option reads from changing what the gate checks; the
	// public SDK factory still captures and freezes the complete bounded JSON snapshot once.
	return {
		id: fields.id.value,
		config: Object.fromEntries(Object.entries(slots).map(([key, slot]) => [key, slot.value])),
	};
}

/** Trusted fixture policy shared by in-memory and retained process transports. */
export function createMockHub(options: MockHubOptions): MockHub {
	if (
		options === null ||
		typeof options !== "object" ||
		isProxy(options) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(options))
	)
		throw new MockHubError("INVALID_OPTIONS");
	const checked = validateManifest(options.plugin.manifest);
	if (!checked.ok) throw new MockHubError(checked.problems[0]?.code ?? "MANIFEST_INVALID");
	const manifest = freeze(checked.manifest);
	const mode = options.mode;
	if (mode !== "in-memory" && mode !== "process") throw new MockHubError("MODE_UNAVAILABLE");
	if (mode === "process" && manifest.kind === "tool")
		throw new MockHubError("PROCESS_KIND_UNAVAILABLE");
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
	const instance = servingInstance(ownOption(options, "instance", "INSTANCE_CONFIG_UNAVAILABLE"));
	const supplied = ownOption(options, "responsesHttp", "INVALID_RESPONSES_BINDINGS");
	const bindings = supplied === undefined ? undefined : copyResponsesHttpInputs(supplied);
	if (
		Object.keys(instance.config).length !== 0 &&
		!(
			mode === "in-memory" &&
			manifest.kind === "ai-provider" &&
			manifest.egress.profile === "responses-api-v1" &&
			bindings !== undefined &&
			bindings.length > 0
		)
	)
		throw new MockHubError("INSTANCE_CONFIG_UNAVAILABLE");
	const bridge = createMockHost({
		manifest,
		...(account ? { account } : {}),
		instance: instance.id,
		upstreams: options.upstreams,
		...(options.secrets ? { secrets: options.secrets } : {}),
		...(bindings ? { responsesHttp: bindings } : {}),
	});
	const memory = (() => {
		try {
			return mode === "process"
				? createProcess(options.plugin, bridge.host, { plugin: manifest.id, instance: instance.id })
				: createInMemory(entry, bridge.host, manifest.kind === "tool", instance);
		} catch (error) {
			bridge.host.close();
			throw error;
		}
	})();
	let closed = false;
	let closing: Promise<void> | undefined;
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
		async call(name, args, metadata = {}, optionsForCall) {
			available();
			const callOptions = copyMockCallOptions(optionsForCall);
			if (callOptions?.onProgress && mode !== "process")
				throw new MockHubError("PROCESS_PROGRESS_UNAVAILABLE");
			if (manifest.kind === "tool" && !Object.hasOwn(canonicalToolsV1, name))
				throw new MockHubError("TOOL_NAME_UNDECLARED");
			const kind =
				manifest.kind === "tool"
					? manifest.tool.kinds.find((item) => item.kind === name)
					: undefined;
			if (manifest.kind === "tool" && !kind && !["tool_describe", "tool_probe"].includes(name))
				throw new MockHubError("TOOL_NAME_UNDECLARED");
			const params = jsonCopy({ name, arguments: args, _meta: metadata });
			return bridge.lookup(
				async (signal, permit) => {
					const admitted =
						permit === undefined
							? params
							: {
									...params,
									_meta: { ...params._meta, [LOOKUP_PERMIT_META_KEY]: permit },
								};
					const result = await memory.request("tools/call", admitted, signal, callOptions);
					if (manifest.kind === "tool") {
						const outcome = checkToolResult(
							name as CanonicalToolName,
							result,
							kind ? { maxBytes: kind.output.maxBytes } : {},
						);
						if (outcome.status === "refused") throw new MockHubError(outcome.refusal);
					}
					return result;
				},
				kind?.kind,
				params.arguments,
			);
		},
		close() {
			if (closing) return closing;
			const outcome = Promise.withResolvers<void>();
			closing = outcome.promise;
			closed = true;
			void (async () => {
				bridge.host.close();
				if ("close" in memory && typeof memory.close === "function") await memory.close();
			})().then(outcome.resolve, outcome.reject);
			return closing;
		},
	};
	return Object.freeze(hub);
}
