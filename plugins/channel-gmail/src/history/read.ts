import { parseStrict } from "@draftyak/protocol/jcs";
import { type PluginContext, PluginError } from "@draftyak/sdk";
import { GMAIL_API_BASE, GMAIL_JSON_MAX_CHUNKS, gmailMessageUrl } from "../boundary.ts";
import {
	copyHistoryData,
	decodeHistoryPage,
	type HistoryOptions,
	historyDecimal,
	historyRecord,
} from "./page.ts";
import { type HistoryReduction, reduceHistoryPage } from "./reduce.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_IDS = 500;

function live(signal: AbortSignal): void {
	if (signal.aborted) throw new PluginError("TRANSIENT");
}

function cancel(body: ReadableStream<Uint8Array> | null): void {
	try {
		void body?.cancel().catch(() => {});
	} catch {}
}

function captureOptions(options: HistoryOptions): HistoryOptions {
	try {
		const settings = historyRecord(copyHistoryData(options));
		const start = historyDecimal(settings.startHistoryId);
		// This internal sentinel validates options only; it is never returned as provider DATA.
		decodeHistoryPage({ historyId: start }, settings as unknown as HistoryOptions);
		if (Array.isArray(settings.seenPageTokens)) Object.freeze(settings.seenPageTokens);
		return Object.freeze(settings) as unknown as HistoryOptions;
	} catch {
		throw new PluginError("INVALID_INPUT");
	}
}

async function jsonBody(
	response: Response,
	signal: AbortSignal,
	budget: { remaining: number },
): Promise<unknown> {
	live(signal);
	if (!response.body) throw new PluginError("TRANSIENT");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let reads = 0;
	let complete = false;
	let rejectAbort: (error: PluginError) => void = () => {};
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject;
	});
	const stop = (): void => {
		try {
			void reader.cancel().catch(() => {});
		} catch {}
		rejectAbort(new PluginError("TRANSIENT"));
	};
	signal.addEventListener("abort", stop, { once: true });
	try {
		for (;;) {
			live(signal);
			const chunk = await Promise.race([reader.read(), aborted]);
			live(signal);
			if (chunk.done) {
				complete = true;
				break;
			}
			if (!(chunk.value instanceof Uint8Array)) throw new PluginError("TRANSIENT");
			if (++reads > GMAIL_JSON_MAX_CHUNKS) throw new PluginError("QUOTA_EXCEEDED");
			if (chunk.value.byteLength > budget.remaining) throw new PluginError("QUOTA_EXCEEDED");
			budget.remaining -= chunk.value.byteLength;
			size += chunk.value.byteLength;
			chunks.push(new Uint8Array(chunk.value));
		}
		const bytes = new Uint8Array(size);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return parseStrict(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} finally {
		signal.removeEventListener("abort", stop);
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

/** Read one provider history page and hydrate only its explicit non-deleted message IDs. */
export async function readHistoryPage(
	context: PluginContext,
	options: HistoryOptions,
): Promise<HistoryReduction> {
	const settings = captureOptions(options);
	const signal = context.signal;
	const budget = { remaining: MAX_BYTES };
	let requests = 0;
	const get = async (url: URL, history: boolean): Promise<unknown> => {
		live(signal);
		if (++requests > MAX_IDS + 1) throw new PluginError("QUOTA_EXCEEDED");
		const response = await context.fetch(url, {
			method: "GET",
			redirect: "manual",
			stream: true,
			headers: { accept: "application/json" },
		});
		if (signal.aborted) {
			cancel(response.body);
			throw new PluginError("TRANSIENT");
		}
		if (response.status !== 200) {
			cancel(response.body);
			if (response.status === 404 && history) throw new PluginError("CURSOR_EXPIRED");
			if (response.status === 401) throw new PluginError("AUTH_EXPIRED");
			if (response.status === 403) throw new PluginError("PERMISSION_DENIED");
			if (response.status === 429) throw new PluginError("RATE_LIMITED");
			throw new PluginError("TRANSIENT");
		}
		return jsonBody(response, signal, budget);
	};
	try {
		const url = new URL(`${GMAIL_API_BASE}/history`);
		url.searchParams.set("startHistoryId", settings.startHistoryId);
		url.searchParams.set("maxResults", String(MAX_IDS));
		if (settings.pageToken !== undefined) url.searchParams.set("pageToken", settings.pageToken);
		const wire = await get(url, true);
		const plan = decodeHistoryPage(wire, settings);
		if (plan.metadataIds.length > MAX_IDS) throw new PluginError("QUOTA_EXCEEDED");
		let targets: URL[];
		try {
			targets = plan.metadataIds.map((id) => gmailMessageUrl(id, "metadata"));
		} catch {
			throw new PluginError("TRANSIENT");
		}
		const metadata: unknown[] = [];
		for (const message of targets) {
			live(signal);
			metadata.push(await get(message, false));
		}
		live(signal);
		return reduceHistoryPage(wire, metadata, settings);
	} catch (error) {
		if (error instanceof PluginError) throw error;
		throw new PluginError("TRANSIENT");
	}
}
