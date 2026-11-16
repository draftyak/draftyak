import * as z from "zod";

export type HubMode = "sidecar" | "service";
export type SchedulerState = "running" | "unavailable";
export interface SchedulingStatus {
	readonly mode: HubMode;
	readonly scheduler: SchedulerState;
	readonly syncPaused: boolean;
}
// A leaf module, so the summary can embed the status while the route checks parse the summary.
export const SchedulingStatus: z.ZodType<SchedulingStatus> = z
	.strictObject({
		mode: z.enum(["sidecar", "service"]),
		scheduler: z.enum(["running", "unavailable"]),
		syncPaused: z.boolean(),
	})
	.meta({
		id: "draftyak.hub-runtime.SchedulingStatus",
		description:
			"The hub's mode, its scheduler state and its own Pause sync state, which the hub keeps across restarts.",
	});
