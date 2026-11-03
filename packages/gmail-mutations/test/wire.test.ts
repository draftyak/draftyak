import { manualClock } from "@draftyak/fakes/faults";
import { createGmailFake, GMAIL_MODIFY_SCOPE } from "@draftyak/fakes/gmail";
import { expect, it } from "vitest";
import { GmailMutationError, observeGmailMutation, planGmailMutation } from "../src/index.ts";

it.each([
	{ op: "archive", before: ["INBOX", "UNREAD"], after: ["UNREAD"], labelIds: undefined },
	{ op: "unarchive", before: ["UNREAD"], after: ["UNREAD", "INBOX"], labelIds: undefined },
	{ op: "read", before: ["INBOX", "UNREAD"], after: ["INBOX"], labelIds: undefined },
	{ op: "unread", before: ["INBOX"], after: ["INBOX", "UNREAD"], labelIds: undefined },
	{ op: "label", before: ["INBOX"], after: ["INBOX", "Label_1"], labelIds: ["Label_1"] },
	{ op: "unlabel", before: ["INBOX", "Label_1"], after: ["INBOX"], labelIds: ["Label_1"] },
])(
	"roundtrips $op through the real in-memory Gmail modify handler",
	async ({ op, before, after, labelIds }) => {
		const now = Date.UTC(2026, 0, 1);
		const fake = createGmailFake({
			clock: manualClock(now),
			accessGrant: (token) =>
				token === "DYTEST-mutation"
					? { scopes: [GMAIL_MODIFY_SCOPE], expiresAt: now + 60_000 }
					: undefined,
			messages: ["m1", "m2"].map((id) => ({
				id,
				threadId: "t1",
				labelIds: before,
				raw: Buffer.from(
					"From: DYTEST <sender@draftyak.example>\r\nSubject: DYTEST\r\n\r\nDYTEST body\r\n",
				),
			})),
		});
		const input = {
			op,
			messages: ["m1", "m2"].map((providerId) => ({ kind: "email", providerId })),
			...(labelIds === undefined ? {} : { labelIds }),
		};
		const plan = planGmailMutation(input);
		const rows = [];
		for (const request of plan.requests) {
			// Fake.fetch calls its in-memory application; no listener or global fetch is used.
			const response = await fake.fetch(request.url, {
				method: request.method,
				headers: { ...request.headers, authorization: "Bearer DYTEST-mutation" },
				body: request.body,
			});
			rows.push({
				providerId: request.providerId,
				status: response.status,
				body: new Uint8Array(await response.arrayBuffer()),
			});
		}
		const result = observeGmailMutation(input, rows);
		expect(result.completeObservation).toBe(true);
		expect(result.observations.map((row) => row.provider)).toEqual([
			{ untrusted: true, id: "m1", threadId: "t1", labelIds: after },
			{ untrusted: true, id: "m2", threadId: "t1", labelIds: after },
		]);
		expect(fake.message("m1").labelIds).toEqual(after);
		expect(fake.message("m2").labelIds).toEqual(after);
	},
);

it("refuses a revoked message-array proxy with the fixed input error", () => {
	const revocable = Proxy.revocable([], {});
	revocable.revoke();
	expect(() => planGmailMutation({ op: "archive", messages: revocable.proxy })).toThrow(
		GmailMutationError,
	);
});
