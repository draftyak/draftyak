import { randomBytes } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import {
	type CtxFetchStub,
	createClient,
	createCtxFetchStub,
	type RecordedRequest,
} from "../src/client.ts";
import { type Pin, verifyRequest } from "../src/verify.ts";
import { type FakeMessagesApi, type Script, startFake } from "./fake-messages-api.ts";

// A key-shaped value, built at run time so no key shape is ever committed.
export const fakeKey = (): string =>
	["sk", "ant", "api03", randomBytes(30).toString("base64url")].join("-");

export interface Harness {
	readonly key: string;
	readonly fake: FakeMessagesApi;
	readonly stub: CtxFetchStub;
	readonly client: Anthropic;
	close(): Promise<void>;
}

// Test-only: forwards what the SDK builds without stopping it, so a test can show the API's own
// answer to a request the verifier refuses. The verdict is still recorded.
function passThrough(upstream: string, key: string): CtxFetchStub {
	const requests: RecordedRequest[] = [];
	const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input instanceof Request ? input.url : input);
		const method = init.method ?? "GET";
		const headers = new Headers(init.headers);
		const body: unknown = typeof init.body === "string" ? JSON.parse(init.body) : undefined;
		const verdict = verifyRequest({ method, url, headers, body });
		requests.push({ method, url, headers: Object.fromEntries(headers), body, verdict });
		headers.set("x-api-key", key);
		const { pathname, search } = new URL(url);
		return globalThis.fetch(new URL(`${pathname}${search}`, upstream), {
			method,
			headers,
			body: init.body ?? null,
			signal: init.signal ?? null,
		});
	};
	return { fetch, requests };
}

// The fake demands the injected key, so every successful call shows the broker's key reaching the
// API while the SDK only ever held the placeholder.
export async function harness(
	options: {
		readonly script?: Script;
		readonly passThrough?: boolean;
		readonly pin?: Pin;
		readonly maxRetries?: number;
	} = {},
): Promise<Harness> {
	const key = fakeKey();
	const fake = await startFake({ key, ...(options.script ? { script: options.script } : {}) });
	const stub = options.passThrough
		? passThrough(fake.url, key)
		: createCtxFetchStub({
				upstream: fake.url,
				key: { reveal: () => key },
				...(options.pin ? { pin: options.pin } : {}),
			});
	const client = createClient(
		stub,
		options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries },
	);
	return { key, fake, stub, client, close: () => fake.close() };
}

// The value a rejected promise settled with, so a test can check it.
export async function failure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to fail");
}
