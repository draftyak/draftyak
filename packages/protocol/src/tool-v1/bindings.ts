import * as z from "zod";
import { boundedText, Ulid } from "../scalars.ts";
import { ToolKind, TopicId } from "./kinds.ts";

// The closed set of binding sources (I5): hub.state (const, owner, clock) and the account's
// metadata class (participant.*). Nothing from message content can bind.
export type BindingSource =
	| { source: "const"; value: string }
	| { source: "owner"; field: "zone" | "workingHours" }
	| { source: "clock"; horizonDays: 3 | 5 | 10 }
	| { source: "participant.verifiedSender" }
	| { source: "participant.ownerRecipient" };

export const BindingSource: z.ZodType<BindingSource> = z
	.discriminatedUnion("source", [
		z.strictObject({ source: z.literal("const"), value: boundedText(256) }),
		z.strictObject({ source: z.literal("owner"), field: z.enum(["zone", "workingHours"]) }),
		z.strictObject({
			source: z.literal("clock"),
			horizonDays: z.union([z.literal(3), z.literal(5), z.literal(10)]).default(3),
		}),
		z.strictObject({ source: z.literal("participant.verifiedSender") }),
		z.strictObject({ source: z.literal("participant.ownerRecipient") }),
	])
	.meta({ title: "BindingSource", description: "Where the hub takes one lookup argument from." });

// A source as an argument names it: owner.zone, not owner.
export type BindingSourceName =
	| Exclude<BindingSource["source"], "owner">
	| `owner.${Extract<BindingSource, { source: "owner" }>["field"]}`;

export const bindingSourceName = (binding: BindingSource): BindingSourceName =>
	binding.source === "owner" ? `owner.${binding.field}` : binding.source;

const isParticipant = (binding: BindingSource): boolean =>
	binding.source.startsWith("participant.");

export interface ToolInput {
	readonly sources: readonly BindingSourceName[];
	// What a const value must be, for an input that takes one.
	readonly constValue?: z.ZodType;
}

const input = (sources: readonly BindingSourceName[], constValue?: z.ZodType): ToolInput =>
	Object.freeze({ sources: Object.freeze([...sources]), ...(constValue && { constValue }) });

// Each kind's arguments and the sources each one may bind from.
export const toolInputsV1: { readonly [K in ToolKind]: { readonly [field: string]: ToolInput } } =
	Object.freeze({
		"calendar.freebusy": Object.freeze({ window: input(["clock"]), tz: input(["owner.zone"]) }),
		"contact.notes": Object.freeze({
			participant: input(["participant.verifiedSender", "participant.ownerRecipient"]),
		}),
		"kb.lookup": Object.freeze({ topic: input(["const"], TopicId) }),
	});

// The account's channel as the hub's own records give it, never as a plugin declares it: its
// first-party Gmail or Slack channel, SMS, or any other channel plugin by id.
export type PresetChannel = "gmail" | "slack" | "sms" | { readonly plugin: string };

// The channels whose participants the hub verifies itself (guardrail 10: never SMS, whatever S12
// decides; a channel plugin asserts its own metadata, so it never binds either).
export const PARTICIPANT_CHANNELS: readonly ("gmail" | "slack")[] = Object.freeze([
	"gmail",
	"slack",
]);

export const PRESET_LIMITS: {
	readonly presets: 5;
	readonly items: 3;
	readonly contactItems: 1;
} = Object.freeze({ presets: 5, items: 3, contactItems: 1 });

export interface ContextPresetItem {
	toolInstance: string;
	kind: ToolKind;
	bindings: Record<string, BindingSource>;
	onDemand: boolean;
	autoDraft: boolean;
}

export const ContextPresetItem: z.ZodType<ContextPresetItem> = z
	.strictObject({
		toolInstance: Ulid,
		kind: ToolKind,
		bindings: z.record(z.string(), BindingSource),
		onDemand: z.boolean(),
		autoDraft: z.boolean(),
	})
	.meta({ title: "ContextPresetItem", description: "One planned lookup of a context preset." });

export interface ContextPreset {
	id: string;
	name: string;
	isDefault: boolean;
	items: ContextPresetItem[];
}

export type PresetProblemCode =
	| "PRESET_INVALID"
	| "PRESET_BINDING_FIELD"
	| "PRESET_BINDING_SOURCE"
	| "PRESET_BINDING_VALUE"
	| "PRESET_AUTODRAFT"
	| "PRESET_PARTICIPANT_CHANNEL"
	| "PRESETS_TOO_MANY"
	| "PRESETS_DEFAULT"
	| "PRESET_CONTACT_ITEMS";

export interface PresetProblem {
	readonly code: PresetProblemCode;
	// Slash-separated, from the value passed in.
	readonly path: string;
}

