import { Validator } from "@cfworker/json-schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type HeaderList, headersSha256, sha256Hex } from "../src/hash.ts";
import { canonicalize } from "../src/jcs.ts";
import {
	presentedTicketId,
	SEND_TICKET_META,
	SEND_TICKET_TTL_MS,
	SendTicket,
	SendUrl,
	sendTicketExp,
	TICKET_CHECKS,
	TICKET_DISABLES_PLUGIN,
	type TicketedRequest,
	type TicketMismatch,
	ticketMatches,
	ticketMismatch,
} from "../src/send-ticket.ts";
import { agree, committed, withMember } from "./plugin-contracts.ts";
import { vectorFiles } from "./vectors.ts";

interface TicketCase {
	readonly id: string;
	readonly description: string;
	readonly ticket: SendTicket | null;
	readonly request: Omit<TicketedRequest, "body" | "headers"> & {
		readonly headers: [string, string][];
		readonly bodyHex: string;
	};
	readonly now: number;
	readonly computed: {
		readonly presentedId: string | null;
		readonly headersSha256: string;
		readonly bodySha256: string;
	};
	readonly matches: boolean;
	readonly reason: TicketMismatch | null;
}
interface TicketVectors {
	readonly format: string;
	readonly metaKey: string;
	readonly ttlMs: number;
	readonly checks: string[];
	readonly disablesPlugin: string[];
	readonly expiry: { id: string; mintedAt: number; deliverBy: number; exp: number }[];
	readonly cases: TicketCase[];
}

const vectors = vectorFiles<TicketVectors>("send-ticket").find(
	([file]) => file === "broker.json",
)?.[1];
if (vectors === undefined) throw new Error("spec/vectors/send-ticket/broker.json is missing");
const requestOf = ({ request }: TicketCase): TicketedRequest => {
	const { bodyHex, ...rest } = request;
	return { ...rest, body: new Uint8Array(Buffer.from(bodyHex, "hex")) };
};
const mintedOf = ({ ticket }: TicketCase): SendTicket | undefined => ticket ?? undefined;
const [match] = vectors.cases;
if (match?.id !== "match" || match.ticket === null) {
	throw new Error("the first send-ticket case is the match");
}
const matchTicket: SendTicket = match.ticket;

const sameJson = (a: unknown, b: unknown): boolean => {
	try {
		return canonicalize(a) === canonicalize(b);
	} catch {
		return false;
	}
};

// Every check a case fails on its own, in order; ticketMismatch names only the first.
function failing(item: TicketCase): TicketMismatch[] {
	const minted = item.ticket;
	const request = requestOf(item);
	const failed: TicketMismatch[] = [];
	if (minted === null) failed.push("TICKET_UNKNOWN");
	const invalid = minted !== null && !SendTicket.safeParse(minted).success;
	if (invalid || !Number.isSafeInteger(item.now)) failed.push("TICKET_INVALID");
	if (minted === null) return failed;
	const types = request.headers.filter(([name]) => name.toLowerCase() === "content-type");
	const checks: [TicketMismatch, boolean][] = [
		["TICKET_ALTERED", !sameJson(request.ticket, minted)],
		["TICKET_EXPIRED", item.now > minted.exp],
		["TICKET_INSTANCE_MISMATCH", request.instanceId !== minted.instanceId],
		["TICKET_METHOD_MISMATCH", request.method !== minted.method],
		["TICKET_URL_MISMATCH", request.url !== minted.url],
		["TICKET_CONTENT_TYPE_MISMATCH", request.contentType !== minted.contentType],
		[
			"TICKET_HEADERS_MISMATCH",
			headersSha256(request.headers) !== minted.headersSha256 ||
				types.length !== 1 ||
				types[0]?.[1] !== minted.contentType,
		],
		["TICKET_BODY_MISMATCH", sha256Hex(request.body) !== minted.bodySha256],
	];
	return [...failed, ...checks.filter(([, fails]) => fails).map(([code]) => code)];
}

