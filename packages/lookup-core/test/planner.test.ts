import { jcsSha256 } from "@draftyak/protocol/hash";
import { describe, expect, it } from "vitest";
import { bindLookup, LookupError, planLookups, type VerifiedThreadMeta } from "../src/index.ts";
import { canary, config, item, meta, now, toolId } from "./helpers.ts";

describe("metadata-only planning and binding", () => {
	it("binds owner constants and clock values from the protocol's closed sources", () => {
		const settings = config([item("calendar.freebusy"), item()]);
		const planned = planLookups(meta, settings, { kind: "on-demand", jobId: "draft" }, now);
		expect(planned.calls.map((call) => call.arguments)).toEqual([
			{ window: { start: now, end: Date.parse("2026-10-22T00:00:00Z") }, tz: "UTC" },
			{ topic: "company" },
		]);
		expect(planned.calls.every((call) => !call.messageDerived)).toBe(true);
	});
	it("requires a single aligned Gmail From with topmost DMARC pass; Reply-To and own-recipient cannot substitute", () => {
		const settings = config([item("contact.notes")]);
		for (const sender of [
			undefined,
			{
				kind: "gmail",
				address: "synthetic@example.invalid",
				topmostDmarc: "fail",
				aligned: true,
				singleFrom: true,
			},
			{
				kind: "gmail",
				address: "synthetic@example.invalid",
				topmostDmarc: "pass",
				aligned: false,
				singleFrom: true,
			},
			{
				kind: "gmail",
				address: "synthetic@example.invalid",
				topmostDmarc: "pass",
				aligned: true,
				singleFrom: false,
			},
		] as const) {
			expect(
				planLookups({ ...meta, sender }, settings, { kind: "on-demand", jobId: "draft" }, now)
					.calls,
			).toHaveLength(0);
		}
	});
	it("accepts real Slack user ids, rejects bots, and never binds SMS numbers", () => {
		const slack: VerifiedThreadMeta = {
			...meta,
			channel: "slack",
			sender: { kind: "slack", userId: "U12345", isBot: false },
		};
		expect(bindLookup(item("contact.notes"), slack, config().owner, now).arguments).toEqual({
			participant: "U12345",
		});
		expect(
			planLookups(
				{ ...slack, sender: { kind: "slack", userId: "U12345", isBot: true } },
				config([item("contact.notes")]),
				{ kind: "on-demand", jobId: "draft" },
				now,
			).calls,
		).toHaveLength(0);
		expect(() =>
			bindLookup(
				item("contact.notes"),
				{ ...meta, channel: "sms", sensitivity: "normal" },
				config().owner,
				now,
			),
		).toThrow(LookupError);
	});
	it("sensitive SMS, MCP and scheduled claims never plan lookups", () => {
		for (const sensitivity of [undefined, "otp", "shortcode", "alnum"] as const)
			expect(
				planLookups(
					{ ...meta, channel: "sms", sensitivity },
					config(),
					{ kind: "on-demand", jobId: "draft" },
					now,
				).calls,
			).toHaveLength(0);
		for (const kind of ["mcp", "scheduled-claim"] as const)
			expect(planLookups(meta, config(), { kind, jobId: "draft" }, now).skipped[0]?.reason).toBe(
				"TRIGGER_REFUSED",
			);
	});
	it("automatic mode requires trusted metadata and eligible AI destinations and never contacts or SMS", () => {
		const settings = config([item("contact.notes"), item()]);
		expect(
			planLookups(meta, settings, { kind: "automatic", jobId: "draft" }, now).calls.map(
				(call) => call.kind,
			),
		).toEqual(["kb.lookup"]);
		for (const automatic of [
			undefined,
			{ directToOwner: true, knownContact: true, bulk: true, list: false, noReply: false },
		])
			expect(
				planLookups({ ...meta, automatic }, config(), { kind: "automatic", jobId: "draft" }, now)
					.calls,
			).toHaveLength(0);
		expect(
			planLookups(
				meta,
				{ ...config(), aiDestination: "cloud-consumer-plan" },
				{ kind: "automatic", jobId: "draft" },
				now,
			).calls,
		).toHaveLength(0);
		expect(
			planLookups(
				{ ...meta, channel: "sms", sensitivity: "normal" },
				config(),
				{ kind: "automatic", jobId: "draft" },
				now,
			).calls,
		).toHaveLength(0);
	});
	it("enforces consent tuple, digest, quarantine and both argument/result route verdicts", () => {
		for (const consent of [
			{ ...config().consents[0], account: "other" },
			{ ...config().consents[0], aiDestination: "other" },
			{ ...config().consents[0], active: false },
		])
			expect(
				planLookups(
					meta,
					{ ...config(), consents: [consent] as OwnerConfig["consents"] },
					{ kind: "on-demand", jobId: "draft" },
					now,
				).calls,
			).toHaveLength(0);
		for (const change of [
			{ status: "disabled" as const },
			{ status: "quarantined" as const },
			{ currentDigest: "b".repeat(64) },
		]) {
			const settings = config();
			expect(
				planLookups(
					meta,
					{
						...settings,
						instances: settings.instances.map((instance) => ({ ...instance, ...change })),
					},
					{ kind: "on-demand", jobId: "draft" },
					now,
				).calls,
			).toHaveLength(0);
		}
		for (const refused of ["arguments", "result"])
			expect(
				planLookups(
					meta,
					{ ...config(), route: (query) => query.phase !== refused },
					{ kind: "on-demand", jobId: "draft" },
					now,
				).calls,
			).toHaveLength(0);
	});
	it("keeps destination identity separate from class and passes explicit route classes", () => {
		const first = config();
		expect(
			planLookups(
				meta,
				{ ...first, aiDestination: "ai-two", aiDestinationClass: "local" },
				{ kind: "on-demand", jobId: "other-ai" },
				now,
			).calls,
		).toHaveLength(0);
		const queries: RouteQuery[] = [];
		expect(
			planLookups(
				meta,
				{
					...first,
					route: (query) => {
						queries.push(query);
						return true;
					},
				},
				{ kind: "automatic", jobId: "auto" },
				now,
			).calls,
		).toHaveLength(1);
		expect(queries).toMatchObject([
			{ phase: "arguments", target: toolId, destinationClass: "local", classes: ["hub.state"] },
			{ phase: "result", target: "ai-one", destinationClass: "local", classes: ["tool.kb.lookup"] },
		]);
		expect(
			planLookups(
				meta,
				{ ...first, aiDestinationClass: "cloud-consumer-plan" },
				{ kind: "automatic", jobId: "refused" },
				now,
			).skipped[0]?.reason,
		).toBe("AUTOMATIC_INELIGIBLE");
	});
	it("refuses truthy non-boolean permission, consent and route evidence", () => {
		const settings = config();
		for (const change of [{ status: "true" }, { posture: "false" }]) {
			const altered = {
				...settings,
				instances: settings.instances.map((instance) => ({ ...instance, ...change })),
			} as unknown as OwnerConfig;
			expect(
				planLookups(meta, altered, { kind: "on-demand", jobId: "draft" }, now).calls,
			).toHaveLength(0);
		}
		const altered = {
			...settings,
			consents: settings.consents.map((consent) => ({ ...consent, active: "false" })),
		} as unknown as OwnerConfig;
		expect(
			planLookups(meta, altered, { kind: "on-demand", jobId: "draft" }, now).calls,
		).toHaveLength(0);
		expect(
			planLookups(
				meta,
				{ ...settings, route: (() => "false") as unknown as OwnerConfig["route"] },
				{ kind: "on-demand", jobId: "draft" },
				now,
			).calls,
		).toHaveLength(0);
	});
	it("cloud participant confirmation binds the draft/account and exact arguments", () => {
		const settings = config([item("contact.notes")]);
		const cloud = {
			...settings,
			instances: settings.instances.map((instance) => ({
				...instance,
				destination: "cloud-tool" as const,
			})),
		};
		const digest = jcsSha256({
			instance: toolId,
			kind: "contact.notes",
			arguments: { participant: "synthetic@example.invalid" },
		});
		const trigger = {
			kind: "on-demand" as const,
			jobId: "draft",
			confirmation: { jobId: "draft", account: meta.account, argumentDigests: [digest] },
		};
		expect(planLookups(meta, cloud, trigger, now).calls).toHaveLength(1);
		expect(planLookups(meta, cloud, trigger, now).pendingConfirmations).toEqual([]);
		const pending = planLookups(
			meta,
			cloud,
			{ kind: "on-demand", jobId: "draft" },
			now,
		).pendingConfirmations;
		expect(pending).toEqual([
			{
				index: 0,
				instance: toolId,
				kind: "contact.notes",
				boundFields: ["participant"],
				argumentDigest: digest,
			},
		]);
		expect(Object.isFrozen(pending)).toBe(true);
		expect(Object.isFrozen(pending[0]?.boundFields)).toBe(true);
		expect(JSON.stringify(pending)).not.toContain("synthetic@example.invalid");
		for (const change of [
			{ jobId: "other" },
			{ account: "other" },
			{ argumentDigests: ["b".repeat(64)] },
		])
			expect(
				planLookups(
					meta,
					cloud,
					{ ...trigger, confirmation: { ...trigger.confirmation, ...change } },
					now,
				).calls,
			).toHaveLength(0);
	});
	it("validates all preset limits and never accepts a content binding", () => {
		const settings = config();
		for (const presets of [
			Array.from({ length: 6 }, () => settings.presets[0]),
			[{ ...settings.presets[0], items: [item(), item(), item(), item()] }],
			[{ ...settings.presets[0], items: [item("contact.notes"), item("contact.notes")] }],
			[
				{
					...settings.presets[0],
					items: [{ ...item(), bindings: { topic: { source: canary, value: canary } } }],
				},
			],
		])
			expect(() =>
				planLookups(
					meta,
					{ ...settings, presets } as OwnerConfig,
					{ kind: "on-demand", jobId: "draft" },
					now,
				),
			).toThrow(LookupError);
		expect(
			planLookups(meta, config([item(), item()]), { kind: "on-demand", jobId: "draft" }, now)
				.skipped,
		).toEqual([{ index: 1, reason: "DUPLICATE" }]);
	});
});

import type { OwnerConfig, RouteQuery } from "../src/index.ts";
