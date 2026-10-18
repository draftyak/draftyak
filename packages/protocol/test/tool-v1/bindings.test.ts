import { describe, expect, it } from "vitest";
import {
	BindingSource,
	type ContextPresetItem,
	PARTICIPANT_CHANNELS,
	PRESET_LIMITS,
	type PresetChannel,
	type PresetContext,
	type PresetProblem,
	type ToolInput,
	ToolKind,
	toolInputsV1,
	toolKindsV1,
	validatePresetItem,
	validatePresets,
} from "../../src/tool-v1.ts";

const instance = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
const gmail: PresetContext = { channel: "gmail" };
const calendar = {
	toolInstance: instance,
	kind: "calendar.freebusy",
	bindings: { window: { source: "clock", horizonDays: 5 }, tz: { source: "owner", field: "zone" } },
	onDemand: true,
	autoDraft: true,
};
const contact = {
	toolInstance: instance,
	kind: "contact.notes",
	bindings: { participant: { source: "participant.verifiedSender" } },
	onDemand: true,
	autoDraft: false,
};
const kb = {
	toolInstance: instance,
	kind: "kb.lookup",
	bindings: { topic: { source: "const", value: "pricing" } },
	onDemand: true,
	autoDraft: true,
};

const problems = (item: unknown, channel: PresetChannel = "gmail"): PresetProblem[] => {
	const checked = validatePresetItem(item, { channel });
	return checked.ok ? [] : [...checked.problems];
};
const withBinding = (
	item: typeof calendar | typeof contact | typeof kb,
	field: string,
	binding: unknown,
) => ({
	...item,
	bindings: { ...item.bindings, [field]: binding },
});

describe("BindingSource", () => {
	it("is the closed set: const, owner, clock and the two participant sources", () => {
		const accepted = [
			{ source: "const", value: "pricing" },
			{ source: "owner", field: "zone" },
			{ source: "owner", field: "workingHours" },
			{ source: "clock", horizonDays: 3 },
			{ source: "clock", horizonDays: 10 },
			{ source: "participant.verifiedSender" },
			{ source: "participant.ownerRecipient" },
		];
		for (const binding of accepted) expect(BindingSource.parse(binding)).toEqual(binding);
		expect(BindingSource.parse({ source: "clock" })).toEqual({ source: "clock", horizonDays: 3 });
		const refused = [
			{ source: "message.body" },
			{ source: "message.subject" },
			{ source: "participant.displayName" },
			{ source: "participant.replyTo" },
			{ source: "model" },
			{ source: "clock", horizonDays: 4 },
			{ source: "owner", field: "signature" },
			{ source: "const", value: 7 },
			{ source: "const", value: "x".repeat(257) },
			{ source: "participant.verifiedSender", value: "dytest@draftyak.example" },
			{},
			"const",
		];
		for (const binding of refused) expect(BindingSource.safeParse(binding).success).toBe(false);
	});
});