describe("the send-ticket vectors", () => {
	it("name the _meta key, the lifetime, the order of the checks and what disables a plugin", () => {
		expect(vectors.format).toBe("draftyak.vectors.send-ticket.v1");
		expect(vectors.metaKey).toBe(SEND_TICKET_META);
		expect(vectors.ttlMs).toBe(SEND_TICKET_TTL_MS);
		expect(vectors.checks).toEqual([...TICKET_CHECKS]);
		expect(vectors.disablesPlugin).toEqual([...TICKET_DISABLES_PLUGIN]);
	});

	it("cover a match, one changed byte in each field, reordered headers, expiry and replays", () => {
		const ids = new Set(vectors.cases.map(({ id }) => id));
		expect(ids.size).toBe(vectors.cases.length);
		const fields = ["id", "outbox-id", "instance-id", "method", "url", "headers-sha256"];
		const required = [
			"match",
			"match-at-exp",
			"match-at-capped-exp",
			"headers-in-other-order-and-case",
			"expired-1-ms-after-exp",
			"expired-1-ms-after-capped-exp",
			"unticketed",
			"replayed-after-burn",
			...[...fields, "content-type", "body-sha256", "exp"].map(
				(field) => `presented-${field}-changed`,
			),
			"request-from-another-instance",
			"method-byte-changed",
			"url-path-byte-changed",
			"content-type-byte-changed",
			"content-type-case-changed",
			"header-value-byte-changed",
			"rendered-content-type-differs",
			"body-byte-changed",
			"minted-headers-sha256-changed",
			"minted-body-sha256-changed",
			"minted-url-dot-segment",
			"minted-url-encoded-dot-segment",
			"minted-url-userinfo",
			"minted-url-upper-case-host",
			"minted-url-trailing-line-feed",
		];
		for (const id of required) expect(ids, id).toContain(id);
		expect(new Set(vectors.cases.map(({ reason }) => reason))).toEqual(
			new Set([null, ...TICKET_CHECKS]),
		);
	});

	it.each(vectors.cases.map((item) => [item.id, item] as const))("broker.json: %s", (_, item) => {
		const request = requestOf(item);
		expect(item.computed).toEqual({
			presentedId: presentedTicketId(request.ticket) ?? null,
			headersSha256: headersSha256(request.headers),
			bodySha256: sha256Hex(request.body),
		});
		if (item.ticket !== null) expect(item.ticket.id).toBe(item.computed.presentedId);
		expect(ticketMismatch(mintedOf(item), request, item.now) ?? null).toBe(item.reason);
		expect(ticketMatches(mintedOf(item), request, item.now)).toBe(item.matches);
		expect(item.matches).toBe(item.reason === null);
		expect(failing(item)[0] ?? null).toBe(item.reason);
	});

	it("pin the order: each two adjacent checks fail together in a case naming the first", () => {
		for (const [index, first] of TICKET_CHECKS.entries()) {
			const second = TICKET_CHECKS[index + 1];
			if (second === undefined) continue;
			const pinned = vectors.cases.filter(
				(item) => item.reason === first && failing(item).join() === [first, second].join(),
			);
			expect(
				pinned.map(({ id }) => id),
				`${first} before ${second}`,
			).toHaveLength(1);
		}
	});

	it("give exp as the earlier of minting plus the TTL and deliverBy", () => {
		expect(vectors.expiry.map(({ id }) => id)).toContain("deliver-by-within-ttl");
		for (const { mintedAt, deliverBy, exp } of vectors.expiry) {
			expect(sendTicketExp(mintedAt, deliverBy)).toBe(exp);
			expect(exp).toBe(Math.min(mintedAt + vectors.ttlMs, deliverBy));
		}
	});
});

const nameChar = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-_!#$%&'*+.^`|~");
const valueChar = fc.integer({ min: 0x21, max: 0x7e }).map((code) => String.fromCharCode(code));
const headerName = fc
	.array(nameChar, { minLength: 1, maxLength: 12 })
	.map((chars) => chars.join(""))
	.filter((name) => name !== "content-type");
const headerValue = fc.array(valueChar, { minLength: 1, maxLength: 16 }).map((c) => c.join(""));

