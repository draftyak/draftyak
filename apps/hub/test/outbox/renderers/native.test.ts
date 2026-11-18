import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	assertNativeSendRenderMatches,
	captureNativeSendRender,
	nativeSendRenderProjection,
} from "../../../src/outbox/renderers/index.ts";
import type { RenderedSend } from "../../../src/outbox/ticket-storage.ts";

// Rendered request DATA, not a channel renderer, ticket or permission to perform HTTP.
const BODY = '{"channel":"C1234567890","text":"A café update"}';
const URL = "https://slack.com/api/chat.postMessage";
const CONTENT_TYPE = "application/json";
const MAX_BODY_BYTES = 33_554_432;
const digest = (value: string | Uint8Array): string =>
	createHash("sha256").update(value).digest("hex");
const expectedProjection = () => ({
	method: "POST" as const,
	url: URL,
	// Independent fixed one-header JCS preimage from the merged hash contract.
	headersSha256: digest('[["content-type","application/json"]]'),
	bodySha256: digest(BODY),
});

function request() {
	return {
		method: "POST" as const,
		url: URL,
		contentType: CONTENT_TYPE,
		headers: [["content-type", CONTENT_TYPE]] as [string, string][],
		body: Buffer.from(BODY, "utf8"),
	};
}

function refused(operation: () => unknown): void {
	try {
		operation();
		expect.fail("Expected fixed send-render refusal");
	} catch (error) {
		expect(error).toMatchObject({
			name: "NativeSendRenderError",
			code: "SEND_RENDER_UNAVAILABLE",
			message: "Send rendering unavailable",
		});
		expect(error).not.toHaveProperty("cause");
	}
}

