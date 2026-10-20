import { types } from "node:util";
import { Worker } from "node:worker_threads";
import type { HygieneOptions, HygieneResult } from "./hygiene.ts";
import { boundedText, ContentError, contentErrorCode, MAX_MAIL_BYTES } from "./limits.ts";
import {
	checkedMailEvidence,
	checkedParsedMail,
	type MailEvidence,
	type ParsedMail,
} from "./mail.ts";

export type ContentJob =
	| { readonly kind: "mail"; readonly raw: Uint8Array; readonly evidence: MailEvidence }
	| { readonly kind: "text" | "html"; readonly source: string; readonly options?: HygieneOptions };

export interface WorkerOptions {
	readonly timeoutMs?: number;
	readonly signal?: AbortSignal;
}

export const MAX_CONTENT_WORKERS = 2;
export const CONTENT_STARTUP_TIMEOUT_MS = 10_000;
let active = 0;

const MailBytes = Uint8Array;
const typedArray = Object.getPrototypeOf(MailBytes.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const setBytes = MailBytes.prototype.set;

function copiedMailBytes(raw: unknown): Uint8Array {
	try {
		if (
			types.isProxy(raw) ||
			!types.isUint8Array(raw) ||
			![MailBytes.prototype, Buffer.prototype].includes(Object.getPrototypeOf(raw))
		)
			throw new ContentError("INVALID_INPUT");
		const length: unknown = byteLength?.call(raw),
			offset: unknown = byteOffset?.call(raw),
			buffer: unknown = backingBuffer?.call(raw);
		if (
			typeof length !== "number" ||
			!Number.isSafeInteger(length) ||
			typeof offset !== "number" ||
			!Number.isSafeInteger(offset) ||
			!types.isArrayBuffer(buffer)
		)
			throw new ContentError("INVALID_INPUT");
		if (length > MAX_MAIL_BYTES) throw new ContentError("INPUT_LIMIT");
		// Shared storage is refused above. This fixed unshared view cannot grow between
		// the intrinsic bound check and synchronous copy, including resizable buffers.
		const view = new MailBytes(buffer, offset, length);
		const copy = new MailBytes(length);
		setBytes.call(copy, view);
		return copy;
	} catch (error) {
		throw error instanceof ContentError ? error : new ContentError("INVALID_INPUT");
	}
}

function copiedEvidence(value: MailEvidence): MailEvidence {
	if (
		!value ||
		!["gmail", "generic"].includes(value.provider) ||
		!Array.isArray(value.ownerAddresses) ||
		value.ownerAddresses.length > 500 ||
		!value.ownerAddresses.every((address) => typeof address === "string" && address.length <= 320)
	)
		throw new ContentError("INVALID_INPUT");
	const sent = value.sentEvidence;
	if (
		sent &&
		(!["verified-send", "provider-sent"].includes(sent.kind) ||
			typeof sent.messageSha256 !== "string" ||
			!/^[0-9a-f]{64}$/.test(sent.messageSha256))
	)
		throw new ContentError("INVALID_INPUT");
	return checkedMailEvidence({
		provider: value.provider,
		ownerAddresses: [...value.ownerAddresses],
		...(sent ? { sentEvidence: { kind: sent.kind, messageSha256: sent.messageSha256 } } : {}),
	});
}

// Every job gets a fresh heap; no content, attachment bytes or parser state survives it.
async function runJob(job: ContentJob, options: WorkerOptions): Promise<unknown> {
	// Large attachment-bearing raw mail has a larger, still bounded decode budget.
	const maximumTimeoutMs = job.kind === "mail" ? 10_000 : 2_000;
	const timeoutMs = options.timeoutMs ?? maximumTimeoutMs;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximumTimeoutMs) {
		throw new ContentError("INVALID_INPUT");
	}
	if (options.signal?.aborted) throw new ContentError("ABORTED");
	if (active >= MAX_CONTENT_WORKERS) throw new ContentError("BUSY");
	if (job.kind === "mail") {
		// Copy the exact view, never its possibly much larger backing buffer or shared memory.
		job = { kind: "mail", raw: copiedMailBytes(job.raw), evidence: copiedEvidence(job.evidence) };
	} else {
		boundedText(job.source);
		job = {
			kind: job.kind,
			source: job.source,
			options: job.options
				? {
						maxChars: job.options.maxChars,
						quotedHistoryChars: job.options.quotedHistoryChars,
					}
				: undefined,
		};
	}
	active++;
	let worker: Worker | undefined;
	try {
		const extension = import.meta.url.endsWith(".ts") ? "ts" : "mjs";
		worker = new Worker(new URL(`./worker-entry.${extension}`, import.meta.url), {
			execArgv: [],
			env: {},
			stdout: true,
			stderr: true,
			resourceLimits:
				job.kind === "mail"
					? { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 }
					: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 2 },
		});
		worker.stdout?.resume();
		worker.stderr?.resume();
		const current = worker;
		const result = await new Promise<unknown>((resolve, reject) => {
			let complete = false;
			let ready = false;
			const finish = (error: ContentError | undefined, value?: unknown): void => {
				if (complete) return;
				complete = true;
				clearTimeout(deadline);
				options.signal?.removeEventListener("abort", aborted);
				if (error) reject(error);
				else resolve(value);
			};
			const aborted = (): void => finish(new ContentError("ABORTED"));
			let deadline = setTimeout(
				() => finish(new ContentError("STARTUP_TIMEOUT")),
				CONTENT_STARTUP_TIMEOUT_MS,
			);
			current.once("error", () => finish(new ContentError("WORKER_FAILED")));
			current.once("exit", () => finish(new ContentError("WORKER_FAILED")));
			current.on("message", (message: unknown) => {
				if (complete) return;
				if (typeof message !== "object" || message === null) {
					finish(new ContentError("WORKER_FAILED"));
					return;
				}
				const reply = message as { ready?: unknown; ok?: unknown; value?: unknown; code?: unknown };
				if (!ready) {
					if (reply.ready !== true) return finish(new ContentError("WORKER_FAILED"));
					ready = true;
					clearTimeout(deadline);
					deadline = setTimeout(() => finish(new ContentError("TIMEOUT")), timeoutMs);
					try {
						current.postMessage(job);
					} catch {
						finish(new ContentError("INVALID_INPUT"));
					}
					return;
				}
				if (reply.ok === true && reply.value !== undefined) finish(undefined, reply.value);
				else finish(new ContentError(contentErrorCode(reply.code) ?? "WORKER_FAILED"));
			});
			options.signal?.addEventListener("abort", aborted, { once: true });
			if (options.signal?.aborted) aborted();
		});
		return job.kind === "mail" ? checkedParsedMail(result as ParsedMail) : result;
	} catch (error) {
		throw error instanceof ContentError ? error : new ContentError("WORKER_FAILED");
	} finally {
		try {
			await worker?.terminate();
		} finally {
			active--;
		}
	}
}

export async function parseMailInWorker(
	raw: Uint8Array,
	evidence: MailEvidence,
	options: WorkerOptions = {},
): Promise<ParsedMail> {
	return (await runJob({ kind: "mail", raw, evidence }, options)) as ParsedMail;
}

export async function cleanInWorker(
	kind: "text" | "html",
	source: string,
	hygiene?: HygieneOptions,
	options: WorkerOptions = {},
): Promise<HygieneResult> {
	return (await runJob({ kind, source, options: hygiene }, options)) as HygieneResult;
}
