import { Buffer } from "node:buffer";
import { ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AI_PROVIDER_V1, DraftOutcome, type DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import { HOST_MAX_FRAME_BYTES, HostFetchParams } from "@draftyak/protocol/host-channel";
import { expect, it } from "vitest";
import { watchPluginCall } from "../../src/plugins/supervisor/call-watchdog.ts";
import { createPluginOutputPump } from "../../src/plugins/supervisor/output-pump.ts";
import {
	encodePluginBootstrapFrame,
	encodePluginHostFrame,
	type PluginWireFrame,
} from "../../src/plugins/supervisor/tagged-wire.ts";

const killOriginal = ChildProcess.prototype.kill;
const MODEL = "developer-component-model";
const ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";

// This starts the normal built payload as a developer process. Synthetic host frames
// prove neither production Native launch membership nor peer/consent/broker authority.
it("serves coalesced bootstrap and modern tools/call without initialize in a real child", async () => {
	const entry = fileURLToPath(new URL("../../dist/ai/compatible-child-entry.mjs", import.meta.url));
	const preload = fileURLToPath(new URL("../helpers/loopback-preload.cjs", import.meta.url));
	expect(statSync(entry).isFile()).toBe(true);
	const child = spawn(
		process.execPath,
		["--disallow-code-generation-from-strings", "--require", preload, entry],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	const stdout = child.stdout,
		stderr = child.stderr,
		stdin = child.stdin;
	const inputClosed = new Promise<void>((resolve) => stdin.once("close", resolve));
	let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let close: { code: number | null; signal: NodeJS.Signals | null } | undefined;
	let closing = false,
		stopped: Promise<void> | undefined,
		failed = false,
		answered = false;
	let frameCount = 0;
	const result = Promise.withResolvers<unknown>();
	void result.promise.catch(() => {});
	const hostWork: Promise<void>[] = [];
	const writes: Promise<void>[] = [];
	let writeTail = Promise.resolve();
	const requests: HostFetchParams[] = [];
	const progress: number[] = [];
	const fail = (): void => {
		failed = true;
		if (!answered) {
			answered = true;
			result.reject(new Error("Developer child protocol failed"));
		}
	};
	const closed = new Promise<void>((resolve) =>
		child.once("close", (code, signal) => {
			close = { code, signal };
			if (!answered || !closing) fail();
			resolve();
		}),
	);
	child.once("exit", (code, signal) => {
		exit = { code, signal };
		if (!answered || !closing) fail();
	});
	child.on("error", fail);
	stdin.on("error", () => {
		if (!closing) fail();
	});
	const stopOriginal = (): Promise<void> => {
		if (stopped) return stopped;
		closing = true;
		stopped = Promise.resolve().then(async () => {
			let stopFailed = false;
			if (!close) {
				try {
					stdin.end();
				} catch {
					stopFailed = true;
				}
				try {
					killOriginal.call(child);
				} catch {
					stopFailed = true;
				}
			}
			await closed;
			if (stopFailed) throw new Error("Developer child stop failed");
		});
		return stopped;
	};
	const send = (bytes: Uint8Array): Promise<void> => {
		if (bytes.byteLength > HOST_MAX_FRAME_BYTES)
			return Promise.reject(new Error("Developer frame exceeds cap"));
		const original = writeTail.then(
			() =>
				new Promise<void>((resolve, reject) => {
					if (closing || failed) {
						reject(new Error("Developer child is unavailable"));
						return;
					}
					stdin.write(bytes, (error) =>
						error ? reject(new Error("Developer write failed")) : resolve(),
					);
				}),
		);
		writeTail = original;
		writes.push(original);
		void original.catch(fail);
		return original;
	};
	const hostFrame = (value: unknown): Promise<void> =>
		send(encodePluginHostFrame(Buffer.from(JSON.stringify(value))));
	const answerHost = async (frame: Extract<PluginWireFrame, { kind: "host" }>): Promise<void> => {
		const request = frame.message;
		if (request.method === "host/cancel") return;
		if (request.method !== "host/fetch" || requests.length !== 0)
			throw new Error("Unexpected developer host request");
		const params = HostFetchParams.parse(request.params);
		if (
			params.method !== "POST" ||
			params.url !== ENDPOINT ||
			params.stream !== true ||
			params.saveAs !== undefined ||
			params.sendTicket !== undefined ||
			params.lookupPermit !== undefined ||
			!params.body ||
			!("base64" in params.body)
		)
			throw new Error("Developer request binding differs");
		requests.push(params);
		const output = {
			body: "A reviewable synthetic reply.",
			ownerNotes: "",
			needsOwnerInput: [],
			suspectedInstructions: false,
			contextRefs: [],
		};
		const response = Buffer.from(
			JSON.stringify({
				model: MODEL,
				choices: [
					{
						finish_reason: "stop",
						message: { role: "assistant", content: JSON.stringify(output) },
					},
				],
				usage: { prompt_tokens: 2, completion_tokens: 3 },
			}),
		);
		const middle = Math.floor(response.byteLength / 2);
		const chunks = [response.subarray(0, middle), response.subarray(middle)];
		const streamId = "developer-component-stream";
		// Complete the original header write before starting the real SDK stream notifications.
		await hostFrame({
			jsonrpc: "2.0",
			id: request.id,
			result: {
				status: 200,
				headers: [["content-type", "application/json"]],
				streamId,
			},
		});
		for (const [sequence, chunk] of chunks.entries())
			await hostFrame({
				jsonrpc: "2.0",
				method: "host/stream.chunk",
				params: {
					streamId,
					sequence,
					base64: chunk.toString("base64url"),
					done: sequence === chunks.length - 1,
				},
			});
	};
	const onFrame = (frame: PluginWireFrame): void => {
		if (closing || failed) return;
		if (++frameCount > 32) {
			fail();
			return;
		}
		if (frame.kind === "host") {
			// Own the original job before any host-response write or SDK callback runs.
			const original = Promise.resolve().then(() => answerHost(frame));
			hostWork.push(original);
			void original.catch(fail);
			return;
		}
		const value = frame.value as Record<string, unknown> | null;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			fail();
			return;
		}
		if (value.method === "notifications/progress") {
			const params = value.params as {
				progressToken?: unknown;
				progress?: unknown;
				total?: unknown;
			} | null;
			if (
				params?.progressToken !== 1 ||
				params.total !== 1 ||
				(params.progress !== 0 && params.progress !== 1)
			) {
				fail();
				return;
			}
			progress.push(params.progress);
			return;
		}
		if (value.jsonrpc !== "2.0" || value.id !== 1 || value.error !== undefined) {
			fail();
			return;
		}
		answered = true;
		result.resolve(value.result);
	};
	const pump = createPluginOutputPump([stdout, stderr], onFrame);
	void pump.failure.then((error) => {
		if (error) fail();
	});
	const controller = new AbortController();
	const watch = watchPluginCall(controller, result.promise, "call", stopOriginal);
	const cancel = (): void => {
		if (!closing)
			void send(
				Buffer.from(
					`${JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/cancelled",
						params: { requestId: 1, reason: "Cancelled" },
					})}\n`,
				),
			).catch(fail);
	};
	controller.signal.addEventListener("abort", cancel, { once: true });
	try {
		const draft: DraftRequest = {
			model: MODEL,
			system: "Fixed synthetic system instructions.",
			prompt: "A fixed synthetic question.",
			contextIds: [],
		};
		const bootstrap = encodePluginBootstrapFrame(
			Buffer.from(
				JSON.stringify({
					jsonrpc: "2.0",
					method: "host/bootstrap",
					params: {
						instance: {
							id: "0".repeat(26),
							config: {
								provider: {
									endpoint: ENDPOINT,
									model: MODEL,
									format: "json_object",
									allowPlaintextLan: false,
								},
								resolution: { hostname: "127.0.0.1", destination: "local" },
								manifest: {
									id: "drafting-developer-component",
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
								},
							},
						},
					},
				}),
			),
		);
		const call = Buffer.from(
			`${JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "ai_draft_generate",
					arguments: draft,
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientCapabilities": {},
						progressToken: 1,
					},
				},
			})}\n`,
		);
		// No initialize/discover request or synthetic readiness marker precedes this sequence.
		await send(Buffer.concat([bootstrap, call]));
		const reply = (await watch.terminal) as { isError?: unknown; structuredContent?: unknown };
		expect(reply.isError).not.toBe(true);
		expect(DraftOutcome.parse(reply.structuredContent)).toMatchObject({
			kind: "draft",
			model: MODEL,
			fallback: false,
			output: { body: "A reviewable synthetic reply." },
		});
		await Promise.all(hostWork);
		expect(requests).toHaveLength(1);
		const body = requests[0]?.body;
		if (!body || !("base64" in body)) throw new Error("Developer request body missing");
		expect(JSON.parse(Buffer.from(body.base64, "base64url").toString("utf8"))).toMatchObject({
			model: MODEL,
			messages: [
				{ role: "system", content: draft.system },
				{ role: "user", content: draft.prompt },
			],
		});
		expect(progress).toEqual([0, 1]);
	} finally {
		controller.signal.removeEventListener("abort", cancel);
		// Actual original child close precedes any final drain/host/write-join qualification.
		const stop = await Promise.allSettled([stopOriginal()]);
		const joins = await Promise.allSettled([
			inputClosed,
			pump.drained,
			...hostWork,
			...writes,
			watch.close(),
		]);
		expect(stop[0]?.status).toBe("fulfilled");
		expect(joins.every((join) => join.status === "fulfilled")).toBe(true);
		expect(failed).toBe(false);
		expect(exit).toBeDefined();
		expect(close).toEqual(exit);
		expect(stdout.closed && stdout.readableEnded).toBe(true);
		expect(stderr.closed && stderr.readableEnded).toBe(true);
		expect(stdin.closed).toBe(true);
		expect(child.stdin).toBe(stdin);
		expect(child.stdout).toBe(stdout);
		expect(child.stderr).toBe(stderr);
	}
});
