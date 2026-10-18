import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SiwcError } from "../src/errors.ts";
import {
	buildRequest,
	createClient,
	parseDraft,
	runDraft,
	STRUCTURES,
	type Structure,
} from "../src/responses.ts";
import { BODY_FIELDS, verifyRequest } from "../src/verify.ts";
import {
	ALLOWED,
	DOCUMENTED_UNSUPPORTED,
	incompleteEvents,
	type Reply,
	refusalEvents,
	type SseEvent,
	textEvents,
	toolEvents,
} from "./fake-responses.ts";
import { failure, type Harness, job, MODEL, SAMPLE_DRAFT, signedIn } from "./harness.ts";

let open: Harness | undefined;
afterEach(async () => {
	delete process.env.OPENAI_CUSTOM_HEADERS;
	await open?.close();
	open = undefined;
});

async function harness(...args: Parameters<typeof signedIn>): Promise<Harness> {
	open = await signedIn(...args);
	return open;
}

// Every body field the pinned SDK can send (ResponseCreateParamsBase in its declarations), plus the
// ones the docs name that it doesn't type yet.
function sdkFields(): string[] {
	const declarations = createRequire(import.meta.url)
		.resolve("openai/resources/responses/responses")
		.replace(/\.js$/, ".d.ts");
	const text = readFileSync(declarations, "utf8");
	const block = /export interface ResponseCreateParamsBase \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
	return [...block.matchAll(/^ {4}([a-z_]+)\??:/gm)].map((match) => match[1] ?? "");
}
const ALL_FIELDS = [...new Set([...sdkFields(), ...DOCUMENTED_UNSUPPORTED])].sort();
const NOT_ALLOWED = ALL_FIELDS.filter((field) => !BODY_FIELDS.includes(field));
const SAMPLE_VALUES: Readonly<Record<string, unknown>> = {
	stream_options: { include_obfuscation: false },
};

// A stream whose completed output holds submit_draft twice.
function twoCalls(): SseEvent[] {
	const events = toolEvents(MODEL, JSON.stringify(SAMPLE_DRAFT), "draftyak");
	const completed = events.at(-1) as SseEvent & { response: { output: object[] } };
	const [call = {}] = completed.response.output;
	const output = [call, { ...call, id: "fc_fake_second" }];
	return [...events.slice(0, -1), { ...completed, response: { ...completed.response, output } }];
}

// A stream whose deltas and completed output disagree.
function finalDiffers(): SseEvent[] {
	const streamed = textEvents(MODEL, JSON.stringify(SAMPLE_DRAFT));
	const other = textEvents(MODEL, JSON.stringify({ ...SAMPLE_DRAFT, body: "Another body." }));
	return [...streamed.slice(0, -1), other.at(-1) as SseEvent];
}

// What the SDK sets on a draft request once the platform headers are off.
const SDK_HEADERS = [
	"accept",
	"authorization",
	"content-type",
	"user-agent",
	"x-stainless-retry-count",
];

describe("allowlist-built requests (plan §4 SIWC verifier)", () => {
	it("knows the SDK's request fields", () => {
		expect(ALL_FIELDS.length).toBeGreaterThan(30);
		expect(ALL_FIELDS).toEqual(expect.arrayContaining([...BODY_FIELDS]));
		expect(ALLOWED).toEqual(BODY_FIELDS);
	});

	it.each(STRUCTURES)(
		"%s: only allowlisted fields, with store false and stream true",
		(structure) => {
			const request = buildRequest(job(structure, { effort: "medium" }));
			expect(Object.keys(request).every((key) => BODY_FIELDS.includes(key))).toBe(true);
			expect([request.store, request.stream]).toEqual([false, true]);
			const headers = new Headers({
				authorization: "Bearer brokered",
				"content-type": "application/json",
			});
			const url = "https://api.openai.com/v1/responses";
			expect(verifyRequest({ method: "POST", url, headers, body: request })).toEqual({ ok: true });
		},
	);

	it("puts submit_draft where each structure asks, never alongside a json_schema", () => {
		const shapes = Object.fromEntries(
			STRUCTURES.map((structure) => {
				const request = buildRequest(job(structure));
				return [structure, [request.tools, request.tool_choice, request.text]];
			}),
		);
		expect(shapes["text-format"]?.[0]).toBeUndefined();
		const namespaced = shapes["tool-namespace"]?.[0] as { type: string }[] | undefined;
		expect(namespaced?.[0]?.type).toBe("namespace");
		expect(shapes["tool-item"]?.[0]).toBeUndefined();
		expect(buildRequest(job("tool-item")).input).toEqual([
			expect.objectContaining({ type: "additional_tools", role: "developer" }),
			expect.objectContaining({ type: "message", role: "user" }),
		]);
		expect(shapes["tool-top-level"]?.[1]).toEqual({ type: "function", name: "submit_draft" });
		for (const structure of STRUCTURES.slice(1)) expect(shapes[structure]?.[2]).toBeUndefined();
		expect(() => buildRequest(job("text-format", { effort: "extreme" }))).toThrow(/effort/);
	});
});

