import { headersSha256, sha256Hex } from "../../src/hash.ts";
import {
	presentedTicketId,
	SEND_TICKET_META,
	SEND_TICKET_TTL_MS,
	type SendTicket,
	sendTicketExp,
	TICKET_CHECKS,
	TICKET_DISABLES_PLUGIN,
	type TicketedRequest,
	type TicketMismatch,
	ticketMismatch,
} from "../../src/send-ticket.ts";
import type { VectorFile } from "../vectors.ts";

const MINTED_AT = 1_792_000_000_000;
const DELIVER_BY = MINTED_AT + 900_000;
const outboxId = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
const instanceId = "01JAZ3W4C8D9E0F1G2H3J4K5M6";
// channel-hello's json-template send: the outbox id is the idempotency key.
const origin = "https://hello.draftyak.example";
const url = `${origin}/v1/conversations/conv-1/messages?idempotency_key=${outboxId}`;
const json = "application/json";
const headers = Object.entries({ "Content-Type": json, Accept: json });
const body = '{"text":"DYTEST hello from the send-ticket vectors"}';
const ticket: SendTicket = {
	id: "01JAZ3W5N8P0Q2R4S6T8V0W2X4",
	outboxId,
	instanceId,
	method: "POST",
	url,
	headersSha256: headersSha256(headers),
	contentType: json,
	bodySha256: sha256Hex(body),
	exp: sendTicketExp(MINTED_AT, DELIVER_BY),
};
const capped = sendTicketExp(MINTED_AT, MINTED_AT + 30_000);

type Request = Omit<TicketedRequest, "headers" | "body"> & {
	headers: [string, string][];
	body: string;
};
const sent: Request = { ticket, instanceId, method: "POST", url, contentType: json, headers, body };
// `minted` changes the ticket the broker found by the presented id, or is null when it found none;
// the plugin presents the minted ticket unless `request` says otherwise.
type Variant = { minted?: object | null; request?: Partial<Request>; now?: number };

const lastChanged = (text: string, to: string): string => `${text.slice(0, -1)}${to}`;
const otherHex = (hex: string): string => lastChanged(hex, hex.endsWith("0") ? "1" : "0");
const shown = (change: object): string =>
	Object.entries(change)
		.map(([name, value]) => `${name} ${JSON.stringify(value)}`)
		.join(" and ");
const told = ({ minted, request, now }: Variant): string =>
	[
		minted ? `The hub minted the ticket with ${shown(minted)}.` : "",
		request ? `The request has ${shown(request)}.` : "",
		now === undefined ? "" : `The broker's clock reads ${now}.`,
	]
		.filter(Boolean)
		.join(" ");

function vector(id: string, expected: TicketMismatch | null, variant: Variant, text?: string) {
	const minted = variant.minted === null ? null : { ...ticket, ...variant.minted };
	const request = { ...sent, ticket: minted ?? ticket, ...variant.request };
	const now = variant.now ?? MINTED_AT;
	const bytes = new TextEncoder().encode(request.body);
	const found = (minted ?? undefined) as SendTicket | undefined;
	const reason = ticketMismatch(found, { ...request, body: bytes }, now) ?? null;
	if (reason !== expected) throw new Error(`send-ticket ${id}: ${reason}, not ${expected}`);
	const { ticket: given, body: _, ...rest } = request;
	const shownRequest = given === undefined ? rest : { ticket: given, ...rest };
	return {
		id,
		description: text ?? told(variant),
		ticket: minted,
		request: { ...shownRequest, bodyHex: Buffer.from(bytes).toString("hex") },
		now,
		computed: {
			presentedId: presentedTicketId(request.ticket) ?? null,
			headersSha256: headersSha256(request.headers),
			bodySha256: sha256Hex(bytes),
		},
		matches: reason === null,
		reason,
	};
}

const [UNKNOWN, INVALID, ALTERED, EXPIRED, INSTANCE, METHOD, URL, CONTENT_TYPE, HEADERS, BODY] =
	TICKET_CHECKS;
const otherHeaders = Object.entries({ "Content-Type": json, Accept: "application/jsom" });
// One way to fail each check alone. Each two adjacent ones combine into a case that fails both.
const failures: Record<TicketMismatch, [Variant, string]> = {
	[UNKNOWN]: [{ minted: null }, "no unburned ticket has the presented id"],
	[INVALID]: [{ now: 1.5 }, "the broker's clock reads 1.5"],
	[ALTERED]: [
		{ request: { ticket: { ...ticket, outboxId: lastChanged(outboxId, "D") } } },
		"the plugin presents the ticket with another outboxId",
	],
	[EXPIRED]: [{ now: ticket.exp + 1 }, "the clock reads 1 ms after exp"],
	[INSTANCE]: [{ request: { instanceId: lastChanged(instanceId, "7") } }, "another instance sends"],
	[METHOD]: [{ request: { method: "PUT" } }, "the method is PUT"],
	[URL]: [{ request: { url: url.replace("conv-1", "conv-2") } }, "the URL names conv-2"],
	[CONTENT_TYPE]: [{ request: { contentType: "text/plain" } }, "the plugin gives text/plain"],
	[HEADERS]: [{ request: { headers: otherHeaders } }, "the rendered Accept value differs"],
	[BODY]: [{ request: { body: body.replace("hello", "jello") } }, "a body byte differs"],
};
const sentence = (text: string): string => `${text[0]?.toUpperCase()}${text.slice(1)}.`;
const slug = (code: string): string =>
	code.slice("TICKET_".length).toLowerCase().replaceAll("_", "-");
