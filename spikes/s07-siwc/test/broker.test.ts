import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createBroker } from "../src/broker.ts";
import type { SiwcError } from "../src/errors.ts";
import { buildRequest, runDraft } from "../src/responses.ts";
import { API_BASE } from "../src/verify.ts";
import { startFakeResponses } from "./fake-responses.ts";
import { answer, drafter, failure, type Harness, job, rescript, signedIn } from "./harness.ts";

// The broker stub's own guarantees (§4 broker): what it sends, what it hands back, what it refuses.

const RESPONSES = `${API_BASE}/responses`;
// The headers the SDK sends on a draft request.
const SDK = { authorization: "Bearer brokered", "content-type": "application/json" };

let h: Harness;
beforeAll(async () => {
	h = await signedIn();
});
afterAll(async () => {
	await h.close();
});

describe("the broker stub", () => {
	it.each([301, 302, 303, 307, 308])(
		"never follows a %i: one upstream call, and nothing goes to the new location",
		async (status) => {
			const elsewhere = await startFakeResponses(h.auth.access, answer);
			try {
				const location = `${elsewhere.url}/v1/responses`;
				rescript(h, () => ({ kind: "status", status, headers: { location } }));
				const { broker, client } = drafter(h);
				const error = (await failure(runDraft(client, job("text-format")))) as SiwcError;
				expect([error.code, error.recovery]).toEqual(["BROKER_REFUSED", "never"]);
				expect(h.api.received).toHaveLength(1);
				expect(elsewhere.received).toEqual([]);
				expect(broker.requests.map((request) => request.status)).toEqual([status]);
			} finally {
				await elsewhere.close();
			}
		},
	);

	it("hands back only content-type, request IDs, retry-after and rate-limit headers", async () => {
		const headers = {
			"set-cookie": "session=fake",
			"x-internal-debug": "on",
			"x-request-id": "req_fake1",
			"openai-request-id": "req_fake2",
			"retry-after": "3",
			"x-ratelimit-remaining-requests": "9",
		};
		rescript(h, () => ({ kind: "status", status: 200, body: { ok: true }, headers }));
		let upstream: string[] = [];
		const broker = createBroker({
			token: () => h.session.accessToken(),
			upstream: h.api.url,
			fetch: async (input, init) => {
				const response = await fetch(input, init);
				upstream = [...response.headers.keys()];
				return response;
			},
		});
		const body = JSON.stringify(buildRequest(job("text-format")));
		const response = await broker.fetch(RESPONSES, { method: "POST", headers: SDK, body });
		expect(upstream).toEqual(
			expect.arrayContaining(["set-cookie", "x-internal-debug", "date", "transfer-encoding"]),
		);
		expect([...response.headers.keys()].sort()).toEqual([
			"content-type",
			"openai-request-id",
			"retry-after",
			"x-ratelimit-remaining-requests",
			"x-request-id",
		]);
		expect(await response.json()).toEqual({ ok: true });
	});

	it("sends the body it verified, re-serialized, so a duplicate key can't carry a second value", async () => {
		rescript(h, answer);
		const { broker } = drafter(h);
		const verified = JSON.stringify(buildRequest(job("text-format")));
		const raw = verified.replace('"store":false', '"store":true,"store":false');
		expect(raw).not.toBe(verified);
		const response = await broker.fetch(RESPONSES, { method: "POST", headers: SDK, body: raw });
		await response.body?.cancel();
		expect(broker.requests[0]?.verdict).toEqual({ ok: true });
		expect(h.api.received.map((request) => request.raw)).toEqual([verified]);
	});

	it("reads only JSON text: an object with its own toJSON, bytes or a stream never leave", async () => {
		rescript(h, answer);
		const { broker } = drafter(h);
		const request = buildRequest(job("text-format"));
		const text = JSON.stringify(request);
		class Draft {
			constructor() {
				Object.assign(this, request);
			}
			toJSON() {
				return { ...request, store: true, temperature: 2 };
			}
		}
		const bodies: unknown[] = [
			new Draft(),
			new TextEncoder().encode(text),
			new Blob([text]),
			new Response(text).body,
		];
		for (const body of bodies) {
			const init = { method: "POST", headers: SDK, body: body as BodyInit };
			const response = await broker.fetch(RESPONSES, init);
			expect(response.status).toBe(403);
			await response.body?.cancel();
		}
		expect(broker.requests.map((record) => record.verdict)).toEqual(
			bodies.map(() => ({ ok: false, problems: ["body: must be a JSON object"] })),
		);
		expect(h.api.received).toEqual([]);
	});
});