export type PresetValidation<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly problems: readonly PresetProblem[] };

export interface PresetContext {
	readonly channel: PresetChannel;
}

const pathOf = (path: readonly PropertyKey[]): string => path.map(String).join("/");
// One problem per code and path.
const unique = (problems: readonly PresetProblem[]): PresetProblem[] =>
	problems.filter(
		(problem, at) =>
			problems.findIndex(({ code, path }) => code === problem.code && path === problem.path) === at,
	);
const result = <T>(value: T, problems: readonly PresetProblem[]): PresetValidation<T> =>
	problems.length === 0 ? { ok: true, value } : { ok: false, problems: unique(problems) };

const verifiesParticipants = ({ channel }: PresetContext): boolean =>
	typeof channel === "string" && (PARTICIPANT_CHANNELS as readonly string[]).includes(channel);

// The rules of §5 Triggers and Context lookups, and guardrail 10.
export function validatePresetItem(
	item: unknown,
	context: PresetContext,
): PresetValidation<ContextPresetItem> {
	const parsed = ContextPresetItem.safeParse(item);
	if (!parsed.success) {
		const problems = parsed.error.issues.map(
			({ path }): PresetProblem =>
				path[0] === "bindings" && path.length > 1
					? { code: "PRESET_BINDING_SOURCE", path: pathOf(path.slice(0, 2)) }
					: { code: "PRESET_INVALID", path: pathOf(path) },
		);
		return { ok: false, problems: unique(problems) };
	}
	const value = parsed.data;
	const problems: PresetProblem[] = [];
	const inputs = toolInputsV1[value.kind];
	// The raw names, so a "__proto__" member the parse dropped still counts.
	const named = Object.keys((item as { bindings: object }).bindings);
	for (const field of new Set([...Object.keys(inputs), ...named])) {
		const path = `bindings/${field}`;
		const input = Object.hasOwn(inputs, field) ? inputs[field] : undefined;
		const binding = Object.hasOwn(value.bindings, field) ? value.bindings[field] : undefined;
		if (input === undefined || binding === undefined) {
			problems.push({ code: "PRESET_BINDING_FIELD", path });
			continue;
		}
		if (!input.sources.includes(bindingSourceName(binding))) {
			problems.push({ code: "PRESET_BINDING_SOURCE", path });
		} else if (binding.source === "const" && !input.constValue?.safeParse(binding.value).success) {
			problems.push({ code: "PRESET_BINDING_VALUE", path });
		}
		if (isParticipant(binding)) {
			if (value.autoDraft) problems.push({ code: "PRESET_AUTODRAFT", path });
			if (!verifiesParticipants(context)) {
				problems.push({ code: "PRESET_PARTICIPANT_CHANNEL", path });
			}
		}
	}
	if (value.autoDraft && value.kind === "contact.notes") {
		problems.push({ code: "PRESET_AUTODRAFT", path: "kind" });
	}
	return result(value, problems);
}

const PresetShape = z.strictObject({
	id: Ulid,
	name: boundedText(64),
	isDefault: z.boolean(),
	items: z.array(z.unknown()).max(PRESET_LIMITS.items),
});

// An account's presets: at most five, exactly one of them the default, each with at most three
// items and at most one contact lookup.
export function validatePresets(
	presets: unknown,
	context: PresetContext,
): PresetValidation<ContextPreset[]> {
	const parsed = z.array(PresetShape).safeParse(presets);
	if (!parsed.success) {
		const problems = parsed.error.issues.map(
			({ path }): PresetProblem => ({ code: "PRESET_INVALID", path: pathOf(path) }),
		);
		return { ok: false, problems: unique(problems) };
	}
	const problems: PresetProblem[] = [];
	const value = parsed.data.map((preset, index) => {
		const items: ContextPresetItem[] = [];
		preset.items.forEach((item, at) => {
			const checked = validatePresetItem(item, context);
			if (checked.ok) items.push(checked.value);
			else {
				for (const { code, path } of checked.problems) {
					problems.push({ code, path: pathOf([index, "items", at, ...(path ? [path] : [])]) });
				}
			}
		});
		if (items.filter(({ kind }) => kind === "contact.notes").length > PRESET_LIMITS.contactItems) {
			problems.push({ code: "PRESET_CONTACT_ITEMS", path: `${index}/items` });
		}
		return { ...preset, items };
	});
	if (value.length > PRESET_LIMITS.presets) problems.push({ code: "PRESETS_TOO_MANY", path: "" });
	if (value.length > 0 && value.filter(({ isDefault }) => isDefault).length !== 1) {
		problems.push({ code: "PRESETS_DEFAULT", path: "" });
	}
	return result(value, problems);
}