const alone = (id: string, code: TicketMismatch) =>
	vector(id, code, failures[code][0], sentence(failures[code][1]));
const pairs = TICKET_CHECKS.slice(1).map((second, index) => {
	const first = TICKET_CHECKS[index] ?? UNKNOWN;
	const [[a, told1], [b, told2]] = [failures[first], failures[second]];
	const both = { ...a, ...b, request: { ...a.request, ...b.request } };
	return vector(
		`${slug(first)}-before-${slug(second)}`,
		first,
		both,
		sentence(`${told1}, and ${told2}`),
	);
});

const presented = (field: string, value: unknown) =>
	vector(
		`presented-${field.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-changed`,
		field === "id" ? UNKNOWN : ALTERED,
		{ minted: field === "id" ? null : {}, request: { ticket: { ...ticket, [field]: value } } },
		`The plugin presents the ticket with ${shown({ [field]: value })}.`,
	);
// A ticket for a non-canonical URL can't be minted; the request goes where the ticket says.
const mintedFor = (id: string, to: string) =>
	vector(`minted-url-${id}`, INVALID, { minted: { url: to }, request: { url: to } });
// Rendered headers that hash to the ticket's headersSha256 but don't hold its content type once.
const renderedWith = (id: string, list: [string, string][]) =>
	vector(`rendered-content-type-${id}`, HEADERS, {
		minted: { headersSha256: headersSha256(list) },
		request: { headers: list },
	});
const reordered = headers.map(([name, value]): [string, string] => [name.toUpperCase(), value]);

const cases = [
	vector("match", null, {}, "The request the ticket was minted for, when it was minted."),
	vector("match-at-exp", null, { now: ticket.exp }, "The same request at exp, 60 s after minting."),
	vector("expired-1-ms-after-exp", EXPIRED, { now: ticket.exp + 1 }),
	vector("match-at-capped-exp", null, { minted: { exp: capped }, now: capped }),
	vector("expired-1-ms-after-capped-exp", EXPIRED, { minted: { exp: capped }, now: capped + 1 }),
	vector("headers-in-other-order-and-case", null, { request: { headers: reordered.reverse() } }),
	vector(
		"presented-members-in-other-order",
		null,
		{ request: { ticket: Object.fromEntries(Object.entries(ticket).reverse()) } },
		"The plugin presents the ticket's members in reverse order.",
	),
	vector("match-with-port-and-encoded-reserved", null, {
		minted: { url: url.replace(".example/", ".example:8443/").replace("conv-1", "a%2Fb") },
		request: { url: url.replace(".example/", ".example:8443/").replace("conv-1", "a%2Fb") },
	}),
	vector(
		"unticketed",
		UNKNOWN,
		{ minted: null, request: { ticket: undefined } },
		"The plugin presents no ticket.",
	),
	vector(
		"presented-not-a-ticket",
		UNKNOWN,
		{ minted: null, request: { ticket: ticket.id } },
		"The plugin presents the ticket's id alone, which names no ticket.",
	),
	vector("replayed-after-burn", UNKNOWN, { minted: null }, "The match again, after it burned."),
	...Object.entries({
		id: lastChanged(ticket.id, "5"),
		outboxId: lastChanged(outboxId, "D"),
		instanceId: lastChanged(instanceId, "7"),
		method: "POSt",
		url: url.replace("conv-1", "conv-2"),
		headersSha256: otherHex(ticket.headersSha256),
		contentType: "application/jsom",
		bodySha256: otherHex(ticket.bodySha256),
		exp: ticket.exp + 1,
		note: "x",
	}).map(([field, value]) => presented(field, value)),
	vector("minted-ticket-extra-member", INVALID, { minted: { note: "x" } }),
	vector("minted-content-type-trailing-line-feed", INVALID, {
		minted: { contentType: `${json}\n` },
	}),
	alone("clock-not-an-integer", INVALID),
	mintedFor("http", url.replace("https:", "http:")),
	mintedFor("dot-segment", url.replace("conv-1", "..")),
	mintedFor("encoded-dot-segment", url.replace("conv-1", "%2E%2E")),
	mintedFor("lower-case-encoding", url.replace("conv-1", "%2e%2e")),
	mintedFor("encoded-unreserved", url.replace("conv-1", "conv%2D1")),
	mintedFor("userinfo", url.replace("://", "://dytest@")),
	mintedFor("upper-case-host", url.replace("hello", "Hello")),
	mintedFor("port-443", url.replace(origin, `${origin}:443`)),
	mintedFor("ip-address", url.replace("hello.draftyak.example", "192.0.2.10")),
	mintedFor("quote-in-query", `${url}&q="x"`),
	mintedFor("fragment", `${url}#top`),
	mintedFor("trailing-line-feed", `${url}\n`),
	alone("request-from-another-instance", INSTANCE),
	vector("method-byte-changed", METHOD, { request: { method: "POSt" } }),
	alone("url-path-byte-changed", URL),
	vector("url-host-letter-upper-case", URL, { request: { url: url.replace("hello", "Hello") } }),
	vector("url-query-byte-changed", URL, { request: { url: lastChanged(url, "D") } }),
	vector("url-dot-segment-added", URL, { request: { url: url.replace("1/", "1/x/../") } }),
	vector("content-type-byte-changed", CONTENT_TYPE, {
		request: { contentType: "application/jsom" },
	}),
	vector("content-type-case-changed", CONTENT_TYPE, {
		request: { contentType: "Application/json" },
	}),
	vector("content-type-parameter-added", CONTENT_TYPE, {
		request: { contentType: `${json}; charset=utf-8` },
	}),
	alone("header-value-byte-changed", HEADERS),
	vector("header-added", HEADERS, { request: { headers: [...headers, ["X-Extra", "1"]] } }),
	vector("header-removed", HEADERS, { request: { headers: headers.slice(0, 1) } }),
	vector("header-repeated", HEADERS, { request: { headers: [...headers, ["Accept", json]] } }),
	vector("minted-headers-sha256-changed", HEADERS, {
		minted: { headersSha256: otherHex(ticket.headersSha256) },
	}),
	renderedWith("differs", Object.entries({ "Content-Type": "text/plain", Accept: json })),
	renderedWith("missing", headers.slice(1)),
	renderedWith("repeated", [...headers, ["content-type", json]]),
	alone("body-byte-changed", BODY),
	vector("body-trailing-line-feed", BODY, { request: { body: `${body}\n` } }),
	vector("body-empty", BODY, { request: { body: "" } }),
	vector("minted-body-sha256-changed", BODY, {
		minted: { bodySha256: otherHex(ticket.bodySha256) },
	}),
	...pairs,
];

