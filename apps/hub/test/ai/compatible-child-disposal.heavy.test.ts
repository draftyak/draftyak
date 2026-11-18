import { Buffer } from "node:buffer";
import { ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { AI_PROVIDER_V1 } from "@draftyak/protocol/ai-provider-v1";
import { HOST_MAX_FRAME_BYTES, HostFetchParams } from "@draftyak/protocol/host-channel";
import { expect, it } from "vitest";
import { createPluginOutputPump } from "../../src/plugins/supervisor/output-pump.ts";
import {
	encodePluginBootstrapFrame,
	encodePluginHostFrame,
	type PluginWireFrame,
} from "../../src/plugins/supervisor/tagged-wire.ts";

const killOriginal = ChildProcess.prototype.kill;
const MODEL = "developer-disposal-model";
const ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
const DEADLINE_MS = 10_000;
const metadata = {
	"io.modelcontextprotocol/protocolVersion": "2026-07-28",
	"io.modelcontextprotocol/clientCapabilities": {},
};
type Terminal = { code: number | null; signal: NodeJS.Signals | null };
type FetchRequest = { id: string; params: HostFetchParams };

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error(`Developer child ${label} deadline`)),
					DEADLINE_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

// Real built SDK stdio, with synthetic parent HTTP DATA. No Native launch membership,
// peer, consent, broker permission or internal reader-liveness claim is supplied here.
function developerChild() {
	const entry = fileURLToPath(new URL("../../dist/ai/compatible-child-entry.mjs", import.meta.url));
	const preload = fileURLToPath(new URL("../helpers/loopback-preload.cjs", import.meta.url));
	expect(statSync(entry).isFile()).toBe(true);
	const child = spawn(
		process.execPath,
		["--disallow-code-generation-from-strings", "--require", preload, entry],
		{ stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
	);
	const stdin = child.stdin;
	const stdout = child.stdout;
	const stderr = child.stderr;
	const inputClosed = new Promise<void>((resolve) => stdin.once("close", resolve));
	const failure = Promise.withResolvers<never>();
	void failure.promise.catch(() => {});
	const entered = Promise.withResolvers<FetchRequest>();
	const cancelled = Promise.withResolvers<string>();
	const replies = new Map<number, Record<string, unknown>>();
	const replyWaiters = new Map<number, (value: Record<string, unknown>) => void>();
	const fetches: FetchRequest[] = [];
	const cancellations: string[] = [];
	const progress: number[] = [];
	const writes: Promise<void>[] = [];
	let writeTail = Promise.resolve();
	let endingInput = false;
	let disposing = false;
	let protocolFailed = false;
	let frames = 0;
	let exit: Terminal | undefined;
	let close: Terminal | undefined;
	const fail = (): void => {
		protocolFailed = true;
		failure.reject(new Error("Developer child protocol failed"));
	};
	const closed = new Promise<void>((resolve) => {
		child.once("close", (code, signal) => {
			close = { code, signal };
			if (!endingInput && !disposing) fail();
			resolve();
		});
	});
	child.once("exit", (code, signal) => {
		exit = { code, signal };
		if (!endingInput && !disposing) fail();
	});
	child.on("error", fail);
	stdin.on("error", () => {
		if (!disposing) fail();
	});
	function onFrame(frame: PluginWireFrame): void {
		if (++frames > 64) {
			fail();
			return;
		}
		if (frame.kind === "host") {
			const request = frame.message;
			if (request.method === "host/cancel") {
				cancellations.push(request.params.requestId);
				cancelled.resolve(request.params.requestId);
				return;
			}
			if (request.method !== "host/fetch" || fetches.length !== 0) {
				fail();
				return;
			}
			const parsed = HostFetchParams.safeParse(request.params);
			if (!parsed.success) {
				fail();
				return;
			}
			const params = parsed.data;
			if (
				params.url !== ENDPOINT ||
				params.method !== "POST" ||
				params.stream !== true ||
				params.saveAs !== undefined ||
				params.sendTicket !== undefined ||
				params.lookupPermit !== undefined ||
				!params.body ||
				!("base64" in params.body)
			) {
				fail();
				return;
			}
			const captured = { id: request.id, params };
			fetches.push(captured);
			entered.resolve(captured);
			return;
		}
		const value = frame.value as Record<string, unknown> | null;
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			fail();
			return;
		}
		if (value.method === "notifications/progress") {
			const params = value.params as Record<string, unknown> | null;
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
		if (value.jsonrpc !== "2.0" || (value.id !== 1 && value.id !== 2)) {
			fail();
			return;
		}
		if (replies.has(value.id)) {
			fail();
			return;
		}
		replies.set(value.id, value);
		replyWaiters.get(value.id)?.(value);
	}
	const pump = createPluginOutputPump([stdout, stderr], onFrame);
	void pump.failure.then((error) => {
		if (error) fail();
	});
	const wait = <T>(promise: Promise<T>, label: string): Promise<T> =>
		bounded(Promise.race([promise, failure.promise]), label);
	const send = (bytes: Uint8Array): Promise<void> => {
		if (bytes.byteLength > HOST_MAX_FRAME_BYTES)
			return Promise.reject(new Error("Developer frame exceeds cap"));
		const original = writeTail.then(
			() =>
				new Promise<void>((resolve, reject) => {
					if (endingInput || disposing) return reject(new Error("Developer stdin ended"));
					stdin.write(bytes, (error) =>
						error ? reject(new Error("Developer write failed")) : resolve(),
					);
				}),
		);
		writes.push(original);
		writeTail = original;
		void original.catch(fail);
		return original;
	};
	const rpc = (value: unknown): Promise<void> => send(Buffer.from(`${JSON.stringify(value)}\n`));
	const host = (value: unknown): Promise<void> =>
		send(encodePluginHostFrame(Buffer.from(JSON.stringify(value))));
	const reply = (id: number): Promise<Record<string, unknown>> => {
		const prior = replies.get(id);
		return wait(
			prior ? Promise.resolve(prior) : new Promise((resolve) => replyWaiters.set(id, resolve)),
			"reply",
		);
	};
	return {
		fetches,
		cancellations,
		progress,
		host,
		rpc,
		reply,
		async start(): Promise<FetchRequest> {
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
										id: "drafting-developer-disposal",
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
						arguments: {
							model: MODEL,
							system: "Fixed DYTEST system instructions.",
							prompt: "An unfinished DYTEST provider request.",
							contextIds: [],
						},
						_meta: { ...metadata, progressToken: 1 },
					},
				})}\n`,
			);
			await wait(send(Buffer.concat([bootstrap, call])), "initial write");
			return wait(entered.promise, "host entry");
		},
		async waitForCancel(): Promise<string> {
			return wait(cancelled.promise, "host cancellation");
		},
		async endInput(): Promise<void> {
			await wait(Promise.all(writes), "writes before EOF");
			endingInput = true;
			const original = Promise.resolve().then(
				() =>
					new Promise<void>((resolve, reject) =>
						stdin.end((error?: Error | null) =>
							error ? reject(new Error("Developer stdin end failed")) : resolve(),
						),
					),
			);
			writes.push(original);
			await wait(original, "stdin end");
			// This receipt must be observed BEFORE dispose() is allowed to use its fallback kill.
			await wait(closed, "natural child close");
			expect(close).toEqual({ code: 0, signal: null });
			expect(exit).toEqual(close);
		},
		assertNoDraftOrCompletion(): void {
			const result = replies.get(1)?.result as Record<string, unknown> | undefined;
			const content = result?.structuredContent as Record<string, unknown> | undefined;
			expect(result?.isError === true || content?.kind !== "draft").toBe(true);
			expect(progress).toEqual([0]);
			expect(fetches).toHaveLength(1);
		},
		async dispose() {
			disposing = true;
			const beforeFallback = close;
			let forcedKill = false;
			const errors: string[] = [];
			if (!close) {
				forcedKill = true;
				try {
					stdin.destroy();
				} catch {
					errors.push("STDIN_DESTROY");
				}
				try {
					killOriginal.call(child);
				} catch {
					errors.push("CHILD_KILL");
				}
			}
			try {
				await bounded(closed, "cleanup close");
			} catch {
				errors.push("CLOSE_UNCONFIRMED");
			}
			const joins = await Promise.allSettled([
				bounded(inputClosed, "input close"),
				bounded(pump.drained, "output drain"),
				bounded(Promise.allSettled(writes), "write settlement"),
			]);
			if (joins.some((value) => value.status !== "fulfilled")) errors.push("JOIN_UNCONFIRMED");
			const writeJoin = joins[2];
			const writesFulfilled =
				writeJoin?.status === "fulfilled" &&
				Array.isArray(writeJoin.value) &&
				writeJoin.value.every((value) => value.status === "fulfilled");
			return {
				beforeFallback,
				exit,
				close,
				forcedKill,
				errors,
				protocolFailed,
				writesFulfilled,
				stdoutClosed: stdout.closed && stdout.readableEnded,
				stderrClosed: stderr.closed && stderr.readableEnded,
				stdinClosed: stdin.closed,
				sameOriginalPipes:
					child.stdin === stdin && child.stdout === stdout && child.stderr === stderr,
			};
		},
	};
}

async function withChild(
	run: (child: ReturnType<typeof developerChild>) => Promise<void>,
): Promise<void> {
	const child = developerChild();
	let failed = false;
	let originalError: unknown;
	try {
		await run(child);
	} catch (error) {
		failed = true;
		originalError = error;
	}
	const cleanup = await child.dispose();
	// Cleanup cannot replace the original failure or turn a fallback kill into natural closure.
	expect.soft(cleanup.errors).toEqual([]);
	expect.soft(cleanup.forcedKill).toBe(false);
	expect.soft(cleanup.beforeFallback).toEqual({ code: 0, signal: null });
	expect.soft(cleanup.exit).toEqual(cleanup.close);
	expect.soft(cleanup.stdoutClosed && cleanup.stderrClosed && cleanup.stdinClosed).toBe(true);
	expect.soft(cleanup.sameOriginalPipes).toBe(true);
	expect.soft(cleanup.writesFulfilled).toBe(true);
	expect.soft(cleanup.protocolFailed).toBe(false);
	if (failed) throw originalError;
	child.assertNoDraftOrCompletion();
}

it("cancels a real child pending host response and discards its late reply before an ordered tools barrier", async () => {
	await withChild(async (child) => {
		const original = await child.start();
		expect(child.progress).toEqual([0]);
		await child.rpc({
			jsonrpc: "2.0",
			method: "notifications/cancelled",
			params: { requestId: 1 },
		});
		expect(await child.waitForCancel()).toBe(original.id);
		const lateBody = Buffer.from(
			JSON.stringify({
				model: MODEL,
				choices: [
					{
						finish_reason: "stop",
						message: {
							role: "assistant",
							content: JSON.stringify({
								body: "A valid late DYTEST reply.",
								ownerNotes: "",
								needsOwnerInput: [],
								suspectedInstructions: false,
								contextRefs: [],
							}),
						},
					},
				],
				usage: { prompt_tokens: 2, completion_tokens: 3 },
			}),
		);
		await child.host({
			jsonrpc: "2.0",
			id: original.id,
			result: {
				status: 200,
				headers: [["content-type", "application/json"]],
				body: { base64: lateBody.toString("base64url") },
			},
		});
		await child.rpc({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: metadata } });
		const barrier = await child.reply(2);
		expect(barrier.error).toBeUndefined();
		expect(barrier.result).toMatchObject({
			tools: expect.arrayContaining([expect.objectContaining({ name: "ai_draft_generate" })]),
		});
		expect(child.cancellations).toEqual([original.id]);
		child.assertNoDraftOrCompletion();
		await child.endInput();
		expect(child.cancellations).toEqual([original.id]);
	});
});

it("closes original child stdin during an unfinished host stream and naturally joins the same process and pipes", async () => {
	await withChild(async (child) => {
		const original = await child.start();
		const streamId = "developer-disposal-stream";
		await child.host({
			jsonrpc: "2.0",
			id: original.id,
			result: { status: 200, headers: [["content-type", "application/json"]], streamId },
		});
		await child.host({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: {
				streamId,
				sequence: 0,
				base64: Buffer.from('{"model":').toString("base64url"),
				done: false,
			},
		});
		// The writes were acknowledged; this does not invent an acknowledgement of private reader state.
		child.assertNoDraftOrCompletion();
		await child.endInput();
	});
});
