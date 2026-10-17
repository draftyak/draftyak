import * as z from "zod";

// Channel areas whose classes the hub defines; the SMS contract adds "sms" to this line.
const channelAreas = ["gmail", "slack"] as const;
const toolKinds = ["calendar.freebusy", "contact.notes", "kb.lookup"] as const;

export type HubDataClass =
	| `${(typeof channelAreas)[number]}.${"metadata" | "content"}`
	| `tool.${(typeof toolKinds)[number]}`
	| "credentials"
	| "hub.state";

const hubDataClasses: HubDataClass[] = [
	...channelAreas.flatMap((area) => [`${area}.metadata`, `${area}.content`] as const),
	...toolKinds.map((kind) => `tool.${kind}` as const),
	"credentials",
	"hub.state",
];

export const HubDataClass: z.ZodEnum<z.core.util.ToEnum<HubDataClass>> = z.enum(
	hubDataClasses as [HubDataClass, ...HubDataClass[]],
);

// A community plugin's own classes, `<plugin>.metadata` and `<plugin>.content`. Names the hub
// uses for its own classes, "sms" among them, are never a plugin's.
const reserved = [...new Set([...channelAreas, "sms", "tool", "hub", "credentials"])];
export const PluginDataClass: z.ZodString = z
	.string()
	.regex(
		new RegExp(`^(?!(?:${reserved.join("|")})\\.)[a-z][a-z0-9-]{0,31}\\.(?:metadata|content)$`),
	);

export const DataClass: z.ZodUnion<readonly [typeof HubDataClass, typeof PluginDataClass]> = z
	.union([HubDataClass, PluginDataClass])
	.meta({ description: "The data class every account-derived row and tool result carries." });
export type DataClass = z.infer<typeof DataClass>;
