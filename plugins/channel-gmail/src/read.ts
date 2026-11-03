import { types } from "node:util";
import { MessageRef } from "@draftyak/protocol/channel-v1";
import type { ProbeResult } from "@draftyak/protocol/extension";
import { HOST_REQUEST_TIMEOUT_MS } from "@draftyak/protocol/host-channel";
import { parseStrict } from "@draftyak/protocol/jcs";
import { BlobRef, MAX_INLINE_BYTES, MessageBody } from "@draftyak/protocol/normalized-change";
import { HostError, type HostResponse, type PluginContext, PluginError } from "@draftyak/sdk";
import { GMAIL_API_BASE, GMAIL_JSON_MAX_CHUNKS, gmailMessageUrl, gmailPathId } from "./boundary.ts";
import { decodeGmailMetadata } from "./decode.ts";
import { copyHistoryData, historyDecimal, historyRecord } from "./history/page.ts";

const MAX_METADATA_BYTES = 4 * 1024 * 1024;
export type GmailMessageBody = Extract<MessageBody, { readonly kind: "email.message" }> & {
	readonly raw: BlobRef;
};
const responseStatus = Object.getOwnPropertyDescriptor(Response.prototype, "status")?.get;
const responseBody = Object.getOwnPropertyDescriptor(Response.prototype, "body")?.get;
const errorCodes = new Set([
	"AUTH_EXPIRED",
	"RATE_LIMITED",
	"QUOTA_EXCEEDED",
	"NOT_FOUND",
	"PERMISSION_DENIED",
	"TRANSIENT",
	"INVALID_INPUT",
	"UNSUPPORTED",
]);

function live(signal: AbortSignal): void {
	if (signal.aborted) throw new PluginError("TRANSIENT");
}

function statusOf(response: HostResponse): number {
	if (types.isProxy(response) || !responseStatus) throw new PluginError("TRANSIENT");
	return Reflect.apply(responseStatus, response, []) as number;
}

function bodyOf(response: HostResponse): ReadableStream<Uint8Array> | null {
	if (types.isProxy(response) || !responseBody) throw new PluginError("TRANSIENT");
	return Reflect.apply(responseBody, response, []) as ReadableStream<Uint8Array> | null;
}

function cancel(response: HostResponse): void {
	try {
		void bodyOf(response)
			?.cancel()
			.catch(() => {});
	} catch {}
}

function fixedError(error: unknown, signal?: AbortSignal): PluginError {
	if (signal?.aborted) return new PluginError("TRANSIENT");
	if (error && typeof error === "object" && !types.isProxy(error)) {
		if (error instanceof PluginError) {
			const result = Object.getOwnPropertyDescriptor(error, "result")?.value;
			if (result && typeof result === "object" && !types.isProxy(result)) {
				const code = Object.getOwnPropertyDescriptor(result, "code")?.value;
				if (typeof code === "string" && errorCodes.has(code))
					return new PluginError(code as PluginError["result"]["code"]);
			}
		}
		if (error instanceof HostError) {
			const code = Object.getOwnPropertyDescriptor(error, "code")?.value;
			if (code === "TOO_LARGE") return new PluginError("QUOTA_EXCEEDED");
			if (code === "UNSUPPORTED") return new PluginError("UNSUPPORTED");
			if (code === "DENIED") return new PluginError("PERMISSION_DENIED");
		}
	}
	return new PluginError("TRANSIENT");
}

async function operation<T>(
	context: PluginContext,
	work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const deadline = new AbortController();
	let signal: AbortSignal | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let completed = false;
	try {
		signal = AbortSignal.any([context.signal, deadline.signal]);
		live(signal);
		timer = setTimeout(() => deadline.abort(), HOST_REQUEST_TIMEOUT_MS);
		timer.unref?.();
		const result = await work(signal);
		live(signal);
		completed = true;
		return result;
	} catch (error) {
		throw fixedError(error, signal);
	} finally {
		clearTimeout(timer);
		// A completed reference is never retroactively cancelled by this helper.
		if (!completed) deadline.abort();
	}
}

function fetchResponse(
	context: PluginContext,
	url: URL,
	signal: AbortSignal,
	raw = false,
): Promise<HostResponse> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const abort = (): void => {
			if (settled) return;
			settled = true;
			signal.removeEventListener("abort", abort);
			reject(new PluginError("TRANSIENT"));
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) {
			abort();
			return;
		}
		let pending: Promise<HostResponse>;
		try {
			pending = context.fetch(url, {
				method: "GET",
				redirect: "manual",
				signal,
				headers: { accept: "application/json" },
				...(raw
					? { saveAs: { kind: "base64url-json-member", member: "raw" } as const }
					: { stream: true }),
			});
		} catch (error) {
			settled = true;
			signal.removeEventListener("abort", abort);
			reject(error);
			return;
		}
		void pending.then(
			(response) => {
				if (settled) {
					cancel(response);
					return;
				}
				settled = true;
				signal.removeEventListener("abort", abort);
				try {
					live(signal);
					statusOf(response);
					resolve(response);
				} catch (error) {
					cancel(response);
					reject(error);
				}
			},
			(error) => {
				if (settled) return;
				settled = true;
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

async function jsonBody(
	response: HostResponse,
	signal: AbortSignal,
	maximum: number,
): Promise<unknown> {
	live(signal);
	const body = bodyOf(response);
	if (!body) throw new PluginError("TRANSIENT");
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0,
		reads = 0,
		complete = false;
	let rejectAbort: (error: PluginError) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const abort = (): void => {
		try {
			void reader.cancel().catch(() => {});
		} catch {}
		rejectAbort(new PluginError("TRANSIENT"));
	};
	signal.addEventListener("abort", abort, { once: true });
	try {
		for (;;) {
			live(signal);
			const next = await Promise.race([reader.read(), aborted]);
			live(signal);
			if (next.done) {
				complete = true;
				break;
			}
			if (++reads > GMAIL_JSON_MAX_CHUNKS || !types.isUint8Array(next.value))
				throw new PluginError("QUOTA_EXCEEDED");
			if (next.value.byteLength > maximum - size) throw new PluginError("QUOTA_EXCEEDED");
			size += next.value.byteLength;
			chunks.push(new Uint8Array(next.value));
		}
		const bytes = new Uint8Array(size);
		let at = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, at);
			at += chunk.byteLength;
		}
		return parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} finally {
		signal.removeEventListener("abort", abort);
		if (!complete) {
			try {
				void reader.cancel().catch(() => {});
			} catch {}
		}
		try {
			reader.releaseLock();
		} catch {}
	}
}

