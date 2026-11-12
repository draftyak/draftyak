import { createHash } from "node:crypto";
import { snapshotClaimStamp } from "@draftyak/mime";
import { validateTemplate } from "@draftyak/protocol/json-template";
import type { SendDeclaration } from "@draftyak/protocol/manifest";
import { CurrentSendSnapshotV1 } from "@draftyak/protocol/snapshot";
import { describe, expect, it } from "vitest";
import {
	type NativeBuiltinSendInput,
	renderNativeBuiltinSend,
} from "../../../src/outbox/renderers/catalog.ts";
import { attachment, claimStamp, emailSnapshot, slackSnapshot, USER_ID } from "./fixture.ts";

const digest = (bytes: string | Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");
const SLACK_URL = "https://slack.com/api/chat.postMessage";
const JSON_HEADERS_PREIMAGE = '[["content-type","application/json"]]';
const DEFAULT_SLACK_BODY =
	'{"channel":"C1234567890","text":"Hello, café.\\nSecond line.\\nSent with DraftYak","unfurl_links":false,"unfurl_media":false}';

function slackInput(): NativeBuiltinSendInput {
	return {
		snapshot: slackSnapshot(),
		profile: "slack-v1",
		declaration: { render: "slack-postmessage" },
		stamp: claimStamp(),
		attachments: [],
	};
}

function gmailInput(): NativeBuiltinSendInput {
	return {
		snapshot: gmailSnapshot(),
		profile: "gmail-v1",
		declaration: { render: "gmail-rfc5322" },
		stamp: claimStamp(),
		attachments: [],
	};
}

function gmailSnapshot() {
	const base = emailSnapshot();
	return { ...base, email: { ...base.email, bcc: [] } };
}

async function refused(raw: unknown): Promise<void> {
	try {
		await renderNativeBuiltinSend(raw as NativeBuiltinSendInput);
		expect.fail("Expected closed-catalog refusal");
	} catch (error) {
		expect(error).toMatchObject({
			name: "NativeSendRenderError",
			code: "SEND_RENDER_UNAVAILABLE",
			message: "Send rendering unavailable",
		});
		expect(error).not.toHaveProperty("cause");
	}
}

async function expectSlack(input: NativeBuiltinSendInput, expectedBody: string) {
	const actual = await renderNativeBuiltinSend(input);
	expect(actual.method).toBe("POST");
	expect(actual.url).toBe(SLACK_URL);
	expect(actual.contentType).toBe("application/json");
	expect(actual.headers).toEqual([["content-type", "application/json"]]);
	expect(Buffer.from(actual.body)).toEqual(Buffer.from(expectedBody, "utf8"));
	expect(actual.render).toEqual({
		method: "POST",
		url: SLACK_URL,
		headersSha256: digest(JSON_HEADERS_PREIMAGE),
		bodySha256: digest(expectedBody),
	});
	return actual;
}

describe("closed native send codec catalog", () => {
	it("uses a valid synthetic stamp DATA value without claiming its issuance", () => {
		const stamp = claimStamp();
		expect(snapshotClaimStamp(stamp)).toEqual(stamp);
		expect(stamp.dateMs % 1000).toBe(0);
	});

	it.each([
		{
			name: "readonly Gmail",
			profile: "gmail-readonly-v1",
			declaration: { render: "gmail-rfc5322" },
		},
		{
			name: "unknown profile",
			profile: "unknown-v1",
			declaration: { render: "slack-postmessage" },
		},
		{
			name: "Slack with Gmail renderer",
			profile: "slack-v1",
			declaration: { render: "gmail-rfc5322" },
		},
		{
			name: "Gmail with Slack renderer",
			profile: "gmail-v1",
			declaration: { render: "slack-postmessage" },
		},
	])("refuses $name rather than selecting a fallback codec", async ({ profile, declaration }) => {
		const snapshot = profile.startsWith("gmail") ? gmailSnapshot() : slackSnapshot();
		await refused({ ...slackInput(), snapshot, profile, declaration });
	});

	it("refuses a valid postponed JSON template instead of creating a third binding", async () => {
		const declaration: SendDeclaration = {
			render: "json-template",
			constants: {},
			template: {
				rule: 0,
				path: ["channels", { bind: "chat.channelId" }, "send"],
				query: {},
				headers: { "content-type": "application/json" },
				body: { text: { bind: "body.textWithFooter" } },
			},
		};
		expect(
			validateTemplate(
				declaration.template,
				[
					{
						class: "send",
						method: "POST",
						host: "example.test",
						pathTemplate: "/channels/{chat.channelId}/send",
						maxBytes: 1024,
						timeoutMs: 1000,
					},
				],
				declaration.constants,
			),
		).toEqual([]);
		await refused({ ...slackInput(), declaration });
	});

	it.each(["email-for-Slack", "chat-for-Gmail"] as const)(
		"refuses mismatched snapshot kind: %s",
		async (fault) => {
			await refused(
				fault === "email-for-Slack"
					? { ...slackInput(), snapshot: emailSnapshot() }
					: { ...gmailInput(), snapshot: slackSnapshot() },
			);
		},
	);

	it("refuses a structurally valid built-in snapshot.render rather than replacing frozen content", async () => {
		const input = slackInput();
		const snapshot = CurrentSendSnapshotV1.parse({
			...input.snapshot,
			render: {
				method: "POST",
				url: SLACK_URL,
				headersSha256: digest(JSON_HEADERS_PREIMAGE),
				bodySha256: digest(DEFAULT_SLACK_BODY),
			},
		});
		await refused({ ...input, snapshot });
		expect(snapshot.render?.bodySha256).toBe(digest(DEFAULT_SLACK_BODY));
	});

	it("has no caller-provided codec registration or authority callback", async () => {
		let calls = 0;
		const codec = () => {
			calls++;
			throw new Error("Untrusted callback must not run");
		};
		await refused({ ...slackInput(), codec });
		expect(calls).toBe(0);
	});

	it("refuses an extended declaration instead of accepting an authority-like field", async () => {
		await refused({
			...slackInput(),
			declaration: { render: "slack-postmessage", approved: true },
		});
	});

	it.each([
		{ name: "subsecond date", stamp: { ...claimStamp(), dateMs: 1_700_000_000_001 } },
		{ name: "bad message ID", stamp: { ...claimStamp(), messageId: "synthetic@example.test" } },
		{ name: "short MIME boundary", stamp: { ...claimStamp(), mimeBoundary: "short" } },
		{
			name: "unsafe upload boundary",
			stamp: { ...claimStamp(), uploadBoundary: "../unsafe-boundary" },
		},
	])("validates the common stamp even for Slack: $name", async ({ stamp }) => {
		await refused({ ...slackInput(), stamp });
	});
});

describe("genuine Slack request projection", () => {
	it("uses exact delivered UTF-8 wire bytes, one footer LF and no MIME stamp fields", async () => {
		const input = slackInput();
		const before = structuredClone(input.snapshot);
		await expectSlack(input, DEFAULT_SLACK_BODY);
		expect(input.snapshot).toEqual(before);
		expect(input.snapshot).not.toHaveProperty("render");
	});

	it("keeps owner text literal but always escapes the footer", async () => {
		const base = slackSnapshot();
		await expectSlack(
			{
				...slackInput(),
				snapshot: { ...base, body: { text: "<owner> & text", footer: "<footer> & note" } },
			},
			'{"channel":"C1234567890","text":"<owner> & text\\n&lt;footer&gt; &amp; note","unfurl_links":false,"unfurl_media":false}',
		);
	});

	it("projects every frozen source kind so a mixed source cannot become owner-only", async () => {
		const base = slackSnapshot();
		await expectSlack(
			{
				...slackInput(),
				snapshot: {
					...base,
					body: { text: "<source> & text", footer: "" },
					source: {
						...base.source,
						authors: [
							{ kind: "owner", id: USER_ID },
							{ kind: "plugin", id: USER_ID },
						],
					},
				},
			},
			'{"channel":"C1234567890","text":"&lt;source&gt; &amp; text","unfurl_links":false,"unfurl_media":false}',
		);
	});

	it("preserves an explicit thread and broadcast in the exact delivered field order", async () => {
		const base = slackSnapshot();
		await expectSlack(
			{
				...slackInput(),
				snapshot: {
					...base,
					body: { text: "Thread reply", footer: "" },
					chat: { ...base.chat, threadTs: "1700000000.000001", broadcast: true },
				},
			},
			'{"channel":"C1234567890","thread_ts":"1700000000.000001","text":"Thread reply","unfurl_links":false,"unfurl_media":false,"reply_broadcast":true}',
		);
	});

	it("preserves shared and external facts as snapshot DATA without inventing request fields", async () => {
		const base = slackSnapshot();
		const snapshot = { ...base, chat: { ...base.chat, shared: true, external: true } };
		await expectSlack({ ...slackInput(), snapshot }, DEFAULT_SLACK_BODY);
		expect(snapshot.chat.shared).toBe(true);
		expect(snapshot.chat.external).toBe(true);
	});

	it("does not serialize a valid but different claim stamp into Slack bytes", async () => {
		await expectSlack(
			{
				...slackInput(),
				stamp: { ...claimStamp(), messageId: "<another-claim@example.test>", dateMs: 0 },
			},
			DEFAULT_SLACK_BODY,
		);
	});

	it("captures snapshot text before returning and detaches the returned byte buffer", async () => {
		const base = slackSnapshot();
		const body = { text: base.body.text, footer: base.body.footer };
		const input = { ...slackInput(), snapshot: { ...base, body } };
		const pending = renderNativeBuiltinSend(input);
		body.text = "Changed after invocation";
		const actual = await pending;
		expect(Buffer.from(actual.body)).toEqual(Buffer.from(DEFAULT_SLACK_BODY));
		const again = await renderNativeBuiltinSend(slackInput());
		actual.body.fill(0);
		expect(Buffer.from(again.body)).toEqual(Buffer.from(DEFAULT_SLACK_BODY));
	});

	it("accepts the exact rendered 40000-code-point limit and refuses one more", async () => {
		const base = slackSnapshot();
		const text = "x".repeat(40_000);
		await expectSlack(
			{ ...slackInput(), snapshot: { ...base, body: { text, footer: "" } } },
			`{"channel":"C1234567890","text":"${text}","unfurl_links":false,"unfurl_media":false}`,
		);
		await refused({
			...slackInput(),
			snapshot: { ...base, body: { text: `${text}x`, footer: "" } },
		});
	});

	it("refuses the independent UTF-8 request-byte limit before 40000 code points", async () => {
		const base = slackSnapshot();
		const text = "😀".repeat(32_768);
		expect([...text].length).toBeLessThan(40_000);
		expect(Buffer.byteLength(text)).toBe(131_072);
		await refused({ ...slackInput(), snapshot: { ...base, body: { text, footer: "" } } });
	});

	it.each(["e\u0301", "hidden\u0000control", "hidden\u007fcontrol", "bad\rline", "   "])(
		"refuses invalid frozen Slack text %#",
		async (text) => {
			const base = slackSnapshot();
			await refused({ ...slackInput(), snapshot: { ...base, body: { text, footer: "" } } });
		},
	);

	it.each(["e\u0301", "hidden\u0000control"])(
		"refuses invalid frozen footer %# rather than repairing it",
		async (footer) => {
			const base = slackSnapshot();
			await refused({ ...slackInput(), snapshot: { ...base, body: { text: "Body", footer } } });
		},
	);

	it("refuses broadcast without a frozen thread rather than adding one", async () => {
		const base = slackSnapshot();
		await refused({
			...slackInput(),
			snapshot: { ...base, chat: { ...base.chat, broadcast: true } },
		});
	});

	it("refuses legacy absent sharing rather than inventing a current sharing fact", async () => {
		const base = slackSnapshot();
		const { shared: _shared, ...legacyChat } = base.chat;
		expect(_shared).toBe(false);
		await refused({ ...slackInput(), snapshot: { ...base, chat: legacyChat } });
	});

	it("refuses Slack attachments instead of silently dropping frozen bytes", async () => {
		const base = slackSnapshot();
		const bytes = Buffer.from("synthetic attachment");
		await refused({
			...slackInput(),
			snapshot: { ...base, attachments: [attachment(bytes)] },
			attachments: [bytes],
		});
	});
});

describe("frozen Gmail attachment admission before the genuine producer", () => {
	it.each(["count", "length", "hash", "order"] as const)(
		"refuses an actual attachment %s mismatch against the frozen snapshot",
		async (fault) => {
			const first = Buffer.from("one");
			const second = Buffer.from("two");
			const base = gmailSnapshot();
			const snapshot = {
				...base,
				attachments: [attachment(first, "one.txt"), attachment(second, "two.txt")],
			};
			const attachments =
				fault === "count"
					? [first]
					: fault === "length"
						? [Buffer.from("on"), second]
						: fault === "hash"
							? [Buffer.from("bad"), second]
							: [second, first];
			await refused({ ...gmailInput(), snapshot, attachments });
			expect(Buffer.from(first)).toEqual(Buffer.from("one"));
			expect(Buffer.from(second)).toEqual(Buffer.from("two"));
		},
	);

	it("refuses shared attachment backing even when its frozen size and hash match", async () => {
		const base = gmailSnapshot();
		const metadata = attachment(new Uint8Array(3));
		await refused({
			...gmailInput(),
			snapshot: { ...base, attachments: [metadata] },
			attachments: [new Uint8Array(new SharedArrayBuffer(3))],
		});
	});

	it("refuses a MIME header-injected snapshot before any real composition", async () => {
		const base = gmailSnapshot();
		await refused({
			...gmailInput(),
			snapshot: {
				...base,
				email: { ...base.email, subject: "Subject\r\nBcc: other@example.test" },
			},
		});
	});
});
