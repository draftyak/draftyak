// The broker's verifier for Messages API requests (plan §4 AI request verifiers, §5): a request
// leaves only if its URL, headers and body hold exactly the allowlisted fields and values.

export const API_ORIGIN = "https://api.anthropic.com";
export const API_VERSION = "2023-06-01";
// The SDK holds this placeholder; the broker swaps in the owner's key after verifying.
export const KEY_PLACEHOLDER = "brokered";
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";
export const MAX_TOKENS_CAP = 16_000;
export const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

// Server-side fallback per the refusals-and-fallback page (read 2026-10-17). Claude Haiku 5.5 has
// none: `fallbacks: "default"` is a no-op there and a list is a 400.
export const FALLBACK_MODELS: ReadonlySet<string> = new Set([
	"claude-fable-5-1",
	"claude-fable-5",
	"claude-opus-5-5",
	"claude-opus-5",
	"claude-sonnet-5-5",
]);

// The SDK's platform headers (OS, CPU, runtime and SDK versions). Plugins send none (guardrail 8).
export const PLATFORM_HEADERS: readonly string[] = [
	"x-stainless-lang",
	"x-stainless-package-version",
	"x-stainless-os",
	"x-stainless-arch",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
];

export interface OutgoingRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Headers;
	readonly body: unknown;
}

// The owner's instance settings: with a pin, no other model or effort runs on the owner's key.
export interface Pin {
	readonly model: string;
	readonly effort: string;
}

export type Verdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly problems: readonly string[] };

type Problems = string[];
type Rule = (value: string) => boolean;

// A Map, so a header named like an inherited property ("constructor") never finds a rule.
const HEADERS: ReadonlyMap<string, Rule> = new Map<string, Rule>([
	["accept", (value) => value === "application/json"],
	["content-type", (value) => value === "application/json"],
	["user-agent", (value) => /^Anthropic\/JS \d+\.\d+\.\d+$/.test(value)],
	["anthropic-version", (value) => value === API_VERSION],
	["x-api-key", (value) => value === KEY_PLACEHOLDER],
	["anthropic-beta", (value) => value === FALLBACK_BETA],
	["x-stainless-retry-count", (value) => /^\d{1,2}$/.test(value)],
	["x-stainless-timeout", (value) => /^\d{1,6}$/.test(value)],
	["x-stainless-helper-method", (value) => value === "stream"],
]);
const REQUIRED_HEADERS = ["content-type", "anthropic-version", "x-api-key"];
const BODY_FIELDS = [
	"model",
	"system",
	"messages",
	"max_tokens",
	"output_config",
	"stream",
	"fallbacks",
];

// Problems repeat only the API's own names: the fields of SDK 0.135.0's beta request types (request,
// message, text block, output_config, format), the headers the SDK can send and the betas below.
// Anything else could be content a plugin chose, so it shows as "(unknown)".
const FIELD_NAMES: ReadonlySet<string> = new Set([
	...BODY_FIELDS,
	...["metadata", "stop_sequences", "temperature", "top_k", "top_p", "tools", "tool_choice"],
	...["thinking", "service_tier", "speed", "container", "mcp_servers", "context_management"],
	...["output_format", "inference_geo", "diagnostics", "cache_control", "compaction", "betas"],
	...["fallback_credit_token", "user_profile_id", "workspace_id", "role", "content", "clear_at"],
	...["type", "text", "citations", "effort", "format", "task_budget", "schema"],
]);
const HEADER_NAMES: ReadonlySet<string> = new Set([
	...HEADERS.keys(),
	...PLATFORM_HEADERS,
	...["x-stainless-helper", "authorization", "anthropic-dangerous-direct-browser-access"],
	...["anthropic-organization-id", "anthropic-user-profile-id", "anthropic-workspace-id"],
	...["traceparent", "tracestate", "baggage"],
]);
const BETA_NAMES: ReadonlySet<string> = new Set([
	FALLBACK_BETA,
	"server-side-fallback-2026-06-01",
	"fallback-credit-2026-07-01",
	"structured-outputs-2025-11-13",
	"structured-outputs-2025-12-15",
]);
const known = (names: ReadonlySet<string>, name: string): string =>
	names.has(name) ? name : "(unknown)";

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function onlyKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	at: string,
	problems: Problems,
): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) problems.push(`${at}${known(FIELD_NAMES, key)}: not allowed`);
	}
}

function checkTarget(method: string, raw: string, problems: Problems): void {
	if (method !== "POST") problems.push("method: only POST is allowed");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		problems.push("url: not a URL");
		return;
	}
	const target =
		url.origin === API_ORIGIN &&
		url.pathname === "/v1/messages" &&
		(url.search === "" || url.search === "?beta=true") &&
		url.username === "" &&
		url.password === "" &&
		url.hash === "";
	if (!target) problems.push(`url: only POST ${API_ORIGIN}/v1/messages is allowed`);
}