describe("the fake Responses endpoint", () => {
	// One sign-in for every field: these requests change nothing.
	let shared: Harness;
	beforeAll(async () => {
		shared = await signedIn();
	});
	afterAll(async () => {
		await shared.close();
	});

	it.each(NOT_ALLOWED)("refuses %s, and the broker never lets it leave", async (field) => {
		const { api, credential } = shared;
		const body = { ...buildRequest(job("text-format")), [field]: SAMPLE_VALUES[field] ?? true };
		const response = await fetch(`${api.url}/v1/responses`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${credential.tokens?.accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});
		const error = ((await response.json()) as { error: { code: string; param: string } }).error;
		expect([response.status, error.code, error.param]).toEqual([
			400,
			"subscription_sharing_unsupported_capability",
			field,
		]);
		const headers = new Headers({
			authorization: "Bearer brokered",
			"content-type": "application/json",
		});
		const verdict = verifyRequest({
			method: "POST",
			url: "https://api.openai.com/v1/responses",
			headers,
			body,
		});
		expect(verdict).toEqual({ ok: false, problems: [`body.${field}: not allowed`] });
	});

	it("refuses system messages, store true, stream false and unsupported hosted tools", async () => {
		const { api, credential } = shared;
		const base = buildRequest(job("text-format"));
		const bodies: [Record<string, unknown>, string][] = [
			[{ ...base, input: [{ type: "message", role: "system", content: "x" }] }, "input[0].role"],
			[{ ...base, store: true }, "store"],
			[{ ...base, stream: false }, "stream"],
			[{ ...base, tools: [{ type: "image_generation" }] }, "tools[0].type"],
			[{ ...base, model: "gpt-unknown" }, "model"],
		];
		for (const [body, param] of bodies) {
			const response = await fetch(`${api.url}/v1/responses`, {
				method: "POST",
				headers: { authorization: `Bearer ${credential.tokens?.accessToken}` },
				body: JSON.stringify(body),
			});
			expect(((await response.json()) as { error: { param: string } }).error.param).toBe(param);
		}
	});
});

