import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import { z } from "zod";
import { draftFormat } from "./format.ts";
import {
	API_URL,
	buildRequest,
	type DraftInput,
	type Effort,
	type RequestBody,
	type Settings,
} from "./request.ts";
import { MessagesError } from "./shared.ts";

export const PLATFORM_HEADERS = [
	"x-stainless-lang",
	"x-stainless-package-version",
	"x-stainless-os",
	"x-stainless-arch",
	"x-stainless-runtime",
	"x-stainless-runtime-version",
] as const;

export type MessagesFetch = NonNullable<ClientOptions["fetch"]>;

export function createClient(
	fetch: MessagesFetch,
	options: { readonly maxRetries?: number } = {},
): Anthropic {
	const maxRetries = options.maxRetries ?? 2;
	if (
		typeof fetch !== "function" ||
		!Number.isSafeInteger(maxRetries) ||
		maxRetries < 0 ||
		maxRetries > 99
	)
		throw new MessagesError("INVALID_INPUT");
	// This explicit plugin initialization leaves imports of the broker verifier side-effect free.
	z.config({ jitless: true });
	return new Anthropic({
		apiKey: "brokered",
		authToken: null,
		webhookKey: null,
		baseURL: new URL(API_URL).origin,
		fetch,
		defaultHeaders: Object.fromEntries(PLATFORM_HEADERS.map((name) => [name, null])),
		openTelemetry: { traces: false, propagation: false },
		logLevel: "off",
		timeout: 600_000,
		maxRetries,
	});
}

export type DraftParams = Omit<RequestBody, "messages" | "output_config" | "stream"> & {
	readonly messages: { role: "user"; content: string }[];
	readonly output_config: { readonly effort: Effort; readonly format: typeof draftFormat };
};
export interface DraftCall {
	readonly params: DraftParams;
	readonly headers: { readonly "anthropic-beta": string | null };
}

// These params support parse, create and stream without choosing the production call mode.
export function draftCall(input: DraftInput, settings: Settings = {}): DraftCall {
	const request = buildRequest(input, settings);
	return {
		params: {
			...request.body,
			messages: request.body.messages.map((message) => ({ ...message })),
			output_config: { effort: request.body.output_config.effort, format: draftFormat },
		},
		// beta.messages.parse otherwise adds its structured-output beta, even for the GA format.
		headers: { "anthropic-beta": request.headers["anthropic-beta"] ?? null },
	};
}
