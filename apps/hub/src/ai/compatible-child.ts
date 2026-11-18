import { Buffer } from "node:buffer";
import {
	CompatibleError,
	type CompatibleRequest,
	type CompatibleResponse,
	createCompatibleCore,
	MAX_RESPONSE_BYTES,
} from "@draftyak/ai-chat-completions";
import { PluginErrorCode } from "@draftyak/protocol/errors";
import { defineAiProviderPlugin } from "@draftyak/sdk/ai-provider";
import type { PluginInstance } from "@draftyak/sdk/context";
import { PluginError } from "@draftyak/sdk/errors";
import type { HostFetch } from "@draftyak/sdk/fetch";
import { type PluginEntry, serveBootstrapped } from "@draftyak/sdk/serve";

async function transport(
	fetch: HostFetch,
	request: CompatibleRequest,
	signal: AbortSignal,
): Promise<CompatibleResponse> {
	const response = await fetch(request.url, {
		method: request.method,
		headers: request.headers,
		body: request.body,
		redirect: "error",
		stream: true,
		signal,
	});
	const reader = response.body?.getReader();
	if (!reader) throw new PluginError("TRANSIENT");
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			signal.throwIfAborted();
			const next = await reader.read();
			signal.throwIfAborted();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > MAX_RESPONSE_BYTES) throw new PluginError("TRANSIENT");
			chunks.push(new Uint8Array(next.value));
		}
		return {
			status: response.status,
			url: request.url,
			contentType: response.headers.get("content-type") ?? "",
			headers: Object.fromEntries(response.headers),
			body: Buffer.concat(chunks, size),
		};
	} finally {
		// Retain the original cancellation join; releasing a lock is not a drain receipt.
		try {
			await reader.cancel();
		} finally {
			reader.releaseLock();
		}
	}
}

/** A fixed payload for a native-owned admitted child. Bootstrap configuration is DATA, not egress permission. */
export function createCompatibleDraftEntry(instance: PluginInstance): PluginEntry {
	const config = instance.config;
	const core = createCompatibleCore(config.provider, config.resolution);
	return defineAiProviderPlugin({
		manifest: config.manifest,
		describe: () => core.describe(),
		listModels: () => ({ models: [{ id: core.config.model, fallbacks: false }] }),
		probe: async () => {
			throw new PluginError("UNSUPPORTED");
		},
		generateDraft: async (request, context) => {
			try {
				context.signal.throwIfAborted();
				await context.progress(0, 1);
				const result = await core.generate(
					request,
					(candidate) => transport(context.fetch, candidate, context.signal),
					context.signal,
				);
				context.signal.throwIfAborted();
				await context.progress(1, 1);
				return result;
			} catch (error) {
				if (error instanceof CompatibleError) {
					const code = PluginErrorCode.safeParse(error.code);
					throw new PluginError(
						code.success ? code.data : "TRANSIENT",
						error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs },
					);
				}
				throw new PluginError("TRANSIENT");
			}
		},
	});
}

/** The bundle's native-owned entry calls this; importing the module never starts a process. */
export function serveCompatibleDraftChild(): ReturnType<typeof serveBootstrapped> {
	return serveBootstrapped(createCompatibleDraftEntry);
}
