// The broker's SIWC verifier (plan §4). The draft schema and submit_draft are pinned too.

export const API_ORIGIN = "https://api.openai.com";
export const API_BASE: string = `${API_ORIGIN}/v1`;
// The SDK holds this placeholder; the broker swaps in the access token after verifying.
export const TOKEN_PLACEHOLDER = "brokered";
export const SUBMIT_DRAFT = "submit_draft";
export const NAMESPACE = "draftyak";
export const EFFORTS: readonly string[] = "none minimal low medium high xhigh max".split(" ");
export const BODY_FIELDS: readonly string[] =
	"model instructions input tools tool_choice text reasoning stream store".split(" ");

// DraftOutput with S9's provisional limits, stated here and checked after parsing (plan §5).
export const DRAFT_SCHEMA: Readonly<Record<string, unknown>> = {
	type: "object",
	properties: {
		body: { type: "string", description: "The reply body, at most 8000 characters." },
		ownerNotes: { type: "string", description: "Notes for the owner, at most 1000 characters." },
		needsOwnerInput: {
			type: "array",
			items: { type: "string", description: "At most 300 characters." },
			maxItems: 5,
		},
		suspectedInstructions: { type: "boolean" },
		contextRefs: {
			type: "array",
			items: { type: "string", enum: ["c1", "c2", "c3"] },
			maxItems: 3,
		},
	},
	required: ["body", "ownerNotes", "needsOwnerInput", "suspectedInstructions", "contextRefs"],
	additionalProperties: false,
};

// Schema-only and never executed: its arguments are the draft, and no output is sent back.
export const SUBMIT_DRAFT_TOOL: Readonly<Record<string, unknown>> = {
	type: "function",
	name: SUBMIT_DRAFT,
	description: "Submit the reply draft. Call exactly once.",
	parameters: DRAFT_SCHEMA,
	strict: true,
};

export interface OutgoingRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: Headers;
	readonly body: unknown;
}

export type Verdict =
	| { readonly ok: true }
	| { readonly ok: false; readonly problems: readonly string[] };

type Problems = string[];

// Problems repeat only the API's own names; anything else could be content and shows as (unknown).
const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/));
const VOCABULARY = words(`${BODY_FIELDS.join(" ")} access_programs background context_management
	conversation include max_output_tokens max_tool_calls metadata moderation multi_agent
	parallel_tool_calls previous_response_id prompt prompt_cache_key prompt_cache_options
	prompt_cache_retention safety_identifier service_tier stream_options temperature top_logprobs
	top_p truncation user type role content text name description parameters strict format schema
	effort summary verbosity id phase status defer_loading allowed_callers async output_schema`);
const HEADER_VOCABULARY = words(`accept content-type user-agent authorization
	x-stainless-retry-count x-stainless-timeout x-stainless-lang x-stainless-package-version
	x-stainless-os x-stainless-arch x-stainless-runtime x-stainless-runtime-version
	x-stainless-helper-method openai-organization openai-project idempotency-key`);
const named = (vocabulary: ReadonlySet<string>, name: string): string =>
	vocabulary.has(name) ? name : "(unknown)";

