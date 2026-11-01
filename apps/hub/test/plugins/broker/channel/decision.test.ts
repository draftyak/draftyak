import type { HeaderList } from "@draftyak/protocol/hash";
import type { ChannelProfile } from "@draftyak/protocol/manifest";
import { TICKET_CHECKS, TICKET_DISABLES_PLUGIN } from "@draftyak/protocol/send-ticket";
import { describe, expect, it } from "vitest";
import { unavailable } from "../../../../src/outbox/ticket-storage.ts";
import { SendTicketRefusal } from "../../../../src/outbox/tickets.ts";
import {
	CHANNEL_DENIAL_CODES,
	type ChannelBinding,
	type ChannelDecision,
	type ChannelRequest,
	type ChannelTicket,
	type ChannelTicketReason,
	decideChannelRequest,
	refusedChannelTicket,
} from "../../../../src/plugins/broker/channel/index.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const UPLOAD_SEND =
	"https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart";
const JSON_SEND = `${GMAIL}/messages/send`;
const SLACK_SEND = "https://slack.com/api/chat.postMessage";
const ABSENT: ChannelTicket = { state: "absent" };
const REDEEMED: ChannelTicket = { state: "redeemed" };
const full = (profile: ChannelProfile): ChannelBinding => ({ profile, accountMode: "full" });
const readOnly = (profile: ChannelProfile): ChannelBinding => ({
	profile,
	accountMode: "read_only",
});
const request = (method: string, url: string, headers: HeaderList = []): ChannelRequest => ({
	method,
	url,
	headers,
});
const denied = (code: string, disablePlugin = false): ChannelDecision =>
	({ allowed: false, code, disablePlugin }) as ChannelDecision;
const refused = (reason: ChannelTicketReason): ChannelTicket => ({ state: "refused", reason });

function decide(binding: ChannelBinding, asked: ChannelRequest, ticket: ChannelTicket) {
	const decision = decideChannelRequest(binding, asked, ticket);
	expect(Object.isFrozen(decision)).toBe(true);
	if (decision.allowed) {
		expect(Object.isFrozen(decision.headers)).toBe(true);
		for (const row of decision.headers) expect(Object.isFrozen(row)).toBe(true);
	}
	return decision;
}

// Written out rather than derived, so the mapping and the disable set are both checked.
const TICKET_OUTCOMES: readonly (readonly [ChannelTicketReason, string, boolean])[] = [
	["TICKET_UNKNOWN", "ticket_unknown", true],
	["TICKET_INVALID", "ticket_invalid", false],
	["TICKET_ALTERED", "ticket_altered", true],
	["TICKET_EXPIRED", "ticket_expired", false],
	["TICKET_INSTANCE_MISMATCH", "ticket_instance_mismatch", true],
	["TICKET_METHOD_MISMATCH", "ticket_method_mismatch", true],
	["TICKET_URL_MISMATCH", "ticket_url_mismatch", true],
	["TICKET_CONTENT_TYPE_MISMATCH", "ticket_content_type_mismatch", true],
	["TICKET_HEADERS_MISMATCH", "ticket_headers_mismatch", false],
	["TICKET_BODY_MISMATCH", "ticket_body_mismatch", true],
	["SEND_STATE_CHANGED", "ticket_state_changed", false],
	["UNAVAILABLE", "ticket_unavailable", false],
];

