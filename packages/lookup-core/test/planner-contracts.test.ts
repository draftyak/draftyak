import { describe, expect, it, vi } from "vitest";
import {
	LookupRunner,
	type OwnerConfig,
	planLookups,
	type RouteQuery,
	type VerifiedThreadMeta,
} from "../src/index.ts";
import { config, host, item, meta, now } from "./helpers.ts";

const trigger = { kind: "on-demand", jobId: "merged-contracts" } as const;

describe("merged lookup channel and tool facts", () => {
	it("plans and runs owner-state calendar and knowledge lookups for a channel plugin", async () => {
		const thread: VerifiedThreadMeta = {
			account: meta.account,
			channel: { plugin: "channel-hello" },
		};
		const settings = config([item("calendar.freebusy"), item("kb.lookup")]);
		const planned = planLookups(thread, settings, trigger, now);
		expect(planned.calls.map((call) => call.kind)).toEqual(["calendar.freebusy", "kb.lookup"]);
		expect(planned.calls.every((call) => !call.messageDerived && !call.slackDerived)).toBe(true);
		expect(planned.calls.map((call) => call.channel)).toEqual([thread.channel, thread.channel]);
		const adapter = host(),
			call = vi.spyOn(adapter, "call");
		expect((await new LookupRunner(adapter).run(planned)).contexts).toHaveLength(2);
		expect(call).toHaveBeenCalledTimes(2);
	});

	it.each(["participant.verifiedSender", "participant.ownerRecipient"] as const)(
		"refuses a plugin channel participant binding from %s",
		(source) => {
			const contact = item("contact.notes");
			contact.bindings = { participant: { source } };
			expect(() =>
				planLookups(
					{ ...meta, channel: { plugin: "channel-hello" } },
					config([contact]),
					trigger,
					now,
				),
			).toThrow("INVALID_PRESET");
		},
	);

	it.each(["unknown", { plugin: "" }, { plugin: "channel-hello", body: "unused" }, { plugin: 1 }])(
		"refuses an invalid channel envelope %j",
		(channel) => {
			expect(() =>
				planLookups({ ...meta, channel } as VerifiedThreadMeta, config(), trigger, now),
			).toThrow("INVALID_INPUT");
		},
	);

	it.each([{ hosts: [] }, { hosts: ["localhost", "[::1]"] }])(
		"retains and detaches the full resolved tool hosts list $hosts",
		({ hosts }) => {
			const settings = config();
			const source = [...hosts];
			const changed = {
				...settings,
				instances: settings.instances.map((instance) => ({ ...instance, hosts: source })),
			};
			const planned = planLookups(meta, changed, trigger, now);
			expect(planned.calls).toHaveLength(1);
			expect(planned.calls[0]?.instance.hosts).toEqual(hosts);
			source.push("later.example.invalid");
			expect(planned.calls[0]?.instance.hosts).toEqual(hosts);
			expect(Object.isFrozen(planned.calls[0]?.instance.hosts)).toBe(true);
		},
	);

	it.each(["disabled", "credential_lost", "quarantined"] as const)(
		"refuses a tool whose merged status is %s",
		(status) => {
			const settings = config();
			const planned = planLookups(
				meta,
				{ ...settings, instances: settings.instances.map((instance) => ({ ...instance, status })) },
				trigger,
				now,
			);
			expect(planned.calls).toHaveLength(0);
			expect(planned.skipped).toEqual([{ index: 0, reason: "INSTANCE_UNAVAILABLE" }]);
		},
	);

	it.each(["gmail", "slack"] as const)(
		"refuses %s metadata to a may-train tool even when the route callback allows it",
		(channel) => {
			const thread: VerifiedThreadMeta =
				channel === "gmail"
					? meta
					: { ...meta, channel, sender: { kind: "slack", userId: "UVERIFIED", isBot: false } };
			const queries: RouteQuery[] = [];
			const settings = config([item("contact.notes")]),
				route = vi.fn((query: RouteQuery) => {
					queries.push(query);
					return true;
				});
			const changed = {
				...settings,
				route,
				instances: settings.instances.map((instance) => ({
					...instance,
					posture: "may-train" as const,
				})),
			};
			const planned = planLookups(thread, changed, trigger, now);
			expect(planned.calls).toHaveLength(0);
			expect(planned.skipped).toEqual([{ index: 0, reason: "ROUTE_REFUSED" }]);
			expect(route).not.toHaveBeenCalled();
			expect(planLookups(thread, { ...settings, route }, trigger, now).calls).toHaveLength(1);
			expect(queries.map((query) => query.toolPosture)).toEqual(["no-train", "no-train"]);
		},
	);

	it("requires matching consent kind, digest, disclosure and revocation facts", () => {
		const settings = config();
		for (const change of [
			{ kinds: [] },
			{ kinds: ["contact.notes"] },
			{ fieldsDigest: "c".repeat(64) },
			{ disclosureVersion: 2 },
			{ revoked: true },
			{ revoked: "false" },
			{ active: false },
		]) {
			const changed = {
				...settings,
				consents: settings.consents.map((consent) => ({ ...consent, ...change })),
			} as OwnerConfig;
			const planned = planLookups(meta, changed, trigger, now);
			expect(planned.calls).toHaveLength(0);
			expect(planned.skipped).toEqual([{ index: 0, reason: "CONSENT_REQUIRED" }]);
		}
		expect(planLookups(meta, settings, trigger, now).calls).toHaveLength(1);
	});

	it("requires a canonical current fields digest and safe positive disclosure version", () => {
		const settings = config();
		for (const fieldsDigest of ["B".repeat(64), "b".repeat(63), "g".repeat(64)]) {
			const changed = {
				...settings,
				instances: settings.instances.map((instance) => ({
					...instance,
					currentFieldsDigest: fieldsDigest,
				})),
				consents: settings.consents.map((consent) => ({ ...consent, fieldsDigest })),
			};
			expect(planLookups(meta, changed, trigger, now).skipped).toEqual([
				{ index: 0, reason: "INSTANCE_UNAVAILABLE" },
			]);
		}
		for (const disclosureVersion of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			const changed = {
				...settings,
				instances: settings.instances.map((instance) => ({
					...instance,
					currentDisclosureVersion: disclosureVersion,
				})),
				consents: settings.consents.map((consent) => ({ ...consent, disclosureVersion })),
			};
			expect(planLookups(meta, changed, trigger, now).skipped).toEqual([
				{ index: 0, reason: "INSTANCE_UNAVAILABLE" },
			]);
		}
	});

	it("requires a requested kind's safe positive output ceiling and carries it detached", () => {
		const settings = config();
		for (const ceiling of [undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			const changed = {
				...settings,
				instances: settings.instances.map((instance) => ({
					...instance,
					outputMaxBytes: { "kb.lookup": ceiling },
				})),
			};
			expect(planLookups(meta, changed, trigger, now).skipped).toEqual([
				{ index: 0, reason: "INSTANCE_UNAVAILABLE" },
			]);
		}
		const ceiling = { "kb.lookup": 64 };
		const changed = {
			...settings,
			instances: settings.instances.map((instance) => ({ ...instance, outputMaxBytes: ceiling })),
		};
		const planned = planLookups(meta, changed, trigger, now);
		expect(planned.calls).toHaveLength(1);
		ceiling["kb.lookup"] = 1;
		expect(planned.calls[0]?.instance.outputMaxBytes).toEqual({ "kb.lookup": 64 });
	});
});
