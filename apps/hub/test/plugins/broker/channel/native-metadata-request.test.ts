import { Account } from "@draftyak/protocol/entities/account";
import {
	HOST_MAX_FRAME_BYTES,
	HOST_MAX_STREAM_BYTES,
	HostFetchParams,
} from "@draftyak/protocol/host-channel";
import { canonicalize } from "@draftyak/protocol/jcs";
import type { ChannelProfile } from "@draftyak/protocol/manifest";
import { MAX_INLINE_BYTES } from "@draftyak/protocol/normalized-change";
import { afterEach, describe, expect, it, vi } from "vitest";

const externalIo = vi.hoisted(() => {
	const refuse = vi.fn((): never => {
		throw new Error("External IO is unavailable in this test");
	});
	const block = (source: object, names: readonly string[]) => {
		const overrides = Object.fromEntries(names.map((name) => [name, refuse]));
		return { ...source, ...overrides, default: { ...source, ...overrides } };
	};
	vi.stubGlobal("fetch", refuse);
	return { refuse, block };
});
vi.mock("node:child_process", async (original) =>
	externalIo.block(await original<typeof import("node:child_process")>(), [
		"spawn",
		"spawnSync",
		"exec",
		"execFile",
		"execSync",
		"execFileSync",
		"fork",
	]),
);
vi.mock("node:http", async (original) =>
	externalIo.block(await original<typeof import("node:http")>(), [
		"request",
		"get",
		"createServer",
	]),
);
vi.mock("node:https", async (original) =>
	externalIo.block(await original<typeof import("node:https")>(), [
		"request",
		"get",
		"createServer",
	]),
);
vi.mock("node:net", async (original) =>
	externalIo.block(await original<typeof import("node:net")>(), [
		"connect",
		"createConnection",
		"createServer",
	]),
);
vi.mock("node:tls", async (original) =>
	externalIo.block(await original<typeof import("node:tls")>(), ["connect", "createServer"]),
);
vi.mock("node:dns", async (original) =>
	externalIo.block(await original<typeof import("node:dns")>(), [
		"lookup",
		"resolve",
		"resolve4",
		"resolve6",
		"reverse",
	]),
);
vi.mock("node:dns/promises", async (original) =>
	externalIo.block(await original<typeof import("node:dns/promises")>(), [
		"lookup",
		"resolve",
		"resolve4",
		"resolve6",
		"reverse",
	]),
);

import { NativeChannelHostError } from "../../../../src/plugins/broker/channel/native-connection.ts";
import {
	assertNativeMetadataWindow,
	captureNativeMetadataRequest,
} from "../../../../src/plugins/broker/channel/native-metadata-request.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const SLACK = "https://slack.com/api";
const ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const OWNER = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const INSTANCE = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const fields = {
	id: ID,
	userId: OWNER,
	alias: "dytest",
	status: "active",
	deletionDeadline: null,
	historyLimitDays: 30,
	disclosureVersion: 1,
	createdAt: 0,
	pluginInstanceId: INSTANCE,
};
function email(mode: Account["mode"] = "full"): Account {
	return Account.parse({ ...fields, channel: "email", mode, address: "dytest@example.test" });
}
function chat(mode: Account["mode"] = "full"): Account {
	return Account.parse({
		...fields,
		channel: "chat",
		mode,
		teamId: "DYTEST-team",
		selfUserId: "DYTEST-self",
	});
}
function get(url: string, extra: Partial<HostFetchParams> = {}): HostFetchParams {
	return { method: "GET", url, headers: [], ...extra };
}
function post(
	body: string | Uint8Array,
	contentType = "application/json",
	url = `${SLACK}/auth.test`,
): HostFetchParams {
	const bytes = Buffer.from(typeof body === "string" ? new TextEncoder().encode(body) : body);
	return {
		method: "POST",
		url,
		headers: [["content-type", contentType]],
		body: { base64: bytes.toString("base64url") },
	};
}
function refuses(work: () => unknown): void {
	let error: unknown;
	try {
		work();
	} catch (reason) {
		error = reason;
	}
	expect(error).toBeInstanceOf(NativeChannelHostError);
	expect(error).toMatchObject({
		code: "NATIVE_CHANNEL_HOST_REFUSED",
		message: "Native channel request unavailable",
	});
	expect(Object.hasOwn(error as object, "cause")).toBe(false);
}
function captureRefuses(
	raw: HostFetchParams,
	profile: ChannelProfile = "gmail-v1",
	account = email(),
): void {
	// These negatives must reach policy/capture controls, rather than malformed wire input.
	expect(HostFetchParams.safeParse(raw).success).toBe(true);
	refuses(() => captureNativeMetadataRequest(raw, profile, account));
}

