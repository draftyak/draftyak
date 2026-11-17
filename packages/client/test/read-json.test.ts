import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { ApiResponseError, readApiJson } from "../src/read-json.ts";

const encoder = new TextEncoder();
const jsonHeaders = { "content-type": "application/json" };

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

async function checkpoint() {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function settlement(promise: Promise<unknown>) {
	let settled = false;
	void promise.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	return () => settled;
}

function fixed(code: ApiResponseError["code"]) {
	return (error: unknown) => {
		assert.ok(error instanceof ApiResponseError);
		assert.equal(error.code, code);
		assert.equal(error.name, "ApiResponseError");
		assert.equal(error.message, "API response could not be read");
		assert.equal("cause" in error, false);
		assert.ok(!error.message.includes("DYTEST"));
		return true;
	};
}

function finiteBody(chunks: Uint8Array[], headers = jsonHeaders) {
	let index = 0;
	let pulls = 0;
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls += 1;
				if (index < chunks.length) controller.enqueue(chunks[index++] as Uint8Array);
				else controller.close();
			},
			cancel() {
				cancels += 1;
			},
		},
		{ highWaterMark: 0 },
	);
	const response = new Response(stream, { headers });
	return { response, stream, counts: () => ({ pulls, cancels }) };
}

test("reads split UTF-8 at the exact observed byte limit and releases a normal body", async () => {
	const text = "\u00e9\u{1f642}";
	const bytes = encoder.encode(JSON.stringify({ DYTEST: text }));
	const body = finiteBody(Array.from(bytes, (byte) => Uint8Array.of(byte)));
	assert.deepEqual(await readApiJson(body.response, { maxBytes: bytes.length }), { DYTEST: text });
	assert.equal(body.counts().cancels, 0);
	assert.equal(body.counts().pulls, bytes.length + 1);
	assert.equal(body.stream.locked, false);
	assert.equal(body.response.bodyUsed, true);
});

test("bounds observed bytes regardless of missing or lying Content-Length", async () => {
	const bytes = encoder.encode('{"DYTEST":"byte-bound"}');
	for (const headers of [
		jsonHeaders,
		{ ...jsonHeaders, "content-length": "1" },
		{ ...jsonHeaders, "content-length": "999999999" },
	]) {
		const exact = finiteBody([bytes], headers);
		assert.deepEqual(await readApiJson(exact.response, { maxBytes: bytes.length }), {
			DYTEST: "byte-bound",
		});
		const excessive = finiteBody([bytes.subarray(0, 2), bytes.subarray(2)], headers);
		await assert.rejects(
			readApiJson(excessive.response, { maxBytes: bytes.length - 1 }),
			fixed("RESPONSE_TOO_LARGE"),
		);
		assert.equal(excessive.counts().cancels, 1);
		assert.equal(excessive.stream.locked, false);
	}
});

test("oversized single chunk cancels once and joins actual delayed cancellation", async () => {
	const cancel = deferred<void>();
	const entered = deferred<void>();
	let pulls = 0;
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls += 1;
				controller.enqueue(encoder.encode('"DYTEST-too-large"'));
			},
			cancel() {
				cancels += 1;
				entered.resolve();
				return cancel.promise;
			},
		},
		{ highWaterMark: 0 },
	);
	const operation = readApiJson(new Response(stream, { headers: jsonHeaders }), { maxBytes: 1 });
	const isSettled = settlement(operation);
	await entered.promise;
	await checkpoint();
	assert.equal(isSettled(), false);
	assert.equal(cancels, 1);
	assert.equal(pulls, 1);
	assert.equal(stream.locked, true);
	cancel.resolve();
	await assert.rejects(operation, fixed("RESPONSE_TOO_LARGE"));
	assert.equal(cancels, 1);
	assert.equal(stream.locked, false);
});

test("copies accepted chunks before a later pull can mutate the source buffer", async () => {
	const first = encoder.encode('{"DYTEST":"original');
	let pulls = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls += 1;
				if (pulls === 1) controller.enqueue(first);
				else {
					first.fill(0x58);
					controller.enqueue(encoder.encode('"}'));
					controller.close();
				}
			},
		},
		{ highWaterMark: 0 },
	);
	assert.deepEqual(
		await readApiJson(new Response(stream, { headers: jsonHeaders }), { maxBytes: 64 }),
		{ DYTEST: "original" },
	);
	assert.equal(pulls, 2);
	assert.equal(stream.locked, false);
});

