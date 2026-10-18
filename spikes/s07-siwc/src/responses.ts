import OpenAI from "openai";
import type {
	ResponseCreateParamsStreaming,
	ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { classifyError, type ErrorFacts, headFacts, SiwcError } from "./errors.ts";
import {
	API_BASE,
	DRAFT_SCHEMA,
	EFFORTS,
	NAMESPACE,
	SUBMIT_DRAFT,
	SUBMIT_DRAFT_TOOL,
	TOKEN_PLACEHOLDER,
} from "./verify.ts";

// The SDK's platform headers (OS, CPU, runtime and versions); plugins send none (guardrail 8).
export const PLATFORM_HEADERS: readonly string[] = ["Lang", "Package-Version", "OS", "Arch"]
	.concat("Runtime", "Runtime-Version")
	.map((name) => `X-Stainless-${name}`);

export type CtxFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// Every option the constructor would read from OPENAI_* is set; OPENAI_CUSTOM_HEADERS can't be
// turned off, so the broker's header allowlist covers it. No retries: a usage limit must pause.
export function createClient(fetch: CtxFetch): OpenAI {
	return new OpenAI({
		apiKey: TOKEN_PLACEHOLDER,
		adminAPIKey: null,
		organization: null,
		project: null,
		webhookSecret: null,
		baseURL: API_BASE,
		fetch,
		maxRetries: 0,
		logLevel: "off",
		defaultHeaders: Object.fromEntries(PLATFORM_HEADERS.map((name) => [name, null])),
	});
}

// submit_draft where Preview limitations put tools, and at the top level.
export const STRUCTURES = ["text-format", "tool-namespace", "tool-item", "tool-top-level"] as const;
export type Structure = (typeof STRUCTURES)[number];
export const CONTEXT_IDS: readonly string[] = ["c1", "c2", "c3"];

export interface DraftJob {
	readonly model: string;
	readonly instructions: string;
	readonly prompt: string;
	readonly structure: Structure;
	readonly effort?: string;
	readonly contextIds?: readonly string[];
}

// Built field by field from the allowlist; nothing from the caller is spread in.
export function buildRequest(job: DraftJob): Readonly<Record<string, unknown>> {
	if (job.effort !== undefined && !EFFORTS.includes(job.effort)) {
		throw new RangeError("effort: not an allowed value");
	}
	const message = {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: job.prompt }],
	};
	const format = { type: "json_schema", name: "draft_output", strict: true, schema: DRAFT_SCHEMA };
	const description = "DraftYak's reply drafts.";
	const namespace = { type: "namespace", name: NAMESPACE, description, tools: [SUBMIT_DRAFT_TOOL] };
	const offered = { type: "additional_tools", role: "developer", tools: [SUBMIT_DRAFT_TOOL] };
	const shape: Record<Structure, Record<string, unknown>> = {
		"text-format": { input: [message], text: { format } },
		"tool-namespace": { input: [message], tools: [namespace], tool_choice: "required" },
		"tool-item": { input: [offered, message], tool_choice: "required" },
		"tool-top-level": {
			input: [message],
			tools: [SUBMIT_DRAFT_TOOL],
			tool_choice: { type: "function", name: SUBMIT_DRAFT },
		},
	};
	return {
		model: job.model,
		instructions: job.instructions,
		...shape[job.structure],
		...(job.effort !== undefined && { reasoning: { effort: job.effort } }),
		store: false,
		stream: true,
	};
}

export interface DraftOutput {
	readonly body: string;
	readonly ownerNotes: string;
	readonly needsOwnerInput: readonly string[];
	readonly suspectedInstructions: boolean;
	readonly contextRefs: readonly string[];
}

