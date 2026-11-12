import { types } from "node:util";
import { HOST_MAX_ACTIVE_REQUESTS } from "@draftyak/protocol/host-channel";
import type { PluginManifestV1 } from "@draftyak/protocol/manifest";
import {
	defineAiProviderPlugin,
	HostError,
	type PluginContext,
	type PluginEntry,
	PluginError,
	type PluginInstance,
} from "@draftyak/sdk";
import { bytes, CompatibleError, data, keys, transportError } from "./boundary.ts";
import { createCompatibleCore } from "./core.ts";
import type { CompatibleRequest } from "./request.ts";
import { type CompatibleResponse, MAX_RESPONSE_BYTES } from "./response.ts";

export const COMPATIBLE_CALL_TIMEOUT_MS: number = 30_000;
export const COMPATIBLE_PROGRESS_INTERVAL_MS: number = 5_000;
export const COMPATIBLE_MAX_ACTIVE_CALLS: number = HOST_MAX_ACTIVE_REQUESTS;

export const manifest: PluginManifestV1 = {
	id: "@draftyak/ai-chat-completions",
	version: "0.0.0",
	sdk: "1.0.0",
	runtime: "node",
	kind: "ai-provider",
	contract: { extension: "io.github.draftyak/ai-provider", version: 1 },
	isolation: "standard",
	auth: { kind: "none", scopes: [], requiredGrantedScopes: [] },
	credentials: { mode: "brokered", urlSecrets: [] },
	permissions: {},
	dataClasses: ["gmail.content", "slack.content"],
	egress: { profile: "chat-completions-v1" },
	license: "Apache-2.0",
};
function freeze(value: unknown): void {
	if (!value || typeof value !== "object") return;
	for (const item of Object.values(value)) freeze(item);
	Object.freeze(value);
}
freeze(manifest);

/** Bootstrap classification data; every fetch remains subject to independent host policy. */
export interface CompatiblePluginConfig {
	readonly endpoint: string;
	readonly model: string;
	readonly format: "json_schema" | "json_object" | "ollama";
	readonly allowPlaintextLan?: boolean;
	readonly resolution: {
		readonly hostname: string;
		readonly destination: "local" | "local-network" | "cloud";
	};
}
interface Invocation {
	readonly signal: AbortSignal;
	readonly ended: Promise<never>;
	check(): void;
}
type RequestContext = Pick<PluginContext, "fetch" | "signal">;

function compatibleFailure(error: unknown, signal?: AbortSignal): CompatibleError {
	if (signal?.aborted) return new CompatibleError("ABORTED");
	if (
		error &&
		typeof error === "object" &&
		!types.isProxy(error) &&
		types.isNativeError(error) &&
		Object.getPrototypeOf(error) === HostError.prototype
	) {
		const code = Object.getOwnPropertyDescriptor(error, "code");
		if (code && "value" in code && code.value === "DENIED")
			return new CompatibleError("PERMISSION_DENIED");
	}
	return transportError(error);
}
function pluginFailure(error: unknown): PluginError {
	const safe = transportError(error);
	switch (safe.code) {
		case "AUTH_REVOKED":
		case "PERMISSION_DENIED":
		case "RATE_LIMITED":
		case "QUOTA_EXCEEDED":
		case "TRANSIENT":
			return new PluginError(safe.code, {
				...(safe.retryAfterMs === undefined ? {} : { retryAfterMs: safe.retryAfterMs }),
			});
		case "INVALID_CONFIG":
		case "INVALID_INPUT":
			return new PluginError("INVALID_INPUT");
		default:
			return new PluginError("TRANSIENT");
	}
}

async function fetchResponse(
	request: CompatibleRequest,
	context: RequestContext,
	invocation: Invocation,
): Promise<CompatibleResponse> {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		invocation.check();
		const response = await context.fetch(request.url, {
			method: request.method,
			headers: request.headers,
			redirect: request.redirect,
			...(request.method === "POST" ? { body: request.body } : {}),
			stream: true,
			signal: invocation.signal,
		});
		reader = response.body?.getReader();
		invocation.check();
		// The SDK's host response has no URL; a supplied different URL is never accepted.
		if (response.redirected || (response.url !== "" && response.url !== request.url))
			throw new CompatibleError("INVALID_RESPONSE");
		const length = response.headers.get("content-length");
		if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_RESPONSE_BYTES)
			throw new CompatibleError("INVALID_RESPONSE");
		const body = new Uint8Array(MAX_RESPONSE_BYTES);
		let total = 0;
		if (reader) {
			for (;;) {
				invocation.check();
				const next = await Promise.race([reader.read(), invocation.ended]);
				invocation.check();
				if (next.done) break;
				let chunk: Uint8Array;
				try {
					chunk = bytes(next.value, MAX_RESPONSE_BYTES - total);
				} catch {
					throw new CompatibleError("INVALID_RESPONSE");
				}
				body.set(chunk, total);
				total += chunk.byteLength;
			}
		}
		invocation.check();
		return {
			status: response.status,
			url: request.url,
			contentType: response.headers.get("content-type") ?? "",
			headers: Object.fromEntries(response.headers),
			body: body.slice(0, total),
		};
	} catch (error) {
		throw compatibleFailure(error, invocation.signal);
	} finally {
		if (reader) {
			try {
				await reader.cancel();
			} finally {
				reader.releaseLock();
			}
		}
	}
}

