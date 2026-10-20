import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createHelloFake,
	createRecorder,
	HELLO_HOST,
	type HelloMessage,
	type HelloPage,
	manualClock,
} from "../src/index.ts";
import { getWithHost, json, sha256 } from "./helpers.ts";

const START = Date.UTC(2026, 9, 19, 9);
const MESSAGES = "/v1/conversations/conv-1/messages";

const post = (body: string, headers: Record<string, string> = {}): RequestInit => ({
	method: "POST",
	headers: { "Content-Type": "application/json", ...headers },
	body,
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("hello fake", () => {
	it("lives under the reserved hello.draftyak.example and calls nothing outside", async () => {
		expect(HELLO_HOST).toBe("hello.draftyak.example");
		const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no egress"));
		const hello = createHelloFake();
		expect(await json(hello.fetch("/v1/me"))).toEqual({ id: "me" });
		expect(await json(hello.fetch("https://hello.draftyak.example/v1/conversations"))).toEqual({
			conversations: [
				{ id: "conv-1", name: "DYTEST general" },
				{ id: "conv-2", name: "DYTEST planning" },
			],
		});
		expect((await hello.fetch("https://hello.draftyak.com/v1/conversations")).status).toBe(421);
		expect(outbound).not.toHaveBeenCalled();
	});

	it("pages with cursors, and a held cursor later returns only what arrived since", async () => {
		const hello = createHelloFake();
		const first = await json<HelloPage>(hello.fetch(`${MESSAGES}?limit=2`));
		expect(first.messages.map((message) => message.text)).toEqual([
			"DYTEST hello",
			"DYTEST hi, how is the plan going?",
		]);
		expect(first.more).toBe(true);
		const second = await json<HelloPage>(hello.fetch(`${MESSAGES}?limit=2&cursor=${first.cursor}`));
		expect(second.messages.map((message) => message.text)).toEqual(["DYTEST almost done"]);
		expect(second.more).toBe(false);
		const quiet = await json<HelloPage>(hello.fetch(`${MESSAGES}?cursor=${second.cursor}`));
		expect(quiet).toMatchObject({ messages: [], more: false });
		const arrived = hello.addMessage("conv-1", { author: "user-2", text: "DYTEST news" });
		const delta = await json<HelloPage>(hello.fetch(`${MESSAGES}?cursor=${second.cursor}`));
		expect(delta.messages).toEqual([arrived]);
		expect(arrived).toMatchObject({ id: "msg_000005", conversationId: "conv-1" });
	});

	it("starts from the first page for an empty cursor, and pages up to 200", async () => {
		const hello = createHelloFake();
		const empty = await json<HelloPage>(hello.fetch(`${MESSAGES}?limit=200&cursor=`));
		expect(empty.messages.map((message) => message.id)).toEqual([
			"msg_000001",
			"msg_000002",
			"msg_000003",
		]);
		expect(empty.more).toBe(false);
	});

	it("rejects an expired cursor with 410 and a foreign or unknown one with 400", async () => {
		const clock = manualClock(START);
		const hello = createHelloFake({ clock, cursorTtlMs: 60_000 });
		const { cursor } = await json<HelloPage>(hello.fetch(`${MESSAGES}?limit=1`));
		clock.advance(59_999);
		expect((await hello.fetch(`${MESSAGES}?cursor=${cursor}`)).status).toBe(200);
		clock.advance(1);
		const expired = await hello.fetch(`${MESSAGES}?cursor=${cursor}`);
		expect(expired.status).toBe(410);
		expect(await expired.json()).toEqual({ error: "cursor_expired" });
		const { cursor: fresh } = await json<HelloPage>(hello.fetch(MESSAGES));
		const foreign = await hello.fetch(`/v1/conversations/conv-2/messages?cursor=${fresh}`);
		expect([foreign.status, await foreign.json()]).toEqual([400, { error: "invalid_cursor" }]);
		expect((await hello.fetch(`${MESSAGES}?cursor=cur_999999`)).status).toBe(400);
		for (const limit of ["0", "201", "two", ""]) {
			expect((await hello.fetch(`${MESSAGES}?limit=${limit}`)).status, limit).toBe(400);
		}
		expect((await hello.fetch("/v1/conversations/conv-9/messages")).status).toBe(404);
		for (const cursorTtlMs of [-1, Number.NaN]) {
			expect(() => createHelloFake({ cursorTtlMs }), String(cursorTtlMs)).toThrow(RangeError);
		}
	});

	it("sends: the exact body is recorded, provider ids come back, the message is stored", async () => {
		const clock = manualClock(START);
		const recorder = createRecorder({ headerValues: ["content-type"] });
		const hello = createHelloFake({ clock, recorder });
		const body = JSON.stringify({ text: "DYTEST reply, café ☕" });
		const response = await hello.fetch("/v1/conversations/conv-2/messages", post(body));
		expect(response.status).toBe(201);
		const sent = await response.json();
		expect(sent).toEqual({ id: "msg_000005", conversationId: "conv-2", createdAt: START });
		const [recorded] = recorder.takeRequests();
		expect(recorded).toMatchObject({
			method: "POST",
			path: "/v1/conversations/conv-2/messages",
			bodySha256: sha256(body),
			headers: { "content-type": "application/json" },
		});
		expect(hello.messages("conv-2").at(-1)).toEqual<HelloMessage>({
			...sent,
			author: "me",
			text: "DYTEST reply, café ☕",
		});
	});

	it("answers a repeated idempotency key with the first result and refuses its reuse", async () => {
		const hello = createHelloFake();
		const body = JSON.stringify({ text: "DYTEST once" });
		const url = "/v1/conversations/conv-1/messages?idempotency_key=out-1";
		const first = await hello.fetch(url, post(body));
		const firstResult = await first.json();
		const again = await hello.fetch(url, post(body));
		expect([again.status, await again.json()]).toEqual([201, firstResult]);
		expect(again.headers.get("idempotent-replayed")).toBe("true");
		const byHeader = await hello.fetch(MESSAGES, post(body, { "Idempotency-Key": "out-1" }));
		expect(await byHeader.json()).toEqual(firstResult);
		expect(
			hello.messages("conv-1").filter((message) => message.text === "DYTEST once"),
		).toHaveLength(1);

		const changed = await hello.fetch(url, post(JSON.stringify({ text: "DYTEST twice" })));
		expect([changed.status, await changed.json()]).toEqual([
			409,
			{ error: "idempotency_key_reused" },
		]);
		const elsewhere = "/v1/conversations/conv-2/messages?idempotency_key=out-1";
		expect((await hello.fetch(elsewhere, post(body))).status).toBe(409);
		const disagree = await hello.fetch(url, post(body, { "Idempotency-Key": "out-2" }));
		expect([disagree.status, await disagree.json()]).toEqual([
			400,
			{ error: "idempotency_key_mismatch" },
		]);

		await hello.fetch(MESSAGES, post(body));
		await hello.fetch(MESSAGES, post(body));
		expect(
			hello.messages("conv-1").filter((message) => message.text === "DYTEST once"),
		).toHaveLength(3);
	});

	it("refuses malformed sends", async () => {
		const hello = createHelloFake();
		const refusal = async (path: string, init: RequestInit) => {
			const response = await hello.fetch(path, init);
			return [response.status, ((await response.json()) as { error: string }).error];
		};
		const text = JSON.stringify({ text: "DYTEST" });
		expect(await refusal(MESSAGES, { method: "POST", body: text })).toEqual([
			415,
			"unsupported_media_type",
		]);
		const bodies: (string | Uint8Array<ArrayBuffer>)[] = [
			"{",
			"[]",
			'{"text":""}',
			'{"text":1}',
			JSON.stringify({ text: "DYTEST", to: "user-9" }),
			JSON.stringify({ text: "x".repeat(4_001) }),
			JSON.stringify({ text: "😀".repeat(4_001) }),
			new Uint8Array([0x7b, 0x22, 0x74, 0x65, 0x78, 0x74, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]),
			// A duplicate key, a lone surrogate, a byte order mark, anything around the object.
			'{"text":"DYTEST a","text":"DYTEST b"}',
			'{"text":"\\ud800"}',
			`﻿${text}`,
			` ${text}`,
			`${text}\n`,
			'{"t\\u0065xt":"DYTEST"}',
		];
		for (const body of bodies) {
			const init = { ...post(""), body };
			expect(await refusal(MESSAGES, init), String(body)).toEqual([400, "invalid_body"]);
		}
		expect(await refusal("/v1/conversations/conv-9/messages", post(text))).toEqual([
			404,
			"unknown_conversation",
		]);
		expect(await refusal("/v1/nothing", {})).toEqual([404, "not_found"]);
		expect(hello.messages("conv-1")).toHaveLength(3);
	});

	it("counts the text's limit in code points, as Python and Rust do", async () => {
		const hello = createHelloFake();
		const texts = ["x".repeat(4_000), "😀".repeat(4_000), "é", ' {"text": "DYTEST"} '];
		for (const text of texts) {
			const response = await hello.fetch(MESSAGES, post(JSON.stringify({ text })));
			expect(response.status, text.slice(0, 10)).toBe(201);
		}
		const spaced = await hello.fetch(MESSAGES, post('{ "text" : "DYTEST spaced" }'));
		expect(spaced.status).toBe(201);
		expect(hello.messages("conv-1").map((message) => message.text.length)).toEqual([
			12, 33, 18, 4_000, 8_000, 1, 20, 13,
		]);
	});

	it("serves the same over loopback, by its name", async () => {
		const hello = createHelloFake();
		const listening = await hello.listen();
		try {
			const answer = await getWithHost(listening, `${MESSAGES}?limit=1`, HELLO_HOST);
			expect(answer.status).toBe(200);
			expect((JSON.parse(answer.body) as HelloPage).messages).toHaveLength(1);
			const sent = await fetch(
				`${listening.origin}${MESSAGES}?idempotency_key=out-9`,
				post('{"text":"DYTEST"}'),
			);
			expect(sent.status).toBe(201);
			const [, recorded] = hello.recorder.takeRequests();
			expect(recorded?.query).toBe("idempotency_key=out-9");
			expect(recorded?.bodySha256).toBe(sha256('{"text":"DYTEST"}'));
		} finally {
			await listening.close();
		}
	});
});
