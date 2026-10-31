import {
	HOST_ERROR_CODES,
	HOST_MAX_FRAME_BYTES,
	HOST_MAX_WS_DATA_LENGTH,
	HostNotification,
} from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import { describe, expect, it } from "vitest";
import {
	createSocketModeLimiter,
	SOCKET_MODE_ACK_WINDOW_MS,
	SOCKET_MODE_ACKNOWLEDGED_MEMORY,
	SOCKET_MODE_MAX_PENDING_ENVELOPES,
	SOCKET_MODE_MAX_PENDING_URLS,
	SOCKET_MODE_MAX_SOCKETS,
	SOCKET_MODE_REFUSALS,
	SOCKET_MODE_URL_TTL_MS,
	type SocketModeDelivery,
	type SocketModeLimiter,
	SocketModeRefusal,
	type SocketModeRefusalCode,
} from "../../../../src/plugins/broker/socket-mode/index.ts";

const urlFor = (n: number): string =>
	`wss://wss-primary.slack.com/link/?ticket=dytest-${n}&app_id=A0TEST`;
const opened = (url: string): { status: number; body: Uint8Array } => ({
	status: 200,
	body: new TextEncoder().encode(JSON.stringify({ ok: true, url })),
});
const envelope = (id: string): string =>
	JSON.stringify({
		envelope_id: id,
		type: "events_api",
		accepts_response_payload: false,
		payload: { event: { type: "message", text: "DYTEST hello" } },
	});

function refusal(run: () => unknown): SocketModeRefusalCode | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof SocketModeRefusal) return error.code;
		throw error;
	}
	return undefined;
}

function setup(start = 50_000): {
	limiter: SocketModeLimiter;
	advance(ms: number): void;
	set(ms: number): void;
	connect(n: number): string;
} {
	let time = start;
	const limiter = createSocketModeLimiter({ monotonicMs: () => time });
	return {
		limiter,
		advance: (ms) => {
			time += ms;
		},
		set: (ms) => {
			time = ms;
		},
		connect: (n) => {
			limiter.bind(opened(urlFor(n)));
			const { socketId } = limiter.open({ url: urlFor(n) });
			limiter.upgraded(socketId, 101);
			return socketId;
		},
	};
}

const acknowledgeable = (delivery: SocketModeDelivery): boolean =>
	delivery.kind === "deliver" && delivery.acknowledgeable;

