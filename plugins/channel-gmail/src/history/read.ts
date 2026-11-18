import { PluginErrorResult } from "@draftyak/protocol/errors";
import { HOST_MAX_HEADER_BYTES } from "@draftyak/protocol/host-channel";
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

/** RFC 9110 recipient dates, using UTC and its rolling 50-year rule for RFC 850. */
function retryDate(value: string, now: number): number | undefined {
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const longDays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];
	const reference = new Date(now);
	const ceiling = reference.getUTCFullYear() + 50;
	let day: number, month: number, year: number, hour: number, minute: number, second: number;
	let weekday: number;
	let obsolete = false;
	const imf =
		/^([A-Z][a-z]{2}), ([0-9]{2}) ([A-Z][a-z]{2}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
			value,
		);
	const rfc850 =
		/^([A-Z][a-z]+), ([0-9]{2})-([A-Z][a-z]{2})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/.exec(
			value,
		);
	const asctime =
		/^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ( [0-9]|[0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$/.exec(
			value,
		);
	if (imf || rfc850) {
		const fields = imf ?? rfc850;
		if (!fields) return undefined;
		weekday = (imf ? days : longDays).indexOf(fields[1] ?? "");
		day = Number(fields[2]);
		month = months.indexOf(fields[3] ?? "");
		year = Number(fields[4]);
		hour = Number(fields[5]);
		minute = Number(fields[6]);
		second = Number(fields[7]);
		if (rfc850) {
			obsolete = true;
			year += Math.floor(ceiling / 100) * 100;
			if (year > ceiling) year -= 100;
		}
	} else if (asctime) {
		weekday = days.indexOf(asctime[1] ?? "");
		month = months.indexOf(asctime[2] ?? "");
		day = Number(asctime[3]);
		hour = Number(asctime[4]);
		minute = Number(asctime[5]);
		second = Number(asctime[6]);
		year = Number(asctime[7]);
	} else return undefined;
	if (
		weekday < 0 ||
		month < 0 ||
		day < 1 ||
		day > 31 ||
		year < 0 ||
		year > 9999 ||
		hour > 23 ||
		minute > 59 ||
		second > 60 ||
		(second === 60 && (hour !== 23 || minute !== 59))
	)
		return undefined;
	// setUTCFullYear avoids Date.UTC's special interpretation of years 00..99.
	const date = new Date(0);
	date.setUTCFullYear(year, month, day);
	date.setUTCHours(hour, minute, Math.min(second, 59), 0);
	const leap = second === 60 ? 1000 : 0;
	if (obsolete) {
		const limit = new Date(now);
		limit.setUTCFullYear(ceiling);
		if (date.getTime() + leap > limit.getTime()) {
			year -= 100;
			date.setUTCFullYear(year, month, day);
		}
	}
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute ||
		date.getUTCDay() !== weekday
	)
		return undefined;
	// JavaScript has no distinct leap-second instant: map 23:59:60 to the following midnight.
	return date.getTime() + leap;
}

function rateLimitError(response: Response): PluginError {
	try {
		const raw = response.headers.get("retry-after");
		// Use the existing host header bound, not a new retry-duration policy or raw diagnostic.
		if (raw !== null && raw.length <= HOST_MAX_HEADER_BYTES && /^[\t\x20-\x7e]*$/.test(raw)) {
			const value = raw.replace(/^[ \t]+|[ \t]+$/g, "");
			let retryAfterMs: number | undefined;
			if (/^[0-9]+$/.test(value)) retryAfterMs = Number(value) * 1000;
			else {
				// Compare absolute dates with one system time sampled while converting the error.
				const now = Date.now();
				if (Number.isSafeInteger(now) && Number.isFinite(new Date(now).getTime())) {
					const date = retryDate(value, now);
					if (date !== undefined) retryAfterMs = Math.max(0, date - now);
				}
			}
			const parsed = PluginErrorResult.safeParse({ code: "RATE_LIMITED", retryAfterMs });
			if (parsed.success && parsed.data.retryAfterMs !== undefined)
				return new PluginError("RATE_LIMITED", { retryAfterMs: parsed.data.retryAfterMs });
		}
	} catch {
		// Missing, invalid, overflowing or unavailable hints never replace rate classification.
	}
	return new PluginError("RATE_LIMITED");
}

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
			if (response.status === 403) {
				let rateLimited = false;
				try {
					const value = historyRecord(copyHistoryData(await jsonBody(response, signal, budget)));
					const error = historyRecord(value.error);
					rateLimited =
						Array.isArray(error.errors) &&
						error.errors.some((item) => {
							const reason = historyRecord(item).reason;
							return reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
						});
				} catch (error) {
					if (signal.aborted) throw new PluginError("TRANSIENT");
					if (error instanceof PluginError && error.result.code === "QUOTA_EXCEEDED")
						throw new PluginError("QUOTA_EXCEEDED");
				} finally {
					cancel(response.body);
				}
				live(signal);
				throw rateLimited ? rateLimitError(response) : new PluginError("PERMISSION_DENIED");
			}
			cancel(response.body);
			if (response.status === 404 && history) throw new PluginError("CURSOR_EXPIRED");
			if (response.status === 401) throw new PluginError("AUTH_EXPIRED");
			if (response.status === 429) throw rateLimitError(response);
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
