import { renderLocalWallTime, resolveLocalTime, ScheduleError } from "@draftyak/protocol/schedule";
import { Schedule, type ScheduleAt } from "@draftyak/protocol/snapshot";
import { SchedulerError } from "./scheduler-ports.ts";
import { snapshot } from "./scheduler-rules.ts";

export interface WallScheduleInput {
	readonly wall: string;
	readonly zone: string;
	readonly latenessSec: 900 | 3600 | 14400 | 86400;
	readonly holdIfNewInbound: boolean;
}

// Every ScheduleError code is also a SchedulerErrorCode, so the compiler keeps this map one to one.
function refusal(error: unknown): SchedulerError {
	return new SchedulerError(error instanceof ScheduleError ? error.code : "INVALID_INPUT");
}

/**
 * Wall time + IANA zone → the frozen protocol ScheduleAt. DST gaps and overlaps refuse as
 * M1.18 classifies them; the schedule bounds and hold offering stay with the proposer.
 * SCHEDULING_UNAVAILABLE whenever schedulingAvailable() is false.
 */
export function scheduleAt(input: WallScheduleInput): ScheduleAt {
	if (!schedulingAvailable()) throw new SchedulerError("SCHEDULING_UNAVAILABLE");
	const { wall, zone, latenessSec, holdIfNewInbound } = snapshot(input, [
		"wall",
		"zone",
		"latenessSec",
		"holdIfNewInbound",
	]);
	let notBefore: number;
	let localWallTime: string;
	try {
		notBefore = resolveLocalTime(wall as string, zone as string);
		localWallTime = renderLocalWallTime(notBefore, zone as string);
	} catch (error) {
		throw refusal(error);
	}
	const parsed = Schedule.safeParse({
		kind: "at",
		notBefore,
		zone,
		localWallTime,
		latenessSec,
		holdIfNewInbound,
	});
	if (!parsed.success || parsed.data.kind !== "at") throw new SchedulerError("INVALID_INPUT");
	return Object.freeze(parsed.data);
}

/** False when the schedule helpers cannot render; existing UTC claims never need them. */
export function schedulingAvailable(): boolean {
	try {
		renderLocalWallTime(0, "UTC");
		return true;
	} catch {
		return false;
	}
}
