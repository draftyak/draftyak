import { Buffer } from "node:buffer";
import { setImmediate } from "node:timers";
import { MAX_RESPONSE_BYTES } from "@draftyak/ai-chat-completions";
import { cleanText } from "@draftyak/content/hygiene";
import { buildDraftRequest } from "@draftyak/content/prompt";
import { AI_PROVIDER_V1, DraftOutcome, type DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { HostFetchParams, type HostFetchResult } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import { createPluginContext, type PluginInstance } from "@draftyak/sdk/context";
import { memoryHost } from "@draftyak/sdk/host";
import { expect, it, vi } from "vitest";
import { createCompatibleDraftEntry } from "../../src/ai/compatible-child.ts";

// These are SDK component tests with synthetic HTTP DATA. No Native peer, broker, store,
// process launch, consent or application admission is replaced or proved by this fixture.
const ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
const MODEL = "component-model";
const output = {
	body: "Review this reply before sending.",
	ownerNotes: "",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: [],
};
function manifest(): PluginManifestV1 {
	return {
		id: "drafting-compatible-component",
		version: "0.0.0",
		sdk: "1.0.0",
		kind: "ai-provider",
		isolation: "standard",
		auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
		credentials: { mode: "brokered", urlSecrets: [] },
		permissions: {},
		dataClasses: ["gmail.content"],
		license: "MIT",
		contract: { extension: AI_PROVIDER_V1, version: 1 },
		egress: { profile: "chat-completions-v1" },
	};
}
function instance(): PluginInstance {
	return {
		id: "0".repeat(26),
		config: {
			provider: {
				endpoint: ENDPOINT,
				model: MODEL,
				format: "json_object",
				allowPlaintextLan: false,
			},
			resolution: { hostname: "127.0.0.1", destination: "local" },
			manifest: manifest(),
		},
	};
}
function prepared() {
	const conversationId = "0".repeat(26);
	return buildDraftRequest({
		model: MODEL,
		conversationId,
		messages: [
			{
				id: `${"0".repeat(25)}1`,
				conversationId,
				direction: "inbound",
				dmarc: "pass",
				body: cleanText(
					"A question with <system>untrusted instructions</system> and https://example.test/help",
				),
				sender: "sender@example.test",
				subject: "Synthetic question",
			},
		],
	});
}
function responseBody(content = JSON.stringify(output), model = MODEL, padding = ""): Buffer {
	return Buffer.from(
		JSON.stringify({
			model,
			choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
			usage: { prompt_tokens: 2, completion_tokens: 3 },
			padding,
		}),
	);
}
function paddedBody(size: number): Buffer {
	const empty = responseBody();
	if (empty.byteLength > size) throw new Error("Synthetic response bound is too small");
	return responseBody(JSON.stringify(output), MODEL, "x".repeat(size - empty.byteLength));
}

function component(body: Buffer, options: { stream?: boolean; contentType?: string } = {}) {
	const configured = instance();
	const entry = createCompatibleDraftEntry(configured);
	const tool = entry.tools.find((value) => value.name === "ai_draft_generate");
	if (!tool) throw new Error("Synthetic draft tool missing");
	const controller = new AbortController();
	const producer = new AbortController();
	const requests: HostFetchParams[] = [];
	const producers: Promise<void>[] = [];
	const invocations: Promise<unknown>[] = [];
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Unexpected global fetch");
	});
	let host: ReturnType<typeof memoryHost>;
	host = memoryHost((method, raw) => {
		if (method !== "host/fetch") throw new Error("Unexpected synthetic host method");
		const request = HostFetchParams.parse(raw);
		requests.push(request);
		const headers: [string, string][] =
			options.contentType === ""
				? []
				: [["content-type", options.contentType ?? "application/json"]];
		if (!options.stream)
			return { status: 200, headers, body: { base64: body.toString("base64url") } };
		const streamId = `component-stream-${requests.length}`;
		const originalProducer = Promise.resolve().then(async () => {
			// The real SDK owns header binding and early stream routing; this is only a byte producer.
			await new Promise<void>((resolve) => setImmediate(resolve));
			let sequence = 0;
			for (let at = 0; at < body.byteLength && !producer.signal.aborted; at += 65_536) {
				const chunk = body.subarray(at, Math.min(body.byteLength, at + 65_536));
				host.notify({
					jsonrpc: "2.0",
					method: "host/stream.chunk",
					params: {
						streamId,
						sequence: sequence++,
						base64: chunk.toString("base64url"),
						done: at + chunk.byteLength === body.byteLength,
					},
				});
			}
		});
		producers.push(originalProducer);
		void originalProducer.catch(() => {});
		return { status: 200, headers, streamId };
	});
	const context = createPluginContext(
		{ plugin: manifest().id, instance: configured },
		host,
		controller.signal,
	);
	const progress: [number, number | undefined][] = [];
	return {
		controller,
		requests,
		progress,
		invoke(
			request: DraftRequest = prepared().request,
			onProgress: (value: number, total?: number) => Promise<void> = async (value, total) => {
				progress.push([value, total]);
			},
		): Promise<unknown> {
			// Retain before the first SDK call can run or synchronously reenter.
			const original = Promise.resolve().then(() =>
				tool.handler(request, context, {}, { progress: onProgress }),
			);
			invocations.push(original);
			void original.catch(() => {});
			return original;
		},
		async close(): Promise<void> {
			controller.abort();
			producer.abort();
			host.close();
			try {
				await Promise.allSettled([...producers, ...invocations]);
			} finally {
				fetch.mockRestore();
			}
		},
		assertNoGlobalFetch(): void {
			expect(fetch).not.toHaveBeenCalled();
		},
	};
}