describe("drafting through the SDK, ctx.fetch and host frames", () => {
	it.each(["text-format", "tool-namespace", "tool-item"] as const)(
		"%s drafts, sending only allowlisted fields and headers, once",
		async (structure) => {
			const { api, broker, client, credential } = await harness();
			const outcome = await runDraft(client, job(structure));
			expect(outcome).toEqual({
				kind: "draft",
				draft: SAMPLE_DRAFT,
				via: structure === "text-format" ? "text" : "tool",
			});
			expect(api.received).toHaveLength(1);
			const [sent] = api.received;
			expect(Object.keys(sent?.body ?? {}).every((key) => ALLOWED.includes(key))).toBe(true);
			expect([sent?.body.store, sent?.body.stream]).toEqual([false, true]);
			expect(broker.requests[0]?.headerNames).toEqual(SDK_HEADERS);
			expect(sent?.headers.get("authorization")).toBe(`Bearer ${credential.tokens?.accessToken}`);
			expect(broker.requests.map((request) => request.verdict)).toEqual([{ ok: true }]);
		},
	);

	it("top-level submit_draft: refused under the docs' strict reading, drafts if the route takes it", async () => {
		const { api, client } = await harness();
		const error = (await failure(runDraft(client, job("tool-top-level")))) as SiwcError;
		expect([error.code, error.facts.param]).toEqual(["UNSUPPORTED_CAPABILITY", "tools[0]"]);
		api.topLevelFunctions = "accept";
		const outcome = await runDraft(client, job("tool-top-level"));
		expect(outcome).toMatchObject({ kind: "draft", via: "tool" });
	});

	it("never executes submit_draft: no tool output goes back and no second request follows", async () => {
		const { api, client } = await harness();
		await runDraft(client, job("tool-namespace"));
		const items = api.received.flatMap((request) => request.body.input as { type?: string }[]);
		expect(items.map((item) => item.type)).toEqual(["message"]);
		expect(api.received).toHaveLength(1);
	});

	it("reports refusals, incomplete responses, unexpected tool calls and bad drafts without a draft", async () => {
		const replies: [Structure, Reply, unknown][] = [
			["text-format", { kind: "events", events: refusalEvents(MODEL) }, { kind: "refusal" }],
			[
				"text-format",
				{ kind: "events", events: incompleteEvents(MODEL, "content_filter") },
				{ kind: "incomplete", reason: "content_filter" },
			],
			[
				"tool-namespace",
				{ kind: "events", events: toolEvents(MODEL, "{}", "draftyak", "send_email") },
				{ kind: "invalid", problems: ["output: unexpected tool call"] },
			],
			[
				"text-format",
				{
					kind: "events",
					events: textEvents(MODEL, JSON.stringify({ ...SAMPLE_DRAFT, body: "x".repeat(8_001) })),
				},
				{ kind: "invalid", problems: ["body: missing or over 8000 characters"] },
			],
			[
				"tool-namespace",
				{ kind: "events", events: twoCalls() },
				{ kind: "invalid", problems: ["output: unexpected tool call"] },
			],
			[
				"text-format",
				{ kind: "events", events: finalDiffers() },
				{ kind: "invalid", problems: ["output: stream and final output differ"] },
			],
		];
		for (const [structure, reply, expected] of replies) {
			const { client } = await harness({ script: () => reply });
			expect(await runDraft(client, job(structure))).toEqual(expected);
			await open?.close();
			open = undefined;
		}
	});

	it("gives an abort its own outcome, before or during the stream, never a retryable failure", async () => {
		const { api, client } = await harness();
		const before = new AbortController();
		before.abort();
		const options = { signal: before.signal };
		expect(await runDraft(client, job("text-format"), options)).toEqual({ kind: "aborted" });
		expect(api.received).toEqual([]);
		const during = new AbortController();
		const outcome = await runDraft(client, job("text-format"), {
			signal: during.signal,
			onEvent: (event) => {
				if (event.type === "response.output_text.delta") during.abort();
			},
		});
		expect(outcome).toEqual({ kind: "aborted" });
		expect(api.received).toHaveLength(1);
	});

	it("throws a caller's invalid job as it is, before anything is sent", async () => {
		const { api, client } = await harness();
		const error = await failure(runDraft(client, job("text-format", { effort: "extreme" })));
		expect(error).toBeInstanceOf(RangeError);
		expect(api.received).toEqual([]);
	});

	it("refuses what OPENAI_CUSTOM_HEADERS adds, in the broker, before anything leaves", async () => {
		const { api, broker } = await harness();
		process.env.OPENAI_CUSTOM_HEADERS = "x-tracking: on";
		const error = (await failure(
			runDraft(createClient(broker.fetch), job("text-format")),
		)) as SiwcError;
		expect(error.code).toBe("BROKER_REFUSED");
		expect(broker.requests[0]?.verdict).toEqual({
			ok: false,
			problems: ["header (unknown): not allowed"],
		});
		expect(api.received).toEqual([]);
	});

	// Models and inference, step 1: the picker's GET passes the broker with no body.
	it("lets the account's model list through, as {models: [{slug, display_name, visibility}]}", async () => {
		const { broker, client } = await harness();
		const body = await client.get<{ models: { slug: string; visibility: string }[] }>("/models");
		expect(
			body.models.filter((model) => model.visibility === "list").map((model) => model.slug),
		).toEqual(["gpt-fake-plan"]);
		expect(broker.requests.map((request) => [request.method, request.verdict])).toEqual([
			["GET", { ok: true }],
		]);
	});

	it("refreshes an expired access token before the request leaves", async () => {
		const { api, auth, client, store } = await harness();
		const current = await store.read();
		if (!current?.tokens) throw new Error("signed out");
		await store.write({ ...current, tokens: { ...current.tokens, expiresAt: Date.now() - 1 } });
		expect(await runDraft(client, job("text-format"))).toMatchObject({ kind: "draft" });
		const after = await store.read();
		expect(api.received[0]?.headers.get("authorization")).toBe(
			`Bearer ${after?.tokens?.accessToken}`,
		);
		expect(auth.tokenForms.map((form) => form.get("grant_type"))).toEqual([
			"authorization_code",
			"refresh_token",
		]);
	});
});

describe("parseDraft", () => {
	it("keeps contextRefs from the job's set, ignoring case, and names fields only", () => {
		const parsed = parseDraft(
			JSON.stringify({ ...SAMPLE_DRAFT, contextRefs: ["C2", "c9", 3, "c2"] }),
		);
		expect(parsed).toEqual({ ok: true, draft: { ...SAMPLE_DRAFT, contextRefs: ["c2"] } });
		const bad = parseDraft(
			JSON.stringify({ ...SAMPLE_DRAFT, secret: "content", needsOwnerInput: ["x".repeat(301)] }),
		);
		expect(bad).toEqual({
			ok: false,
			problems: ["output: extra field", "needsOwnerInput: at most 5 strings of 300 characters"],
		});
		expect(parseDraft("not json")).toEqual({ ok: false, problems: ["output: not JSON"] });
	});
});
