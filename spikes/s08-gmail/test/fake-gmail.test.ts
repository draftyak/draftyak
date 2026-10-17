import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GMAIL_MODIFY } from "../src/oauth.ts";
import { multipartUpload } from "../src/send.ts";
import { checkSchema, type FakeGmail, methodById, startFakeGmail } from "./fake-gmail.ts";
import { TokenRegistry } from "./fake-google-oauth.ts";

// The fake is the spike's evidence that every request stays inside the discovery document, so it
// has to catch what falls outside it.
let tokens: TokenRegistry;
let fake: FakeGmail;
let token: string;

beforeEach(async () => {
	tokens = new TokenRegistry();
	fake = await startFakeGmail({ tokens });
	token = tokens.grant(["openid", "email", GMAIL_MODIFY]).accessToken;
});

afterEach(async () => {
	expect(fake.unimplemented).toEqual([]);
	await fake.close();
});

async function call(
	method: string,
	pathAndQuery: string,
	body?: { type: string; bytes: Uint8Array<ArrayBuffer> | string },
	bearer: string = token,
): Promise<number> {
	const response = await fetch(`${fake.url}${pathAndQuery}`, {
		method,
		headers: {
			authorization: `Bearer ${bearer}`,
			...(body === undefined ? {} : { "content-type": body.type }),
		},
		...(body === undefined ? {} : { body: body.bytes }),
	});
	await response.arrayBuffer();
	return response.status;
}

const raw = "From: owner@example.com\r\nTo: alice@example.org\r\nSubject: x\r\n\r\nbody\r\n";
const upload = (metadata: Record<string, string>, media = raw, type = "message/rfc822") => {
	const { body, contentType } = multipartUpload(metadata, Buffer.from(media));
	const bytes = Buffer.from(body)
		.toString("latin1")
		.replace("Content-Type: message/rfc822", `Content-Type: ${type}`);
	return { type: contentType, bytes: new Uint8Array(Buffer.from(bytes, "latin1")) };
};

