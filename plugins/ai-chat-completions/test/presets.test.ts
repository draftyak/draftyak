import {
	createPluginContext,
	type HostFetch,
	type HostFetchInit,
	memoryHost,
	type PluginContext,
	PluginError,
} from "@draftyak/sdk";
import { describe, expect, it, vi } from "vitest";
import { type CompatibleFormat, createCompatibleCore } from "../src/index.ts";
import { createPlugin } from "../src/plugin.ts";
import { MODEL, REQUEST } from "./helpers.ts";

const formats = ["json_schema", "json_object", "ollama"] as const;
const presets = [
	{ preset: "ollama", origin: "http://127.0.0.1:11434" },
	{ preset: "lmStudio", origin: "http://127.0.0.1:1234" },
	{ preset: "llamaCpp8080", origin: "http://127.0.0.1:8080" },
	{ preset: "llamaCpp9931", origin: "http://127.0.0.1:9931" },
	{ preset: "vllm", origin: "http://127.0.0.1:8000" },
] as const;
const selections = presets.flatMap((preset) => formats.map((format) => ({ ...preset, format })));
const emptyDraft = {
	body: "",
	ownerNotes: "",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: [],
};

function choice(preset: unknown = "ollama", format: unknown = "json_schema") {
	return {
		preset,
		model: MODEL,
		format,
		resolution: { hostname: "127.0.0.1", destination: "local" },
	};
}

function envelope(format: CompatibleFormat, content = JSON.stringify(emptyDraft), model = MODEL) {
	const message = { role: "assistant", content };
	return format === "ollama"
		? { model, message, done: true, done_reason: "stop" }
		: { model, choices: [{ message, finish_reason: "stop" }] };
}