describe("Socket Mode URL binding", () => {
	it("opens a URL bound from the apps.connections.open response exactly once", () => {
		const { limiter } = setup();
		limiter.bind(opened(urlFor(1)));
		const target = limiter.open({ url: urlFor(1) });
		expect(target).toEqual({
			socketId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
			host: "wss-primary.slack.com",
			port: 443,
			path: "/link/?ticket=dytest-1&app_id=A0TEST",
		});
		expect(Object.isFrozen(target)).toBe(true);
		expect(refusal(() => limiter.open({ url: urlFor(1) }))).toBe("URL_UNBOUND");
		expect(refusal(() => limiter.open({ url: urlFor(2) }))).toBe("URL_UNBOUND");
	});

	it("refuses a URL the plugin supplies itself, even on a Slack host", () => {
		const { limiter } = setup();
		limiter.bind(opened(urlFor(1)));
		for (const url of [
			urlFor(2),
			`${urlFor(1)}&x=1`,
			urlFor(1).replace("wss-primary", "wss-backup"),
			urlFor(1).toUpperCase(),
		])
			expect(refusal(() => limiter.open({ url }))).toBe("URL_UNBOUND");
		expect(limiter.open({ url: urlFor(1) }).host).toBe("wss-primary.slack.com");
	});

	it("binds the exact URL text, including a written-out default port", () => {
		const { limiter } = setup();
		const written = "wss://wss-primary.slack.com:443/link/?ticket=dytest-443";
		limiter.bind(opened(written));
		expect(refusal(() => limiter.open({ url: written.replace(":443", "") }))).toBe("URL_UNBOUND");
		expect(limiter.open({ url: written })).toEqual({
			socketId: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
			host: "wss-primary.slack.com",
			port: 443,
			path: "/link/?ticket=dytest-443",
		});
	});

	it("binds nothing from a refused response", () => {
		const { limiter } = setup();
		const redirect = { ...opened(urlFor(1)), status: 302 };
		expect(refusal(() => limiter.bind(redirect))).toBe("URL_RESPONSE");
		const elsewhere = opened("wss://example.com/link/?ticket=dytest-1");
		expect(refusal(() => limiter.bind(elsewhere))).toBe("URL_TARGET");
		expect(refusal(() => limiter.open({ url: urlFor(1) }))).toBe("URL_UNBOUND");
		expect(refusal(() => limiter.open({ url: "wss://example.com/link/?ticket=dytest-1" }))).toBe(
			"URL_UNBOUND",
		);
	});

	it("keeps a bound URL for exactly its time limit", () => {
		const { limiter, advance } = setup();
		limiter.bind(opened(urlFor(1)));
		limiter.bind(opened(urlFor(2)));
		advance(SOCKET_MODE_URL_TTL_MS);
		expect(limiter.open({ url: urlFor(1) }).socketId).toHaveLength(26);
		advance(1);
		expect(refusal(() => limiter.open({ url: urlFor(2) }))).toBe("URL_UNBOUND");
	});

	it("treats a clock that moved backwards as expired", () => {
		const { limiter, set } = setup(50_000);
		limiter.bind(opened(urlFor(1)));
		set(49_999);
		expect(refusal(() => limiter.open({ url: urlFor(1) }))).toBe("URL_UNBOUND");
	});

	it("refuses a duplicate binding and more pending URLs than its bound", () => {
		const { limiter, advance } = setup();
		for (let n = 0; n < SOCKET_MODE_MAX_PENDING_URLS; n++) limiter.bind(opened(urlFor(n)));
		expect(refusal(() => limiter.bind(opened(urlFor(0))))).toBe("URL_DUPLICATE");
		expect(refusal(() => limiter.bind(opened(urlFor(99))))).toBe("URL_LIMIT");
		limiter.open({ url: urlFor(0) });
		limiter.bind(opened(urlFor(99)));
		expect(refusal(() => limiter.bind(opened(urlFor(98))))).toBe("URL_LIMIT");
		advance(SOCKET_MODE_URL_TTL_MS + 1);
		limiter.bind(opened(urlFor(98)));
		expect(limiter.open({ url: urlFor(98) }).host).toBe("wss-primary.slack.com");
	});

	it("counts sockets that have not upgraded yet and keeps the URL when the limit refuses", () => {
		const { limiter, connect } = setup();
		const first = connect(0);
		for (let n = 1; n < SOCKET_MODE_MAX_SOCKETS - 1; n++) connect(n);
		limiter.bind(opened(urlFor(50)));
		limiter.open({ url: urlFor(50) });
		limiter.bind(opened(urlFor(51)));
		expect(refusal(() => limiter.open({ url: urlFor(51) }))).toBe("SOCKET_LIMIT");
		limiter.closed(first);
		expect(limiter.open({ url: urlFor(51) }).port).toBe(443);
		limiter.bind(opened(urlFor(52)));
		expect(refusal(() => limiter.open({ url: urlFor(52) }))).toBe("SOCKET_LIMIT");
	});

	it("keeps limiters for different bindings apart", () => {
		const one = setup();
		const two = setup();
		one.limiter.bind(opened(urlFor(1)));
		expect(refusal(() => two.limiter.open({ url: urlFor(1) }))).toBe("URL_UNBOUND");
		const socketId = one.connect(2);
		expect(two.limiter.receive(socketId, envelope("E1"))).toEqual({ kind: "drop" });
		expect(refusal(() => two.limiter.acknowledge({ socketId, envelopeId: "E1" }))).toBe(
			"SOCKET_UNKNOWN",
		);
	});
});

