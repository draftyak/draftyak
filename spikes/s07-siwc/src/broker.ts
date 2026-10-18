import { type Recovery, type SiwcCode, SiwcError } from "./errors.ts";
import type { CtxFetch } from "./responses.ts";
import { fromFrames, type HostFrame, toFrames } from "./stream.ts";
import { API_ORIGIN, type Verdict, verifyRequest } from "./verify.ts";

// ctx.fetch for the SIWC plugin (§4 broker): verified before it leaves, the access token added
// only on the way out, no redirect followed, the body back as host frames. Records keep names only.

export interface BrokerOptions {
	readonly token: () => Promise<string>;
	readonly upstream?: string;
	readonly frameBytes?: number;
	readonly fetch?: typeof fetch;
}

export interface BrokerRecord {
	readonly method: string;
	readonly url: string;
	readonly headerNames: readonly string[];
	readonly fields: readonly string[];
	readonly verdict: Verdict;
	credential?: SiwcCode;
	status?: number;
	frames?: number;
}

export interface Broker {
	readonly fetch: CtxFetch;
	readonly requests: readonly BrokerRecord[];
}

const KEPT = /^(?:content-type|x-request-id|openai-request-id|retry-after|x-ratelimit-[a-z-]+)$/;
const STATUS: Readonly<Record<Recovery, number>> = { reauth: 401, never: 403, backoff: 503 };

function refused(problems: readonly string[], code = "broker_refused", status = 403): Response {
	const error = { type: "broker_refused", code, message: problems.join("; ") };
	return Response.json({ error }, { status, headers: { "x-should-retry": "false" } });
}

// Only JSON text is read, so the verified value is what leaves: a stream, bytes or an object (with
// a toJSON of its own) never passes.
function parseBody(body: RequestInit["body"]): unknown {
	if (body === undefined || body === null) return undefined;
	try {
		return typeof body === "string" ? JSON.parse(body) : null;
	} catch {
		return null;
	}
}

async function* serialized(frames: AsyncIterable<HostFrame>, record: BrokerRecord) {
	for await (const frame of frames) {
		record.frames = (record.frames ?? 0) + 1;
		yield JSON.parse(JSON.stringify(frame)) as HostFrame;
	}
}

export function createBroker(options: BrokerOptions): Broker {
	const upstream = new URL(options.upstream ?? API_ORIGIN);
	const requests: BrokerRecord[] = [];
	const ctxFetch: CtxFetch = async (input, init = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init.method ?? "GET").toUpperCase();
		const headers = new Headers(init.headers);
		const body = parseBody(init.body);
		const verdict = verifyRequest({ method, url, headers, body });
		const fields = typeof body === "object" && body !== null ? Object.keys(body) : [];
		const record: BrokerRecord = {
			method,
			url,
			headerNames: [...headers.keys()].sort(),
			fields,
			verdict,
		};
		requests.push(record);
		if (!verdict.ok) return refused(verdict.problems);
		let token: string;
		try {
			token = await options.token();
		} catch (error) {
			// A credential the hub can't use: its code tells the plugin what to do, and nothing leaves.
			if (!(error instanceof SiwcError)) throw error;
			record.credential = error.code;
			return refused([error.code], error.code, STATUS[error.recovery]);
		}
		const outgoing = new Headers(headers);
		outgoing.set("authorization", `Bearer ${token}`);
		// Re-serialized, so a duplicate key can't slip a second value past the verifier.
		const response = await (options.fetch ?? fetch)(new URL(new URL(url).pathname, upstream), {
			method,
			headers: outgoing,
			...(method === "POST" && { body: JSON.stringify(body) }),
			redirect: "manual",
			signal: init.signal ?? null,
		});
		record.status = response.status;
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			return refused([`upstream ${response.status}: redirects are not followed`]);
		}
		const head = {
			status: response.status,
			headers: [...response.headers].filter(([name]) => KEPT.test(name)),
		};
		if (response.body === null || [204, 205].includes(response.status)) {
			return new Response(null, head);
		}
		record.frames = 0;
		return fromFrames(
			head,
			serialized(toFrames(response.body, options.frameBytes ?? 4_096), record),
		);
	};
	return { fetch: ctxFetch, requests };
}
