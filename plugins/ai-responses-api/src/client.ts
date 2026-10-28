import type { DraftRequest } from "@draftyak/protocol/ai-provider-v1";
import OpenAI, { APIConnectionError } from "openai";
import { buildRequest, type Settings } from "./request.ts";
import { normalizeError, ResponsesError } from "./shared.ts";

export type ResponsesFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface ResponsesSdkClient {
	readonly send: (
		input: DraftRequest,
		settings?: Settings,
		signal?: AbortSignal,
	) => Promise<Response>;
}

const quietLogger = Object.freeze({ debug() {}, info() {}, warn() {}, error() {} });

class RawHttpResponse extends Error {
	readonly response: Response;
	constructor(response: Response) {
		super("Unconsumed HTTP response");
		this.response = response;
	}
}

class FetchFailure extends Error {
	readonly error: ResponsesError;
	constructor(error: unknown) {
		super("Normalized injected-fetch failure");
		this.error = normalizeError(error);
	}
}

function rawResponse(error: unknown): Response | undefined {
	return error instanceof APIConnectionError && error.cause instanceof RawHttpResponse
		? error.cause.response
		: undefined;
}

function cancelBody(response: Response | undefined): void {
	try {
		void Promise.resolve(response?.body?.cancel()).catch(() => undefined);
	} catch {
		// Cleanup cannot delay or replace the caller's cancellation result.
	}
}

function makeSdk(fetch: ResponsesFetch, capture: (response: Response | undefined) => void): OpenAI {
	if (Reflect.has(process.env, "OPENAI_CUSTOM_HEADERS")) throw new ResponsesError("INVALID_INPUT");
	// This pinned SDK otherwise reads custom-header environment values even with explicit defaults.
	return new OpenAI({
		fetch: async (url, init) => {
			let response: Response;
			try {
				response = await fetch(url, init);
			} catch (error) {
				throw new FetchFailure(error);
			}
			capture(response);
			if (init?.signal?.aborted) {
				capture(undefined);
				cancelBody(response);
				throw new ResponsesError("TRANSIENT");
			}
			// The SDK parses non-2xx bodies before .asResponse(); intercept without reading them.
			if (!response.ok) throw new RawHttpResponse(response);
			return response;
		},
		apiKey: "brokered",
		adminAPIKey: null,
		organization: null,
		project: null,
		webhookSecret: null,
		baseURL: "https://api.openai.com/v1",
		defaultQuery: {},
		fetchOptions: { redirect: "manual" },
		maxRetries: 0,
		logLevel: "off",
		logger: quietLogger,
		defaultHeaders: {
			"user-agent": null,
			"x-stainless-lang": null,
			"x-stainless-package-version": null,
			"x-stainless-os": null,
			"x-stainless-arch": null,
			"x-stainless-runtime": null,
			"x-stainless-runtime-version": null,
			"x-stainless-retry-count": null,
			"x-stainless-timeout": null,
			"x-stainless-helper-method": null,
		},
	});
}

/** Returns the original unread HTTP response, including non-2xx, for the bounded native consumer. */
export function createClient(fetch: ResponsesFetch): ResponsesSdkClient {
	if (typeof fetch !== "function" || Reflect.has(process.env, "OPENAI_CUSTOM_HEADERS"))
		throw new ResponsesError("INVALID_INPUT");
	return Object.freeze({
		async send(
			input: DraftRequest,
			settings: Settings = {},
			signal?: AbortSignal,
		): Promise<Response> {
			if (signal?.aborted) throw new ResponsesError("ABORTED");
			const { body } = buildRequest(input, settings);
			let ownedResponse: Response | undefined;
			const client = makeSdk(fetch, (received) => {
				ownedResponse = received;
			});
			let response: Response;
			try {
				response = await client.responses
					.create({ ...body, input: body.input.map((item) => ({ ...item })) }, { signal })
					.asResponse();
			} catch (error) {
				if (signal?.aborted) {
					cancelBody(ownedResponse);
					throw new ResponsesError("ABORTED");
				}
				const raw = rawResponse(error);
				if (!raw) {
					cancelBody(ownedResponse);
					if (error instanceof APIConnectionError && error.cause instanceof FetchFailure)
						throw error.cause.error;
					throw normalizeError(error);
				}
				response = raw;
			}
			if (signal?.aborted) {
				cancelBody(ownedResponse);
				throw new ResponsesError("ABORTED");
			}
			ownedResponse = undefined;
			return response;
		},
	});
}