const HEADERS = new Map<string, RegExp>([
	["accept", /^application\/json$/],
	["content-type", /^application\/json$/],
	["user-agent", /^OpenAI\/JS \d+\.\d+\.\d+$/],
	["authorization", new RegExp(`^Bearer ${TOKEN_PLACEHOLDER}$`)],
	["x-stainless-retry-count", /^\d{1,2}$/],
	["x-stainless-timeout", /^\d{1,6}$/],
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (!isRecord(value)) return JSON.stringify(value) ?? "null";
	const keys = Object.keys(value).sort();
	return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function onlyKeys(obj: Record<string, unknown>, keys: readonly string[], at: string, p: Problems) {
	for (const key of Object.keys(obj)) {
		if (!keys.includes(key)) p.push(`${at}${named(VOCABULARY, key)}: not allowed`);
	}
}

const isSubmitDraft = (tool: unknown): boolean => canonical(tool) === canonical(SUBMIT_DRAFT_TOOL);
const only = (list: unknown, test: (item: unknown) => boolean): boolean =>
	Array.isArray(list) && list.length === 1 && test(list[0]);

function checkTools(tools: unknown, p: Problems): boolean {
	const tool = Array.isArray(tools) && tools.length === 1 ? tools[0] : undefined;
	if (isSubmitDraft(tool)) return true;
	const namespace =
		isRecord(tool) &&
		tool.type === "namespace" &&
		tool.name === NAMESPACE &&
		typeof tool.description === "string" &&
		only(tool.tools, isSubmitDraft);
	if (!namespace) p.push("tools: only submit_draft, alone or in the draftyak namespace");
	else onlyKeys(tool, ["type", "name", "description", "tools"], "tools[0].", p);
	return namespace;
}

const isText = (part: unknown): boolean =>
	isRecord(part) &&
	part.type === "input_text" &&
	typeof part.text === "string" &&
	Object.keys(part).length === 2;

function checkInput(input: unknown, p: Problems): boolean {
	if (!Array.isArray(input) || input.length === 0) {
		p.push("input: must be a non-empty array");
		return false;
	}
	let offered = 0;
	for (const [index, item] of input.entries()) {
		const at = `input[${index}]`;
		if (isRecord(item) && item.type === "additional_tools") {
			offered++;
			onlyKeys(item, ["type", "role", "tools"], `${at}.`, p);
			if (item.role !== "developer" || !only(item.tools, isSubmitDraft)) {
				p.push(`${at}: an additional_tools item may only offer submit_draft`);
			}
		} else if (isRecord(item) && item.type === "message" && item.role === "user") {
			onlyKeys(item, ["type", "role", "content"], `${at}.`, p);
			const parts = Array.isArray(item.content) ? item.content : [];
			if (parts.length === 0 || !parts.every(isText))
				p.push(`${at}.content: only input_text parts`);
		} else {
			p.push(`${at}: only user messages and one submit_draft item are allowed`);
		}
	}
	if (offered > 1) p.push("input: submit_draft offered more than once");
	return offered === 1;
}

function checkText(text: unknown, toolOffered: boolean, p: Problems): void {
	const format = isRecord(text) ? text.format : undefined;
	if (isRecord(text)) onlyKeys(text, ["format"], "text.", p);
	if (isRecord(format) && format.type === "text" && Object.keys(format).length === 1) return;
	const schema =
		isRecord(format) &&
		format.type === "json_schema" &&
		format.strict === true &&
		typeof format.name === "string" &&
		/^[A-Za-z0-9_-]{1,64}$/.test(format.name) &&
		canonical(format.schema) === canonical(DRAFT_SCHEMA);
	if (!schema) p.push("text.format: only text or the strict draft json_schema");
	else onlyKeys(format, ["type", "name", "schema", "strict", "description"], "text.format.", p);
	if (schema && toolOffered) p.push("text.format: not alongside submit_draft");
}

function checkBody(body: unknown, p: Problems): void {
	if (!isRecord(body)) {
		p.push("body: must be a JSON object");
		return;
	}
	onlyKeys(body, BODY_FIELDS, "body.", p);
	if (body.store !== false) p.push("store: must be false");
	if (body.stream !== true) p.push("stream: must be true");
	if (typeof body.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.model)) {
		p.push("model: must be a model slug");
	}
	if ("instructions" in body && typeof body.instructions !== "string") {
		p.push("instructions: must be a string");
	}
	const inInput = checkInput(body.input, p);
	const inTools = "tools" in body && checkTools(body.tools, p);
	if (inInput && "tools" in body) p.push("tools: submit_draft offered twice");
	if ("tool_choice" in body) {
		const choice = body.tool_choice;
		const forced = canonical(choice) === canonical({ type: "function", name: SUBMIT_DRAFT });
		if (
			!(forced || ["required", "auto", "none"].includes(choice as string)) ||
			!(inInput || inTools)
		) {
			p.push("tool_choice: required, auto, none or submit_draft, with submit_draft offered");
		}
	}
	if ("text" in body) checkText(body.text, inInput || inTools, p);
	if ("reasoning" in body) {
		const reasoning = body.reasoning;
		if (!isRecord(reasoning) || !EFFORTS.includes(reasoning.effort as string)) {
			p.push("reasoning.effort: not an allowed value");
		} else {
			onlyKeys(reasoning, ["effort"], "reasoning.", p);
		}
	}
}

export function verifyRequest(request: OutgoingRequest): Verdict {
	const p: Problems = [];
	const method = request.method.toUpperCase();
	const url = URL.canParse(request.url) ? new URL(request.url) : undefined;
	const bare = url?.search === "" && url.hash === "" && url.username === "" && url.password === "";
	const plain = url?.origin === API_ORIGIN && bare;
	const route = `${method} ${url?.pathname}`;
	if (!plain || (route !== "POST /v1/responses" && route !== "GET /v1/models")) {
		p.push(`url: only POST ${API_BASE}/responses and GET ${API_BASE}/models are allowed`);
	} else if (method === "POST") {
		checkBody(request.body, p);
	} else if (request.body !== undefined) {
		p.push("body: GET takes none");
	}
	for (const [name, value] of request.headers) {
		const rule = HEADERS.get(name);
		if (rule === undefined) p.push(`header ${named(HEADER_VOCABULARY, name)}: not allowed`);
		else if (!rule.test(value)) p.push(`header ${name}: value not allowed`);
	}
	for (const name of method === "POST" ? ["authorization", "content-type"] : ["authorization"]) {
		if (!request.headers.has(name)) p.push(`header ${name}: missing`);
	}
	return p.length === 0 ? { ok: true } : { ok: false, problems: p };
}