test("requires JSON MIME and UTF-8 while returning only fixed content-free failures", async () => {
	for (const contentType of [
		"application/json",
		"application/json; charset=utf-8",
		'APPLICATION/JSON; CHARSET="UTF-8"',
		"application/json \t; charset = utf-8",
	]) {
		assert.equal(
			await readApiJson(new Response("null", { headers: { "content-type": contentType } }), {
				maxBytes: 4,
			}),
			null,
		);
	}
	const invalidBodies = [
		encoder.encode('{"DYTEST":'),
		Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode("null")]),
		Uint8Array.from([...encoder.encode('{"DYTEST":"'), 0xc3, 0x28, ...encoder.encode('"}')]),
	];
	for (const bytes of invalidBodies) {
		const body = finiteBody([bytes]);
		await assert.rejects(readApiJson(body.response, { maxBytes: 128 }), fixed("RESPONSE_INVALID"));
		assert.equal(body.stream.locked, false);
	}
	for (const contentType of [
		"text/plain",
		"application/problem+json",
		"application/json; charset=iso-8859-1",
	]) {
		let pulls = 0;
		let cancels = 0;
		const stream = new ReadableStream<Uint8Array>(
			{
				pull() {
					pulls += 1;
				},
				cancel() {
					cancels += 1;
				},
			},
			{ highWaterMark: 0 },
		);
		await assert.rejects(
			readApiJson(new Response(stream, { headers: { "content-type": contentType } }), {
				maxBytes: 64,
			}),
			fixed("RESPONSE_INVALID"),
		);
		assert.equal(pulls, 0);
		assert.equal(cancels, 1);
		assert.equal(stream.locked, false);
	}
});

test("reader errors and non-byte chunks cannot leak the underlying reason or retain the lock", async () => {
	const raw = new Error("DYTEST-reader-private-detail");
	const failed = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.error(raw);
			},
		},
		{ highWaterMark: 0 },
	);
	await assert.rejects(
		readApiJson(new Response(failed, { headers: jsonHeaders }), { maxBytes: 64 }),
		fixed("RESPONSE_INVALID"),
	);
	assert.equal(failed.locked, false);
	for (const chunk of ["DYTEST-not-bytes", new ArrayBuffer(2), new DataView(new ArrayBuffer(2))]) {
		let cancels = 0;
		const stream = new ReadableStream(
			{
				pull(controller) {
					controller.enqueue(chunk);
				},
				cancel() {
					cancels += 1;
				},
			},
			{ highWaterMark: 0 },
		);
		await assert.rejects(
			readApiJson(new Response(stream, { headers: jsonHeaders }), { maxBytes: 64 }),
			fixed("RESPONSE_INVALID"),
		);
		assert.equal(cancels, 1);
		assert.equal(stream.locked, false);
	}
});

test("arbitrary stream rejections stay opaque even when they forge the public error prototype", async () => {
	let prototypeCalls = 0;
	let codeReads = 0;
	const reasons: unknown[] = [
		new Proxy(
			{},
			{
				getPrototypeOf() {
					prototypeCalls += 1;
					throw new Error("DYTEST-prototype-private-detail");
				},
			},
		),
		Object.create(ApiResponseError.prototype, {
			code: {
				get() {
					codeReads += 1;
					throw new Error("DYTEST-getter-private-detail");
				},
			},
		}),
		Object.create(ApiResponseError.prototype, {
			code: { value: "DYTEST-nonpalette-code" },
		}),
	];
	for (const reason of reasons) {
		const stream = new ReadableStream<Uint8Array>(
			{
				pull(controller) {
					controller.error(reason);
				},
			},
			{ highWaterMark: 0 },
		);
		let fulfilled = false;
		let refusal: unknown;
		try {
			await readApiJson(new Response(stream, { headers: jsonHeaders }), { maxBytes: 64 });
			fulfilled = true;
		} catch (error) {
			refusal = error;
		}
		assert.equal(fulfilled, false);
		// Check identity as a boolean before any assertion could inspect the reason.
		assert.equal(refusal === reason, false);
		assert.equal(prototypeCalls, 0);
		assert.equal(codeReads, 0);
		fixed("RESPONSE_INVALID")(refusal);
		assert.equal(stream.locked, false);
	}
});

test("pre-abort performs zero pulls but still cancels and joins the owned body", async () => {
	const abort = new AbortController();
	abort.abort(new Error("DYTEST-abort-private-detail"));
	const cancel = deferred<void>();
	const entered = deferred<void>();
	let pulls = 0;
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull() {
				pulls += 1;
			},
			cancel() {
				cancels += 1;
				entered.resolve();
				return cancel.promise;
			},
		},
		{ highWaterMark: 0 },
	);
	const operation = readApiJson(new Response(stream, { headers: jsonHeaders }), {
		maxBytes: 64,
		signal: abort.signal,
	});
	const isSettled = settlement(operation);
	await entered.promise;
	await checkpoint();
	assert.equal(isSettled(), false);
	assert.equal(pulls, 0);
	assert.equal(cancels, 1);
	cancel.resolve();
	await assert.rejects(operation, fixed("RESPONSE_ABORTED"));
	assert.equal(stream.locked, false);
});

test("abort during pending read fences completion and joins cancellation before rejecting", async () => {
	const abort = new AbortController();
	const pulled = deferred<void>();
	const cancel = deferred<void>();
	const entered = deferred<void>();
	let pulls = 0;
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull() {
				pulls += 1;
				pulled.resolve();
			},
			cancel() {
				cancels += 1;
				entered.resolve();
				return cancel.promise;
			},
		},
		{ highWaterMark: 0 },
	);
	const operation = readApiJson(new Response(stream, { headers: jsonHeaders }), {
		maxBytes: 64,
		signal: abort.signal,
	});
	const isSettled = settlement(operation);
	await pulled.promise;
	abort.abort(new Error("DYTEST-abort-private-detail"));
	await entered.promise;
	await checkpoint();
	assert.equal(isSettled(), false);
	assert.equal(cancels, 1);
	assert.equal(pulls, 1);
	assert.equal(stream.locked, true);
	cancel.resolve();
	await assert.rejects(operation, fixed("RESPONSE_ABORTED"));
	assert.equal(stream.locked, false);
	assert.equal(cancels, 1);
});