describe("ticketMismatch", () => {
	const ticket = matchTicket;
	const request = requestOf(match);

	it("never lets a ticket outlive the TTL or deliverBy (1,000 runs)", () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 60_000, max: 2 ** 50 }),
				fc.integer({ min: -60_000, max: 1_000_000 }),
				(mintedAt, window) => {
					const exp = sendTicketExp(mintedAt, mintedAt + window);
					expect(exp).toBe(Math.min(mintedAt + SEND_TICKET_TTL_MS, mintedAt + window));
					const minted = { ...ticket, exp };
					const sent = { ...request, ticket: minted };
					expect(ticketMismatch(minted, sent, exp)).toBeUndefined();
					expect(ticketMismatch(minted, sent, exp + 1)).toBe("TICKET_EXPIRED");
				},
			),
			{ numRuns: 1000 },
		);
	});

	it("ignores the order of headers and the case of every letter in their names (1,000 runs)", () => {
		const rendered = fc
			.array(fc.tuple(headerName, headerValue), { maxLength: 10 })
			.map((others): [string, string][] => [["content-type", ticket.contentType], ...others]);
		const sentAs = rendered.chain((list) =>
			fc.tuple(
				fc.constant(list),
				fc.shuffledSubarray(list, { minLength: list.length, maxLength: list.length }),
				fc.infiniteStream(fc.boolean()),
			),
		);
		fc.assert(
			fc.property(sentAs, ([list, shuffled, upper]) => {
				const minted = { ...ticket, headersSha256: headersSha256(list) };
				const headers = shuffled.map(([name, value]): [string, string] => [
					[...name].map((c) => (upper.next().value === true ? c.toUpperCase() : c)).join(""),
					value,
				]);
				const sent = { ...request, ticket: minted, headers };
				expect(ticketMismatch(minted, sent, match.now)).toBeUndefined();
				const changed = headers.map(([name, value], i): [string, string] => [
					name,
					i === headers.length - 1 ? `${value}x` : value,
				]);
				expect(ticketMismatch(minted, { ...sent, headers: changed }, match.now)).toBe(
					"TICKET_HEADERS_MISMATCH",
				);
			}),
			{ numRuns: 1000 },
		);
	});

	it("refuses a body with any one byte changed (1,000 runs)", () => {
		fc.assert(
			fc.property(
				fc.nat({ max: request.body.length - 1 }),
				fc.integer({ min: 1, max: 255 }),
				(at, xor) => {
					const body = request.body.slice();
					body[at] = (body[at] ?? 0) ^ xor;
					expect(ticketMismatch(ticket, { ...request, body }, match.now)).toBe(
						"TICKET_BODY_MISMATCH",
					);
				},
			),
			{ numRuns: 1000 },
		);
	});

	it("refuses a URL with any one character changed (1,000 runs)", () => {
		fc.assert(
			fc.property(
				fc.nat({ max: request.url.length - 1 }),
				fc.constantFrom("x", "X", "%", "/"),
				(at, to) => {
					fc.pre(request.url[at] !== to);
					const url = `${request.url.slice(0, at)}${to}${request.url.slice(at + 1)}`;
					expect(ticketMismatch(ticket, { ...request, url }, match.now)).toBe(
						"TICKET_URL_MISMATCH",
					);
				},
			),
			{ numRuns: 1000 },
		);
	});

	it("fails closed on tickets, headers, bodies and clocks that aren't what they claim", () => {
		expect(ticketMismatch(undefined, request, match.now)).toBe("TICKET_UNKNOWN");
		const crlf: HeaderList = [...request.headers, ["Accept", "application/json\r\nX: 1"]];
		expect(ticketMismatch(ticket, { ...request, headers: crlf }, match.now)).toBe(
			"TICKET_HEADERS_MISMATCH",
		);
		const notHeaders = "content-type: application/json" as unknown as HeaderList;
		expect(ticketMismatch(ticket, { ...request, headers: notHeaders }, match.now)).toBe(
			"TICKET_HEADERS_MISMATCH",
		);
		const text = Buffer.from(request.body).toString("utf8") as unknown as Uint8Array;
		expect(ticketMismatch(ticket, { ...request, body: text }, match.now)).toBe(
			"TICKET_BODY_MISMATCH",
		);
		for (const now of [Number.NaN, 1.5, -0.5]) {
			expect(ticketMismatch(ticket, request, now)).toBe("TICKET_INVALID");
		}
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(ticketMismatch(ticket, { ...request, ticket: cyclic }, match.now)).toBe(
			"TICKET_ALTERED",
		);
		const { ticket: _, ...unticketed } = request;
		expect(ticketMismatch(ticket, unticketed as TicketedRequest, match.now)).toBe("TICKET_ALTERED");
	});

	it("looks a ticket up only by the id it presents", () => {
		expect(presentedTicketId(ticket)).toBe(ticket.id);
		for (const presented of [undefined, null, ticket.id, [ticket], { id: 7 }, {}]) {
			expect(presentedTicketId(presented)).toBeUndefined();
		}
	});
});

// URLs built only from what SendUrl's pattern allows, with no dot segment and no port 443.
const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
const encoded = fc
	.integer({ min: 0, max: 255 })
	.filter((byte) => !unreserved.includes(String.fromCharCode(byte)))
	.map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`);
const pathChar = fc.oneof(fc.constantFrom(...`${unreserved}!$&'()*+,;=:@`), encoded);
const queryChar = fc.oneof(fc.constantFrom(...`${unreserved}!$&()*+,;=:@/?`), encoded);
const segment = fc
	.array(pathChar, { maxLength: 6 })
	.map((chars) => chars.join(""))
	.filter((text) => text !== "." && text !== "..");