export type Parsed =
	| { readonly ok: true; readonly draft: DraftOutput }
	| { readonly ok: false; readonly problems: readonly string[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const short = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length <= max;
const FIELDS = ["body", "ownerNotes", "needsOwnerInput", "suspectedInstructions", "contextRefs"];

// Strict mode enforces no lengths. contextRefs is informational (plan §5).
export function parseDraft(json: string, contextIds: readonly string[] = CONTEXT_IDS): Parsed {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		return { ok: false, problems: ["output: not JSON"] };
	}
	if (!isRecord(value)) return { ok: false, problems: ["output: not an object"] };
	const problems: string[] = [];
	const asks = value.needsOwnerInput;
	if (Object.keys(value).some((key) => !FIELDS.includes(key))) problems.push("output: extra field");
	if (!short(value.body, 8_000)) problems.push("body: missing or over 8000 characters");
	if (!short(value.ownerNotes, 1_000)) problems.push("ownerNotes: missing or over 1000 characters");
	if (!Array.isArray(asks) || asks.length > 5 || !asks.every((ask) => short(ask, 300))) {
		problems.push("needsOwnerInput: at most 5 strings of 300 characters");
	}
	if (typeof value.suspectedInstructions !== "boolean")
		problems.push("suspectedInstructions: missing");
	if (!Array.isArray(value.contextRefs)) problems.push("contextRefs: missing");
	if (problems.length > 0) return { ok: false, problems };
	const refs = (value.contextRefs as unknown[]).map((ref) =>
		typeof ref === "string" ? ref.toLowerCase() : ref,
	);
	const draft = { ...value, contextRefs: contextIds.filter((id) => refs.includes(id)) };
	return { ok: true, draft: draft as unknown as DraftOutput };
}

export type DraftOutcome =
	| { readonly kind: "draft"; readonly draft: DraftOutput; readonly via: "text" | "tool" }
	| { readonly kind: "invalid"; readonly problems: readonly string[] }
	| { readonly kind: "refusal" }
	| { readonly kind: "incomplete"; readonly reason: string }
	| { readonly kind: "aborted" };

interface Seen {
	readonly text: string[];
	readonly args: string[];
	refusal: boolean;
	// The stream's status and request ID, kept for errors that arrive inside it.
	head: ErrorFacts;
}

const invalid = (problem: string): DraftOutcome => ({ kind: "invalid", problems: [problem] });

// submit_draft is never executed: its arguments are the draft, and nothing goes back.
function finish(output: readonly unknown[], seen: Seen, job: DraftJob): DraftOutcome {
	const items = output.filter(isRecord);
	const calls = items.filter((item) => item.type === "function_call");
	const ours = calls.filter(
		(call) =>
			call.name === SUBMIT_DRAFT &&
			(call.namespace ?? NAMESPACE) === NAMESPACE &&
			typeof call.arguments === "string",
	);
	if (calls.length !== ours.length || ours.length > 1)
		return invalid("output: unexpected tool call");
	if (seen.refusal) return { kind: "refusal" };
	const tool = job.structure !== "text-format";
	const streamed = (tool ? seen.args : seen.text).join("");
	const parts = items.flatMap((item) => (Array.isArray(item.content) ? item.content : []));
	const text = parts.map((part) =>
		isRecord(part) && part.type === "output_text" ? String(part.text) : "",
	);
	const final = tool ? String(ours[0]?.arguments ?? "") : text.join("");
	if (final !== "" && final !== streamed) return invalid("output: stream and final output differ");
	const parsed = parseDraft(streamed, job.contextIds);
	if (!parsed.ok) return { kind: "invalid", problems: parsed.problems };
	return { kind: "draft", draft: parsed.draft, via: tool ? "tool" : "text" };
}

function onEvent(event: ResponseStreamEvent, seen: Seen, job: DraftJob): DraftOutcome | undefined {
	switch (event.type) {
		case "response.output_text.delta":
			seen.text.push(event.delta);
			return undefined;
		case "response.function_call_arguments.delta":
			seen.args.push(event.delta);
			return undefined;
		case "response.refusal.delta":
			seen.refusal = true;
			return undefined;
		case "response.completed":
			return finish(event.response.output, seen, job);
		case "response.incomplete":
			return { kind: "incomplete", reason: event.response.incomplete_details?.reason ?? "unknown" };
		// Both read like the SDK's own error for an SSE `error` event, with the stream's head.
		case "response.failed":
			throw classifyError({ error: event.response.error ?? {} }, seen.head);
		case "error":
			throw classifyError({ error: event }, seen.head);
		default:
			return undefined;
	}
}

// A draft counts only after response.completed (Models and inference, step 3). The caller's abort
// is its own outcome, never a failure to retry.
export async function runDraft(
	client: OpenAI,
	job: DraftJob,
	options: {
		readonly signal?: AbortSignal;
		readonly onEvent?: (event: ResponseStreamEvent) => void;
	} = {},
): Promise<DraftOutcome> {
	const request = buildRequest(job) as unknown as ResponseCreateParamsStreaming;
	const seen: Seen = { text: [], args: [], refusal: false, head: {} };
	const signal = options.signal;
	try {
		const created = client.responses.create(request, { signal: signal ?? null });
		const { data, response } = await created.withResponse();
		seen.head = headFacts(response.status, response.headers);
		for await (const event of data) {
			options.onEvent?.(event);
			const outcome = onEvent(event, seen, job);
			if (outcome) return outcome;
		}
	} catch (error) {
		if (signal?.aborted) return { kind: "aborted" };
		throw classifyError(error, seen.head);
	}
	if (signal?.aborted) return { kind: "aborted" };
	throw new SiwcError("STREAM_INTERRUPTED", { ...seen.head, detail: "no terminal event" });
}