describe("native rendered send DATA", () => {
	it("captures exact UTF-8 body and the independently specified one-header digest", () => {
		const input = request();
		const actual = captureNativeSendRender(input);
		expect(actual).toEqual({
			method: "POST",
			url: URL,
			contentType: CONTENT_TYPE,
			headers: [["content-type", CONTENT_TYPE]],
			body: new Uint8Array(Buffer.from(BODY, "utf8")),
			render: expectedProjection(),
		});
		expect(Buffer.from(actual.body)).toEqual(Buffer.from(BODY, "utf8"));
		expect(actual.body).not.toBe(input.body);
		expect(actual.headers).not.toBe(input.headers);
		expect(actual.headers[0]).not.toBe(input.headers[0]);
		expect(Object.isFrozen(actual)).toBe(true);
		expect(Object.isFrozen(actual.headers)).toBe(true);
		expect(Object.isFrozen(actual.headers[0])).toBe(true);
		expect(Object.isFrozen(actual.render)).toBe(true);
	});

	it("normalizes only header-name case before hashing", () => {
		const input = request();
		input.headers[0] = ["Content-Type", CONTENT_TYPE];
		const actual = captureNativeSendRender(input);
		expect(actual.headers).toEqual([["content-type", CONTENT_TYPE]]);
		expect(actual.render).toEqual(expectedProjection());
	});

	it("does not trust a caller's cached render projection when recapturing bytes", () => {
		const input = {
			...request(),
			render: {
				...expectedProjection(),
				headersSha256: "0".repeat(64),
				bodySha256: "0".repeat(64),
			},
		};
		expect(captureNativeSendRender(input).render).toEqual(expectedProjection());
		expect(nativeSendRenderProjection(input)).toEqual(expectedProjection());
		expect(input.render.bodySha256).toBe("0".repeat(64));
	});

	it("uses only the visible Uint8Array slice rather than its entire backing allocation", () => {
		const bytes = Buffer.concat([Buffer.from("prefix"), Buffer.from(BODY), Buffer.from("suffix")]);
		const visible = new Uint8Array(bytes.buffer, bytes.byteOffset + 6, Buffer.byteLength(BODY));
		const actual = captureNativeSendRender({ ...request(), body: visible });
		expect(Buffer.from(actual.body)).toEqual(Buffer.from(BODY));
		expect(actual.render).toEqual(expectedProjection());
	});

	it("is detached from later caller body and header mutations", () => {
		const input = request();
		const actual = captureNativeSendRender(input);
		input.body.fill(0);
		input.headers[0] = ["content-type", "text/plain"];
		expect(Buffer.from(actual.body)).toEqual(Buffer.from(BODY));
		expect(actual.headers).toEqual([["content-type", CONTENT_TYPE]]);
		expect(actual.render).toEqual(expectedProjection());
	});

	it("recomputes a mutated owned output rather than accepting its earlier projection", () => {
		const actual = captureNativeSendRender(request());
		const approved = nativeSendRenderProjection(actual);
		actual.body[0] = (actual.body[0] ?? 0) ^ 1;
		expect(approved).toEqual(expectedProjection());
		expect(nativeSendRenderProjection(actual).bodySha256).not.toBe(approved.bodySha256);
		refused(() => assertNativeSendRenderMatches(approved, actual));
	});

	it("accepts exact matching approved request DATA without mutating it", () => {
		const approved = Object.freeze(expectedProjection());
		const input = request();
		assertNativeSendRenderMatches(approved, input);
		expect(approved).toEqual(expectedProjection());
		expect(Buffer.from(input.body)).toEqual(Buffer.from(BODY));
	});

	it.each(["method", "url", "headersSha256", "bodySha256"] as const)(
		"refuses a changed approved %s field",
		(field) => {
			const approved = {
				...expectedProjection(),
				[field]:
					field === "method"
						? "PUT"
						: field === "url"
							? "https://slack.com/api/other"
							: "0".repeat(64),
			};
			refused(() => assertNativeSendRenderMatches(approved, request()));
		},
	);

	it.each([
		{ name: "body", change: () => ({ ...request(), body: Buffer.from(`${BODY} `) }) },
		{ name: "method", change: () => ({ ...request(), method: "PUT" as const }) },
		{ name: "URL", change: () => ({ ...request(), url: "https://slack.com/api/other" }) },
		{
			name: "header and content type",
			change: () => ({
				...request(),
				contentType: "text/plain",
				headers: [["content-type", "text/plain"]],
			}),
		},
	])("refuses changed actual $name bytes against the approved projection", ({ change }) => {
		refused(() => assertNativeSendRenderMatches(expectedProjection(), change() as RenderedSend));
	});

	it("accepts an empty body and exactly the maximum body size", () => {
		const empty = captureNativeSendRender({ ...request(), body: new Uint8Array() });
		expect(empty.body).toHaveLength(0);
		expect(empty.render.bodySha256).toBe(digest(new Uint8Array()));
		const bytes = new Uint8Array(MAX_BODY_BYTES);
		const full = captureNativeSendRender({ ...request(), body: bytes });
		expect(full.body).toHaveLength(MAX_BODY_BYTES);
		expect(full.render.bodySha256).toBe(digest(bytes));
		refused(() =>
			captureNativeSendRender({ ...request(), body: new Uint8Array(MAX_BODY_BYTES + 1) }),
		);
	});

	it.each([
		{ name: "GET method", change: () => ({ ...request(), method: "GET" }) },
		{ name: "HTTP URL", change: () => ({ ...request(), url: "http://example.test/send" }) },
		{
			name: "noncanonical URL",
			change: () => ({ ...request(), url: "https://slack.com:443/api/chat.postMessage" }),
		},
		{ name: "URL fragment", change: () => ({ ...request(), url: `${URL}#fragment` }) },
		{
			name: "header injection",
			change: () => ({ ...request(), contentType: "text/plain\r\nX-Extra: value" }),
		},
		{
			name: "mismatched Content-Type",
			change: () => ({ ...request(), contentType: "text/plain" }),
		},
		{ name: "missing header", change: () => ({ ...request(), headers: [] }) },
		{
			name: "duplicate header",
			change: () => ({
				...request(),
				headers: [
					["content-type", CONTENT_TYPE],
					["content-type", CONTENT_TYPE],
				],
			}),
		},
		{
			name: "authorization header",
			change: () => ({ ...request(), headers: [["authorization", "synthetic"]] }),
		},
		{ name: "array body", change: () => ({ ...request(), body: [1, 2, 3] }) },
		{
			name: "DataView body",
			change: () => ({ ...request(), body: new DataView(new ArrayBuffer(3)) }),
		},
		{
			name: "shared body",
			change: () => ({ ...request(), body: new Uint8Array(new SharedArrayBuffer(3)) }),
		},
		{ name: "extra field", change: () => ({ ...request(), approved: true }) },
	])("refuses $name through the fixed public refusal", ({ change }) => {
		refused(() => captureNativeSendRender(change() as RenderedSend));
	});

	it("refuses an accessor without invoking its getter or exposing its detail", () => {
		const getter = vi.fn(() => {
			throw new Error("Synthetic detail must not escape");
		});
		const input = Object.defineProperty(request(), "body", { enumerable: true, get: getter });
		refused(() => captureNativeSendRender(input));
		expect(getter).not.toHaveBeenCalled();
	});

	it("refuses a proxy without invoking its traps", () => {
		const trap = vi.fn();
		const input = new Proxy(request(), { get: trap, ownKeys: trap });
		refused(() => captureNativeSendRender(input));
		expect(trap).not.toHaveBeenCalled();
	});

	it("refuses an optional render accessor even though cached projections are not trusted", () => {
		const getter = vi.fn(() => expectedProjection());
		const input = Object.defineProperty(request(), "render", { enumerable: true, get: getter });
		refused(() => captureNativeSendRender(input));
		expect(getter).not.toHaveBeenCalled();
	});

	it.each(["symbol", "nonenumerable", "sparse-header", "extended-pair"] as const)(
		"refuses %s record structure",
		(fault) => {
			const input = request();
			if (fault === "symbol") Object.defineProperty(input, Symbol("extra"), { value: true });
			else if (fault === "nonenumerable")
				Object.defineProperty(input, "body", { value: input.body, enumerable: false });
			else if (fault === "sparse-header") delete input.headers[0];
			else {
				const pair = input.headers[0];
				if (!pair) throw new Error("Expected owned header pair");
				Object.defineProperty(pair, "extra", { value: true });
			}
			refused(() => captureNativeSendRender(input));
		},
	);

	it("refuses an accessor in an otherwise exact approved projection without reading it", () => {
		const getter = vi.fn(() => "0".repeat(64));
		const approved = Object.defineProperty(expectedProjection(), "bodySha256", {
			enumerable: true,
			get: getter,
		});
		refused(() => assertNativeSendRenderMatches(approved, request()));
		expect(getter).not.toHaveBeenCalled();
	});
});