describe("unticketed requests", () => {
	it("allows a read with only the allowlisted plugin headers", () => {
		const href = `${GMAIL}/messages?q=in%3Ainbox`;
		expect(
			decide(
				full("gmail-v1"),
				request("GET", href, [
					["Accept", "application/json"],
					["Authorization", "Bearer DYTEST-plugin"],
					["X-Goog-Api-Key", "DYTEST-key"],
				]),
				ABSENT,
			),
		).toEqual({
			allowed: true,
			class: "read",
			method: "GET",
			url: href,
			headers: [["accept", "application/json"]],
			ticketed: false,
		});
	});

	it("allows reads on every profile and on read-only accounts", () => {
		for (const [profile, method, href] of [
			["gmail-v1", "GET", `${GMAIL}/threads/18c2f0a1b2c3d4e5`],
			["gmail-readonly-v1", "GET", `${GMAIL}/history?startHistoryId=7`],
			["slack-v1", "POST", "https://slack.com/api/conversations.history"],
			["slack-v1", "GET", "https://slack.com/api/apps.connections.open"],
		] as const)
			for (const binding of [full(profile), readOnly(profile)])
				expect(decide(binding, request(method, href), ABSENT)).toMatchObject({
					allowed: true,
					class: "read",
					ticketed: false,
				});
	});

	it("allows organize only on a full-mode gmail-v1 account", () => {
		const modify = request("POST", `${GMAIL}/messages/batchModify`, [
			["content-type", "application/json"],
		]);
		expect(decide(full("gmail-v1"), modify, ABSENT)).toEqual({
			allowed: true,
			class: "organize",
			method: "POST",
			url: `${GMAIL}/messages/batchModify`,
			headers: [["content-type", "application/json"]],
			ticketed: false,
		});
		expect(decide(readOnly("gmail-v1"), modify, ABSENT)).toEqual(denied("account_read_only"));
		expect(decide(full("gmail-readonly-v1"), modify, ABSENT)).toEqual(denied("off_profile"));
		expect(decide(readOnly("gmail-readonly-v1"), modify, ABSENT)).toEqual(denied("off_profile"));
	});

	it("denies an unticketed send and disables the plugin on every profile", () => {
		for (const [profile, method, href] of [
			["gmail-v1", "POST", JSON_SEND],
			["gmail-v1", "POST", UPLOAD_SEND],
			["gmail-v1", "GET", JSON_SEND],
			["gmail-v1", "POST", `${GMAIL}/drafts/send`],
			["gmail-readonly-v1", "POST", UPLOAD_SEND],
			["gmail-readonly-v1", "POST", JSON_SEND],
			["slack-v1", "POST", SLACK_SEND],
			["slack-v1", "GET", `${SLACK_SEND}?channel=C0123&text=hi`],
			["gmail-v1", "POST", `${JSON_SEND}?$alt=json`],
			["gmail-readonly-v1", "POST", `${UPLOAD_SEND}&access_token=DYTEST-token`],
			["slack-v1", "POST", `${SLACK_SEND}?token=DYTEST-token`],
		] as const)
			for (const binding of [full(profile), readOnly(profile)])
				expect(
					decide(binding, request(method, href, [["content-type", "application/json"]]), ABSENT),
				).toEqual(denied("ticket_missing", true));
	});

	it("passes classification denials through without disabling the plugin", () => {
		for (const [profile, method, href, code] of [
			["gmail-v1", "POST", "https://www.googleapis.com/batch/gmail/v1", "gmail_batch"],
			["gmail-v1", "POST", `${GMAIL}/messages/18c2/trash`, "off_profile"],
			["gmail-v1", "GET", `${GMAIL}/messages?$alt=media`, "system_parameter"],
			["gmail-v1", "GET", `${GMAIL}/messages?access_token=DYTEST-token`, "query_credential"],
			["slack-v1", "POST", "https://slack.com/api/chat.scheduleMessage", "slack_scheduling"],
			["slack-v1", "POST", "https://slack.com/api/auth.revoke", "hub_only"],
			["slack-v1", "POST", "https://slack.com/api/chat.update", "off_profile"],
			["slack-v1", "GET", "https://slack.com/api/auth.test?token=DYTEST-token", "query_credential"],
		] as const)
			expect(decide(full(profile), request(method, href), ABSENT)).toEqual(denied(code));
	});

	it("denies invalid methods and non-canonical URLs", () => {
		for (const method of ["get", "CONNECT", "TRACE", "", undefined, 1, null])
			expect(
				decide(full("gmail-v1"), request(method as string, `${GMAIL}/messages`), ABSENT),
			).toEqual(denied("method_invalid"));
		for (const href of [
			"http://gmail.googleapis.com/gmail/v1/users/me/messages",
			"https://gmail.googleapis.com:8443/gmail/v1/users/me/messages",
			"https://localhost/gmail/v1/users/me/messages",
			`${GMAIL}/messages#top`,
			`${GMAIL}/messages/a%2Fb`,
			42,
			undefined,
		])
			expect(decide(full("gmail-v1"), request("GET", href as string), ABSENT)).toEqual(
				denied("url_invalid"),
			);
	});

	it("refuses method override headers and invalid header lists", () => {
		const href = "https://slack.com/api/conversations.history";
		expect(
			decide(full("slack-v1"), request("POST", href, [["X-HTTP-Method-Override", "GET"]]), ABSENT),
		).toEqual(denied("method_override"));
		expect(
			decide(full("slack-v1"), request("POST", href, [["accept", "a\r\nx: y"]]), ABSENT),
		).toEqual(denied("headers_invalid"));
		expect(
			decide(full("slack-v1"), { method: "POST", url: href } as unknown as ChannelRequest, ABSENT),
		).toEqual(denied("headers_invalid"));
	});
});