describe("Socket Mode handshake", () => {
	it.each([100, 200, 204, 301, 302, 307, 308, 400, 401, 426, 500])(
		"retires the socket on handshake status %i",
		(status) => {
			const { limiter } = setup();
			limiter.bind(opened(urlFor(1)));
			const { socketId } = limiter.open({ url: urlFor(1) });
			expect(refusal(() => limiter.upgraded(socketId, status))).toBe("UPGRADE_REFUSED");
			expect(refusal(() => limiter.upgraded(socketId, 101))).toBe("SOCKET_UNKNOWN");
			expect(limiter.receive(socketId, envelope("E1"))).toEqual({ kind: "drop" });
			expect(refusal(() => limiter.close({ socketId }))).toBe("SOCKET_UNKNOWN");
		},
	);

	it("delivers nothing before the upgrade and upgrades once", () => {
		const { limiter } = setup();
		limiter.bind(opened(urlFor(1)));
		const { socketId } = limiter.open({ url: urlFor(1) });
		expect(limiter.receive(socketId, envelope("E1"))).toEqual({ kind: "drop" });
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E1" }))).toBe(
			"SOCKET_UNKNOWN",
		);
		limiter.upgraded(socketId, 101);
		expect(refusal(() => limiter.upgraded(socketId, 101))).toBe("SOCKET_UNKNOWN");
		expect(refusal(() => limiter.upgraded("01J0000000000000000000000Z", 101))).toBe(
			"SOCKET_UNKNOWN",
		);
		expect(acknowledgeable(limiter.receive(socketId, envelope("E2")))).toBe(true);
	});
});

