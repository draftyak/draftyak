import { existsSync } from "node:fs";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFake } from "@draftyak/fakes";
import {
	type AiProviderFixtures,
	bindProcessPlugin,
	type MockPlugin,
	type ProcessPluginFiles,
} from "@draftyak/plugin-testkit";
import type { DraftOutcome, DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { defineAiProviderPlugin } from "@draftyak/sdk";
import { build } from "tsdown";
import manifest from "../../../draftyak.plugin.json" with { type: "json" };
import type { CompatibleFormat } from "../../../src/index.ts";

const MODEL = "dytest-compatible-sdk-model";
const request: DraftRequest = {
	model: MODEL,
	system: "DYTEST-Return the fictional reply as DraftOutputV1.",
	prompt: "DYTEST-A fictional message asks when the sample is ready.",
	contextIds: ["c1"],
};
const expected: Extract<DraftOutcome, { kind: "draft" }> = {
	kind: "draft",
	model: MODEL,
	fallback: false,
	usage: { input: 100, output: 50 },
	output: {
		body: "DYTEST-The sample is ready for review.",
		ownerNotes: "DYTEST-Check the sample before replying.",
		needsOwnerInput: [],
		suspectedInstructions: false,
		contextRefs: ["c1"],
	},
};
const probePrompt =
	'Return exactly {"body":"","ownerNotes":"","needsOwnerInput":[],"suspectedInstructions":false,"contextRefs":[]}.';
const entries: Record<CompatibleFormat, string> = {
	json_schema: "./server-json-schema.ts",
	json_object: "./server-json-object.ts",
	ollama: "./server-ollama.ts",
};

export interface RecordedCompatibleCall {
	readonly method: string;
	readonly url: string;
	readonly headers: readonly (readonly [string, string])[];
	readonly body: string;
}
export type CompatibleScript = "normal" | "oversize" | "stall";
export interface CompatibleProcessFixture {
	readonly plugin: MockPlugin;
	fixtures(script?: CompatibleScript): AiProviderFixtures;
	calls(): readonly RecordedCompatibleCall[];
	parentCalls(): number;
	started(): Promise<void>;
	reading(): Promise<void>;
	cancelled(): Promise<void>;
	cancellations(): number;
	cleanup(): Promise<void>;
}

export async function compatibleProcessFixture(
	format: CompatibleFormat,
): Promise<CompatibleProcessFixture> {
	const temporary = await realpath(tmpdir());
	const root = await realpath(await mkdtemp(path.join(temporary, "DYTEST-compatible-process-")));
	const born = await lstat(root, { bigint: true });
	let cleaned = false;
	let closing: Promise<void> | undefined;
	const cleanup = (): Promise<void> => {
		if (cleaned) return Promise.resolve();
		if (closing) return closing;
		closing = (async () => {
			const current = await lstat(root, { bigint: true });
			if (
				path.dirname(root) !== temporary ||
				!path.basename(root).startsWith("DYTEST-compatible-process-") ||
				current.isSymbolicLink() ||
				current.dev !== born.dev ||
				current.ino !== born.ino ||
				current.birthtimeNs !== born.birthtimeNs ||
				(await realpath(root)) !== root
			)
				throw new Error("Compatible process fixture cleanup refused.");
			await rm(root, { recursive: true, force: true });
			if (existsSync(root)) throw new Error("Compatible process fixture cleanup incomplete.");
			cleaned = true;
		})().catch((error: unknown) => {
			closing = undefined;
			throw error;
		});
		return closing;
	};
	try {
		await build({
			config: false,
			entry: { server: fileURLToPath(new URL(entries[format], import.meta.url)) },
			outDir: root,
			platform: "node",
			format: "esm",
			target: "node26",
			fixedExtension: true,
			deps: { alwaysBundle: [/.*/] },
			dts: false,
			sourcemap: false,
			clean: false,
			exports: false,
			report: false,
			logLevel: "warn",
			failOnWarn: true,
		});
		if ((await readdir(root)).sort().join() !== "server.mjs")
			throw new Error("Compatible process fixture must be one self-contained module.");
		const files: ProcessPluginFiles = Object.freeze({
			directory: root,
			entry: "server.mjs",
			files: Object.freeze(["server.mjs"]),
		});
		let parentCalls = 0;
		const tripwire = (): never => {
			parentCalls++;
			throw new Error("Compatible provider parent handler executed.");
		};
		const plugin = bindProcessPlugin({
			manifest,
			entry: defineAiProviderPlugin({
				manifest,
				describe: tripwire,
				listModels: tripwire,
				probe: tripwire,
				generateDraft: tripwire,
			}),
		}, files);
		let calls: RecordedCompatibleCall[] = [];
		let started = Promise.withResolvers<void>();
		let reading = Promise.withResolvers<void>();
		let cancelled = Promise.withResolvers<void>();
		let lifetime = { cancellations: 0 };
		return {
			plugin,
			calls: () => calls,
			parentCalls: () => parentCalls,
			started: () => started.promise,
			reading: () => reading.promise,
			cancelled: () => cancelled.promise,
			cancellations: () => lifetime.cancellations,
			cleanup,
			fixtures(script = "normal"): AiProviderFixtures {
				calls = [];
				started = Promise.withResolvers<void>();
				reading = Promise.withResolvers<void>();
				cancelled = Promise.withResolvers<void>();
				lifetime = { cancellations: 0 };
				const currentCalls = calls;
				const currentStarted = started;
				const currentReading = reading;
				const currentCancelled = cancelled;
				const currentLifetime = lifetime;
				const upstream = createFake({
					async fetch(input) {
						const body = await input.text();
						currentCalls.push({ method: input.method, url: input.url, headers: [...input.headers], body });
						const pathname = new URL(input.url).pathname;
						if (pathname === "/v1/models")
							return Response.json({ object: "list", data: [{ object: "model", id: MODEL }] });
						if (pathname === "/api/tags") return Response.json({ models: [{ name: MODEL }] });
						const wire = JSON.parse(body) as { messages: { content: string }[] };
						const output = wire.messages[1]?.content === probePrompt
							? { body: "", ownerNotes: "", needsOwnerInput: [], suspectedInstructions: false, contextRefs: [] }
							: expected.output;
						const content = JSON.stringify(output);
						const response = format === "ollama" ? {
							model: MODEL, message: { role: "assistant", content }, done: true,
							done_reason: "stop", prompt_eval_count: 100, eval_count: 50,
						} : {
							model: MODEL, choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
							usage: { prompt_tokens: 100, completion_tokens: 50 },
						};
						currentStarted.resolve();
						if (script === "normal") return Response.json(response);
						const encoded = new TextEncoder().encode(JSON.stringify(response));
						// Never reach EOF: only the real consumer's limit or close can cancel this source.
						const chunk = script === "oversize" ? new Uint8Array(262_145).fill(32) : encoded.subarray(0, 1);
						if (script === "oversize") chunk.set(encoded);
						let pulls = 0;
						const bodyStream = new ReadableStream<Uint8Array>({
							start(controller) { controller.enqueue(chunk); },
							pull(controller) {
								// The fake's transform can prefetch once before the host reads its response.
								if (script === "stall" && pulls++ === 0) {
									controller.enqueue(encoded.subarray(1, 2));
									return;
								}
								// A second pull requires the host to drain the transform's first write.
								currentReading.resolve();
							},
							cancel() {
								currentLifetime.cancellations++;
								currentCancelled.resolve();
							},
						});
						return new Response(bodyStream, { headers: { "Content-Type": "application/json" } });
					},
				}, { host: "127.0.0.1" });
				// These independent constructor inputs are never derived from child metadata.
				const config = {
					endpoint: `http://127.0.0.1/${format === "ollama" ? "api/chat" : "v1/chat/completions"}`,
					model: MODEL,
					format,
				};
				const compatibleHttp: NonNullable<AiProviderFixtures["compatibleHttp"]> = [
					{ operation: "ai_models_list", config },
					{ operation: "ai_probe", config },
					{ operation: "ai_draft_generate", config, draft: structuredClone(request) },
				];
				return {
					upstreams: [upstream],
					compatibleHttp,
					request: structuredClone(request),
					expected: structuredClone(expected),
					progress: [{ progress: 0, total: 1 }, { progress: 1, total: 1 }],
				};
			},
		};
	} catch {
		await cleanup();
		throw new Error("Compatible process fixture preparation refused.");
	}
}
