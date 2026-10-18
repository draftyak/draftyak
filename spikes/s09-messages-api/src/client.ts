import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_MODEL, DRAFT_EFFORT } from "./draft.ts";
import {
	API_ORIGIN,
	KEY_PLACEHOLDER,
	type Pin,
	PLATFORM_HEADERS,
	type Verdict,
	verifyRequest,
} from "./verify.ts";

// Response header values worth keeping; every other header is kept by name only.
const KEPT_HEADER = /^(?:content-type|retry-after|.*ratelimit.*)$/;

// The kit's Secret, or a fake built at run time in tests.
export interface KeySource {
	reveal(): string;
}

export interface RecordedResponse {
	readonly status: number;
	readonly headerNames: readonly string[];
	readonly kept: Readonly<Record<string, string>>;
}

// A request as the SDK built it: the key header still holds the placeholder.
export interface RecordedRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly body: unknown;
	readonly verdict: Verdict;
	response?: RecordedResponse;
}

export interface StubOptions {
	// Where verified requests go: the loopback fake offline, the API in live mode.
	readonly upstream?: string;
	// The key the broker injects; only live mode passes the owner's key.
	readonly key?: KeySource;
	readonly pin?: Pin;
}

export interface CtxFetchStub {
	readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	readonly requests: readonly RecordedRequest[];
}

function parseBody(body: RequestInit["body"]): unknown {
	if (typeof body !== "string") return undefined;
	try {
		return JSON.parse(body);
	} catch {
		return undefined;
	}
}

// A refusal answers like an API error the SDK won't retry, so no request leaves and none repeats.
function refused(problems: readonly string[]): Response {
	const error = { type: "broker_refused", message: `refused: ${problems.join("; ")}` };
	return Response.json(
		{ type: "error", error },
		{ status: 403, headers: { "x-should-retry": "false" } },
	);
}

function recordResponse(response: Response): RecordedResponse {
	const kept: Record<string, string> = {};
	for (const [name, value] of response.headers) if (KEPT_HEADER.test(name)) kept[name] = value;
	return { status: response.status, headerNames: [...response.headers.keys()].sort(), kept };
}

// ctx.fetch as the plugin sees it: every request is recorded and verified before it leaves, and
// the key is added only on the way out, so neither the SDK nor the recording ever holds it.
export function createCtxFetchStub(options: StubOptions = {}): CtxFetchStub {
	const upstream = new URL(options.upstream ?? API_ORIGIN);
	const requests: RecordedRequest[] = [];
	const ctxFetchStub = async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const method = (init.method ?? "GET").toUpperCase();
		const headers = new Headers(init.headers);
		const body = parseBody(init.body);
		const verdict = verifyRequest({ method, url, headers, body }, options.pin);
		const record: RecordedRequest = {
			method,
			url,
			headers: Object.fromEntries(headers),
			body,
			verdict,
		};
		requests.push(record);
		if (!verdict.ok) return refused(verdict.problems);
		const { pathname, search } = new URL(url);
		const target = new URL(`${pathname}${search}`, upstream);
		const outgoing = new Headers(headers);
		if (options.key) outgoing.set("x-api-key", options.key.reveal());
		// What leaves is what was verified: the body is serialized again from the parsed object, so a
		// duplicate key can't carry a second value past the verifier to a first-wins parser. No
		// redirect is followed (§4 broker step 7): it would take the key and the prompt elsewhere.
		const response = await globalThis.fetch(target, {
			method,
			headers: outgoing,
			body: JSON.stringify(body),
			redirect: "manual",
			signal: init.signal ?? null,
		});
		record.response = recordResponse(response);
		if (response.status < 300 || response.status > 399) return response;
		await response.body?.cancel();
		return refused([`upstream ${response.status}: redirects are not followed`]);
	};
	return { fetch: ctxFetchStub, requests };
}

// The plugin's client: the SDK gets only the placeholder key and ctx.fetch. Every option the
// constructor would otherwise read from ANTHROPIC_* variables is set, so the environment can't
// redirect requests, add a bearer token, log request options or turn on tracing.
export function createClient(
	stub: CtxFetchStub,
	options: { readonly maxRetries?: number } = {},
): Anthropic {
	return new Anthropic({
		apiKey: KEY_PLACEHOLDER,
		authToken: null,
		webhookKey: null,
		baseURL: API_ORIGIN,
		fetch: stub.fetch,
		defaultHeaders: Object.fromEntries(PLATFORM_HEADERS.map((name) => [name, null])),
		openTelemetry: false,
		logLevel: "off",
		...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
	});
}

// Live mode (M0.31): the owner's key, read only through the kit from the main checkout's .env.live,
// and only for the draft's model and effort unless the caller pins others.
export async function liveStub(
	pin: Pin = { model: DEFAULT_MODEL, effort: DRAFT_EFFORT },
): Promise<CtxFetchStub> {
	const { loadEnvLive } = await import("@draftyak/spike-kit");
	const { DY_LIVE_MESSAGES_API_KEY: key } = loadEnvLive(["DY_LIVE_MESSAGES_API_KEY"]);
	return createCtxFetchStub({ upstream: API_ORIGIN, key, pin });
}