describe("Socket Mode messages and acknowledgements", () => {
	it("delivers each text message unchanged as one host/ws.message notification", () => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		const data = `${envelope("Ev01-abc_DEF")}\n{"line":"two é😀"}`;
		const delivery = limiter.receive(socketId, data);
		expect(delivery).toEqual({
			kind: "deliver",
			acknowledgeable: false,
			notification: { jsonrpc: "2.0", method: "host/ws.message", params: { socketId, data } },
		});
		const single = limiter.receive(socketId, envelope("Ev01-abc_DEF"));
		expect(acknowledgeable(single)).toBe(true);
		if (single.kind !== "deliver") throw new Error("expected a delivery");
		expect(HostNotification.safeParse(single.notification).success).toBe(true);
		expect(Object.isFrozen(single)).toBe(true);
		expect(Object.isFrozen(single.notification)).toBe(true);
		expect(Object.isFrozen(single.notification.params)).toBe(true);
	});

	it("acknowledges each envelope once, with exactly the envelope ID frame", () => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		const other = connect(2);
		limiter.receive(socketId, envelope("E1"));
		limiter.receive(other, envelope("E2"));
		expect(limiter.acknowledge({ socketId, envelopeId: "E1" })).toBe('{"envelope_id":"E1"}');
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E1" }))).toBe(
			"ENVELOPE_REPEATED",
		);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E2" }))).toBe(
			"ENVELOPE_UNKNOWN",
		);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E3" }))).toBe(
			"ENVELOPE_UNKNOWN",
		);
		expect(limiter.acknowledge({ socketId: other, envelopeId: "E2" })).toBe('{"envelope_id":"E2"}');
	});

	it("accepts an acknowledgement for exactly its time limit", () => {
		const { limiter, connect, advance } = setup();
		const socketId = connect(1);
		limiter.receive(socketId, envelope("E1"));
		limiter.receive(socketId, envelope("E2"));
		advance(SOCKET_MODE_ACK_WINDOW_MS);
		expect(limiter.acknowledge({ socketId, envelopeId: "E1" })).toBe('{"envelope_id":"E1"}');
		advance(1);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E2" }))).toBe(
			"ENVELOPE_UNKNOWN",
		);
	});

	it("refuses an acknowledgement after the clock moved backwards", () => {
		const { limiter, connect, set } = setup(50_000);
		const socketId = connect(1);
		limiter.receive(socketId, envelope("E1"));
		set(49_999);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E1" }))).toBe(
			"ENVELOPE_UNKNOWN",
		);
	});

	it("keeps the first arrival time of a repeated envelope and never acknowledges it twice", () => {
		const { limiter, connect, advance } = setup();
		const socketId = connect(1);
		expect(acknowledgeable(limiter.receive(socketId, envelope("E1")))).toBe(true);
		advance(SOCKET_MODE_ACK_WINDOW_MS - 1000);
		expect(acknowledgeable(limiter.receive(socketId, envelope("E1")))).toBe(true);
		advance(1001);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E1" }))).toBe(
			"ENVELOPE_UNKNOWN",
		);
		limiter.receive(socketId, envelope("E2"));
		limiter.acknowledge({ socketId, envelopeId: "E2" });
		expect(acknowledgeable(limiter.receive(socketId, envelope("E2")))).toBe(false);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E2" }))).toBe(
			"ENVELOPE_REPEATED",
		);
	});

	it.each([
		["a frame without an envelope", JSON.stringify({ type: "hello" })],
		["a numeric envelope ID", JSON.stringify({ envelope_id: 7 })],
		["an empty envelope ID", JSON.stringify({ envelope_id: "" })],
		["a space", JSON.stringify({ envelope_id: "a b" })],
		["a quote", JSON.stringify({ envelope_id: 'a"b' })],
		["a non-ASCII letter", JSON.stringify({ envelope_id: "é" })],
		["129 characters", JSON.stringify({ envelope_id: "a".repeat(129) })],
		["a line break", JSON.stringify({ envelope_id: "a\nb" })],
		["a nested envelope", JSON.stringify({ payload: { envelope_id: "E1" } })],
		["an array", JSON.stringify([{ envelope_id: "E1" }])],
		["a duplicate name", '{"envelope_id":"E1","envelope_id":"E2"}'],
		["an escaped duplicate name", '{"envelope_id":"E1","\\u0065nvelope_id":"E2"}'],
		["trailing data", `${envelope("E1")} {}`],
		["malformed JSON", '{"envelope_id":"E1"'],
		["plain text", "E1"],
	])("delivers %s without making it acknowledgeable", (_name, data) => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		const delivery = limiter.receive(socketId, data);
		expect(delivery.kind).toBe("deliver");
		expect(acknowledgeable(delivery)).toBe(false);
		for (const envelopeId of ["E1", "E2", "a b", "a".repeat(129), ""])
			expect(refusal(() => limiter.acknowledge({ socketId, envelopeId }))).toBe("ENVELOPE_UNKNOWN");
	});

	it("accepts envelope IDs of 1 to 128 word characters and hyphens", () => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		for (const id of ["a", "a".repeat(128), "57d6a792-4d35-4d0b-b6aa-3361493e1caf", "A_b-9"]) {
			expect(acknowledgeable(limiter.receive(socketId, envelope(id)))).toBe(true);
			expect(limiter.acknowledge({ socketId, envelopeId: id })).toBe(
				JSON.stringify({ envelope_id: id }),
			);
		}
	});

	it("bounds the pending envelopes of a socket", () => {
		const { limiter, connect, advance } = setup();
		const socketId = connect(1);
		const other = connect(2);
		for (let n = 0; n < SOCKET_MODE_MAX_PENDING_ENVELOPES; n++)
			expect(acknowledgeable(limiter.receive(socketId, envelope(`E${n}`)))).toBe(true);
		const overflow = limiter.receive(socketId, envelope("Eover"));
		expect(overflow.kind).toBe("deliver");
		expect(acknowledgeable(overflow)).toBe(false);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "Eover" }))).toBe(
			"ENVELOPE_UNKNOWN",
		);
		expect(acknowledgeable(limiter.receive(other, envelope("Eover")))).toBe(true);
		limiter.acknowledge({ socketId, envelopeId: "E0" });
		expect(acknowledgeable(limiter.receive(socketId, envelope("Enext")))).toBe(true);
		expect(acknowledgeable(limiter.receive(socketId, envelope("Efull")))).toBe(false);
		advance(SOCKET_MODE_ACK_WINDOW_MS + 1);
		expect(acknowledgeable(limiter.receive(socketId, envelope("Elater")))).toBe(true);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E1" }))).toBe(
			"ENVELOPE_UNKNOWN",
		);
	});

	it("remembers acknowledged envelopes up to its memory bound, oldest forgotten first", () => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		const acknowledge = (id: string): void => {
			expect(acknowledgeable(limiter.receive(socketId, envelope(id)))).toBe(true);
			limiter.acknowledge({ socketId, envelopeId: id });
		};
		for (let n = 0; n < SOCKET_MODE_ACKNOWLEDGED_MEMORY; n++) acknowledge(`E${n}`);
		expect(acknowledgeable(limiter.receive(socketId, envelope("E0")))).toBe(false);
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E0" }))).toBe(
			"ENVELOPE_REPEATED",
		);
		acknowledge("Elast");
		expect(acknowledgeable(limiter.receive(socketId, envelope("E1")))).toBe(false);
		acknowledge("E0");
	});
});