test("reentrant abort from underlying cancellation shares one join and preserves the primary refusal", async () => {
	const abort = new AbortController();
	const cancel = deferred<void>();
	const entered = deferred<void>();
	let cancels = 0;
	let pulls = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls += 1;
				controller.enqueue(encoder.encode('"DYTEST-large"'));
			},
			cancel() {
				cancels += 1;
				abort.abort(new Error("DYTEST-reentrant-abort"));
				entered.resolve();
				return cancel.promise;
			},
		},
		{ highWaterMark: 0 },
	);
	const operation = readApiJson(new Response(stream, { headers: jsonHeaders }), {
		maxBytes: 1,
		signal: abort.signal,
	});
	const isSettled = settlement(operation);
	await entered.promise;
	await checkpoint();
	assert.equal(isSettled(), false);
	assert.equal(cancels, 1);
	assert.equal(pulls, 1);
	cancel.resolve();
	await assert.rejects(operation, fixed("RESPONSE_TOO_LARGE"));
	assert.equal(cancels, 1);
	assert.equal(stream.locked, false);
});

test("rejected asynchronous cancellation is contained without replacing the primary fixed error", async () => {
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				controller.enqueue(encoder.encode('"DYTEST-large"'));
			},
			cancel() {
				cancels += 1;
				return Promise.reject(new Error("DYTEST-cancel-private-detail"));
			},
		},
		{ highWaterMark: 0 },
	);
	await assert.rejects(
		readApiJson(new Response(stream, { headers: jsonHeaders }), { maxBytes: 1 }),
		fixed("RESPONSE_TOO_LARGE"),
	);
	await checkpoint();
	assert.equal(cancels, 1);
	assert.equal(stream.locked, false);
});

test("locked and consumed bodies refuse without cancelling or releasing a foreign reader", async () => {
	let pulls = 0;
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				pulls += 1;
				controller.enqueue(encoder.encode("null"));
				controller.close();
			},
			cancel() {
				cancels += 1;
			},
		},
		{ highWaterMark: 0 },
	);
	const response = new Response(stream, { headers: jsonHeaders });
	const foreign = stream.getReader();
	try {
		await assert.rejects(readApiJson(response, { maxBytes: 64 }), fixed("RESPONSE_INVALID"));
		assert.equal(stream.locked, true);
		assert.equal(pulls, 0);
		assert.equal(cancels, 0);
		assert.deepEqual(await foreign.read(), { done: false, value: encoder.encode("null") });
		assert.equal((await foreign.read()).done, true);
	} finally {
		foreign.releaseLock();
	}
	assert.equal(response.bodyUsed, true);
	await assert.rejects(readApiJson(response, { maxBytes: 64 }), fixed("RESPONSE_INVALID"));
	assert.equal(cancels, 0);
	assert.equal(stream.locked, false);
});

test("normal completion removes its abort listener and later abort cannot cancel the completed body", async () => {
	const abort = new AbortController();
	const pulled = deferred<void>();
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancels = 0;
	const stream = new ReadableStream<Uint8Array>(
		{
			start(value) {
				controller = value;
			},
			pull() {
				pulled.resolve();
			},
			cancel() {
				cancels += 1;
			},
		},
		{ highWaterMark: 0 },
	);
	const operation = readApiJson(new Response(stream, { headers: jsonHeaders }), {
		maxBytes: 4,
		signal: abort.signal,
	});
	await pulled.promise;
	assert.equal(getEventListeners(abort.signal, "abort").length, 1);
	controller.enqueue(encoder.encode("null"));
	controller.close();
	assert.equal(await operation, null);
	assert.equal(getEventListeners(abort.signal, "abort").length, 0);
	assert.equal(stream.locked, false);
	abort.abort();
	await checkpoint();
	assert.equal(cancels, 0);
});

test("maxBytes accepts both finite endpoints and refuses malformed bounds", async () => {
	assert.equal(await readApiJson(new Response("0", { headers: jsonHeaders }), { maxBytes: 1 }), 0);
	assert.equal(
		await readApiJson(new Response("null", { headers: jsonHeaders }), {
			maxBytes: 8 * 1024 * 1024,
		}),
		null,
	);
	for (const maxBytes of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 8 * 1024 * 1024 + 1]) {
		const body = finiteBody([encoder.encode("null")]);
		await assert.rejects(readApiJson(body.response, { maxBytes }), fixed("RESPONSE_LIMIT_INVALID"));
		assert.deepEqual(body.counts(), { pulls: 0, cancels: 0 });
		assert.equal(body.stream.locked, false);
	}
});
