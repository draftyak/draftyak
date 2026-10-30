import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { manualClock } from "../src/faults.ts";
import { type GmailField, gmailFieldSchemas } from "../src/gmail/fields-schema.ts";
import { compileGmailProjection } from "../src/gmail/wire.ts";
import { createGmailFake } from "../src/gmail.ts";
import { json } from "./helpers.ts";

const BASE = "/gmail/v1/users/me";
const START = Date.UTC(2026, 9, 19, 9);
const RAW = Buffer.from(
	"From: owner@draftyak.example\r\nTo: peer@draftyak.example\r\nSubject: DYTEST fields\r\nMessage-ID: <fields@draftyak.example>\r\n\r\nDYTEST body\r\n",
);
const grant = () => ({
	scopes: ["https://www.googleapis.com/auth/gmail.modify"],
	expiresAt: START + 3_600_000,
});
const create = (options: Partial<Parameters<typeof createGmailFake>[0]> = {}) =>
	createGmailFake({ accessGrant: grant, clock: manualClock(START), ...options });
const call = (
	fake: ReturnType<typeof createGmailFake>,
	path: string,
	fields: string,
	init: RequestInit = {},
) =>
	fake.fetch(
		`${BASE}${path}${path.includes("?") ? "&" : "?"}fields=${encodeURIComponent(fields)}`,
		{
			...init,
			headers: { authorization: "Bearer DYTEST-fields", ...init.headers },
		},
	);
const post = (value: unknown): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json" },
	body: JSON.stringify(value),
});

interface DiscoverySchema {
	readonly type?: string;
	readonly $ref?: string;
	readonly properties?: Readonly<Record<string, DiscoverySchema>>;
	readonly items?: DiscoverySchema;
}

describe("Gmail response field schemas", () => {
	it("matches the technical field graph of every supported discovery response", () => {
		const document = JSON.parse(
			readFileSync(
				new URL("../../../spikes/s08-gmail/vendor/gmail-discovery.json", import.meta.url),
				"utf8",
			),
		) as { schemas: Readonly<Record<string, DiscoverySchema>> };
		const pending = [
			"Profile",
			"ListMessagesResponse",
			"ListThreadsResponse",
			"ListHistoryResponse",
			"Message",
			"Thread",
		];
		const shapes: Record<string, Record<string, GmailField>> = Object.create(null);
		function field(schema: DiscoverySchema): GmailField {
			if (schema.$ref) {
				pending.push(schema.$ref);
				return { ref: schema.$ref };
			}
			if (schema.type === "array") {
				expect(schema.items).toBeDefined();
				return { items: field(schema.items as DiscoverySchema) };
			}
			expect(["string", "integer", "boolean", "number"]).toContain(schema.type);
			return null;
		}
		while (pending.length) {
			const name = pending.pop() as string;
			if (Object.hasOwn(shapes, name)) continue;
			const schema = document.schemas[name];
			expect(schema?.type).toBe("object");
			shapes[name] = Object.fromEntries(
				Object.entries(schema?.properties ?? {}).map(([name, schema]) => [name, field(schema)]),
			);
		}
		expect(Object.keys(shapes)).toHaveLength(16);
		expect(gmailFieldSchemas).toEqual({ ...shapes, Empty: {} });
	});

	it.each([
		"idd",
		"id(foo)",
		"id/foo",
		"labelIds(id)",
		"labelIds/*",
		"payload(idd)",
		"payload/body/idd",
		"payload/headers/idd",
		"payload/headers/name(value)",
		"payload(*(idd))",
		"payload(*(name(foo)))",
		"payload, payload(idd)",
		"payload,payload(idd)",
		"*,payload(idd)",
		"payload(toString)",
		"payload/valueOf",
		"hasOwnProperty",
	])("refuses unknown names or explicit scalar children: %s", (fields) => {
		expect(() => compileGmailProjection(fields, "Message")).toThrow();
	});

	it.each(["messages(idd)", "messages,messages(idd)", "*,messages(idd)"])(
		"validates a branch before complete-parent union: %s",
		(fields) => {
			expect(() => compileGmailProjection(fields, "ListMessagesResponse")).toThrow();
		},
	);

	it("accepts schema fields independently of empty arrays and omitted optional data", () => {
		const list = compileGmailProjection(
			"messages(id,payload(body/attachmentId)),nextPageToken",
			"ListMessagesResponse",
		);
		expect(list({ messages: [] })).toEqual({ messages: [] });
		expect(list({ messages: [{ id: "m1", threadId: "t1" }] })).toEqual({
			messages: [{ id: "m1" }],
		});
		const recursive = compileGmailProjection("payload/parts/parts/parts/body/data", "Message");
		expect(recursive({ id: "m1" })).toEqual({});
		expect(recursive({ payload: { parts: [] } })).toEqual({ payload: { parts: [] } });
		expect(
			compileGmailProjection("classificationLabelValues(fields(selection))", "Message")({}),
		).toEqual({});
	});

	it("walks long slash paths without introducing a parenthesis-depth restriction", () => {
		const fields = `payload/${"parts/".repeat(100)}body/data`;
		expect(compileGmailProjection(fields, "Message")({})).toEqual({});
	});

	it("narrows wildcard alternatives at every step and preserves heterogeneous projections", () => {
		const value = {
			id: "m1",
			payload: {
				mimeType: "text/plain",
				body: { data: "DYTEST" },
				headers: [{ name: "Subject", value: "DYTEST" }],
			},
		};
		expect(compileGmailProjection("payload(*(name))", "Message")(value)).toEqual({
			payload: { mimeType: "text/plain", body: {}, headers: [{ name: "Subject" }] },
		});
		expect(compileGmailProjection("payload,*(headers)", "Message")(value)).toEqual(value);
		expect(() => compileGmailProjection("payload/*/name/headers", "Message")).toThrow();
	});

	it("uses an explicit empty schema for a response without a JSON body", () => {
		for (const fields of [null, "", "*"])
			expect(compileGmailProjection(fields, "Empty")({})).toEqual({});
		for (const fields of ["id", "messages(id)", "*(id)", "*,id"])
			expect(() => compileGmailProjection(fields, "Empty")).toThrow();
	});
});

