import type { DraftOutputV1 } from "@draftyak/protocol/draft-output";
import type { HostHandler, MemoryHost, PluginServerOptions, StdioHost } from "@draftyak/sdk";
import type { DraftRequest } from "../src/index.ts";

export const input: DraftRequest = {
	model: "gpt-synthetic",
	system: "Draft a plain-text reply.",
	prompt: "Synthetic thread; propose Tuesday.",
	contextIds: ["c1"],
};
export const draft: DraftOutputV1 = {
	body: "Tuesday works for me.",
	ownerNotes: "Synthetic note.",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};
export const CANARY = "PRIVATE_SYNTHETIC_CANARY";
export function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: "completed",
		model: input.model,
		usage: { input_tokens: 100, output_tokens: 50 },
		output: [
			{ type: "reasoning", summary: [] },
			{
				type: "message",
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text: JSON.stringify(draft), annotations: [] }],
			},
		],
		...overrides,
	};
}

export interface MountedReply {
	readonly result?: {
		readonly structuredContent?: unknown;
		readonly isError?: boolean;
		readonly tools?: readonly { readonly name: string }[];
	};
	readonly error?: unknown;
}
export type MountedAsk = (
	method: string,
	params?: Record<string, unknown>,
) => Promise<MountedReply>;

/** Exercises the real SDK server with an isolated in-memory host and MCP transport. */
export async function mountedProvider(
	handler: HostHandler,
	check: (
		ask: MountedAsk,
		host: MemoryHost,
		notifications: unknown[],
		cancel: (requestId: number) => void,
	) => Promise<void>,
	options: PluginServerOptions = {},
): Promise<void> {
	const { memoryHost } = await import("@draftyak/sdk");
	const { startPlugin } = await import("../src/plugin.ts");
	const host = memoryHost(handler);
	const ready = Promise.withResolvers<void>();
	const pending = new Map<number, ReturnType<typeof Promise.withResolvers<MountedReply>>>();
	const notifications: unknown[] = [];
	let id = 0;
	const transport: StdioHost["transport"] = {
		async start() {
			ready.resolve();
		},
		async send(value) {
			if ("id" in value && typeof value.id === "number" && !("method" in value)) {
				pending.get(value.id)?.resolve(value as MountedReply);
				pending.delete(value.id);
			} else notifications.push(value);
		},
		async close() {
			for (const item of pending.values()) item.reject(new Error("Test transport closed"));
			pending.clear();
			transport.onclose?.();
		},
	};
	const handle = startPlugin("api-key", { ...options, host: { ...host, transport } });
	try {
		await ready.promise;
		await check(
			async (method, params = {}) => {
				const current = ++id;
				const reply = Promise.withResolvers<MountedReply>();
				void reply.promise.catch(() => undefined);
				pending.set(current, reply);
				transport.onmessage?.({
					jsonrpc: "2.0",
					id: current,
					method,
					params: {
						...params,
						_meta: {
							"io.modelcontextprotocol/protocolVersion": "2026-07-28",
							"io.modelcontextprotocol/clientCapabilities": {},
							...(params._meta as object),
						},
					},
				});
				return reply.promise;
			},
			host,
			notifications,
			(requestId) =>
				transport.onmessage?.({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId },
				}),
		);
	} finally {
		await handle.close();
		host.close();
	}
}

export function streamBytes(host: MemoryHost, streamId: string, bytes: Uint8Array): void {
	let sequence = 0;
	for (let offset = 0; offset < bytes.length; offset += 16_384)
		host.notify({
			jsonrpc: "2.0",
			method: "host/stream.chunk",
			params: {
				streamId,
				sequence: sequence++,
				base64: Buffer.from(bytes.subarray(offset, offset + 16_384)).toString("base64url"),
				done: false,
			},
		});
	host.notify({
		jsonrpc: "2.0",
		method: "host/stream.chunk",
		params: { streamId, sequence, base64: "", done: true },
	});
}
