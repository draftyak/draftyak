import * as z from "zod";

const routingDestinations = [
	"local",
	"local-network",
	"cloud-no-train",
	"cloud",
	"cloud-consumer-plan",
	"mcp-client",
	"cloud-tool",
] as const;
export type RoutingDestination = (typeof routingDestinations)[number];
export const RoutingDestination: z.ZodEnum<z.core.util.ToEnum<RoutingDestination>> = z
	.enum(routingDestinations)
	.meta({
		id: "draftyak.entities.RoutingDestination",
		description:
			"Where account data may go: local (loopback) by default; every other destination is " +
			"opted into per account. cloud-tool is for tool instances only.",
	});