// exp = min(mintedAt + ttlMs, deliverBy), so no ticket outlives its item's window.
const expiry = Object.entries({
	"deliver-by-after-ttl": DELIVER_BY,
	"deliver-by-at-ttl": MINTED_AT + SEND_TICKET_TTL_MS,
	"deliver-by-within-ttl": MINTED_AT + 30_000,
	"deliver-by-at-minting": MINTED_AT,
}).map(([id, deliverBy]) => ({
	id,
	mintedAt: MINTED_AT,
	deliverBy,
	exp: sendTicketExp(MINTED_AT, deliverBy),
}));

export function generate(): VectorFile[] {
	const description =
		"Broker send tickets. The broker looks the presented ticket's id (`computed.presentedId`) " +
		"up among the tickets it minted and hasn't burned: `ticket` is the one it found, or null. " +
		"`request.ticket` is what the plugin presented, from channel_send's " +
		`_meta["${SEND_TICKET_META}"] through host/fetch's sendTicket, absent when it presented ` +
		"none; `request.contentType` is the Content-Type the plugin gave, `request.headers` the " +
		"hub-rendered headers the broker sends and `request.bodyHex` the exact body; `now` is the " +
		"broker's clock in UTC ms. `reason` names the first of `checks` that fails, or is null: a " +
		"ticket was found; it is a SendTicket and now a safe integer; the presented ticket is " +
		"JCS-equal to it; now <= exp; instanceId, method, url and contentType equal byte for byte; " +
		"headersSha256 equals headersSha256(request.headers), and those headers hold exactly one " +
		"content-type, equal to the ticket's; bodySha256 equals the SHA-256 of the body. The " +
		"broker burns every ticket it found, and the reasons in `disablesPlugin` also disable the " +
		"plugin. `expiry` gives exp: the earlier of mintedAt + ttlMs and the item's deliverBy.";
	return [
		{
			path: "send-ticket/broker.json",
			content: {
				format: "draftyak.vectors.send-ticket.v1",
				description,
				metaKey: SEND_TICKET_META,
				ttlMs: SEND_TICKET_TTL_MS,
				checks: TICKET_CHECKS,
				disablesPlugin: TICKET_DISABLES_PLUGIN,
				expiry,
				cases,
			},
		},
	];
}
