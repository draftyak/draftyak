import { isProxy } from "node:util/types";
import type { ProbeResult } from "@draftyak/protocol/extension";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import type { PluginContext } from "@draftyak/sdk/context";
import type { HostFetch, HostResponse } from "@draftyak/sdk/fetch";

const OK: ProbeResult = Object.freeze({ status: "ok" });
const DEGRADED: ProbeResult = Object.freeze({
	status: "degraded",
	detail: "Slack probe unavailable",
});

interface ProbeTransport {
	readonly fetch: HostFetch;
	readonly signal: AbortSignal;
	readonly receiver: unknown;
}

function capture(raw: unknown): ProbeTransport {
	if (raw === null || typeof raw !== "object" || isProxy(raw)) throw new Error();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) throw new Error();
	const fetch = Object.getOwnPropertyDescriptor(raw, "fetch");
	const signal = Object.getOwnPropertyDescriptor(raw, "signal");
	if (
		!fetch?.enumerable ||
		!("value" in fetch) ||
		typeof fetch.value !== "function" ||
		isProxy(fetch.value) ||
		!signal?.enumerable ||
		!("value" in signal) ||
		signal.value === null ||
		typeof signal.value !== "object" ||
		isProxy(signal.value)
	)
		throw new Error();
	Reflect.get(AbortSignal.prototype, "aborted", signal.value);
	return { fetch: fetch.value, signal: signal.value, receiver: raw };
}

function assertActive(signal: AbortSignal): void {
	if (Reflect.get(AbortSignal.prototype, "aborted", signal)) throw new Error("SLACK_PROBE_ABORTED");
}

async function probe(input: ProbeTransport): Promise<ProbeResult> {
	const owned = new AbortController();
	const signal = AbortSignal.any([input.signal, owned.signal]);
	let response: HostResponse | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		assertActive(input.signal);
		const received: HostResponse = await Reflect.apply(input.fetch, input.receiver, [
			"https://slack.com/api/auth.test",
			{ method: "GET", stream: false, signal },
		]);
		response = received;
		assertActive(input.signal);
		if (
			!response.ok ||
			response.bodyRef !== undefined ||
			response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
				"application/json" ||
			response.body === null
		)
			return DEGRADED;
		reader = response.body.getReader();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const text: string[] = [];
		let bytes = 0;
		for (;;) {
			const part = await reader.read();
			assertActive(input.signal);
			if (part.done) break;
			bytes += part.value.byteLength;
			if (bytes > MAX_INLINE_BYTES) return DEGRADED;
			text.push(decoder.decode(part.value, { stream: true }));
		}
		text.push(decoder.decode());
		const value: unknown = JSON.parse(text.join(""));
		assertActive(input.signal);
		if (value === null || typeof value !== "object" || Array.isArray(value)) return DEGRADED;
		const prototype = Object.getPrototypeOf(value);
		if (prototype !== null && prototype !== Object.prototype) return DEGRADED;
		return Object.getOwnPropertyDescriptor(value, "ok")?.value === true ? OK : DEGRADED;
	} catch {
		assertActive(input.signal);
		return DEGRADED;
	} finally {
		owned.abort();
		try {
			if (reader !== undefined) await reader.cancel();
			else if (response?.body !== null && response?.body !== undefined)
				await response.body.cancel();
		} catch {
			// SDK cancellation and already-settled bodies need no second completion.
		} finally {
			reader?.releaseLock();
		}
	}
}

/** Advisory health only; it grants no account, native read, send or retry authority. */
export function probeSlack(ctx: Pick<PluginContext, "fetch" | "signal">): Promise<ProbeResult> {
	try {
		const input = capture(ctx);
		return probe(input)
			.then((result) => {
				assertActive(input.signal);
				return result;
			})
			.catch(() => {
				assertActive(input.signal);
				return DEGRADED;
			});
	} catch {
		return Promise.resolve(DEGRADED);
	}
}
