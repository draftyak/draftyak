import { expect, it } from "vitest";
import {
	checkSlackPreflight,
	classifySlackRequest,
	classifySlackSend,
	renderSlackRequest,
	SlackCoreError,
	slackChatFacts,
	slackTimestamp,
} from "../src/index.ts";

const response = {
	channelId: "C0CHAN001",
	now: 1_000,
	deliverBy: 10_000,
	retryAttempt: 0,
	observation: {
		kind: "response",
		status: 200,
		body: { ok: true, channel: "C0CHAN001", ts: "1.0" },
	},
};

it("refuses proxies before invoking any caller traps across exported data boundaries", () => {
	let calls = 0;
	const target = { channelId: "C0CHAN001", text: "Synthetic message", origin: "machine" };
	const proxy = new Proxy(target, {
		getPrototypeOf() {
			calls++;
			throw new Error("PRIVATE_PROXY_CANARY");
		},
		ownKeys() {
			calls++;
			throw new Error("PRIVATE_PROXY_CANARY");
		},
		getOwnPropertyDescriptor() {
			calls++;
			throw new Error("PRIVATE_PROXY_CANARY");
		},
		get() {
			calls++;
			throw new Error("PRIVATE_PROXY_CANARY");
		},
	});
	for (const run of [renderSlackRequest, classifySlackSend, slackChatFacts, checkSlackPreflight]) {
		expect(() => run(proxy)).toThrowError(new SlackCoreError("INVALID_INPUT"));
	}
	expect(classifySlackRequest(proxy)).toBe("deny");
	expect(calls).toBe(0);
});

it("keeps proxy provider success ambiguous without evaluating the provider object", () => {
	let calls = 0;
	const body = new Proxy(response.observation.body, {
		getPrototypeOf(target) {
			calls++;
			return Reflect.getPrototypeOf(target);
		},
		ownKeys(target) {
			calls++;
			return Reflect.ownKeys(target);
		},
		getOwnPropertyDescriptor(target, key) {
			calls++;
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
	expect(
		classifySlackSend({ ...response, observation: { ...response.observation, body } }),
	).toEqual({ state: "UNKNOWN", reason: "ambiguous" });
	expect(calls).toBe(0);
});

it("normalizes revoked proxy failures to fixed refusals", () => {
	const { proxy, revoke } = Proxy.revocable({}, {});
	revoke();
	expect(() => renderSlackRequest(proxy)).toThrowError(new SlackCoreError("INVALID_INPUT"));
	expect(classifySlackRequest(proxy)).toBe("deny");
});

it.each(["\n", "\r\n"])(
	"refuses final line breaks %j in native preflight and success identifiers",
	(ending) => {
		const facts = {
			id: "C0CHAN001",
			type: "public",
			name: "Synthetic",
			isArchived: false,
			isShared: false,
			isExternal: false,
			isMember: true,
			memberCount: 3,
		};
		expect(() => slackChatFacts({ ...facts, id: facts.id + ending })).toThrow(SlackCoreError);
		expect(() =>
			checkSlackPreflight({
				approved: facts,
				current: facts,
				holdIfReply: true,
				approvedInboundWatermark: "1.0",
				currentInboundWatermark: `1.1${ending}`,
			}),
		).toThrow(SlackCoreError);
		expect(() => slackTimestamp(`1.0${ending}`)).toThrow(SlackCoreError);
		expect(
			classifySlackSend({
				...response,
				observation: {
					...response.observation,
					body: { ...response.observation.body, ts: `1.0${ending}` },
				},
			}),
		).toEqual({ state: "UNKNOWN", reason: "ambiguous" });
	},
);