function reply(value: unknown, status = 200) {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function mounted(
	config: Readonly<Record<string, unknown>>,
	format: CompatibleFormat,
	transport?: HostFetch,
) {
	const instance = { id: "preset-test-instance", config };
	const plugin = createPlugin(instance);
	const controller = new AbortController();
	const host = memoryHost(() => {
		throw new Error("Unexpected host operation");
	});
	const calls: { url: string; init: HostFetchInit }[] = [];
	const fetch: HostFetch = async (input, init = {}) => {
		calls.push({ url: input.toString(), init });
		if (transport) return transport(input, init);
		return reply(
			init.method === "GET"
				? format === "ollama"
					? { models: [{ name: MODEL }] }
					: { data: [{ id: MODEL }] }
				: envelope(format),
		);
	};
	const context: PluginContext = {
		...createPluginContext({ plugin: plugin.plugin, instance }, host, controller.signal),
		fetch,
	};
	return {
		calls,
		invoke(name: string, input: unknown = {}) {
			const tool = plugin.tools.find((entry) => entry.name === name);
			if (!tool) throw new Error(`Missing tool ${name}`);
			return Promise.resolve(tool.handler(input, context, {}));
		},
		close: () => host.close(),
	};
}

function invalid(config: unknown) {
	let caught: unknown;
	try {
		createPlugin({
			id: "preset-test-instance",
			config: config as Readonly<Record<string, unknown>>,
		});
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(PluginError);
	expect(caught).toMatchObject({ result: { code: "INVALID_INPUT" } });
	return caught;
}

describe("selected compatible presets", () => {
	it.each(selections)(
		"mounts $preset in $format through models and probe",
		async ({ preset, origin, format }) => {
			const h = mounted(choice(preset, format), format);
			try {
				expect(h.calls).toHaveLength(0);
				expect(await h.invoke("ai_models_list")).toEqual({
					models: [{ id: MODEL, fallbacks: false }],
				});
				expect(await h.invoke("ai_probe", { model: MODEL })).toEqual({ status: "ok" });
				expect(h.calls).toHaveLength(2);
				const [models, probe] = h.calls;
				expect(models?.url).toBe(`${origin}${format === "ollama" ? "/api/tags" : "/v1/models"}`);
				expect(models?.init).toMatchObject({ method: "GET", redirect: "error", stream: true });
				expect(models?.init.body).toBeUndefined();
				expect([...new Headers(models?.init.headers)]).toEqual([]);
				expect(probe?.url).toBe(
					`${origin}${format === "ollama" ? "/api/chat" : "/v1/chat/completions"}`,
				);
				expect(probe?.init).toMatchObject({ method: "POST", redirect: "error", stream: true });
				expect(probe?.init.signal).toBeInstanceOf(AbortSignal);
				const body = JSON.parse(String(probe?.init.body));
				expect(body.model).toBe(MODEL);
				expect(body.stream).toBe(false);
				expect(body.messages.map((message: { role: string }) => message.role)).toEqual([
					"system",
					"user",
				]);
				if (format === "ollama") {
					expect(body.format.type).toBe("object");
					expect(body.response_format).toBeUndefined();
				} else {
					expect(body.response_format.type).toBe(format);
					expect(body.format).toBeUndefined();
				}
			} finally {
				h.close();
			}
		},
	);

	it.each([
		"llamaCpp",
		"lmstudio",
		"constructor",
		"__proto__",
		"toString",
		"ollama ",
		"",
		null,
		42,
	])("refuses unknown or inherited preset ID %j", (preset) => {
		invalid(choice(preset));
	});
	it("rejects simultaneous preset and endpoint before factory bootstrap", () => {
		invalid({ ...choice(), endpoint: "http://127.0.0.1:11434/v1/chat/completions" });
	});
	it.each([
		{ ...choice(), endpoint: undefined },
		{ ...choice(), preset: undefined, endpoint: "http://127.0.0.1:11434/v1/chat/completions" },
		{ model: MODEL, format: "json_schema", resolution: choice().resolution },
	])("refuses ambiguous or missing endpoint selection", (config) => {
		invalid(config);
	});
	it.each(["path", "modelsEndpoint", "destination", "fallbackPreset"])(
		"refuses extra selection key %s",
		(key) => {
			invalid({ ...choice(), [key]: key === "path" ? "/api/chat" : "local" });
		},
	);
	it.each([
		{ ...choice(), model: undefined },
		{ ...choice(), model: "" },
		{ ...choice(), format: undefined },
		{ ...choice(), format: "openai" },
	])("requires an explicit valid model and format", (config) => {
		invalid(config);
	});

	it("never chooses the first listed model instead of the configured pin", async () => {
		const h = mounted(choice("llamaCpp9931"), "json_schema", async (_input, init) =>
			reply(init?.method === "GET" ? { data: [{ id: "another-model" }] } : envelope("json_schema")),
		);
		try {
			expect(await h.invoke("ai_models_list")).toEqual({
				models: [{ id: "another-model", fallbacks: false }],
			});
			expect(await h.invoke("ai_probe")).toEqual({ status: "ok" });
			expect(JSON.parse(String(h.calls[1]?.init.body)).model).toBe(MODEL);
		} finally {
			h.close();
		}
	});
	it.each(formats)("rejects another requested model before any %s fetch", async (format) => {
		const h = mounted(choice("ollama", format), format);
		try {
			await expect(h.invoke("ai_probe", { model: "another-model" })).rejects.toMatchObject({
				result: { code: "INVALID_INPUT" },
			});
			await expect(
				h.invoke("ai_draft_generate", { ...REQUEST, model: "another-model" }),
			).rejects.toMatchObject({ result: { code: "INVALID_INPUT" } });
			expect(h.calls).toHaveLength(0);
		} finally {
			h.close();
		}
	});
	it.each(formats)("does not accept a %s completion under a model alias", async (format) => {
		const h = mounted(choice("vllm", format), format, async () =>
			reply(envelope(format, JSON.stringify(emptyDraft), "another-model")),
		);
		try {
			expect(await h.invoke("ai_probe")).toEqual({
				status: "degraded",
				detail: "probe: unexpected",
			});
			expect(await h.invoke("ai_draft_generate", REQUEST)).toMatchObject({
				kind: "unexpected",
				model: MODEL,
				fallback: false,
				stopReason: "model_mismatch",
			});
			expect(h.calls).toHaveLength(2);
		} finally {
			h.close();
		}
	});
	it.each(formats)("reports invalid %s probe output as degraded health", async (format) => {
		const h = mounted(choice("lmStudio", format), format, async () =>
			reply(envelope(format, "not a draft JSON object")),
		);
		try {
			expect(await h.invoke("ai_probe")).toEqual({ status: "degraded", detail: "probe: invalid" });
			expect(h.calls).toHaveLength(1);
		} finally {
			h.close();
		}
	});
	it("does not switch to another llama.cpp port after a failed probe", async () => {
		const h = mounted(choice("llamaCpp8080"), "json_schema", async () => reply({}, 503));
		try {
			await expect(h.invoke("ai_probe")).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
			expect(h.calls).toHaveLength(1);
			expect(h.calls[0]?.url).toBe("http://127.0.0.1:8080/v1/chat/completions");
		} finally {
			h.close();
		}
	});

	it("does not turn rejected endpoint classifications into local destinations", () => {
		for (const destination of ["cloud", "mixed", "blocked", "may-train", undefined])
			invalid({
				...choice(),
				allowPlaintextLan: true,
				resolution: { hostname: "127.0.0.1", destination },
			});
	});
	it("requires the original hostname and closed classification fields", () => {
		invalid({
			...choice(),
			resolution: { hostname: "other.example.invalid", destination: "local" },
		});
		invalid({ ...choice(), resolution: { ...choice().resolution, preset: "ollama" } });
	});
	it("keeps the supplied LAN classification and requires plaintext acknowledgement", () => {
		const resolution = { hostname: "127.0.0.1", destination: "local-network" };
		invalid({ ...choice(), resolution });
		invalid({ ...choice(), resolution, allowPlaintextLan: false });
		invalid({ ...choice(), resolution, allowPlaintextLan: "true" });
		const core = createCompatibleCore(
			{ preset: "ollama", model: MODEL, format: "json_schema", allowPlaintextLan: true },
			resolution,
		);
		expect(core.config.destination).toBe("local-network");
		expect(core.config.endpoint).toBe("http://127.0.0.1:11434/v1/chat/completions");
	});
	it.each(["preset", "model", "format", "resolution"])(
		"rejects a bootstrap %s accessor without invoking it",
		(key) => {
			const getter = vi.fn(() => {
				throw new Error("preset-config-sentinel");
			});
			const config = Object.defineProperty(choice(), key, { enumerable: true, get: getter });
			expect(String(invalid(config))).not.toContain("preset-config-sentinel");
			expect(getter).not.toHaveBeenCalled();
		},
	);
	it("rejects configuration proxies without consulting their traps", () => {
		const trap = vi.fn(() => {
			throw new Error("preset-config-sentinel");
		});
		const config = new Proxy(choice(), {
			get: trap,
			getPrototypeOf: trap,
			getOwnPropertyDescriptor: trap,
			ownKeys: trap,
		});
		invalid(config);
		expect(trap).not.toHaveBeenCalled();
	});
	it("rejects revoked configuration proxies", () => {
		const config = Proxy.revocable(choice(), {});
		config.revoke();
		invalid(config.proxy);
	});
	it("rejects symbol selection fields", () =>
		invalid({ ...choice(), [Symbol("preset")]: "ollama" }));
	it("does not read an inherited preset", () => {
		const getter = vi.fn(() => "ollama");
		const prototype = Object.defineProperty({}, "preset", { get: getter });
		const { model, format, resolution } = choice();
		invalid(Object.assign(Object.create(prototype), { model, format, resolution }));
		expect(getter).not.toHaveBeenCalled();
	});
	it("rejects a non-enumerable preset instead of treating it as absent", () => {
		invalid(Object.defineProperty(choice(), "preset", { value: "ollama", enumerable: false }));
	});
	it("captures a valid null-prototype selection without requiring object hooks", async () => {
		const config = Object.assign(Object.create(null), choice("llamaCpp9931", "ollama"));
		config.resolution = Object.assign(Object.create(null), config.resolution);
		const h = mounted(config, "ollama");
		try {
			expect(await h.invoke("ai_probe")).toEqual({ status: "ok" });
			expect(h.calls[0]?.url).toBe("http://127.0.0.1:9931/api/chat");
		} finally {
			h.close();
		}
	});
	it("captures the selected preset, format, model and classification before caller mutation", async () => {
		const config = choice("llamaCpp8080");
		const h = mounted(config, "json_schema");
		config.preset = "vllm";
		config.model = "another-model";
		config.format = "ollama";
		config.resolution.hostname = "other.example.invalid";
		config.resolution.destination = "cloud";
		try {
			expect(await h.invoke("ai_models_list")).toEqual({
				models: [{ id: MODEL, fallbacks: false }],
			});
			expect(await h.invoke("ai_probe")).toEqual({ status: "ok" });
			expect(h.calls.map((call) => call.url)).toEqual([
				"http://127.0.0.1:8080/v1/models",
				"http://127.0.0.1:8080/v1/chat/completions",
			]);
			expect(JSON.parse(String(h.calls[1]?.init.body)).model).toBe(MODEL);
		} finally {
			h.close();
		}
	});
	it("preserves the explicit HTTPS endpoint bootstrap", async () => {
		const h = mounted(
			{
				endpoint: "https://model.example.invalid/v1/chat/completions",
				model: MODEL,
				format: "json_object",
				resolution: { hostname: "model.example.invalid", destination: "cloud" },
			},
			"json_object",
		);
		try {
			expect(await h.invoke("ai_models_list")).toEqual({
				models: [{ id: MODEL, fallbacks: false }],
			});
			expect(await h.invoke("ai_probe")).toEqual({ status: "ok" });
			expect(h.calls.map((call) => call.url)).toEqual([
				"https://model.example.invalid/v1/models",
				"https://model.example.invalid/v1/chat/completions",
			]);
		} finally {
			h.close();
		}
	});
});
