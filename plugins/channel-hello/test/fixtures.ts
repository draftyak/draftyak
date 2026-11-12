import { createHelloFake, createRecorder, HELLO_HOST, manualClock } from "@draftyak/fakes";
import type { ChannelContractFixture } from "@draftyak/plugin-testkit";
import type { ChatMessageChange } from "@draftyak/protocol/normalized-change";

export function fixtures(): ChannelContractFixture {
	const clock = manualClock(1_000);
	const recorder = createRecorder({ headerValues: ["content-type"] });
	const channelId = "DYTEST-room";
	const initial: ChatMessageChange = {
		kind: "chat.message",
		channelId,
		ts: "msg_000001",
		sentAt: 1_000,
		author: { kind: "user", id: "DYTEST-user" },
		text: "DYTEST initial",
	};
	const fake = createHelloFake({
		clock,
		recorder,
		cursorTtlMs: 100,
		conversations: [
			{
				id: channelId,
				name: "DYTEST contract room",
				messages: [{ author: "DYTEST-user", text: "DYTEST initial" }],
			},
		],
	});
	let delta: readonly ChatMessageChange[] = [];
	const outboxId = "00000000000000000000000003";
	const approvedText = "DYTEST approved\nDYTEST footer";
	const sent: ChatMessageChange = {
		kind: "chat.message",
		channelId,
		// A fresh provider has one seeded message, so its next allocation is msg_000002.
		ts: "msg_000002",
		sentAt: 1_000,
		author: { kind: "user", id: "me" },
		text: approvedText,
	};
	return {
		upstreams: [fake],
		sync: {
			since: 1_000,
			initial: [initial],
			addDelta() {
				clock.advance(1);
				const added = fake.addMessage(channelId, {
					author: "DYTEST-user-two",
					text: "DYTEST delta",
				});
				delta = [
					{
						kind: "chat.message",
						channelId,
						ts: added.id,
						sentAt: 1_001,
						author: { kind: "user", id: "DYTEST-user-two" },
						text: "DYTEST delta",
					},
				];
				return delta;
			},
			resync: () => [initial, ...delta],
			expireCursor: () => clock.advance(100),
		},
		body: {
			message: { kind: "chat", channelId, ts: "msg_000001" },
			expected: initial,
		},
		send: {
			rendered: {
				outboxId,
				method: "POST",
				url: `https://${HELLO_HOST}/v1/conversations/${channelId}/messages?idempotency_key=${outboxId}`,
				headers: [["content-type", "application/json"]],
				body: new TextEncoder().encode(JSON.stringify({ text: approvedText })),
			},
			expectedMessage: { kind: "chat", channelId, ts: "msg_000002" },
			reconcile: {
				arguments: { attemptAt: 1_000, target: { kind: "chat", channelId } },
				expected: { candidates: [sent], complete: true },
			},
		},
		errors: [
			{
				name: "channel_body_fetch",
				arguments: { message: { kind: "chat", channelId, ts: "DYTEST-missing" } },
				code: "NOT_FOUND",
			},
		],
	};
}
