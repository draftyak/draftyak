import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, liveStub } from "../src/client.ts";
import { draft } from "../src/draft.ts";
import { API_ORIGIN, FALLBACK_BETA, KEY_PLACEHOLDER, PLATFORM_HEADERS } from "../src/verify.ts";
import { type FakeMessagesApi, replies, startFake } from "./fake-messages-api.ts";
import { failure, fakeKey, type Harness, harness } from "./harness.ts";

const input = { system: "Draft a reply.", prompt: "<thread>Can we meet Tuesday?</thread>" };

let open: Harness | undefined;
let other: FakeMessagesApi | undefined;
const start = async (options?: Parameters<typeof harness>[0]): Promise<Harness> => {
	open = await harness(options);
	return open;
};

afterEach(async () => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	await open?.close();
	await other?.close();
	open = undefined;
	other = undefined;
});

describe("ctx.fetch stub", () => {
	it("keeps the key out of the SDK and the recording, and adds it only on the way out", async () => {
		const { key, fake, stub, client } = await start();
		expect((await draft(client, input)).kind).toBe("draft");
		expect(client.apiKey).toBe(KEY_PLACEHOLDER);
		expect(stub.requests[0]?.headers["x-api-key"]).toBe(KEY_PLACEHOLDER);
		expect(fake.received[0]?.headers.get("x-api-key")).toBe(key);
		expect(JSON.stringify(stub.requests)).not.toContain(key);
	});

	it("sends the body it verified, so a duplicate key can't smuggle a second value", async () => {
		const { fake, stub } = await start();
		const messages = '"messages":[{"role":"user","content":"hi"}]';
		const response = await stub.fetch(`${API_ORIGIN}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"anthropic-version": "2023-06-01",
				"x-api-key": KEY_PLACEHOLDER,
			},
			body: `{"model":"claude-opus-5-5","max_tokens":128000,"max_tokens":16000,${messages}}`,
		});
		expect(response.status).toBe(200);
		expect(stub.requests[0]?.verdict).toEqual({ ok: true });
		expect(fake.received[0]?.raw).toBe(
			`{"model":"claude-opus-5-5","max_tokens":16000,${messages}}`,
		);
	});

	it("sends only the allowlisted headers the SDK builds", async () => {
		const { fake, stub, client } = await start();
		await draft(client, input);
		const sent = stub.requests[0]?.headers ?? {};
		expect(Object.keys(sent).sort()).toEqual([
			"accept",
			"anthropic-beta",
			"anthropic-version",
			"content-type",
			"user-agent",
			"x-api-key",
			"x-stainless-retry-count",
			"x-stainless-timeout",
		]);
		expect(sent).toMatchObject({
			"anthropic-beta": FALLBACK_BETA,
			"anthropic-version": "2023-06-01",
			"user-agent": "Anthropic/JS 0.135.0",
			"x-stainless-timeout": "600",
		});
		expect(stub.requests[0]?.url).toBe(`${API_ORIGIN}/v1/messages?beta=true`);
		expect(fake.received[0]?.search).toBe("?beta=true");
	});

	it("refuses a default SDK client, whose platform headers the plugin must drop", async () => {
		const { fake, stub } = await start();
		const plain = new Anthropic({ fetch: stub.fetch, apiKey: KEY_PLACEHOLDER });
		const error = await failure(draft(plain, input));
		expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
		const verdict = stub.requests[0]?.verdict;
		expect(verdict?.ok).toBe(false);
		for (const name of PLATFORM_HEADERS) {
			expect(verdict?.ok === false && verdict.problems).toContain(`header ${name}: not allowed`);
		}
		expect(fake.received).toHaveLength(0);
	});

	it("answers a refusal with a 403 the SDK doesn't retry, and nothing leaves", async () => {
		const { fake, stub, client } = await start({ maxRetries: 2 });
		const error = await failure(
			client.beta.messages.create({
				model: "claude-opus-5-5",
				max_tokens: 1_000,
				messages: [{ role: "user", content: "hi" }],
				temperature: 0.2,
			}),
		);
		expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
		expect((error as InstanceType<typeof Anthropic.APIError>).type).toBe("broker_refused");
		expect(stub.requests).toHaveLength(1);
		expect(fake.received).toHaveLength(0);
	});

	it.each([301, 302, 303, 307, 308])(
		"never follows a %i, so the key and the prompt stay with the upstream",
		async (status) => {
			other = await startFake();
			const location = `${other.url}/v1/messages`;
			const { fake, stub, client } = await start({
				maxRetries: 2,
				script: () => ({ status, body: {}, headers: { location } }),
			});
			const error = await failure(draft(client, input));
			expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
			expect(String(error)).toContain(`upstream ${status}: redirects are not followed`);
			expect(fake.received).toHaveLength(1);
			expect(other.received).toHaveLength(0);
			expect(stub.requests[0]?.response?.status).toBe(status);
			expect(stub.requests[0]?.response?.headerNames).toContain("location");
			expect(stub.requests[0]?.response?.kept).not.toHaveProperty("location");
		},
	);

	it("verifies every retry, and records response headers by name with only the allowed values", async () => {
		let calls = 0;
		const { stub, client } = await start({
			script: (request) =>
				calls++ === 0 ? replies.rateLimited() : replies.draft(String(request.body.model)),
		});
		expect((await draft(client, input)).kind).toBe("draft");
		expect(stub.requests.map((request) => request.headers["x-stainless-retry-count"])).toEqual([
			"0",
			"1",
		]);
		expect(stub.requests.every((request) => request.verdict.ok)).toBe(true);
		const limited = stub.requests[0]?.response;
		expect(limited?.status).toBe(429);
		expect(limited?.headerNames).toEqual(expect.arrayContaining(["request-id", "retry-after-ms"]));
		expect(limited?.kept).toEqual({
			"anthropic-ratelimit-requests-remaining": "0",
			"content-type": "application/json",
		});
	});

	it("refuses another model or effort when pinned to the instance's", async () => {
		const pin = { model: "claude-opus-5-5", effort: "medium" };
		const { fake, stub, client } = await start({ pin });
		expect((await draft(client, input)).kind).toBe("draft");
		const error = await failure(draft(client, { ...input, model: "claude-fable-5-1" }));
		expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
		expect(stub.requests[1]?.verdict).toEqual({
			ok: false,
			problems: ["model: not the instance's model"],
		});
		expect(fake.received).toHaveLength(1);
	});

	it("ignores ANTHROPIC_* variables that would move requests, add a token or log, and never traces", async () => {
		const { fake, stub } = await start();
		const token = fakeKey();
		vi.stubEnv("ANTHROPIC_BASE_URL", "http://127.0.0.1:9/");
		vi.stubEnv("ANTHROPIC_AUTH_TOKEN", token);
		vi.stubEnv("ANTHROPIC_API_KEY", token);
		vi.stubEnv("ANTHROPIC_LOG", "debug");
		const logs = (["log", "debug", "info", "warn", "error"] as const).map((level) =>
			vi.spyOn(console, level),
		);
		const client = createClient(stub);
		expect(client.logLevel).toBe("off");
		expect(client.openTelemetry.traces.enabled).toBe(false);
		expect((await draft(client, input)).kind).toBe("draft");
		for (const log of logs) expect(log).not.toHaveBeenCalled();
		expect(stub.requests[0]?.url).toBe(`${API_ORIGIN}/v1/messages?beta=true`);
		expect(stub.requests[0]?.verdict).toEqual({ ok: true });
		expect(fake.received[0]?.headers.has("authorization")).toBe(false);
		expect(JSON.stringify(stub.requests)).not.toContain(token);
	});

	it("refuses headers from ANTHROPIC_CUSTOM_HEADERS, which no client option can drop", async () => {
		const { fake, stub } = await start();
		vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "x-draft-note: from-env");
		const error = await failure(draft(createClient(stub), input));
		expect(error).toBeInstanceOf(Anthropic.PermissionDeniedError);
		expect(stub.requests[0]?.verdict).toEqual({
			ok: false,
			problems: ["header (unknown): not allowed"],
		});
		expect(fake.received).toHaveLength(0);
	});

	it("starts with no ANTHROPIC_* variable from the developer's shell", () => {
		expect(Object.keys(process.env).filter((name) => /^anthropic_/i.test(name))).toEqual([]);
	});

	it("can't read .env.live in the unit tier", async () => {
		await expect(liveStub()).rejects.toThrow(/not set in .*DY_LIVE_MESSAGES_API_KEY/s);
	});
});
