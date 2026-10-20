import { readFileSync } from "node:fs";
import { canonicalize } from "@draftyak/protocol/jcs";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { metadata } from "../src/metadata.ts";
import type { LookupPlan, RouteQuery, VerifiedThreadMeta } from "../src/model.ts";
import { planLookups } from "../src/planner.ts";
import { LookupRunner } from "../src/runner.ts";
import { config, host, item, meta, now, secondId } from "./helpers.ts";
import { runtimeClosure } from "./runtime-imports.ts";

const ignoredNames = ["body", "subject", "displayName", "name", "replyTo", "authenticationResults"];
const signature = (plan: LookupPlan) =>
	plan.calls.map((call) => [call.kind, call.instance.id, canonicalize(call.arguments)]);

describe("planner metadata security properties", () => {
	it("keeps only declared nested sender and automatic fields without reading unrelated getters", () => {
		let reads = 0;
		const thread = structuredClone(meta);
		for (const object of [thread, thread.sender, thread.automatic]) {
			if (!object) throw new Error("Missing synthetic metadata");
			for (const name of ignoredNames)
				Object.defineProperty(object, name, {
					enumerable: true,
					get() {
						reads++;
						throw new Error("PRIVATE_UNUSED_CANARY");
					},
				});
		}
		expect(metadata(thread)).toEqual(meta);
		expect(
			signature(planLookups(thread, config(), { kind: "on-demand", jobId: "nested" }, now)),
		).toEqual(signature(planLookups(meta, config(), { kind: "on-demand", jobId: "nested" }, now)));
		expect(reads).toBe(0);
	});

	it("varies verified metadata and participant presets while ignoring nested content (500 runs)", () => {
		const generated = fc.record({
			channel: fc.constantFrom("gmail", "slack", "sms"),
			index: fc.integer({ min: 0, max: 999_999 }),
			pass: fc.boolean(),
			aligned: fc.boolean(),
			single: fc.boolean(),
			bot: fc.boolean(),
			recipient: fc.boolean(),
			source: fc.constantFrom("participant.verifiedSender", "participant.ownerRecipient"),
			sensitivity: fc.constantFrom("normal", "otp", "shortcode", "alnum"),
			automatic: fc.record({
				directToOwner: fc.boolean(),
				knownContact: fc.boolean(),
				bulk: fc.boolean(),
				list: fc.boolean(),
				noReply: fc.boolean(),
			}),
			trigger: fc.constantFrom("on-demand", "automatic"),
			localNetwork: fc.boolean(),
			cloudAi: fc.boolean(),
			horizon: fc.constantFrom(3, 5, 10),
			start: fc.integer({ min: 480, max: 660 }),
			untrusted: fc.jsonValue({ maxDepth: 3 }),
		});
		const covered = new Set<string>();
		fc.assert(
			fc.property(generated, (value) => {
				covered.add(value.channel);
				covered.add(value.source);
				const address = `person${value.index}@example.invalid`;
				const user = `U${String(value.index).padStart(3, "0")}`;
				const thread: VerifiedThreadMeta = {
					account: `account-${value.index}`,
					channel: value.channel,
					sensitivity: value.sensitivity,
					sender:
						value.channel === "gmail"
							? {
									kind: "gmail",
									address,
									topmostDmarc: value.pass ? "pass" : "fail",
									aligned: value.aligned,
									singleFrom: value.single,
								}
							: value.channel === "slack"
								? { kind: "slack", userId: user, isBot: value.bot }
								: undefined,
					ownerRecipient: value.recipient
						? value.channel === "slack"
							? "WRECIPIENT"
							: `owner${value.index}@example.invalid`
						: undefined,
					automatic: value.automatic,
				};
				const contact = item("contact.notes");
				contact.bindings = { participant: { source: value.source } };
				const kb = item("kb.lookup", secondId);
				kb.bindings = { topic: { source: "const", value: `topic-${value.index}` } };
				const calendar = item("calendar.freebusy");
				calendar.bindings = {
					window: { source: "clock", horizonDays: value.horizon },
					tz: { source: "owner", field: "zone" },
				};
				const settings = config(value.channel === "sms" ? [kb, calendar] : [contact, kb, calendar]);
				const aiDestination = `ai-${value.index}`;
				const queries: RouteQuery[] = [];
				const varied = {
					...settings,
					aiDestination,
					aiDestinationClass: value.cloudAi ? ("cloud-no-train" as const) : ("local" as const),
					route: (query: RouteQuery) => {
						queries.push(query);
						return true;
					},
					owner: {
						...settings.owner,
						workingHours: {
							...settings.owner.workingHours,
							start: `${String(Math.floor(value.start / 60)).padStart(2, "0")}:${String(value.start % 60).padStart(2, "0")}`,
						},
					},
					instances: settings.instances.map((instance) => ({
						...instance,
						hosts: [`host${value.index}.example.invalid`],
						destination: value.localNetwork ? ("local-network" as const) : ("local" as const),
					})),
					consents: settings.consents.map((consent) => ({
						...consent,
						account: thread.account,
						aiDestination,
					})),
				};
				const untrusted = Object.fromEntries(ignoredNames.map((name) => [name, value.untrusted]));
				untrusted.replyTo = `attacker${value.index}@example.invalid`;
				const changed = {
					...thread,
					...untrusted,
					sender: thread.sender ? { ...thread.sender, ...untrusted } : undefined,
					automatic: { ...value.automatic, ...untrusted },
				};
				const trigger = { kind: value.trigger, jobId: `job-${value.index}` };
				const baseline = planLookups(thread, varied, trigger, now);
				expect(signature(planLookups(changed, varied, trigger, now))).toEqual(signature(baseline));
				expect(metadata(changed)).toEqual(metadata(thread));
				if (baseline.calls.some((call) => call.kind === "contact.notes")) {
					expect(value.channel).not.toBe("sms");
					if (value.source === "participant.ownerRecipient") expect(value.recipient).toBe(true);
					else if (value.channel === "gmail")
						expect([value.pass, value.aligned, value.single]).toEqual([true, true, true]);
					else expect(value.bot).toBe(false);
				}
				if (value.trigger === "automatic") {
					expect(baseline.calls.every((call) => !call.messageDerived)).toBe(true);
					expect(baseline.calls.every((call) => call.kind !== "contact.notes")).toBe(true);
					expect(
						queries
							.filter((query) => query.phase === "arguments")
							.every((query) => canonicalize(query.classes) === '["hub.state"]'),
					).toBe(true);
				}
			}),
			{ numRuns: 500, seed: 7_783 },
		);
		expect([...covered].sort()).toEqual([
			"gmail",
			"participant.ownerRecipient",
			"participant.verifiedSender",
			"slack",
			"sms",
		]);
	});

	it.each(["gmail", "slack"] as const)(
		"exercises both participant sources and exact %s route data classes",
		(channel) => {
			const thread: VerifiedThreadMeta =
				channel === "gmail"
					? meta
					: {
							...meta,
							channel,
							sender: { kind: "slack", userId: "UVERIFIED", isBot: false },
							ownerRecipient: "WRECIPIENT",
						};
			for (const source of ["participant.verifiedSender", "participant.ownerRecipient"] as const) {
				const contact = item("contact.notes");
				contact.bindings = { participant: { source } };
				const queries: RouteQuery[] = [];
				const settings = {
					...config([contact]),
					route: (query: RouteQuery) => {
						queries.push(query);
						return true;
					},
				};
				const planned = planLookups(
					thread,
					settings,
					{ kind: "on-demand", jobId: "participant" },
					now,
				);
				expect(planned.calls).toHaveLength(1);
				expect(planned.calls[0]?.arguments).toEqual({
					participant:
						source === "participant.ownerRecipient"
							? thread.ownerRecipient
							: channel === "gmail"
								? "synthetic@example.invalid"
								: "UVERIFIED",
				});
				expect(queries.map((query) => [query.phase, query.classes])).toEqual([
					["arguments", [`${channel}.metadata`]],
					["result", ["tool.contact.notes", `${channel}.metadata`]],
				]);
			}
		},
	);

	it.each(["participant.verifiedSender", "participant.ownerRecipient"] as const)(
		"refuses an attempted SMS contact preset bound to %s before routing",
		(source) => {
			const contact = item("contact.notes");
			contact.bindings = { participant: { source } };
			const route = vi.fn(() => true);
			expect(() =>
				planLookups(
					{ ...meta, channel: "sms", sensitivity: "normal" },
					{ ...config([contact]), route },
					{ kind: "on-demand", jobId: "sms-contact" },
					now,
				),
			).toThrow("INVALID_PRESET");
			expect(route).not.toHaveBeenCalled();
		},
	);

	it.each(["gmail", "slack"] as const)(
		"plans nonempty eligible automatic %s calls with only hub.state arguments",
		(channel) => {
			const thread: VerifiedThreadMeta =
				channel === "gmail"
					? meta
					: { ...meta, channel, sender: { kind: "slack", userId: "UVERIFIED", isBot: false } };
			const queries: RouteQuery[] = [];
			const settings = {
				...config([item("contact.notes"), item("kb.lookup", secondId), item("calendar.freebusy")]),
				route: (query: RouteQuery) => {
					queries.push(query);
					return true;
				},
			};
			const planned = planLookups(thread, settings, { kind: "automatic", jobId: "eligible" }, now);
			expect(planned.calls.map((call) => call.kind)).toEqual(["kb.lookup", "calendar.freebusy"]);
			expect(planned.calls.every((call) => !call.messageDerived)).toBe(true);
			expect(
				queries.filter((query) => query.phase === "arguments").map((query) => query.classes),
			).toEqual([["hub.state"], ["hub.state"]]);
		},
	);

	it("does not retain a Slack-derived cache entry after its draft job ends", async () => {
		const adapter = host(),
			call = vi.spyOn(adapter, "call");
		const thread: VerifiedThreadMeta = {
			...meta,
			channel: "slack",
			sender: { kind: "slack", userId: "UVERIFIED", isBot: false },
		};
		const settings = config([item("contact.notes")]);
		const runner = new LookupRunner(adapter);
		for (let repeat = 0; repeat < 2; repeat++) {
			const planned = planLookups(
				thread,
				settings,
				{ kind: "on-demand", jobId: "same-draft" },
				now,
			);
			expect(planned.calls).toHaveLength(1);
			expect((await runner.run(planned)).contexts).toHaveLength(1);
		}
		expect(call).toHaveBeenCalledTimes(2);
	});
});