describe("ticketed requests", () => {
	it("admits the send a redeemed ticket matched, with none of the plugin's headers", () => {
		const hostile: HeaderList = [
			["Content-Type", "application/json"],
			["Authorization", "Bearer DYTEST-plugin"],
			["X-HTTP-Method-Override", "DELETE"],
			["Cookie", "sid=DYTEST-cookie"],
		];
		for (const [profile, href] of [
			["gmail-v1", JSON_SEND],
			["gmail-v1", UPLOAD_SEND],
			["slack-v1", SLACK_SEND],
		] as const)
			expect(decide(full(profile), request("POST", href, hostile), REDEEMED)).toEqual({
				allowed: true,
				class: "send",
				method: "POST",
				url: href,
				headers: [],
				ticketed: true,
			});
		expect(
			decide(
				full("slack-v1"),
				{ method: "POST", url: SLACK_SEND, headers: "junk" } as unknown as ChannelRequest,
				REDEEMED,
			),
		).toMatchObject({ allowed: true, headers: [], ticketed: true });
	});

	it("never admits a redeemed ticket for a request its profile or account doesn't allow", () => {
		for (const [binding, method, href, code] of [
			[full("gmail-readonly-v1"), "POST", UPLOAD_SEND, "ticket_off_profile"],
			[full("gmail-v1"), "GET", `${GMAIL}/messages`, "ticket_off_profile"],
			[full("gmail-v1"), "POST", `${GMAIL}/messages/batchModify`, "ticket_off_profile"],
			[
				full("slack-v1"),
				"POST",
				"https://slack.com/api/conversations.history",
				"ticket_off_profile",
			],
			[readOnly("gmail-v1"), "POST", UPLOAD_SEND, "account_read_only"],
			[readOnly("slack-v1"), "POST", SLACK_SEND, "account_read_only"],
			[full("gmail-v1"), "POST", `${GMAIL}/drafts`, "off_profile"],
			[full("gmail-v1"), "POST", "https://gmail.googleapis.com/batch/gmail/v1", "gmail_batch"],
			[full("slack-v1"), "POST", "https://slack.com/api/chat.scheduleMessage", "slack_scheduling"],
			[
				full("gmail-v1"),
				"POST",
				"http://gmail.googleapis.com/gmail/v1/users/me/messages/send",
				"url_invalid",
			],
		] as const)
			expect(decide(binding, request(method, href), REDEEMED)).toEqual(denied(code));
	});

	it("holds a redeemed send to the query rule reads and organize meet", () => {
		for (const [profile, href, code] of [
			["gmail-v1", `${JSON_SEND}?$alt=json`, "system_parameter"],
			["gmail-v1", `${UPLOAD_SEND}&%24fields=id`, "system_parameter"],
			["slack-v1", `${SLACK_SEND}?$x=1`, "system_parameter"],
			["gmail-v1", `${JSON_SEND}?access_token=DYTEST-token`, "query_credential"],
			["gmail-v1", `${UPLOAD_SEND}&KEY=DYTEST-key`, "query_credential"],
			["slack-v1", `${SLACK_SEND}?Token=DYTEST-token`, "query_credential"],
		] as const)
			expect(decide(full(profile), request("POST", href), REDEEMED)).toEqual(denied(code));
	});

	it.each(TICKET_OUTCOMES)("answers a ticket refused with %s by %s", (reason, code, disable) => {
		for (const asked of [
			request("POST", UPLOAD_SEND, [["content-type", "message/rfc822"]]),
			request("GET", `${GMAIL}/messages`),
			request("get", "http://example.com/"),
		])
			for (const binding of [full("gmail-v1"), readOnly("gmail-readonly-v1")])
				expect(decide(binding, asked, refused(reason))).toEqual(denied(code, disable));
	});

	it("disables the plugin for exactly the protocol's plugin-caused ticket refusals", () => {
		expect(TICKET_OUTCOMES.map(([reason]) => reason)).toEqual([
			...TICKET_CHECKS,
			"SEND_STATE_CHANGED",
			"UNAVAILABLE",
		]);
		expect(TICKET_OUTCOMES.filter(([, , disable]) => disable).map(([reason]) => reason)).toEqual(
			TICKET_DISABLES_PLUGIN,
		);
		for (const [, code] of TICKET_OUTCOMES)
			expect((CHANNEL_DENIAL_CODES as readonly string[]).includes(code)).toBe(true);
	});
});