describe("validatePresetItem", () => {
	it("accepts each kind bound from its own sources", () => {
		for (const item of [calendar, contact, kb]) {
			expect(validatePresetItem(item, gmail)).toEqual({ ok: true, value: item });
		}
		const recipient = withBinding(contact, "participant", { source: "participant.ownerRecipient" });
		expect(problems(recipient, "slack")).toEqual([]);
		const defaulted = withBinding(calendar, "window", { source: "clock" });
		const checked = validatePresetItem(defaulted, gmail);
		expect(checked.ok && checked.value.bindings.window).toEqual({
			source: "clock",
			horizonDays: 3,
		});
	});

	it("knows every argument of each kind's canonical entry, and nothing can change its tables", () => {
		expect(Object.keys(toolInputsV1)).toEqual(ToolKind.options);
		for (const kind of ToolKind.options) {
			const { inputSchema } = toolKindsV1[kind].entry;
			const fields = Object.keys(toolInputsV1[kind]);
			expect(fields, kind).toEqual(inputSchema.required);
			expect(fields, kind).toEqual(Object.keys(inputSchema.properties as object));
			expect(Object.isFrozen(toolInputsV1[kind])).toBe(true);
			for (const field of fields) {
				expect(Object.isFrozen(toolInputsV1[kind][field])).toBe(true);
				expect(Object.isFrozen(toolInputsV1[kind][field]?.sources)).toBe(true);
			}
		}
		for (const table of [toolInputsV1, PARTICIPANT_CHANNELS, PRESET_LIMITS]) {
			expect(Object.isFrozen(table)).toBe(true);
		}
		const topic = toolInputsV1["kb.lookup"].topic as ToolInput;
		expect(() => (PARTICIPANT_CHANNELS as string[]).push("sms")).toThrow(TypeError);
		expect(() => (topic.sources as string[]).push("participant.verifiedSender")).toThrow(TypeError);
		expect(() => {
			(PRESET_LIMITS as { presets: number }).presets = 50;
		}).toThrow(TypeError);
	});

	it("binds every argument of the kind and nothing else", () => {
		expect(problems({ ...calendar, bindings: { window: calendar.bindings.window } })).toEqual([
			{ code: "PRESET_BINDING_FIELD", path: "bindings/tz" },
		]);
		expect(problems(withBinding(kb, "query", { source: "const", value: "x" }))).toEqual([
			{ code: "PRESET_BINDING_FIELD", path: "bindings/query" },
		]);
		const proto = JSON.parse(
			'{"toolInstance":"01JAZ3W3B6Q8M2V0G5T9K4X7RC","kind":"kb.lookup","onDemand":true,"autoDraft":false,' +
				'"bindings":{"topic":{"source":"const","value":"pricing"},"__proto__":{"source":"clock"}}}',
		);
		expect(problems(proto)).toEqual([{ code: "PRESET_BINDING_FIELD", path: "bindings/__proto__" }]);
	});

	it("refuses a binding outside the closed set or outside the argument's sources", () => {
		const outside: [typeof calendar | typeof contact | typeof kb, string, unknown][] = [
			[contact, "participant", { source: "message.from" }],
			[kb, "topic", { source: "message.subject" }],
			[contact, "participant", { source: "const", value: "dytest@draftyak.example" }],
			[kb, "topic", { source: "participant.verifiedSender" }],
			[calendar, "tz", { source: "owner", field: "workingHours" }],
			[calendar, "tz", { source: "const", value: "Europe/London" }],
			[calendar, "window", { source: "const", value: "2026-10-19" }],
			[calendar, "tz", { source: "clock", horizonDays: 3 }],
		];
		for (const [item, field, binding] of outside) {
			const onDemand = { ...item, autoDraft: false };
			expect(problems(withBinding(onDemand, field, binding)), JSON.stringify(binding)).toEqual([
				{ code: "PRESET_BINDING_SOURCE", path: `bindings/${field}` },
			]);
		}
	});

	it("refuses a const the argument refuses", () => {
		for (const value of ["Pricing", "pricing plan", "", `a${"b".repeat(64)}`]) {
			expect(problems(withBinding(kb, "topic", { source: "const", value }))).toEqual([
				{ code: "PRESET_BINDING_VALUE", path: "bindings/topic" },
			]);
		}
	});

	it("refuses an autoDraft item with a participant binding or of kind contact.notes", () => {
		expect(problems({ ...contact, autoDraft: true })).toEqual([
			{ code: "PRESET_AUTODRAFT", path: "bindings/participant" },
			{ code: "PRESET_AUTODRAFT", path: "kind" },
		]);
		expect(problems({ ...contact, autoDraft: true, onDemand: false }, "slack")).toHaveLength(2);
		expect(problems({ ...calendar, autoDraft: true })).toEqual([]);
		expect(problems({ ...kb, autoDraft: true })).toEqual([]);
	});

	it("refuses a participant binding on SMS and on plugin channels, whose senders aren't verified", () => {
		expect(PARTICIPANT_CHANNELS).toEqual(["gmail", "slack"]);
		// A channel plugin is never Gmail or Slack to the hub, whatever its id; an unknown value fails
		// closed.
		const channels: PresetChannel[] = [
			"sms",
			{ plugin: "hello" },
			{ plugin: "gmail" },
			{ plugin: "slack" },
			"telegram" as PresetChannel,
			{} as PresetChannel,
		];
		for (const channel of channels) {
			for (const source of ["participant.verifiedSender", "participant.ownerRecipient"]) {
				expect(problems(withBinding(contact, "participant", { source }), channel)).toEqual([
					{ code: "PRESET_PARTICIPANT_CHANNEL", path: "bindings/participant" },
				]);
			}
		}
		expect(problems({ ...contact, autoDraft: true }, "sms")).toEqual([
			{ code: "PRESET_AUTODRAFT", path: "bindings/participant" },
			{ code: "PRESET_PARTICIPANT_CHANNEL", path: "bindings/participant" },
			{ code: "PRESET_AUTODRAFT", path: "kind" },
		]);
		for (const item of [calendar, kb]) expect(problems(item, "sms")).toEqual([]);
	});

	it("refuses unknown members, kinds and instance ids", () => {
		expect(problems({ ...kb, extra: 1 })).toEqual([{ code: "PRESET_INVALID", path: "" }]);
		expect(problems({ ...kb, kind: "order.status" })).toEqual([
			{ code: "PRESET_INVALID", path: "kind" },
		]);
		expect(problems({ ...kb, toolInstance: "tool-1" })).toEqual([
			{ code: "PRESET_INVALID", path: "toolInstance" },
		]);
		expect(problems({ ...kb, onDemand: "yes" })).toEqual([
			{ code: "PRESET_INVALID", path: "onDemand" },
		]);
		expect(problems(null)).toEqual([{ code: "PRESET_INVALID", path: "" }]);
	});
});

