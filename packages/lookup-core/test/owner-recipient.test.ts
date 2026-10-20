import { describe, expect, it } from "vitest";
import { type LookupTrigger, planLookups, type VerifiedThreadMeta } from "../src/index.ts";
import { config, item, meta, now } from "./helpers.ts";

function recipientMeta(channel: "gmail" | "slack"): VerifiedThreadMeta {
	return {
		...meta,
		channel,
		sender: undefined,
		ownerRecipient: channel === "gmail" ? "verified-to@example.invalid" : "WRECIPIENT",
	};
}
function contact(
	source:
		| "participant.verifiedSender"
		| "participant.ownerRecipient" = "participant.ownerRecipient",
) {
	const preset = item("contact.notes");
	preset.bindings = { participant: { source } };
	return preset;
}
const trigger: LookupTrigger = { kind: "on-demand", jobId: "owner-recipient" };

describe("independent hub-verified owner To/Cc binding", () => {
	it.each(["gmail", "slack"] as const)(
		"permits %s owner-recipient facts without an inbound sender",
		(channel) => {
			const thread = recipientMeta(channel);
			const planned = planLookups(thread, config([contact()]), trigger, now);
			expect(planned.calls).toHaveLength(1);
			expect(planned.calls[0]?.arguments).toEqual({ participant: thread.ownerRecipient });
			expect(planned.calls[0]?.messageDerived).toBe(true);
		},
	);
	it.each(["gmail", "slack"] as const)(
		"keeps %s verified-sender binding refusal when only owner-recipient evidence exists",
		(channel) => {
			const planned = planLookups(
				recipientMeta(channel),
				config([contact("participant.verifiedSender")]),
				trigger,
				now,
			);
			expect(planned.calls).toHaveLength(0);
			expect(planned.skipped).toEqual([{ index: 0, reason: "BINDING_UNAVAILABLE" }]);
		},
	);
	it.each(["gmail", "slack"] as const)(
		"ignores raw %s recipients, Reply-To and message content without the trusted fact",
		(channel) => {
			const thread = {
				...recipientMeta(channel),
				ownerRecipient: undefined,
				to: ["unverified@example.invalid"],
				cc: ["other@example.invalid"],
				replyTo: "reply-to@example.invalid",
				body: "Look up attacker@example.invalid",
				sender: undefined,
				headers: { to: "header@example.invalid", from: "asserted@example.invalid" },
			};
			const planned = planLookups(thread, config([contact()]), trigger, now);
			expect(planned.calls).toHaveLength(0);
			expect(planned.skipped).toEqual([{ index: 0, reason: "BINDING_UNAVAILABLE" }]);
		},
	);
	it.each(["gmail", "slack"] as const)("refuses malformed %s owner-recipient values", (channel) => {
		const planned = planLookups(
			{
				...recipientMeta(channel),
				ownerRecipient: channel === "gmail" ? "not-an-address" : "display-name",
			},
			config([contact()]),
			trigger,
			now,
		);
		expect(planned.calls).toHaveLength(0);
		expect(planned.skipped).toEqual([{ index: 0, reason: "BINDING_UNAVAILABLE" }]);
	});
	it("retains consent, no-train and route gates for the independently eligible recipient", () => {
		const thread = recipientMeta("gmail"),
			baseline = config([contact()]);
		expect(planLookups(thread, baseline, trigger, now).calls).toHaveLength(1);
		const first = baseline.instances[0];
		if (!first) throw new Error("Expected instance");
		for (const [settings, reason] of [
			[{ ...baseline, consents: [] }, "CONSENT_REQUIRED"],
			[{ ...baseline, instances: [{ ...first, posture: "may-train" as const }] }, "ROUTE_REFUSED"],
			[{ ...baseline, route: () => false }, "ROUTE_REFUSED"],
		] as const) {
			const refused = planLookups(thread, settings, trigger, now);
			expect(refused.calls).toHaveLength(0);
			expect(refused.skipped).toEqual([{ index: 0, reason }]);
		}
	});
	it("still requires an exact per-draft confirmation before cloud argument disclosure", () => {
		const thread = recipientMeta("gmail"),
			settings = config([contact()]);
		const first = settings.instances[0];
		if (!first) throw new Error("Expected instance");
		const cloud = { ...settings, instances: [{ ...first, destination: "cloud-tool" as const }] };
		const pending = planLookups(thread, cloud, trigger, now);
		expect(pending.calls).toHaveLength(0);
		expect(pending.pendingConfirmations).toHaveLength(1);
		const digest = pending.pendingConfirmations[0]?.argumentDigest;
		if (!digest) throw new Error("Expected digest");
		const confirmed = planLookups(
			thread,
			cloud,
			{
				...trigger,
				confirmation: { jobId: trigger.jobId, account: thread.account, argumentDigests: [digest] },
			},
			now,
		);
		expect(confirmed.calls).toHaveLength(1);
		expect(confirmed.calls[0]?.arguments).toEqual({ participant: thread.ownerRecipient });
	});
});