describe("Gmail field validation before effects", () => {
	it.each([
		["/messages", "messages(idd)"],
		["/threads", "threads(idd)"],
		["/history?startHistoryId=1", "history(messagesAdded(message/idd))"],
		["/profile", "messages(id)"],
		["/messages/m1", "id(child)"],
		["/threads/t1", "messages(payload/headers/name/value)"],
	])("refuses schema-invalid reads before grant callbacks or quota: %s", async (path, fields) => {
		const accessGrant = vi.fn(grant);
		const fake = create({ accessGrant, readBudget: { units: 1, windowMs: 60_000 } });
		expect((await call(fake, path, fields)).status).toBe(400);
		expect(accessGrant).not.toHaveBeenCalled();
		expect((await call(fake, "/profile", "emailAddress")).status).toBe(200);
		expect((await call(fake, "/profile", "emailAddress")).status).toBe(429);
	});

	it("refuses invalid send and mutation fields before grant callbacks or mailbox changes", async () => {
		const accessGrant = vi.fn(grant);
		const fake = create({ accessGrant, messages: [{ id: "m1", raw: RAW, labelIds: ["INBOX"] }] });
		const before = fake.historyId;
		for (const [path, fields, value] of [
			["/messages/send", "id(child)", { raw: RAW.toString("base64url") }],
			["/messages/m1/modify", "idd", { addLabelIds: ["STARRED"] }],
			["/messages/batchModify", "id", { ids: ["m1"], addLabelIds: ["STARRED"] }],
		] as const) {
			const response = await call(fake, path, fields, post(value));
			expect(response.status).toBe(400);
			expect(fake.historyId).toBe(before);
			expect(fake.message("m1").labelIds).toEqual(["INBOX"]);
		}
		expect(accessGrant).not.toHaveBeenCalled();
	});

	it("checks field semantics before application content-type or body parsing rules", async () => {
		const fake = create();
		const response = await call(fake, "/messages/send", "id(child)", {
			method: "POST",
			headers: { "content-type": "application/octet-stream" },
			body: "DYTEST invalid application body",
		});
		expect(response.status).toBe(400);
	});

	it("validates and projects requests without native fetch", async () => {
		const outbound = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("DYTEST no egress"));
		try {
			const fake = create();
			expect((await call(fake, "/messages", "messages(idd)")).status).toBe(400);
			expect(await json(call(fake, "/profile", "emailAddress"))).toEqual({
				emailAddress: "owner@draftyak.example",
			});
			expect(outbound).not.toHaveBeenCalled();
		} finally {
			outbound.mockRestore();
		}
	});

	it("preserves the queued send result and send budget after an invalid selection", async () => {
		const fake = create({ sendBudget: { units: 1, windowMs: 60_000 } });
		fake.queueSend({ kind: "mail-rate-limit", retryAfterSeconds: 37 });
		expect(
			(await call(fake, "/messages/send", "id(child)", post({ raw: RAW.toString("base64url") })))
				.status,
		).toBe(400);
		const response = await call(
			fake,
			"/messages/send",
			"id",
			post({ raw: RAW.toString("base64url") }),
		);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("37");
		expect(await json(call(fake, "/messages", "resultSizeEstimate"))).toEqual({
			resultSizeEstimate: 0,
		});
	});

	it("accepts optional fields on sparse messages and empty list responses", async () => {
		const fake = create();
		expect(
			await json(call(fake, "/messages", "messages(payload/body/attachmentId),nextPageToken")),
		).toEqual({ messages: [] });
		fake.addMessage({ id: "m1", raw: RAW });
		expect(
			await json(
				call(
					fake,
					"/messages/m1?format=minimal",
					"id,payload(body/attachmentId),classificationLabelValues",
				),
			),
		).toEqual({ id: "m1" });
	});

	it("allows a bare wildcard on a batch mutation's empty response", async () => {
		const fake = create({ messages: [{ id: "m1", raw: RAW, labelIds: ["INBOX"] }] });
		expect(
			(
				await call(
					fake,
					"/messages/batchModify",
					"*",
					post({ ids: ["m1"], addLabelIds: ["STARRED"] }),
				)
			).status,
		).toBe(204);
		expect(fake.message("m1").labelIds).toEqual(["INBOX", "STARRED"]);
	});
});