describe("Socket Mode message limits", () => {
	it("closes with 1003 on a message that is not text, and retires the socket", () => {
		for (const data of [new Uint8Array([0x7b, 0x7d]), new ArrayBuffer(2), undefined, 7, null]) {
			const { limiter, connect } = setup();
			const socketId = connect(1);
			limiter.receive(socketId, envelope("E1"));
			expect(limiter.receive(socketId, data)).toEqual({ kind: "close", code: 1003 });
			expect(limiter.receive(socketId, envelope("E2"))).toEqual({ kind: "drop" });
			expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E1" }))).toBe(
				"SOCKET_UNKNOWN",
			);
		}
	});

	it("closes with 1007 on text that holds a lone surrogate", () => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		expect(limiter.receive(socketId, '{"envelope_id":"E1","x":"\ud800"}')).toEqual({
			kind: "close",
			code: 1007,
		});
		expect(refusal(() => limiter.close({ socketId }))).toBe("SOCKET_UNKNOWN");
	});

	it("delivers a message whose frame is exactly the bound and closes with 1009 one byte over", () => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		const frameBytes = (data: string): number =>
			Buffer.byteLength(
				canonicalize({ jsonrpc: "2.0", method: "host/ws.message", params: { socketId, data } }),
			);
		const padded = (length: number): string =>
			`{"envelope_id":"Ebig","pad":"${"a".repeat(length)}"}`;
		const fill = HOST_MAX_FRAME_BYTES - frameBytes(padded(0));
		expect(frameBytes(padded(fill))).toBe(HOST_MAX_FRAME_BYTES);
		const exact = limiter.receive(socketId, padded(fill));
		expect(acknowledgeable(exact)).toBe(true);
		if (exact.kind !== "deliver") throw new Error("expected a delivery");
		expect(HostNotification.safeParse(exact.notification).success).toBe(true);
		expect(limiter.acknowledge({ socketId, envelopeId: "Ebig" })).toBe('{"envelope_id":"Ebig"}');
		expect(limiter.receive(socketId, padded(fill + 1))).toEqual({ kind: "close", code: 1009 });
		expect(limiter.receive(socketId, envelope("E1"))).toEqual({ kind: "drop" });
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "Ebig" }))).toBe(
			"SOCKET_UNKNOWN",
		);
	});

	it("counts JSON escapes and multi-byte characters against the frame bound", () => {
		for (const unit of ['"', "\u0001", "é", "😀"]) {
			const { limiter, connect } = setup();
			const socketId = connect(1);
			const data = unit.repeat(Math.ceil(HOST_MAX_FRAME_BYTES / 2 / unit.length));
			expect(data.length).toBeLessThan(HOST_MAX_WS_DATA_LENGTH);
			expect(limiter.receive(socketId, data)).toEqual({ kind: "close", code: 1009 });
		}
	});

	it("decides by the exact frame size for text within the contract's data length", () => {
		for (const unit of ["a", '"', "\u0001", "é", "😀"]) {
			const { limiter, connect } = setup();
			const socketId = connect(1);
			const frameBytes = (data: string): number =>
				Buffer.byteLength(
					canonicalize({ jsonrpc: "2.0", method: "host/ws.message", params: { socketId, data } }),
				);
			const exact = unit + "a".repeat(HOST_MAX_FRAME_BYTES - frameBytes(unit));
			expect(frameBytes(exact)).toBe(HOST_MAX_FRAME_BYTES);
			expect(exact.length).toBeLessThan(HOST_MAX_WS_DATA_LENGTH);
			expect(limiter.receive(socketId, exact).kind).toBe("deliver");
			expect(limiter.receive(socketId, `${exact}a`)).toEqual({ kind: "close", code: 1009 });
		}
	});
});

