import { describe, expect, it } from "vitest";
import { planGmailMutation } from "../src/plan.ts";

const email = (providerId: string) => ({ kind: "email", providerId });
const messages = (count: number) =>
	Array.from({ length: count }, (_, index) => email(`message_${index}`));

function onlyRequest(plan: ReturnType<typeof planGmailMutation>) {
	expect(plan.requests).toHaveLength(1);
	const request = plan.requests[0];
	if (request === undefined) throw new Error("Synthetic mutation plan has no request");
	return request;
}

function labelsOf(request: { readonly body: string }) {
	const body = JSON.parse(request.body) as Record<string, unknown>;
	expect(
		Object.keys(body).every((name) => name === "addLabelIds" || name === "removeLabelIds"),
	).toBe(true);
	return { add: body.addLabelIds ?? [], remove: body.removeLabelIds ?? [] };
}

describe("Gmail mutation request DATA", () => {
	it.each([
		["archive", [], ["INBOX"]],
		["unarchive", ["INBOX"], []],
		["read", [], ["UNREAD"]],
		["unread", ["UNREAD"], []],
	] as const)("maps %s through only the fixed message modify route", (op, add, remove) => {
		const plan = planGmailMutation({ op, messages: [email("message_1"), email("message-2")] });
		expect(plan.operation).toBe(op);
		expect(plan.requests).toHaveLength(2);
		for (const [index, request] of plan.requests.entries()) {
			const providerId = index === 0 ? "message_1" : "message-2";
			expect(request.providerId).toBe(providerId);
			expect(request.method).toBe("POST");
			expect(request.url).toBe(
				`https://gmail.googleapis.com/gmail/v1/users/me/messages/${providerId}/modify`,
			);
			expect(request.headers).toEqual({ "content-type": "application/json" });
			expect(labelsOf(request)).toEqual({ add, remove });
		}
	});

	it.each(["label", "unlabel"] as const)("plans the admitted user-label subset for %s", (op) => {
		const labelIds = ["Label_1", "Label_work-2026", "Label_with_underscore"];
		const plan = planGmailMutation({ op, messages: [email("m1")], labelIds });
		expect(labelsOf(onlyRequest(plan))).toEqual({
			add: op === "label" ? labelIds : [],
			remove: op === "unlabel" ? labelIds : [],
		});
	});

	it.each([1, 100])("keeps the shared upper message bound at %i", (count) => {
		const plan = planGmailMutation({ op: "read", messages: messages(count) });
		expect(plan.requests).toHaveLength(count);
		expect(new Set(plan.requests.map((request) => request.providerId)).size).toBe(count);
	});

	it.each([0, 101])("refuses %i message references", (count) => {
		expect(() => planGmailMutation({ op: "read", messages: messages(count) })).toThrow();
	});

	it.each([1, 20])("keeps the shared label bound at %i", (count) => {
		const labelIds = Array.from({ length: count }, (_, index) => `Label_${index}`);
		const plan = planGmailMutation({ op: "label", messages: [email("m1")], labelIds });
		expect(labelsOf(onlyRequest(plan)).add).toEqual(labelIds);
	});

	it.each([0, 21])("refuses %i label identifiers", (count) => {
		const labelIds = Array.from({ length: count }, (_, index) => `Label_${index}`);
		expect(() => planGmailMutation({ op: "label", messages: [email("m1")], labelIds })).toThrow();
	});

	it("admits the exact wire identifier limits", () => {
		for (const providerId of ["x", "x".repeat(128)]) {
			const plan = planGmailMutation({ op: "read", messages: [email(providerId)] });
			expect(plan.requests[0]?.providerId).toBe(providerId);
		}
		const longestLabel = `Label_${"x".repeat(122)}`;
		const plan = planGmailMutation({
			op: "label",
			messages: [email("m1")],
			labelIds: [longestLabel],
		});
		expect(labelsOf(onlyRequest(plan)).add).toEqual([longestLabel]);
	});

	it.each([
		"",
		"x".repeat(129),
		"../message",
		"message/child",
		"message%2Fchild",
		"message?query",
		"message#fragment",
		"message:port",
		"message\\child",
		"message\r\nheader",
		" message",
		"message ",
		"message.dot",
		"\u212aey",
	])("refuses non-Gmail wire message identifier %j", (providerId) => {
		expect(() => planGmailMutation({ op: "read", messages: [email(providerId)] })).toThrow();
	});

	it.each([
		"INBOX",
		"UNREAD",
		"SENT",
		"DRAFT",
		"TRASH",
		"SPAM",
		"STARRED",
		"IMPORTANT",
		"CATEGORY_PERSONAL",
		"Label_",
		"label_1",
		"Label_dot.name",
		"Label_slash/name",
		"Label_%31",
		`Label_${"x".repeat(123)}`,
		"Label_\u212aey",
	])("does not treat %j as an admitted user label", (labelId) => {
		for (const op of ["label", "unlabel"]) {
			expect(() =>
				planGmailMutation({ op, messages: [email("m1")], labelIds: [labelId] }),
			).toThrow();
		}
	});

	it("refuses duplicate message references rather than planning repeated effects", () => {
		expect(() =>
			planGmailMutation({ op: "archive", messages: [email("m1"), email("m1")] }),
		).toThrow();
	});

	it.each(["label", "unlabel"] as const)("refuses duplicate labels for %s", (op) => {
		expect(() =>
			planGmailMutation({ op, messages: [email("m1")], labelIds: ["Label_1", "Label_1"] }),
		).toThrow();
	});

	it.each(
		[
			null,
			[],
			"read",
			{ op: "unknown", messages: [email("m1")] },
			{ op: "read", messages: [{ kind: "chat", channelId: "c1", ts: "1" }] },
			{ op: "read", messages: [{ ...email("m1"), accountId: "other" }] },
			{ op: "read", messages: [email("m1")], labelIds: [] },
			{ op: "label", messages: [email("m1")] },
			{ op: "label", messages: [email("m1")], labelIds: "Label_1" },
			{ op: "read", messages: [email("m1")], accountMode: "full" },
			{ op: "read", messages: [email("m1")], role: "owner" },
			{ op: "read", messages: [email("m1")], ticket: "synthetic" },
			{ op: "read", messages: [email("m1")], url: "https://example.invalid/batch" },
		].map((input) => ({ input })),
	)("does not widen the shared mutation input with $input", ({ input }) => {
		expect(() => planGmailMutation(input)).toThrow();
	});

	it("refuses sparse references", () => {
		const refs: unknown[] = new Array(2);
		refs[1] = email("m2");
		expect(() => planGmailMutation({ op: "read", messages: refs })).toThrow();
	});

	it("does not evaluate an operation accessor", () => {
		let calls = 0;
		const input = Object.defineProperty({ messages: [email("m1")] }, "op", {
			enumerable: true,
			get() {
				calls++;
				throw new Error("Synthetic accessor must remain inert");
			},
		});
		expect(() => planGmailMutation(input)).toThrow();
		expect(calls).toBe(0);
	});

	it("detaches and freezes the planned wire DATA from its input", () => {
		const message = email("m1");
		const input = { op: "label", messages: [message], labelIds: ["Label_original"] };
		const plan = planGmailMutation(input);
		input.op = "read";
		message.providerId = "m2";
		input.labelIds[0] = "Label_changed";
		expect(plan.operation).toBe("label");
		expect(plan.requests[0]?.providerId).toBe("m1");
		expect(labelsOf(onlyRequest(plan)).add).toEqual(["Label_original"]);
		expect(Object.isFrozen(plan)).toBe(true);
		expect(Object.isFrozen(plan.requests)).toBe(true);
		expect(Object.isFrozen(plan.requests[0])).toBe(true);
		expect(Object.isFrozen(plan.requests[0]?.headers)).toBe(true);
	});
});