afterEach(() => {
	expect(externalIo.refuse).not.toHaveBeenCalled();
	externalIo.refuse.mockClear();
	vi.restoreAllMocks();
});

describe("native metadata request DATA capture", () => {
	it.each([
		["gmail-v1", `${GMAIL}/labels`, email()],
		["gmail-readonly-v1", `${GMAIL}/labels`, email("read_only")],
		["slack-v1", `${SLACK}/auth.test`, chat()],
		["slack-v1", `${SLACK}/users.info?user=DYTEST-self`, chat("read_only")],
	] satisfies [ChannelProfile, string, Account][])(
		"keeps non-history metadata available for %s when the scan floor moves by one millisecond",
		(profile, url, account) => {
			const captured = captureNativeMetadataRequest(get(url, { stream: true }), profile, account);
			const preparedSince = 1_000;
			const historyFloorMs = preparedSince + 1;
			expect(() => assertNativeMetadataWindow({ profile, historyFloorMs }, captured)).not.toThrow();
			expect(captured).toMatchObject({
				url,
				method: "GET",
				maxBytes: HOST_MAX_STREAM_BYTES,
				stream: true,
			});
			expect(captured.body.byteLength).toBe(0);
			expect(Object.isFrozen(captured)).toBe(true);
		},
	);

	it.each([0, Number.MAX_SAFE_INTEGER])(
		"accepts a valid native floor of %s on non-history metadata",
		(historyFloorMs) => {
			const captured = captureNativeMetadataRequest(get(`${GMAIL}/labels`), "gmail-v1", email());
			expect(() =>
				assertNativeMetadataWindow({ profile: "gmail-v1", historyFloorMs }, captured),
			).not.toThrow();
		},
	);

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"refuses an invalid native floor %s on an otherwise admitted metadata request",
		(historyFloorMs) => {
			const captured = captureNativeMetadataRequest(get(`${GMAIL}/labels`), "gmail-v1", email());
			refuses(() => assertNativeMetadataWindow({ profile: "gmail-v1", historyFloorMs }, captured));
		},
	);

	it.each([
		["gmail-v1", `${GMAIL}/messages?maxResults=1`, email()],
		["gmail-readonly-v1", `${GMAIL}/threads?maxResults=1`, email("read_only")],
		["gmail-v1", `${GMAIL}/history?startHistoryId=DYTEST-history`, email()],
		["slack-v1", `${SLACK}/conversations.history?channel=DYTEST-channel`, chat()],
		["slack-v1", `${SLACK}/conversations.replies?channel=DYTEST-channel&ts=1.000`, chat()],
	] satisfies [ChannelProfile, string, Account][])(
		"refuses time-bearing %s metadata despite a valid read-class capture: %s",
		(profile, url, account) => {
			const captured = captureNativeMetadataRequest(get(url), profile, account);
			expect(captured.url).toBe(url);
			refuses(() => assertNativeMetadataWindow({ profile, historyFloorMs: 0 }, captured));
		},
	);

	it("captures a stable request while dropping plugin credentials and non-forwarded headers", () => {
		const headers: [string, string][] = [
			["Accept", "application/json"],
			["Authorization", "Bearer DYTEST"],
			["Cookie", "DYTEST=1"],
		];
		const raw = get(`${GMAIL}/labels`, { headers });
		const captured = captureNativeMetadataRequest(raw, "gmail-v1", email());
		expect(captured.headers).toEqual([["accept", "application/json"]]);
		headers[0] = ["accept", "text/plain"];
		expect(captured.headers).toEqual([["accept", "application/json"]]);
		expect(Object.isFrozen(captured.headers)).toBe(true);
		expect(captured.stream).toBe(false);
	});

	it("scopes Gmail mailbox paths to me or the captured account address", () => {
		const account = email();
		for (const user of ["me", encodeURIComponent("dytest@example.test")]) {
			expect(
				captureNativeMetadataRequest(
					get(`https://gmail.googleapis.com/gmail/v1/users/${user}/labels`),
					"gmail-v1",
					account,
				).method,
			).toBe("GET");
		}
		captureRefuses(
			get("https://gmail.googleapis.com/gmail/v1/users/other%40example.test/labels"),
			"gmail-v1",
			account,
		);
	});

	it.each([
		["gmail-v1", `${GMAIL}/labels`, chat()],
		["slack-v1", `${SLACK}/auth.test`, email()],
	] satisfies [ChannelProfile, string, Account][])(
		"refuses a %s/account channel mismatch",
		(profile, url, account) => {
			captureRefuses(get(url), profile, account);
		},
	);

	it.each([
		{ saveAs: "blob" as const },
		{ saveAs: { kind: "base64url-json-member" as const, member: "raw" as const } },
		{ sendTicket: { fixture: "DYTEST" } },
		{ lookupPermit: "A".repeat(43) },
	])("refuses schema-valid authority/projection fields on metadata: %j", (extra) => {
		captureRefuses(get(`${GMAIL}/labels`, extra));
	});

	it.each([
		[
			"gmail-v1",
			`${GMAIL}/messages/DYTEST-message/attachments/DYTEST-part?format=metadata`,
			email(),
		],
		["slack-v1", `${SLACK}/apps.connections.open`, chat()],
		["gmail-v1", `${GMAIL}/messages/DYTEST-message?format=raw`, email()],
		["gmail-v1", `${GMAIL}/threads/DYTEST-thread?format=full`, email()],
	] satisfies [ChannelProfile, string, Account][])(
		"refuses out-of-scope %s metadata: %s",
		(profile, url, account) => {
			captureRefuses(get(url), profile, account);
		},
	);

	it("captures only explicit minimal/metadata per-message DATA without admitting its time window", () => {
		for (const endpoint of ["messages", "threads"]) {
			for (const format of ["metadata", "minimal"]) {
				const captured = captureNativeMetadataRequest(
					get(`${GMAIL}/${endpoint}/DYTEST-id?format=${format}`),
					"gmail-v1",
					email(),
				);
				expect(captured.method).toBe("GET");
				refuses(() =>
					assertNativeMetadataWindow({ profile: "gmail-v1", historyFloorMs: 0 }, captured),
				);
			}
			captureRefuses(get(`${GMAIL}/${endpoint}/DYTEST-id`));
			captureRefuses(get(`${GMAIL}/${endpoint}/DYTEST-id?format=metadata&format=minimal`));
		}
	});

	it.each(["messages/send", "messages/batchModify"])(
		"refuses the non-read Gmail path %s",
		(path) => {
			captureRefuses({
				method: "POST",
				url: `${GMAIL}/${path}`,
				headers: [],
				body: { base64: "e30" },
			});
		},
	);

	it.each([
		["application/json", '{"user":"DYTEST-self"}'],
		["application/x-www-form-urlencoded", "user=DYTEST-self"],
	])("captures bounded %s body DATA independently of the caller", (contentType, text) => {
		const raw = post(text, contentType);
		expect(HostFetchParams.safeParse(raw).success).toBe(true);
		const captured = captureNativeMetadataRequest(raw, "slack-v1", chat());
		expect(Buffer.from(captured.body).toString()).toBe(text);
		expect(captured.method).toBe("POST");
		if (raw.body && "base64" in raw.body) (raw.body as { base64: string }).base64 = "";
		expect(Buffer.from(captured.body).toString()).toBe(text);
	});

	it.each([
		["application/json", '{"token":"DYTEST"}'],
		["application/json", '{"$method":"DYTEST"}'],
		["application/json", '{"user":1}'],
		["application/json", '["DYTEST"]'],
		["application/json", '{"user":"a","user":"b"}'],
		["text/plain", "DYTEST"],
	])("refuses unsafe decoded %s body fields: %s", (contentType, text) => {
		captureRefuses(post(text, contentType), "slack-v1", chat());
	});

	it("refuses duplicate query/body fields, invalid UTF-8 and non-inline body references", () => {
		captureRefuses(
			post("user=b", "application/x-www-form-urlencoded", `${SLACK}/auth.test?user=a`),
			"slack-v1",
			chat(),
		);
		captureRefuses(post("user=a&user=b", "application/x-www-form-urlencoded"), "slack-v1", chat());
		captureRefuses(post(Uint8Array.of(0xff)), "slack-v1", chat());
		captureRefuses(get(`${GMAIL}/labels`, { body: { ref: ID } }));
	});

	it("keeps the inline body bound and refuses nonempty GET bodies", () => {
		const overhead = Buffer.byteLength('{"user":""}');
		const exact = JSON.stringify({ user: "a".repeat(MAX_INLINE_BYTES - overhead) });
		const captured = captureNativeMetadataRequest(post(exact), "slack-v1", chat());
		expect(captured.body.byteLength).toBe(MAX_INLINE_BYTES);
		const tooLarge = post(`${exact} `);
		expect(HostFetchParams.safeParse(tooLarge).success).toBe(false);
		refuses(() => captureNativeMetadataRequest(tooLarge, "slack-v1", chat()));
		captureRefuses(
			get(`${GMAIL}/labels`, { body: { base64: Buffer.from("DYTEST").toString("base64url") } }),
		);
	});

	it("erases the allocated decoded body when a schema-valid body is refused", () => {
		const text = '{"token":"DYTEST-body-cleanup"}';
		const raw = post(text);
		expect(HostFetchParams.safeParse(raw).success).toBe(true);
		const expected = Buffer.from(text);
		const original = Buffer.from;
		const copies: Buffer[] = [];
		const spy = vi.spyOn(Buffer, "from").mockImplementation(((...args: unknown[]) => {
			const result = Reflect.apply(original, Buffer, args) as Buffer;
			if (args[0] instanceof Uint8Array && result.equals(expected)) copies.push(result);
			return result;
		}) as typeof Buffer.from);
		let error: unknown;
		try {
			captureNativeMetadataRequest(raw, "slack-v1", chat());
		} catch (reason) {
			error = reason;
		} finally {
			spy.mockRestore();
		}
		expect(error).toBeInstanceOf(NativeChannelHostError);
		expect(copies).toHaveLength(1);
		expect(copies[0]?.some((byte) => byte !== 0)).toBe(false);
	});

	it("bounds the copied header arrays and requires exact dense header pairs", () => {
		const headers = Array.from({ length: 64 }, (_, index): [string, string] => [
			`x-dytest-${index}`,
			"value",
		]);
		expect(
			captureNativeMetadataRequest(get(`${GMAIL}/labels`, { headers }), "gmail-v1", email())
				.headers,
		).toEqual([]);
		const tooMany = { ...get(`${GMAIL}/labels`), headers: [...headers, ["x-dytest-65", "value"]] };
		refuses(() => captureNativeMetadataRequest(tooMany, "gmail-v1", email()));
		for (const rows of [[new Array(2)], [["accept", "application/json", "extra"]], new Array(1)]) {
			refuses(() =>
				captureNativeMetadataRequest(
					{ ...get(`${GMAIL}/labels`), headers: rows },
					"gmail-v1",
					email(),
				),
			);
		}
	});

	it("refuses schema-valid escaped DATA above the aggregate frame bound", () => {
		const value = `a${"\t".repeat(8190)}z`;
		const headers = Array.from({ length: 64 }, (_, index): [string, string] => [
			`x-dytest-${index}`,
			value,
		]);
		const raw = get(`${GMAIL}/labels`, { headers });
		expect(HostFetchParams.safeParse(raw).success).toBe(true);
		expect(Buffer.byteLength(canonicalize(raw))).toBeGreaterThan(HOST_MAX_FRAME_BYTES);
		// The independent raw-header byte bound also rejects this DATA; this is no isolated cap proof.
		refuses(() => captureNativeMetadataRequest(raw, "gmail-v1", email()));
	});

	it("refuses custom raw/body prototypes while accepting owned null-prototype DATA", () => {
		const raw = Object.setPrototypeOf(get(`${GMAIL}/labels`), { fixture: "DYTEST" });
		refuses(() => captureNativeMetadataRequest(raw, "gmail-v1", email()));
		const bodyRaw = post('{"user":"DYTEST-self"}');
		if (bodyRaw.body) Object.setPrototypeOf(bodyRaw.body, { fixture: "DYTEST" });
		refuses(() => captureNativeMetadataRequest(bodyRaw, "slack-v1", chat()));
		const nullRaw = Object.assign(Object.create(null), get(`${GMAIL}/labels`));
		expect(captureNativeMetadataRequest(nullRaw, "gmail-v1", email()).method).toBe("GET");
		const nullBodyRaw = post('{"user":"DYTEST-self"}');
		if (nullBodyRaw.body) Object.setPrototypeOf(nullBodyRaw.body, null);
		expect(captureNativeMetadataRequest(nullBodyRaw, "slack-v1", chat()).method).toBe("POST");
	});

	it("refuses raw and nested hooks before snapshotting metadata DATA", () => {
		let reads = 0;
		const trap = (): never => {
			reads++;
			throw new Error("DYTEST caller property evaluated");
		};
		const accessor = Object.defineProperty({}, "method", { enumerable: true, get: trap });
		const traps = {
			get: trap,
			ownKeys: trap,
			getOwnPropertyDescriptor: trap,
			getPrototypeOf: trap,
		};
		const proxy = new Proxy({}, traps);
		const headerArray = Object.defineProperty([], "0", { enumerable: true, get: trap });
		const headerTuple = Object.defineProperty(["accept", "application/json"], "0", {
			enumerable: true,
			get: trap,
		});
		const body = Object.defineProperty({}, "base64", { enumerable: true, get: trap });
		const reference = Object.defineProperty({}, "ref", { enumerable: true, get: trap });
		const rawValues: unknown[] = [
			accessor,
			proxy,
			{ ...get(`${GMAIL}/labels`), headers: headerArray },
			{ ...get(`${GMAIL}/labels`), headers: [headerTuple] },
			{ ...get(`${GMAIL}/labels`), headers: new Proxy([], traps) },
			{ ...get(`${GMAIL}/labels`), headers: [new Proxy(["accept", "application/json"], traps)] },
			{ ...get(`${GMAIL}/labels`), body },
			{ ...get(`${GMAIL}/labels`), body: reference },
			{ ...get(`${GMAIL}/labels`), body: new Proxy({}, traps) },
		];
		for (const name of ["saveAs", "sendTicket", "lookupPermit"]) {
			rawValues.push(
				Object.defineProperty(get(`${GMAIL}/labels`), name, { enumerable: true, get: trap }),
			);
		}
		for (const raw of rawValues)
			refuses(() => captureNativeMetadataRequest(raw, "gmail-v1", email()));
		expect(reads).toBe(0);
	});
});