describe("transitive planner runtime import boundary", () => {
	it("scans every runtime module reached by planner and binder", async () => {
		const root = new URL("../src/", import.meta.url);
		const visited = await runtimeClosure(
			root,
			[new URL("planner.ts", root), new URL("binder.ts", root)],
			(file) => readFileSync(file, "utf8"),
		);
		for (const name of ["planner", "binder", "model", "metadata", "clock"])
			expect(visited).toContain(new URL(`${name}.ts`, root).href);
	});
	it.each([
		"import '@draftyak/protocol/entities';",
		"import { content } from '@draftyak/protocol/normalized-change';",
		"export { content } from '@draftyak/protocol/entities';",
		"void import('@draftyak/protocol/entities');",
		"void import(target);",
		// biome-ignore lint/suspicious/noTemplateCurlyInString: JavaScript fixture for a computed import.
		"void import(`@draftyak/protocol/${target}`);",
		"import 'node:fs';",
		"import 'node:util';",
		"import '../outside.ts';",
	])("refuses indirect runtime dependencies: %s", async (dependency) => {
		const root = new URL("file:///planner-test/");
		const modules: Record<string, string> = {
			"planner.ts": "import './model.ts';",
			"model.ts": dependency,
		};
		await expect(
			runtimeClosure(
				root,
				[new URL("planner.ts", root)],
				(file) => modules[file.pathname.split("/").at(-1) ?? ""] ?? "",
			),
		).rejects.toThrow();
	});
	it("ignores import.meta and erased type imports while checking all runtime import forms", async () => {
		const root = new URL("file:///planner-test/");
		const modules: Record<string, string> = {
			"planner.ts":
				"import './model.ts'; const here = import.meta.url; void import('@draftyak/protocol/tool-v1');",
			"model.ts":
				"import type { Unused } from '@draftyak/protocol/entities'; export { canonicalize } from '@draftyak/protocol/jcs';",
		};
		expect(
			await runtimeClosure(
				root,
				[new URL("planner.ts", root)],
				(file) => modules[file.pathname.split("/").at(-1) ?? ""] ?? "",
			),
		).toHaveLength(2);
	});
});
