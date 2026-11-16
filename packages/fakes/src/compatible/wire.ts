/** The synthetic model the compatible fake lists and its replies name by default. */
export const COMPATIBLE_MODEL = "synthetic-model:1";

/** A DraftOutputV1-shaped draft, as a model writes it in its message text. */
export interface CompatibleDraft {
	readonly body: string;
	readonly ownerNotes: string;
	readonly needsOwnerInput: readonly string[];
	readonly suspectedInstructions: boolean;
	readonly contextRefs: readonly string[];
}

/** A benign synthetic draft: the default reply content. */
export const COMPATIBLE_DRAFT: CompatibleDraft = Object.freeze({
	body: "DYTEST reply: thanks for the note, Tuesday works.",
	ownerNotes: "",
	needsOwnerInput: Object.freeze([]),
	suspectedInstructions: false,
	contextRefs: Object.freeze([]),
});

export interface CompatibleToolCall {
	readonly name: string;
	readonly arguments: Readonly<Record<string, unknown>>;
}

/** Token counts: prompt_tokens/completion_tokens, or Ollama's prompt_eval_count/eval_count. */
export interface CompatibleUsage {
	readonly input: number;
	readonly output: number;
}

export interface ChatCompletionReply {
	/** COMPATIBLE_MODEL by default. */
	readonly model?: string;
	/** The message text, COMPATIBLE_DRAFT as JSON by default; null sends `content: null`. */
	readonly content?: string | null;
	/** Sent as `message.refusal`. */
	readonly refusal?: string;
	/** `finish_reason`: "stop" by default; "length" truncates and "content_filter" refuses. */
	readonly finishReason?: string | null;
	readonly toolCalls?: readonly CompatibleToolCall[];
	/** The legacy single `function_call`. */
	readonly functionCall?: CompatibleToolCall;
	/** `{input: 12, output: 8}` by default; null leaves out `usage`. */
	readonly usage?: CompatibleUsage | null;
}

export interface OllamaChatReply {
	/** COMPATIBLE_MODEL by default. */
	readonly model?: string;
	/** The message text, COMPATIBLE_DRAFT as JSON by default. */
	readonly content?: string;
	/** `done_reason`: "stop" by default; "length" truncates. */
	readonly doneReason?: string;
	/** true by default. */
	readonly done?: boolean;
	readonly toolCalls?: readonly CompatibleToolCall[];
	/** `{input: 12, output: 8}` by default; null leaves out both counts. */
	readonly usage?: CompatibleUsage | null;
}

const USAGE: CompatibleUsage = { input: 12, output: 8 };
const draftText = (): string => JSON.stringify(COMPATIBLE_DRAFT);

const chatCall = (call: CompatibleToolCall) => ({
	name: call.name,
	arguments: JSON.stringify(call.arguments),
});

/**
 * A completed, non-streamed `/v1/chat/completions` body. It builds wire shapes only and checks
 * nothing, so a reply can be as invalid, oversized or unexpected as a test needs.
 */
export function chatCompletionBody(reply: ChatCompletionReply = {}): Record<string, unknown> {
	const message: Record<string, unknown> = {
		role: "assistant",
		content: reply.content === undefined ? draftText() : reply.content,
	};
	if (reply.refusal !== undefined) message.refusal = reply.refusal;
	if (reply.toolCalls !== undefined)
		message.tool_calls = reply.toolCalls.map((call, index) => ({
			id: `call_dytest_${index + 1}`,
			type: "function",
			function: chatCall(call),
		}));
	if (reply.functionCall !== undefined) message.function_call = chatCall(reply.functionCall);
	const usage = reply.usage === undefined ? USAGE : reply.usage;
	return {
		id: "chatcmpl-dytest",
		object: "chat.completion",
		model: reply.model ?? COMPATIBLE_MODEL,
		choices: [
			{
				index: 0,
				message,
				finish_reason: reply.finishReason === undefined ? "stop" : reply.finishReason,
			},
		],
		...(usage === null
			? {}
			: {
					usage: {
						prompt_tokens: usage.input,
						completion_tokens: usage.output,
						total_tokens: usage.input + usage.output,
					},
				}),
	};
}

/** A completed, non-streamed Ollama `/api/chat` body; like chatCompletionBody, it checks nothing. */
export function ollamaChatBody(reply: OllamaChatReply = {}): Record<string, unknown> {
	const message: Record<string, unknown> = {
		role: "assistant",
		content: reply.content ?? draftText(),
	};
	if (reply.toolCalls !== undefined)
		message.tool_calls = reply.toolCalls.map((call) => ({
			function: { name: call.name, arguments: call.arguments },
		}));
	const usage = reply.usage === undefined ? USAGE : reply.usage;
	return {
		model: reply.model ?? COMPATIBLE_MODEL,
		message,
		done: reply.done ?? true,
		done_reason: reply.doneReason ?? "stop",
		...(usage === null ? {} : { prompt_eval_count: usage.input, eval_count: usage.output }),
	};
}
