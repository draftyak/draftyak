import { afterEach, describe, expect, it, vi } from "vitest";
import { checkAiProviderOutput } from "../src/contracts/ai-provider.ts";
import type { MessagesHttpBindingInput } from "../src/messages-http.ts";
import { createMockHub } from "../src/mock-hub.ts";
import type { MockHubOptions } from "../src/types.ts";
import {
	createMessagesContractFixture,
	origin,
	outcome,
	request,
	schema,
} from "./fixtures/ai-provider-messages-http/fixture.ts";

afterEach(() => vi.unstubAllGlobals());

function input() {
	return {
		operation: "ai_draft_generate" as const,
		origin: "https://api.anthropic.com" as const,
		draft: { ...request, contextIds: ["c1"] as ("c1" | "c2" | "c3")[] },
		schema: structuredClone(schema),
	};
}

function options(
	fixture: ReturnType<typeof createMessagesContractFixture>,
	messagesHttp: readonly MessagesHttpBindingInput[],
): MockHubOptions {
	return { mode: "in-memory", plugin: fixture.plugin, upstreams: [fixture.fake], messagesHttp };
}

describe("Messages constructor-owned fixture bindings", () => {
	it("captures the complete draft/schema before a plugin getter can change them", async () => {
		const fixture = createMessagesContractFixture();
		const selected = input();
		const values = [selected];
		let reads = 0;
		const config = options(fixture, values);
		Object.defineProperty(config, "plugin", {
			enumerable: true,
			get() {
				reads++;
				selected.draft.prompt = "DYTEST-intervening change";
				selected.schema.required.length = 0;
				values.length = 0;
				return fixture.plugin;
			},
		});
		const hub = createMockHub(config);
		try {
			await hub.discover();
			expect((await hub.call("ai_draft_generate", { ...request })).isError).not.toBe(true);
			expect(fixture.calls).toHaveLength(1);
			expect(reads).toBeGreaterThan(0);
		} finally {
			await hub.close();
		}
	});

	it("keeps nested arrays/schema detached after construction", async () => {
		const fixture = createMessagesContractFixture();
		const selected = input();
		const values = [selected];
		const hub = createMockHub(options(fixture, values));
		selected.draft.system = "DYTEST-other system";
		selected.draft.contextIds[0] = "c2";
		selected.schema.properties.body.type = "number";
		selected.schema.required.pop();
		values.length = 0;
		try {
			await hub.discover();
			expect((await hub.call("ai_draft_generate", { ...request })).structuredContent).toEqual(
				outcome,
			);
			expect(fixture.calls).toHaveLength(1);
		} finally {
			await hub.close();
		}
	});

	it("captures Messages data before another contract fixture getter runs", async () => {
		const fixture = createMessagesContractFixture();
		const selected = input();
		let reads = 0;
		const values = { ...fixture.fixtures(), messagesHttp: [selected] };
		Object.defineProperty(values, "request", {
			enumerable: true,
			get() {
				reads++;
				selected.draft.prompt = "DYTEST-intervening fixture change";
				selected.schema.required.length = 0;
				return request;
			},
		});
		expect(
			await checkAiProviderOutput({
				mode: "in-memory",
				plugin: fixture.plugin,
				fixtures: () => values,
			}),
		).toEqual({ status: "pass" });
		expect(reads).toBeGreaterThan(0);
		expect(fixture.calls).toHaveLength(1);
	});

	it("refuses a schema mismatch before the real public host calls the fake", async () => {
		const fixture = createMessagesContractFixture();
		const selected = input();
		selected.schema.required.pop();
		const hub = createMockHub(options(fixture, [selected]));
		try {
			await hub.discover();
			const result = await hub.call("ai_draft_generate", { ...request });
			expect(fixture.calls).toHaveLength(0);
			expect(fixture.fake.recorder.takeRequests()).toHaveLength(0);
			expect(result.isError).toBe(true);
		} finally {
			await hub.close();
		}
		expect(
			await checkAiProviderOutput({
				mode: "in-memory",
				plugin: fixture.plugin,
				fixtures: fixture.fixtures,
			}),
		).toEqual({ status: "pass" });
		expect(fixture.calls).toHaveLength(1);
	});

	it.each(["ai_models_list", "ai_probe"] as const)(
		"refuses a mismatched %s binding before the fake, then accepts matching DATA",
		async (operation) => {
			const fixture = createMessagesContractFixture();
			const wrong: MessagesHttpBindingInput =
				operation === "ai_models_list"
					? { operation, origin, afterId: "claude-other-page" }
					: { operation, origin, model: "claude-other-model" };
			const correct: MessagesHttpBindingInput =
				operation === "ai_models_list"
					? { operation, origin }
					: { operation, origin, model: request.model };
			const refused = createMockHub(options(fixture, [wrong]));
			try {
				await refused.discover();
				expect((await refused.call(operation, {})).isError).toBe(true);
				expect(fixture.calls).toHaveLength(0);
			} finally {
				await refused.close();
			}
			const accepted = createMockHub(options(fixture, [correct]));
			try {
				await accepted.discover();
				expect((await accepted.call(operation, {})).isError).not.toBe(true);
				expect(fixture.calls).toHaveLength(1);
			} finally {
				await accepted.close();
			}
		},
	);

	it.each([
		"array proxy",
		"element accessor",
		"option accessor",
		"sparse array",
		"nested schema getter",
		"element proxy",
	])("refuses %s without hooks or fake/global dispatch", async (kind) => {
		const fixture = createMessagesContractFixture();
		let hooks = 0;
		let globalCalls = 0;
		vi.stubGlobal("fetch", async () => {
			globalCalls++;
			throw new Error("DYTEST unexpected global dispatch");
		});
		let bindings: unknown = [input()];
		if (kind === "array proxy")
			bindings = new Proxy([input()], {
				ownKeys() {
					hooks++;
					return [];
				},
			});
		if (kind === "sparse array") bindings = new Array(1);
		if (kind === "element accessor") {
			bindings = Object.defineProperty([input()], "0", {
				enumerable: true,
				get() {
					hooks++;
					return input();
				},
			});
		}
		if (kind === "nested schema getter") {
			bindings = [
				{
					...input(),
					schema: Object.defineProperty({}, "type", {
						enumerable: true,
						get() {
							hooks++;
							return "object";
						},
					}),
				},
			];
		}
		if (kind === "element proxy")
			bindings = [
				new Proxy(input(), {
					getPrototypeOf() {
						hooks++;
						return Object.prototype;
					},
				}),
			];
		const config = { mode: "in-memory", upstreams: [fixture.fake], messagesHttp: bindings };
		Object.defineProperty(config, "plugin", {
			enumerable: true,
			get() {
				hooks++;
				return fixture.plugin;
			},
		});
		if (kind === "option accessor")
			Object.defineProperty(config, "messagesHttp", {
				enumerable: true,
				get() {
					hooks++;
					return [input()];
				},
			});
		expect(() => createMockHub(config as unknown as MockHubOptions)).toThrowError(
			expect.objectContaining({ code: "INVALID_MESSAGES_BINDINGS" }),
		);
		expect(hooks).toBe(0);
		expect(globalCalls).toBe(0);
		expect(fixture.calls).toHaveLength(0);
	});

	it.each(["responses-api-v1", "chat-completions-v1"] as const)(
		"refuses Messages bindings under %s",
		(profile) => {
			const fixture = createMessagesContractFixture();
			const plugin = {
				...fixture.plugin,
				manifest: { ...(fixture.plugin.manifest as object), egress: { profile } },
			};
			expect(() => createMockHub({ ...options(fixture, [input()]), plugin })).toThrowError(
				expect.objectContaining({ code: "INVALID_MESSAGES_BINDINGS" }),
			);
			expect(fixture.calls).toHaveLength(0);
		},
	);

	it("retains the nonempty process instance-config refusal with valid Messages inputs", () => {
		const fixture = createMessagesContractFixture();
		expect(() =>
			createMockHub({
				...options(fixture, [input()]),
				mode: "process",
				instance: { id: "DYTEST-instance", config: { model: request.model } },
			}),
		).toThrowError(expect.objectContaining({ code: "INSTANCE_CONFIG_UNAVAILABLE" }));
		expect(fixture.calls).toHaveLength(0);
	});

	it("rejects an accessor binding option before reading the contract request", async () => {
		const fixture = createMessagesContractFixture();
		let hooks = 0;
		const values = fixture.fixtures();
		Object.defineProperty(values, "messagesHttp", {
			enumerable: true,
			get() {
				hooks++;
				return [input()];
			},
		});
		Object.defineProperty(values, "request", {
			enumerable: true,
			get() {
				hooks++;
				return request;
			},
		});
		expect(
			await checkAiProviderOutput({
				mode: "in-memory",
				plugin: fixture.plugin,
				fixtures: () => values,
			}),
		).toEqual({ status: "fail", code: "AI_FIXTURES_INVALID" });
		expect(hooks).toBe(0);
		expect(fixture.calls).toHaveLength(0);
	});
});