describe("validatePresets", () => {
	const preset = (id: string, isDefault: boolean, items: unknown[]) => ({
		id,
		name: `DYTEST ${id.slice(-2)}`,
		isDefault,
		items,
	});
	const id = (n: number): string => `01JAZ3W3B6Q8M2V0G5T9K4X7${String(n).padStart(2, "0")}`;

	it("holds at most five presets, exactly one default, three items and one contact lookup each", () => {
		expect(PRESET_LIMITS).toEqual({ presets: 5, items: 3, contactItems: 1 });
		const five = [
			preset(id(1), true, [calendar, contact, kb]),
			...[2, 3, 4, 5].map((n) => preset(id(n), false, [kb])),
		];
		const checked = validatePresets(five, gmail);
		expect(checked.ok).toBe(true);
		expect(checked.ok && (checked.value[0]?.items as ContextPresetItem[])).toEqual([
			calendar,
			contact,
			kb,
		]);
		expect(validatePresets([], gmail)).toEqual({ ok: true, value: [] });

		const failures = (presets: unknown) => {
			const result = validatePresets(presets, gmail);
			return result.ok ? [] : result.problems;
		};
		expect(failures([...five, preset(id(6), false, [])])).toEqual([
			{ code: "PRESETS_TOO_MANY", path: "" },
		]);
		expect(failures([preset(id(1), false, [kb])])).toEqual([{ code: "PRESETS_DEFAULT", path: "" }]);
		expect(failures([preset(id(1), true, [kb]), preset(id(2), true, [kb])])).toEqual([
			{ code: "PRESETS_DEFAULT", path: "" },
		]);
		expect(failures([preset(id(1), true, [kb, kb, kb, kb])])).toEqual([
			{ code: "PRESET_INVALID", path: "0/items" },
		]);
		expect(failures([preset(id(1), true, [contact, contact])])).toEqual([
			{ code: "PRESET_CONTACT_ITEMS", path: "0/items" },
		]);
		expect(failures([{ ...preset(id(1), true, []), extra: 1 }])).toEqual([
			{ code: "PRESET_INVALID", path: "0" },
		]);
	});

	it("checks each item for its account's channel, with the item's path", () => {
		const result = validatePresets([preset(id(1), true, [kb, contact])], { channel: "sms" });
		expect(result).toEqual({
			ok: false,
			problems: [{ code: "PRESET_PARTICIPANT_CHANNEL", path: "0/items/1/bindings/participant" }],
		});
		const unknown = validatePresets([preset(id(1), true, [kb, { ...kb, extra: 1 }])], gmail);
		expect(unknown).toEqual({
			ok: false,
			problems: [{ code: "PRESET_INVALID", path: "0/items/1" }],
		});
	});
});