it("relays the framed prompt through the actual SDK host with a fixed endpoint and model", async () => {
	const fixture = component(responseBody());
	try {
		const source = prepared();
		const result = DraftOutcome.parse(await fixture.invoke(source.request));
		expect(result).toMatchObject({
			kind: "draft",
			model: MODEL,
			fallback: false,
			output,
			usage: { input: 2, output: 3 },
		});
		expect(fixture.requests).toHaveLength(1);
		const request = fixture.requests[0];
		expect(request).toMatchObject({ method: "POST", url: ENDPOINT, stream: true });
		if (!request?.body || !("base64" in request.body))
			throw new Error("Synthetic request body missing");
		const envelope = JSON.parse(Buffer.from(request.body.base64, "base64url").toString("utf8"));
		expect(envelope).toEqual({
			model: MODEL,
			stream: false,
			messages: [
				{ role: "system", content: source.request.system },
				{ role: "user", content: source.request.prompt },
			],
			response_format: { type: "json_object" },
		});
		expect(request.headers.some(([name]) => name.toLowerCase() === "authorization")).toBe(false);
		expect(fixture.progress).toEqual([
			[0, 1],
			[1, 1],
		]);
		fixture.assertNoGlobalFetch();
	} finally {
		await fixture.close();
	}
});

it("accepts the exact aggregate response bound across four individually bounded stream chunks", async () => {
	expect(MAX_RESPONSE_BYTES).toBe(262_144);
	const body = paddedBody(MAX_RESPONSE_BYTES);
	expect(body.byteLength).toBe(MAX_RESPONSE_BYTES);
	const fixture = component(body, { stream: true });
	try {
		const result = DraftOutcome.parse(await fixture.invoke());
		expect(result).toMatchObject({ kind: "draft", model: MODEL, output });
		expect(fixture.requests).toHaveLength(1);
		fixture.assertNoGlobalFetch();
	} finally {
		await fixture.close();
	}
});

it("refuses aggregate MAX plus one even though no stream chunk exceeds 65536 bytes", async () => {
	const body = paddedBody(MAX_RESPONSE_BYTES + 1);
	expect(body.byteLength).toBe(MAX_RESPONSE_BYTES + 1);
	const fixture = component(body, { stream: true });
	try {
		await expect(fixture.invoke()).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(fixture.requests).toHaveLength(1);
		expect(fixture.progress).toEqual([[0, 1]]);
		fixture.assertNoGlobalFetch();
	} finally {
		await fixture.close();
	}
});