async function checked(response: HostResponse, signal: AbortSignal): Promise<void> {
	const status = statusOf(response);
	if (status === 200) return;
	if (status === 403) {
		try {
			const value = historyRecord(
				copyHistoryData(await jsonBody(response, signal, MAX_INLINE_BYTES)),
			);
			const error = historyRecord(value.error);
			if (
				Array.isArray(error.errors) &&
				error.errors.some((item) => {
					const reason = historyRecord(item).reason;
					return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
				})
			)
				throw new PluginError("RATE_LIMITED");
		} catch (error) {
			if (signal.aborted) throw new PluginError("TRANSIENT");
			const mapped = fixedError(error, signal);
			if (mapped.result.code === "RATE_LIMITED" || mapped.result.code === "QUOTA_EXCEEDED")
				throw mapped;
		} finally {
			cancel(response);
		}
		throw new PluginError("PERMISSION_DENIED");
	}
	cancel(response);
	if (status === 401) throw new PluginError("AUTH_EXPIRED");
	if (status === 404) throw new PluginError("NOT_FOUND");
	if (status === 429) throw new PluginError("RATE_LIMITED");
	throw new PluginError("TRANSIENT");
}

/** Probe only provider reach and credentials; never return the profile's account address. */
export function probeGmail(context: PluginContext): Promise<ProbeResult> {
	return operation(context, async (signal) => {
		const response = await fetchResponse(context, new URL(`${GMAIL_API_BASE}/profile`), signal);
		await checked(response, signal);
		const data = historyRecord(
			copyHistoryData(await jsonBody(response, signal, MAX_INLINE_BYTES)),
			["emailAddress", "messagesTotal", "threadsTotal", "historyId"],
		);
		if (
			typeof data.emailAddress !== "string" ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject ASCII controls in provider addresses.
			!/^[^@\s\x00-\x1f\x7f]+@[^@\s\x00-\x1f\x7f]+$/u.test(data.emailAddress)
		)
			throw new PluginError("TRANSIENT");
		for (const count of [data.messagesTotal, data.threadsTotal])
			if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
				throw new PluginError("TRANSIENT");
		historyDecimal(data.historyId);
		return Object.freeze({ status: "ok" as const });
	});
}

/** Fixed read-only SDK requests; the host owns extraction, storage and source admission. */
export function fetchGmailBody(
	context: PluginContext,
	message: MessageRef,
): Promise<{ readonly message: GmailMessageBody }> {
	let id: string;
	try {
		const parsed = MessageRef.safeParse(copyHistoryData(message));
		if (!parsed.success || parsed.data.kind !== "email") throw new Error();
		id = gmailPathId(parsed.data.providerId);
	} catch {
		return Promise.reject(new PluginError("INVALID_INPUT"));
	}
	return operation(context, async (signal) => {
		const response = await fetchResponse(context, gmailMessageUrl(id, "metadata"), signal);
		await checked(response, signal);
		const metadata = decodeGmailMetadata(await jsonBody(response, signal, MAX_METADATA_BYTES));
		if (metadata.providerId !== id || metadata.internalDate === undefined)
			throw new PluginError("TRANSIENT");
		const raw = await fetchResponse(context, gmailMessageUrl(id, "raw"), signal, true);
		await checked(raw, signal);
		const descriptor = Object.getOwnPropertyDescriptor(raw, "bodyRef");
		const reference =
			descriptor && Object.hasOwn(descriptor, "value")
				? BlobRef.safeParse(copyHistoryData(descriptor.value))
				: undefined;
		if (!reference?.success || bodyOf(raw) !== null) {
			cancel(raw);
			throw new PluginError("TRANSIENT");
		}
		live(signal);
		const result = MessageBody.safeParse({
			kind: "email.message",
			providerId: id,
			threadId: metadata.threadId,
			internalDate: metadata.internalDate,
			labelIds: metadata.labelIds,
			...(metadata.sizeBytes === undefined ? {} : { sizeBytes: metadata.sizeBytes }),
			raw: reference.data,
		});
		if (!result.success || result.data.kind !== "email.message") throw new PluginError("TRANSIENT");
		Object.freeze(result.data.labelIds);
		return Object.freeze({
			message: Object.freeze({ ...result.data, raw: Object.freeze(reference.data) }),
		});
	});
}