describe("ledger refusals", () => {
	it.each([...TICKET_CHECKS, "SEND_STATE_CHANGED"] as const)(
		"keeps the ledger's %s reason",
		(reason) => {
			const outcome = refusedChannelTicket(new SendTicketRefusal(reason));
			expect(outcome).toEqual({ state: "refused", reason });
			expect(Object.isFrozen(outcome)).toBe(true);
		},
	);

	it("answers UNAVAILABLE for anything else the ledger threw", () => {
		const forged = new SendTicketRefusal("TICKET_EXPIRED");
		Object.defineProperty(forged, "reason", { value: "toString" });
		for (const error of [
			unavailable(),
			new Error("TICKET_ALTERED"),
			{ reason: "TICKET_ALTERED" },
			Object.create(SendTicketRefusal.prototype),
			forged,
			"TICKET_UNKNOWN",
			undefined,
		])
			expect(refusedChannelTicket(error)).toEqual({ state: "refused", reason: "UNAVAILABLE" });
	});
});

describe("policy inputs", () => {
	const asked = request("GET", `${GMAIL}/messages`);

	it.each([
		["null", null],
		["a string", "gmail-v1"],
		["an array", ["gmail-v1", "full"]],
		[
			"a class instance",
			new (class Binding {
				profile = "gmail-v1";
				accountMode = "full";
			})(),
		],
		["a proxy", new Proxy({ profile: "gmail-v1", accountMode: "full" }, {})],
		["an inherited object", Object.create({ profile: "gmail-v1", accountMode: "full" })],
	])("throws for %s in any position", (_name, value) => {
		expect(() => decideChannelRequest(value as ChannelBinding, asked, ABSENT)).toThrow(
			"Channel policy input is invalid",
		);
		expect(() => decideChannelRequest(full("gmail-v1"), value as ChannelRequest, ABSENT)).toThrow(
			"Channel policy input is invalid",
		);
		expect(() => decideChannelRequest(full("gmail-v1"), asked, value as ChannelTicket)).toThrow(
			"Channel policy input is invalid",
		);
	});

	it("throws for unknown profiles, modes, ticket states and reasons", () => {
		for (const profile of ["gmail-v2", "toString", "__proto__", "constructor", undefined])
			expect(() =>
				decideChannelRequest(
					{ profile, accountMode: "full" } as unknown as ChannelBinding,
					asked,
					ABSENT,
				),
			).toThrow(TypeError);
		for (const accountMode of ["readonly", "FULL", undefined])
			expect(() =>
				decideChannelRequest(
					{ profile: "gmail-v1", accountMode } as unknown as ChannelBinding,
					asked,
					ABSENT,
				),
			).toThrow(TypeError);
		for (const ticket of [
			{ state: "used" },
			{},
			{ state: "refused" },
			{ state: "refused", reason: "TICKET_FORGED" },
			{ state: "refused", reason: "toString" },
		])
			expect(() =>
				decideChannelRequest(full("gmail-v1"), asked, ticket as unknown as ChannelTicket),
			).toThrow(TypeError);
	});

	it("refuses a bad binding before a ticket, method or URL can answer", () => {
		const early: readonly (readonly [ChannelRequest, ChannelTicket])[] = [
			[request("POST", UPLOAD_SEND), refused("TICKET_ALTERED")],
			[request("POST", UPLOAD_SEND), refused("TICKET_EXPIRED")],
			[request("get", `${GMAIL}/messages`), ABSENT],
			[request("POST", "http://slack.com/api/chat.postMessage"), REDEEMED],
			[asked, ABSENT],
		];
		for (const binding of [
			{ profile: "gmail-v2", accountMode: "full" },
			{ profile: "toString", accountMode: "full" },
			{ profile: "__proto__", accountMode: "read_only" },
			{ profile: "constructor", accountMode: "full" },
			{ profile: "gmail-v1", accountMode: "readonly" },
		])
			for (const [call, ticket] of early)
				expect(() =>
					decideChannelRequest(binding as unknown as ChannelBinding, call, ticket),
				).toThrow("Channel policy input is invalid");
	});

	it("reads only plain data fields and never calls an accessor", () => {
		let calls = 0;
		const getter = (value: unknown) => ({
			enumerable: true,
			get() {
				calls++;
				return value;
			},
		});
		const binding = Object.defineProperties(
			{ accountMode: "full" },
			{ profile: getter("gmail-v1") },
		);
		expect(() => decideChannelRequest(binding as ChannelBinding, asked, ABSENT)).toThrow(TypeError);
		const ticket = Object.defineProperties({}, { state: getter("redeemed") });
		expect(() => decideChannelRequest(full("gmail-v1"), asked, ticket as ChannelTicket)).toThrow(
			TypeError,
		);
		const send = Object.defineProperties(
			{ url: SLACK_SEND, headers: [] },
			{ method: getter("POST") },
		);
		expect(
			decideChannelRequest(full("slack-v1"), send as unknown as ChannelRequest, REDEEMED),
		).toEqual(denied("method_invalid"));
		const read = Object.defineProperties(
			{ method: "GET", headers: [] },
			{ url: getter(`${GMAIL}/messages`) },
		);
		expect(
			decideChannelRequest(full("gmail-v1"), read as unknown as ChannelRequest, ABSENT),
		).toEqual(denied("url_invalid"));
		expect(calls).toBe(0);
	});

	it("accepts null-prototype records", () => {
		const binding = Object.assign(Object.create(null), {
			profile: "slack-v1",
			accountMode: "full",
		});
		const asked = Object.assign(Object.create(null), {
			method: "POST",
			url: SLACK_SEND,
			headers: [],
		});
		const ticket = Object.assign(Object.create(null), { state: "redeemed" });
		expect(decideChannelRequest(binding, asked, ticket)).toMatchObject({
			allowed: true,
			class: "send",
		});
	});
});