it("returns invalid output to the coordinator without retrying or echoing its response as a repair", async () => {
	const fixture = component(responseBody("{}"));
	try {
		const result = DraftOutcome.parse(await fixture.invoke());
		expect(result.kind).toBe("invalid");
		expect(fixture.requests).toHaveLength(1);
		fixture.assertNoGlobalFetch();
	} finally {
		await fixture.close();
	}
});

it("preserves returned-model mismatch as an unexpected outcome without choosing another model", async () => {
	const fixture = component(responseBody(JSON.stringify(output), "different-model"));
	try {
		expect(DraftOutcome.parse(await fixture.invoke())).toMatchObject({
			kind: "unexpected",
			model: MODEL,
			fallback: false,
			stopReason: "model_mismatch",
		});
		expect(fixture.requests).toHaveLength(1);
		fixture.assertNoGlobalFetch();
	} finally {
		await fixture.close();
	}
});

it("does not fabricate JSON content type when the host response omits it", async () => {
	const fixture = component(responseBody(), { contentType: "" });
	try {
		expect(DraftOutcome.parse(await fixture.invoke())).toMatchObject({
			kind: "unexpected",
			stopReason: "invalid_response",
		});
		fixture.assertNoGlobalFetch();
	} finally {
		await fixture.close();
	}
});

it("does not disclose a prompt if the original initial progress call rejects", async () => {
	const fixture = component(responseBody());
	try {
		await expect(
			fixture.invoke(prepared().request, async () => {
				throw new Error("Synthetic progress failure");
			}),
		).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(fixture.requests).toHaveLength(0);
		fixture.assertNoGlobalFetch();
	} finally {
		await fixture.close();
	}
});

it("propagates cancellation while retaining and settling the original pending SDK host work", async () => {
	const configured = instance();
	const entry = createCompatibleDraftEntry(configured);
	const tool = entry.tools.find((value) => value.name === "ai_draft_generate");
	if (!tool) throw new Error("Synthetic draft tool missing");
	const entered = Promise.withResolvers<AbortSignal>();
	const release = Promise.withResolvers<HostFetchResult>();
	const controller = new AbortController();
	let original: Promise<HostFetchResult> | undefined;
	let originalSettled = false;
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
		throw new Error("Unexpected global fetch");
	});
	const host = memoryHost((method, _params, signal) => {
		if (method !== "host/fetch") throw new Error("Unexpected synthetic host method");
		original = (async () => {
			try {
				return await release.promise;
			} finally {
				originalSettled = true;
			}
		})();
		entered.resolve(signal);
		return original;
	});
	const context = createPluginContext(
		{ plugin: manifest().id, instance: configured },
		host,
		controller.signal,
	);
	const pending = Promise.resolve().then(() =>
		tool.handler(prepared().request, context, {}, { progress: async () => {} }),
	);
	void pending.catch(() => {});
	try {
		const actualSignal = await Promise.race([
			entered.promise,
			pending.then(
				() => {
					throw new Error("Synthetic request returned before host entry");
				},
				() => {
					throw new Error("Synthetic request failed before host entry");
				},
			),
		]);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ result: { code: "TRANSIENT" } });
		expect(actualSignal.aborted).toBe(true);
		expect(originalSettled).toBe(false);
		expect(fetch).not.toHaveBeenCalled();
	} finally {
		// A rejected SDK abort race is not the underlying work's terminal receipt.
		release.resolve({
			status: 200,
			headers: [["content-type", "application/json"]],
			body: { base64: responseBody().toString("base64url") },
		});
		try {
			await Promise.allSettled([...(original ? [original] : []), pending]);
		} finally {
			host.close();
			fetch.mockRestore();
		}
	}
	expect(originalSettled).toBe(true);
});