describe("FakeGmail against the discovery document", () => {
	it("serves requests the document describes", async () => {
		expect(await call("GET", "/gmail/v1/users/me/profile")).toBe(200);
		expect(
			await call(
				"GET",
				"/gmail/v1/users/me/messages?q=in%3Asent&maxResults=10&labelIds=SENT&labelIds=UNREAD",
			),
		).toBe(200);
		expect(
			await call(
				"POST",
				"/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
				upload({}),
			),
		).toBe(200);
		expect(
			await call("GET", "/gmail/v1/users/me/history?startHistoryId=1000&historyTypes=messageAdded"),
		).toBe(200);
		expect(fake.violations).toEqual([]);
	});

	const outside: [
		string,
		string,
		string,
		ReturnType<typeof upload> | { type: string; bytes: string } | undefined,
		RegExp,
	][] = [
		[
			"an unknown path",
			"GET",
			"/gmail/v1/users/me/nothing",
			undefined,
			/is not in the discovery document/,
		],
		[
			"the batch endpoint",
			"POST",
			"/batch/gmail/v1",
			{ type: "multipart/mixed", bytes: "" },
			/is not in the discovery document/,
		],
		[
			"a method the path doesn't have",
			"DELETE",
			"/gmail/v1/users/me/messages",
			undefined,
			/is not in the discovery document/,
		],
		[
			"an unknown query parameter",
			"GET",
			"/gmail/v1/users/me/messages?sendAt=1",
			undefined,
			/query sendAt is not in/,
		],
		[
			"a value outside an enum",
			"GET",
			"/gmail/v1/users/me/messages/abc?format=everything",
			undefined,
			/format=everything is not in its enum/,
		],
		[
			"a repeated single parameter",
			"GET",
			"/gmail/v1/users/me/messages?q=a&q=b",
			undefined,
			/query q is not repeated/,
		],
		[
			"a non-integer",
			"GET",
			"/gmail/v1/users/me/messages?maxResults=ten",
			undefined,
			/maxResults is not uint32/,
		],
		[
			"a non-uint64 history id",
			"GET",
			"/gmail/v1/users/me/history?startHistoryId=abc",
			undefined,
			/startHistoryId is not uint64/,
		],
		[
			"a Google system parameter, even one the document lists",
			"GET",
			"/gmail/v1/users/me/profile?%24.xgafv=2",
			undefined,
			/query \$\.xgafv is a Google system parameter/,
		],
		[
			"a field the request schema lacks",
			"POST",
			"/gmail/v1/users/me/messages/send",
			{ type: "application/json", bytes: '{"raw":"eA","sendAt":"2026"}' },
			/sendAt is not in the discovery document/,
		],
		[
			"a JSON send without raw",
			"POST",
			"/gmail/v1/users/me/messages/send",
			{ type: "application/json", bytes: "{}" },
			/raw is required for gmail.users.messages.send/,
		],
		[
			"an upload type the path doesn't take",
			"POST",
			"/upload/gmail/v1/users/me/messages/send?uploadType=resumable",
			upload({}),
			/uploadType=resumable/,
		],
		[
			"uploadType on a plain path",
			"POST",
			"/gmail/v1/users/me/messages/send?uploadType=multipart",
			{ type: "application/json", bytes: '{"raw":"eA"}' },
			/uploadType on/,
		],
		[
			"metadata the Message schema lacks",
			"POST",
			"/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
			upload({ threadId: "t", scheduledAt: "x" }),
			/scheduledAt is not in the discovery document/,
		],
		[
			"raw beside the media part",
			"POST",
			"/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
			upload({ raw: "eA" }),
			/raw beside media/,
		],
		[
			"a media type outside accept",
			"POST",
			"/upload/gmail/v1/users/me/messages/send?uploadType=multipart",
			upload({}, raw, "text/plain"),
			/media type text\/plain not in message\/\*/,
		],
	];
	for (const [label, method, target, body, problem] of outside) {
		it(`flags ${label}`, async () => {
			expect(await call(method, target, body)).toBe(400);
			expect(fake.violations.join("\n")).toMatch(problem);
			expect(fake.calls).toEqual([]);
		});
	}

	it("flags a method-override header, which would turn the request into another method", async () => {
		for (const name of ["X-HTTP-Method-Override", "X-HTTP-Method", "X-Method-Override"]) {
			const response = await fetch(`${fake.url}/gmail/v1/users/me/messages?q=in%3Asent`, {
				headers: { authorization: `Bearer ${token}`, [name]: "DELETE" },
			});
			await response.arrayBuffer();
			expect(response.status, name).toBe(400);
		}
		expect(fake.violations).toEqual([
			"header x-http-method-override overrides the method",
			"header x-http-method overrides the method",
			"header x-method-override overrides the method",
		]);
		expect(fake.calls).toEqual([]);
	});

	it("flags a body sent to a method that takes none", async () => {
		const response = await fetch(`${fake.url}/gmail/v1/users/me/messages/abc/trash`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: "{}",
		});
		expect(response.status).toBe(400);
		expect(fake.violations).toEqual(["gmail.users.messages.trash takes no request body"]);
	});

	it("answers like Gmail for a bad token, a missing scope or a revoked grant", async () => {
		expect(await call("GET", "/gmail/v1/users/me/profile", undefined, "nope")).toBe(401);
		const signIn = tokens.grant(["openid", "email"]);
		expect(await call("GET", "/gmail/v1/users/me/profile", undefined, signIn.accessToken)).toBe(
			403,
		);
		tokens.revoke(token);
		expect(await call("GET", "/gmail/v1/users/me/profile")).toBe(401);
		expect(fake.violations).toEqual([]);
	});

	it("leaves the unit tier offline: a fetch beyond loopback is refused", async () => {
		await expect(fetch("https://example.invalid/")).rejects.toThrow(/outside loopback refused/);
		expect(await call("GET", "/gmail/v1/users/me/profile")).toBe(200);
	});

	it("checks values against the schemas, its own answers included", () => {
		const problems: string[] = [];
		const message = { $ref: "Message" };
		checkSchema(
			{ id: "a", threadId: "b", labelIds: ["SENT"], internalDate: "12" },
			message,
			"ok",
			undefined,
			problems,
		);
		expect(problems).toEqual([]);
		checkSchema(
			{ id: 1, labelIds: "SENT", internalDate: "soon", extra: true },
			message,
			"bad",
			undefined,
			problems,
		);
		expect(problems).toEqual([
			"bad.id: expected a string",
			"bad.labelIds: expected an array",
			"bad.internalDate: not int64",
			"bad: extra is not in the discovery document",
		]);
		expect(methodById("gmail.users.messages.send").response).toEqual({ $ref: "Message" });
	});
});