describe("Socket Mode plugin requests", () => {
	it("accepts exactly the contract fields, from a plain or null-prototype object", () => {
		const { limiter } = setup();
		limiter.bind(opened(urlFor(1)));
		const params = Object.assign(Object.create(null) as object, { url: urlFor(1) });
		const { socketId } = limiter.open(params);
		limiter.upgraded(socketId, 101);
		limiter.receive(socketId, envelope("E1"));
		const ack = Object.assign(Object.create(null) as object, { socketId, envelopeId: "E1" });
		expect(limiter.acknowledge(ack)).toBe('{"envelope_id":"E1"}');
		limiter.close(Object.assign(Object.create(null) as object, { socketId }));
		expect(refusal(() => limiter.close({ socketId }))).toBe("SOCKET_UNKNOWN");
	});

	it("refuses malformed params before anything else, as BAD_REQUEST", () => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		limiter.receive(socketId, envelope("E1"));
		limiter.bind(opened(urlFor(2)));
		const url = urlFor(2);
		const shapes = (fields: Record<string, unknown>): unknown[] => [
			null,
			undefined,
			"text",
			[fields],
			{},
			{ ...fields, extra: 1 },
			{ ...fields, [Symbol("extra")]: 1 },
			Object.fromEntries(Object.keys(fields).map((name) => [name, 1])),
			Object.defineProperties(
				{},
				Object.fromEntries(
					Object.entries(fields).map(([name, value]) => [
						name,
						{ get: () => value, enumerable: true },
					]),
				),
			),
			Object.defineProperties(
				{},
				Object.fromEntries(
					Object.entries(fields).map(([name, value]) => [name, { value, enumerable: false }]),
				),
			),
			Object.create(fields),
			Object.assign(new (class Params {})(), fields),
			new Proxy({ ...fields }, {}),
		];
		const cases: [string, (params: unknown) => unknown, Record<string, unknown>][] = [
			["open", (params) => limiter.open(params), { url }],
			["acknowledge", (params) => limiter.acknowledge(params), { socketId, envelopeId: "E1" }],
			["close", (params) => limiter.close(params), { socketId }],
		];
		for (const [, call, fields] of cases)
			for (const params of shapes(fields)) {
				let caught: unknown;
				try {
					call(params);
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(SocketModeRefusal);
				expect((caught as SocketModeRefusal).code).toBe("PARAMS_INVALID");
				expect((caught as SocketModeRefusal).hostError).toBe("BAD_REQUEST");
			}
		expect(
			refusal(() => limiter.acknowledge({ socketId, envelopeId: "E1", payload: { text: "x" } })),
		).toBe("PARAMS_INVALID");
		expect(limiter.acknowledge({ socketId, envelopeId: "E1" })).toBe('{"envelope_id":"E1"}');
		expect(limiter.open({ url }).port).toBe(443);
	});

	it("frees a socket on host/ws.close or a native close", () => {
		const { limiter, connect } = setup();
		const sockets = Array.from({ length: SOCKET_MODE_MAX_SOCKETS }, (_, n) => connect(n));
		limiter.bind(opened(urlFor(90)));
		expect(refusal(() => limiter.open({ url: urlFor(90) }))).toBe("SOCKET_LIMIT");
		limiter.close({ socketId: sockets[0] as string });
		expect(refusal(() => limiter.close({ socketId: sockets[0] as string }))).toBe("SOCKET_UNKNOWN");
		connect(91);
		limiter.closed(sockets[1] as string);
		limiter.closed(sockets[1] as string);
		limiter.closed("not-a-socket");
		expect(limiter.receive(sockets[1] as string, envelope("E1"))).toEqual({ kind: "drop" });
		expect(limiter.open({ url: urlFor(90) }).port).toBe(443);
	});

	it("retires every binding and socket for good", () => {
		const { limiter, connect } = setup();
		const socketId = connect(1);
		limiter.receive(socketId, envelope("E1"));
		limiter.bind(opened(urlFor(2)));
		limiter.retire();
		expect(refusal(() => limiter.bind(opened(urlFor(3))))).toBe("RETIRED");
		expect(refusal(() => limiter.open({ url: urlFor(2) }))).toBe("RETIRED");
		expect(refusal(() => limiter.upgraded(socketId, 101))).toBe("RETIRED");
		expect(refusal(() => limiter.acknowledge({ socketId, envelopeId: "E1" }))).toBe("RETIRED");
		expect(refusal(() => limiter.close({ socketId }))).toBe("RETIRED");
		expect(limiter.receive(socketId, envelope("E2"))).toEqual({ kind: "drop" });
		limiter.closed(socketId);
		limiter.retire();
		expect(refusal(() => limiter.open({ url: urlFor(2) }))).toBe("RETIRED");
	});

	it("maps every refusal to a host error and carries no URL, ticket or envelope", () => {
		for (const hostError of Object.values(SOCKET_MODE_REFUSALS))
			expect(HOST_ERROR_CODES).toContain(hostError);
		expect(SOCKET_MODE_REFUSALS.PARAMS_INVALID).toBe("BAD_REQUEST");
		const { limiter, connect } = setup();
		const socketId = connect(1);
		const errors: unknown[] = [];
		for (const run of [
			() => limiter.open({ url: urlFor(77) }),
			() => limiter.acknowledge({ socketId, envelopeId: "Esecret-77" }),
			() => limiter.bind(opened("wss://example.com/link/?ticket=dytest-77")),
		])
			try {
				run();
			} catch (error) {
				errors.push(error);
			}
		expect(errors).toHaveLength(3);
		for (const error of errors) {
			expect(error).toBeInstanceOf(SocketModeRefusal);
			const text = `${String(error)} ${JSON.stringify(error)}`;
			expect(text).not.toMatch(/dytest-77|Esecret|example\.com/);
			expect((error as Error).message).toBe("Socket Mode request refused");
		}
	});
});