const label = fc
	.stringMatching(/^[a-z0-9](?:[a-z0-9-]{0,8}[a-z0-9])?$/)
	.filter((text) => !text.startsWith("xn--"));
const lastLabel = fc
	.stringMatching(/^[a-z](?:[a-z0-9-]{0,8}[a-z0-9])?$/)
	.filter((text) => !text.startsWith("xn--"));
const canonicalUrl = fc
	.record({
		host: fc.tuple(fc.array(label, { maxLength: 3 }), lastLabel),
		port: fc.option(fc.integer({ min: 1, max: 65_535 }).filter((port) => port !== 443)),
		path: fc.array(segment, { minLength: 1, maxLength: 4 }),
		query: fc.option(fc.array(queryChar, { minLength: 1, maxLength: 8 })),
	})
	.map(({ host: [labels, last], port, path, query }) => {
		const authority = [...labels, last].join(".") + (port === null ? "" : `:${port}`);
		return `https://${authority}/${path.join("/")}${query === null ? "" : `?${query.join("")}`}`;
	});

describe("SendUrl", () => {
	const ticket = matchTicket;
	const schema = committed("schemas/broker-ticket-v1.schema.json");

	it("accepts only URLs a WHATWG parser, as fetch uses, leaves unchanged (1,000 runs)", () => {
		fc.assert(
			fc.property(canonicalUrl, (url) => {
				expect(new URL(url).href).toBe(url);
				expect(SendUrl.safeParse(url).success).toBe(true);
			}),
			{ numRuns: 1000 },
		);
	});

	it("refuses dot segments, port 443 and out-of-range ports, which only its validator can tell", () => {
		const document = new Validator(schema, "2020-12", false);
		const base = "https://hello.draftyak.example";
		for (const url of [
			`${base}/v1/conversations/../messages`,
			`${base}/v1/./messages`,
			`${base}/v1/messages/..`,
			`${base}:443/v1/messages`,
			`${base}:65536/v1/messages`,
		]) {
			expect(SendUrl.safeParse(url).success, url).toBe(false);
			expect(document.validate(withMember(ticket, "url", url)).valid, url).toBe(true);
		}
	});

	it("agrees with spec/schemas/broker-ticket-v1.schema.json", () => {
		const { exp: _, ...withoutExp } = ticket;
		const url = (to: string) => withMember(ticket, "url", to);
		agree(
			SendTicket,
			schema,
			[
				ticket,
				withMember(ticket, "method", "PUT"),
				withMember(ticket, "method", "PATCH"),
				url("https://hello.draftyak.example:8443/v1/team%2Fconv-1/messages"),
				url("https://xn--80ak6aa92e.xn--p1ai/v1/it's/(1)*?a=b&c=%27"),
			],
			[
				withMember(ticket, "note", "x"),
				withMember(ticket, "method", "GET"),
				withMember(ticket, "method", "post"),
				url(ticket.url.replace("https:", "http:")),
				url(`${ticket.url}#top`),
				url(`${ticket.url}\n`),
				url(ticket.url.replace("conv-1", "conv 1")),
				url(ticket.url.replace("conv-1", "%2e%2e")),
				url(ticket.url.replace("conv-1", "%2E%2E")),
				url(ticket.url.replace("conv-1", "conv%2D1")),
				url(ticket.url.replace("hello", "Hello")),
				url(ticket.url.replace("://", "://dytest@")),
				url(ticket.url.replace("hello.draftyak.example", "192.0.2.10")),
				url(ticket.url.replace("hello.draftyak.example", "hello.draftyak.example.")),
				url(`${ticket.url}&q="x"`),
				url(`${ticket.url}&q='x'`),
				url("https://hello.draftyak.example"),
				url("https://hello.draftyak.example/?"),
				url(`https://x.example/${"a".repeat(8_192)}`),
				withMember(ticket, "headersSha256", ticket.headersSha256.toUpperCase()),
				withMember(ticket, "bodySha256", ticket.bodySha256.slice(1)),
				withMember(ticket, "contentType", " application/json"),
				withMember(ticket, "contentType", "application/json\n"),
				withMember(ticket, "contentType", ""),
				withMember(ticket, "exp", 1.5),
				withMember(ticket, "exp", -1),
				withMember(ticket, "id", "not-a-ulid"),
				withoutExp,
			],
		);
	});
});
