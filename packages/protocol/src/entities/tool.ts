import * as z from "zod";
import { HubDataClass } from "../data-class.ts";
import { Ulid, UtcMs } from "../scalars.ts";
import { patterned } from "./common.ts";
import { uniqueItems } from "./fields.ts";
import { RoutingDestination } from "./routing.ts";

// The kinds are those with a tool.<kind> data class, so the two lists never differ.
type ToolKindOf<Class> = Class extends `tool.${infer Kind}` ? Kind : never;
type ToolKind = ToolKindOf<HubDataClass>;
const toolKinds = HubDataClass.options.flatMap((dataClass) =>
	dataClass.startsWith("tool.") ? [dataClass.slice("tool.".length) as ToolKind] : [],
);

export type ToolDestination = "local" | "local-network" | "cloud-tool";
export const ToolDestination: z.ZodEnum<z.core.util.ToEnum<ToolDestination>> =
	RoutingDestination.extract(["local", "local-network", "cloud-tool"]).meta({
		id: "draftyak.entities.ToolDestination",
		description:
			"local: no egress or loopback only; local-network: RFC 1918 or ULA addresses; otherwise " +
			"cloud-tool.",
	});

const trainingPostures = ["no-train", "may-train"] as const;
export type TrainingPosture = (typeof trainingPostures)[number];
export const TrainingPosture: z.ZodEnum<z.core.util.ToEnum<TrainingPosture>> = z
	.enum(trainingPostures)
	.meta({
		id: "draftyak.entities.TrainingPosture",
		description: "Whether the owner declared that the destination doesn't train on what it gets.",
	});

const toolInstanceStatuses = ["active", "disabled", "credential_lost", "quarantined"] as const;
export type ToolInstanceStatus = (typeof toolInstanceStatuses)[number];
export const ToolInstanceStatus: z.ZodEnum<z.core.util.ToEnum<ToolInstanceStatus>> = z
	.enum(toolInstanceStatuses)
	.meta({
		id: "draftyak.entities.ToolInstanceStatus",
		description:
			"credential_lost: the secret address or key stopped working and needs replacing; " +
			"quarantined: its plugin changed its surface or digest.",
	});

const toolRunStatuses = [
	"ok",
	"cached",
	"timeout",
	"error",
	"skipped",
	"denied",
	"quarantined",
] as const;
export type ToolRunStatus = (typeof toolRunStatuses)[number];
export const ToolRunStatus: z.ZodEnum<z.core.util.ToEnum<ToolRunStatus>> = z
	.enum(toolRunStatuses)
	.meta({ id: "draftyak.entities.ToolRunStatus", description: "How one lookup ended." });

export const Hostname: z.ZodString = patterned(
	/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:[.][a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]{2,45}\])$/,
	253,
).meta({
	id: "draftyak.entities.Hostname",
	description: "A host as a URL holds it: a lower-case ASCII name, an IPv4 or a [IPv6] address.",
});

export const ToolInstance: z.ZodObject<
	{
		id: typeof Ulid;
		pluginId: typeof Ulid;
		kinds: z.ZodArray<z.ZodEnum<z.core.util.ToEnum<ToolKind>>>;
		hosts: z.ZodArray<typeof Hostname>;
		destination: typeof ToolDestination;
		posture: typeof TrainingPosture;
		status: typeof ToolInstanceStatus;
		createdAt: typeof UtcMs;
	},
	z.core.$strict
> = z
	.strictObject({
		id: Ulid,
		pluginId: Ulid,
		kinds: uniqueItems(z.array(z.enum(toolKinds as [ToolKind, ...ToolKind[]])).min(1)),
		hosts: uniqueItems(z.array(Hostname)),
		destination: ToolDestination,
		posture: TrainingPosture,
		status: ToolInstanceStatus,
		createdAt: UtcMs,
	})
	.meta({
		id: "draftyak.entities.ToolInstance",
		description:
			"A configured tool plugin. hosts are the hosts its egress reaches, as the hub resolved " +
			"them; posture is the owner's declaration, may-train unless they declared otherwise.",
	});
export type ToolInstance = z.infer<typeof ToolInstance>;
