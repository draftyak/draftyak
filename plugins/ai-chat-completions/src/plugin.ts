import { types } from "node:util";
import {
	type AiProviderContext,
	defineAiProviderPlugin,
	HostError,
	type PluginContext,
	type PluginEntry,
	PluginError,
} from "@draftyak/sdk";
import manifest from "../draftyak.plugin.json" with { type: "json" };
import { bytes, CompatibleError, transportError } from "./boundary.ts";
import { type CompatibleTransport, createCompatibleCore } from "./core.ts";
import { MAX_RESPONSE_BYTES } from "./response.ts";

function pluginError(error: unknown): PluginError {
	const normalized = transportError(error);
	switch (normalized.code) {
		case "INVALID_CONFIG":
		case "INVALID_INPUT":
			return new PluginError("INVALID_INPUT");
		case "INVALID_RESPONSE":
		case "ABORTED":
			return new PluginError("TRANSIENT");
		default:
			return new PluginError(normalized.code, {
				...(normalized.retryAfterMs === undefined ? {} : { retryAfterMs: normalized.retryAfterMs }),
			});
	}
}

async function canonical<T>(operation: () => T | Promise<T>): Promise<T> {
	try {
		return await operation();
	} catch (error) {
		throw pluginError(error);
	}
}

async function readBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
	if (signal.aborted) {
		void response.body?.cancel().catch(() => {});
		throw new CompatibleError("ABORTED");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	let rejectAbort: (error: CompatibleError) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const abort = (): void => {
		rejectAbort(new CompatibleError("ABORTED"));
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		while (true) {
			if (signal.aborted) throw new CompatibleError("ABORTED");
			const next = await Promise.race([reader.read(), aborted]);
			if (signal.aborted) throw new CompatibleError("ABORTED");
			if (next.done) break;
			let chunk: Uint8Array;
			try {
				chunk = bytes(next.value, MAX_RESPONSE_BYTES - length);
			} catch {
				throw new CompatibleError("INVALID_RESPONSE");
			}
			length += chunk.byteLength;
			if (chunk.byteLength) chunks.push(chunk);
		}
		const body = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			body.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return body;
	} finally {
		signal.removeEventListener("abort", abort);
		// A producer's cancellation hook cannot hold the provider call open.
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function transport(context: PluginContext): CompatibleTransport {
	return async (request, signal = context.signal) => {
		try {
			if (signal.aborted) throw new CompatibleError("ABORTED");
			const response = await context.fetch(request.url, {
				method: request.method,
				headers: request.headers,
				...(request.method === "POST" ? { body: request.body } : {}),
				redirect: request.redirect,
				stream: true,
				signal,
			});
			if (response.redirected || (response.url !== "" && response.url !== request.url)) {
				void response.body?.cancel().catch(() => {});
				throw new CompatibleError("INVALID_RESPONSE");
			}
			const body = await readBody(response, signal);
			const retryAfter = response.headers.get("retry-after");
			const headers: Record<string, string> = {};
			if (retryAfter !== null) headers["retry-after"] = retryAfter;
			return {
				status: response.status,
				// SDK host responses omit URL metadata; the broker owns redirect refusal.
				url: request.url,
				contentType: response.headers.get("content-type") ?? "",
				headers,
				body,
			};
		} catch (error) {
			if (signal.aborted) throw new CompatibleError("ABORTED");
			if (
				!types.isProxy(error) &&
				types.isNativeError(error) &&
				Object.getPrototypeOf(error) === HostError.prototype &&
				Object.getOwnPropertyDescriptor(error, "code")?.value === "DENIED"
			)
				throw new CompatibleError("PERMISSION_DENIED");
			throw transportError(error);
		}
	};
}

type PendingResult<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "error"; readonly error: unknown };

async function progressStep<T>(
	pending: Promise<PendingResult<T>>,
	signal: AbortSignal,
): Promise<PendingResult<T> | "tick"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let aborted: (() => void) | undefined;
	try {
		return await Promise.race([
			pending,
			new Promise<"tick">((resolve) => {
				timer = setTimeout(() => resolve("tick"), 5_000);
			}),
			new Promise<never>((_resolve, reject) => {
				aborted = () => reject(new CompatibleError("ABORTED"));
				signal.addEventListener("abort", aborted, { once: true });
				if (signal.aborted) aborted();
			}),
		]);
	} finally {
		clearTimeout(timer);
		if (aborted) signal.removeEventListener("abort", aborted);
	}
}

async function requestProgress<T>(
	context: AiProviderContext,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const owner = new AbortController();
	const signal = AbortSignal.any([context.signal, owner.signal]);
	const completed: { current?: PendingResult<T> } = {};
	let pending: Promise<PendingResult<T>> | undefined;
	try {
		if (signal.aborted) throw new CompatibleError("ABORTED");
		await context.progress(0, 1);
		if (signal.aborted) throw new CompatibleError("ABORTED");
		pending = Promise.resolve()
			.then(() => work(signal))
			.then(
				(value) => {
					const result = { kind: "value", value } as const;
					completed.current = result;
					return result;
				},
				(error: unknown) => {
					const result = { kind: "error", error } as const;
					completed.current = result;
					return result;
				},
			);
		while (true) {
			if (signal.aborted) throw new CompatibleError("ABORTED");
			const result = completed.current;
			if (result) {
				if (result.kind === "error") throw result.error;
				await context.progress(1, 1);
				return result.value;
			}
			if ((await progressStep(pending, signal)) === "tick" && completed.current === undefined) {
				if (signal.aborted) throw new CompatibleError("ABORTED");
				// One request remains pending, so zero of its one unit is complete.
				await context.progress(0, 1);
			}
		}
	} catch (error) {
		// Preserve an already observed broker/core failure over a failing notification or cleanup.
		const primary = completed.current?.kind === "error" ? completed.current.error : error;
		owner.abort();
		await pending;
		throw primary;
	} finally {
		owner.abort();
	}
}

/** Mount the existing completed-response core through the accepted provider SDK. */
export function createPlugin(
	input: Parameters<typeof createCompatibleCore>[0],
	trustedResolution: Parameters<typeof createCompatibleCore>[1],
): PluginEntry {
	let core: ReturnType<typeof createCompatibleCore>;
	try {
		core = createCompatibleCore(input, trustedResolution);
	} catch (error) {
		throw pluginError(error);
	}
	return defineAiProviderPlugin({
		manifest,
		describe: () => core.describe(),
		listModels: (_args, context) =>
			canonical(async () =>
				core.models(await transport(context)(core.modelsRequest(), context.signal)),
			),
		probe: (request, context) =>
			canonical(() => {
				if (request.model !== undefined && request.model !== core.config.model)
					throw new CompatibleError("INVALID_INPUT");
				return core.probe(transport(context), context.signal);
			}),
		generateDraft: (request, context) =>
			canonical(() =>
				requestProgress(context, (signal) => core.generate(request, transport(context), signal)),
			),
	});
}