/** Construct one instance from parent bootstrap data, without starting a server or a request. */
export function createPlugin(instance: PluginInstance): PluginEntry {
	let core: ReturnType<typeof createCompatibleCore>;
	try {
		const supplied = data(instance);
		keys(supplied, ["id", "config"]);
		if (typeof supplied.id !== "string" || !/^[!-~]{1,256}$/.test(supplied.id))
			throw new CompatibleError("INVALID_CONFIG");
		const config = data(supplied.config);
		keys(config, ["endpoint", "model", "format", "allowPlaintextLan", "resolution"]);
		const { resolution, ...input } = config;
		core = createCompatibleCore(input, resolution);
	} catch {
		throw new PluginError("INVALID_INPUT");
	}
	let active = 0;
	async function invoke<T>(
		context: RequestContext,
		work: (invocation: Invocation) => Promise<T>,
		report?: (value: number, total: number) => Promise<void>,
	): Promise<T> {
		if (active >= COMPATIBLE_MAX_ACTIVE_CALLS) throw new PluginError("TRANSIENT");
		active++;
		const controller = new AbortController();
		const signal = AbortSignal.any([context.signal, controller.signal]);
		const started = performance.now();
		const check = (): void => {
			const elapsed = performance.now() - started;
			if (
				signal.aborted ||
				!Number.isFinite(elapsed) ||
				elapsed < 0 ||
				elapsed >= COMPATIBLE_CALL_TIMEOUT_MS
			) {
				controller.abort();
				throw new CompatibleError("ABORTED");
			}
		};
		let rejectEnd: (error: CompatibleError) => void = () => {};
		const ended = new Promise<never>((_resolve, reject) => {
			rejectEnd = reject;
		});
		const abort = (): void => rejectEnd(new CompatibleError("ABORTED"));
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		const deadline = setTimeout(() => controller.abort(), COMPATIBLE_CALL_TIMEOUT_MS);
		let pendingProgress: Promise<void> | undefined;
		const progress = (value: number): Promise<void> => {
			if (!report) return Promise.resolve();
			const pending = Promise.resolve(pendingProgress).then(async () => {
				check();
				await report(value, 1);
				check();
			});
			pendingProgress = pending;
			const settled = (): void => {
				if (pendingProgress === pending) pendingProgress = undefined;
			};
			void pending.then(settled, settled);
			return pending;
		};
		const heartbeat = report
			? setInterval(() => {
					if (!pendingProgress) void progress(0).catch(() => controller.abort());
				}, COMPATIBLE_PROGRESS_INTERVAL_MS)
			: undefined;
		const invocation: Invocation = { signal, ended, check };
		const running = (async () => {
			try {
				check();
				await progress(0);
				const result = await work(invocation);
				check();
				await progress(1);
				check();
				return result;
			} finally {
				clearInterval(heartbeat);
				await pendingProgress?.catch(() => {});
				// A retired caller cannot free capacity while its fetch, reader or progress is pending.
				active--;
			}
		})();
		try {
			return await Promise.race([running, ended]);
		} catch (error) {
			throw pluginFailure(compatibleFailure(error, signal));
		} finally {
			clearTimeout(deadline);
			clearInterval(heartbeat);
			signal.removeEventListener("abort", abort);
			controller.abort();
		}
	}
	return defineAiProviderPlugin({
		manifest,
		describe: () => core.describe(),
		listModels: (_input, context) =>
			invoke(context, async (call) =>
				core.models(await fetchResponse(core.modelsRequest(), context, call)),
			),
		probe: (input, context) =>
			invoke(context, async (call) => {
				if (input.model !== undefined && input.model !== core.config.model)
					throw new CompatibleError("INVALID_INPUT");
				return core.probe((request) => fetchResponse(request, context, call), call.signal);
			}),
		generateDraft: (input, context) =>
			invoke(
				context,
				(call) =>
					core.generate(input, (request) => fetchResponse(request, context, call), call.signal),
				(value, total) => context.progress(value, total),
			),
	});
}