// System prompts and message contents are text only: no images, documents, tool blocks or caching.
function checkText(value: unknown, at: string, problems: Problems): void {
	if (typeof value === "string") return;
	if (!Array.isArray(value) || value.length === 0) {
		problems.push(`${at}: must be a string or text blocks`);
		return;
	}
	value.forEach((block, index) => {
		if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") {
			problems.push(`${at}[${index}]: only text blocks are allowed`);
		} else {
			onlyKeys(block, ["type", "text"], `${at}[${index}].`, problems);
		}
	});
}

function checkMessages(value: unknown, problems: Problems): void {
	if (!Array.isArray(value) || value.length === 0) {
		problems.push("messages: must be a non-empty array");
		return;
	}
	value.forEach((message, index) => {
		const at = `messages[${index}]`;
		if (!isRecord(message)) {
			problems.push(`${at}: must be an object`);
			return;
		}
		onlyKeys(message, ["role", "content"], `${at}.`, problems);
		if (message.role !== "user" && message.role !== "assistant") {
			problems.push(`${at}.role: must be user or assistant`);
		}
		checkText(message.content, `${at}.content`, problems);
	});
}

function checkOutputConfig(value: unknown, problems: Problems): void {
	if (!isRecord(value)) {
		problems.push("output_config: must be an object");
		return;
	}
	onlyKeys(value, ["format", "effort"], "output_config.", problems);
	if ("effort" in value && !(typeof value.effort === "string" && EFFORTS.includes(value.effort))) {
		problems.push("output_config.effort: not an allowed value");
	}
	if (!("format" in value)) return;
	const format = value.format;
	if (!isRecord(format) || format.type !== "json_schema" || !isRecord(format.schema)) {
		problems.push("output_config.format: must be { type: json_schema, schema }");
	} else {
		onlyKeys(format, ["type", "schema"], "output_config.format.", problems);
	}
}

function checkBody(body: unknown, problems: Problems): Record<string, unknown> {
	if (!isRecord(body)) {
		problems.push("body: must be a JSON object");
		return {};
	}
	onlyKeys(body, BODY_FIELDS, "body.", problems);
	if (typeof body.model !== "string" || !/^claude-[a-z0-9.-]{1,64}$/.test(body.model)) {
		problems.push("model: must be a model id");
	}
	const maxTokens = body.max_tokens;
	if (
		typeof maxTokens !== "number" ||
		!Number.isInteger(maxTokens) ||
		maxTokens < 1 ||
		maxTokens > MAX_TOKENS_CAP
	) {
		problems.push(`max_tokens: must be an integer from 1 to ${MAX_TOKENS_CAP}`);
	}
	checkMessages(body.messages, problems);
	if ("system" in body) checkText(body.system, "system", problems);
	if ("output_config" in body) checkOutputConfig(body.output_config, problems);
	if ("stream" in body && typeof body.stream !== "boolean") {
		problems.push("stream: must be a boolean");
	}
	if ("fallbacks" in body) {
		if (body.fallbacks !== "default") problems.push('fallbacks: only "default" is allowed');
		if (!FALLBACK_MODELS.has(body.model as string)) {
			problems.push("fallbacks: the model has no server-side fallback");
		}
	}
	return body;
}

// A missing effort is refused too: the API would run its own default.
function checkPin(body: Record<string, unknown>, pin: Pin, problems: Problems): void {
	if (body.model !== pin.model) problems.push("model: not the instance's model");
	const effort = isRecord(body.output_config) ? body.output_config.effort : undefined;
	if (effort !== pin.effort) problems.push("output_config.effort: not the instance's effort");
}

function checkHeaders(headers: Headers, body: Record<string, unknown>, problems: Problems): void {
	for (const [name, value] of headers) {
		const rule = HEADERS.get(name);
		if (rule === undefined) {
			problems.push(`header ${known(HEADER_NAMES, name)}: not allowed`);
		} else if (!rule(value)) {
			const betas = value.split(",").map((beta) => known(BETA_NAMES, beta.trim()));
			const shown = name === "anthropic-beta" ? ` (${betas.join(", ")})` : "";
			problems.push(`header ${name}: value not allowed${shown}`);
		}
	}
	for (const name of REQUIRED_HEADERS) {
		if (!headers.has(name)) problems.push(`header ${name}: missing`);
	}
	const fallbacks = "fallbacks" in body;
	if (fallbacks !== headers.has("anthropic-beta")) {
		problems.push(`fallbacks and the ${FALLBACK_BETA} beta go together`);
	}
}

export function verifyRequest(request: OutgoingRequest, pin?: Pin): Verdict {
	const problems: Problems = [];
	checkTarget(request.method, request.url, problems);
	const body = checkBody(request.body, problems);
	if (pin) checkPin(body, pin, problems);
	checkHeaders(request.headers, body, problems);
	return problems.length === 0 ? { ok: true } : { ok: false, problems };
}