describe("Socket Mode clock", () => {
	it("refuses a clock without a callable monotonic reading", () => {
		for (const clock of [null, undefined, {}, { monotonicMs: 5 }, new Proxy({}, {})])
			expect(
				refusal(() =>
					createSocketModeLimiter(
						clock as unknown as Parameters<typeof createSocketModeLimiter>[0],
					),
				),
			).toBe("CLOCK_INVALID");
	});

	it("refuses to act on an unusable reading", () => {
		for (const reading of [
			() => Number.NaN,
			() => Number.POSITIVE_INFINITY,
			() => "1",
			() => {
				throw new Error("clock failed");
			},
		]) {
			const limiter = createSocketModeLimiter({ monotonicMs: reading as () => number });
			expect(refusal(() => limiter.bind(opened(urlFor(1))))).toBe("CLOCK_INVALID");
		}
	});

	it("captures the clock's reading function once", () => {
		let time = 1_000;
		const clock = { monotonicMs: () => time };
		const limiter = createSocketModeLimiter(clock);
		clock.monotonicMs = () => Number.NaN;
		limiter.bind(opened(urlFor(1)));
		time += SOCKET_MODE_URL_TTL_MS + 1;
		expect(refusal(() => limiter.open({ url: urlFor(1) }))).toBe("URL_UNBOUND");
	});
});
