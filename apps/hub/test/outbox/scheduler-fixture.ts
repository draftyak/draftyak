import type { SchedulerGate } from "../../src/outbox/scheduler-ports.ts";
import {
	type BrokerDateSample,
	type HoldClock,
	observeBrokerDate,
} from "../../src/outbox/scheduler-rules.ts";

export { FakeClock, type FakeWait, settle } from "../kernel/fake-clock.ts";

export const ACCOUNT_A = "01JAZ3W3B6Q8M2V0G5T9K4X7RD";
export const ACCOUNT_B = "01JAZ3W3B6Q8M2V0G5T9K4X7RE";
export const OUTBOX_1 = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
export const READ_1 = "01JAZ3W3B6Q8M2V0G5T9K4X7RF";
export const READ_2 = "01JAZ3W3B6Q8M2V0G5T9K4X7RG";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A distinct well-formed ULID for each n below 32^6. */
export function ulidFor(n: number): string {
	let tail = "";
	for (let value = n, digit = 0; digit < 6; digit++, value = Math.floor(value / 32))
		tail = CROCKFORD.charAt(value % 32) + tail;
	return `01JAZ3W3B6Q8M2V0G5T9${tail}`;
}

export class FakeGate implements SchedulerGate {
	value: "running" | "paused" = "running";
	reads = 0;

	state(): "running" | "paused" {
		this.reads++;
		return this.value;
	}
}

export interface ReadTimes {
	readonly requestWall: number;
	readonly requestMono: number;
	readonly responseWall: number;
	readonly responseMono: number;
}

/** A broker-minted sample, as a fake reader would return it; a number header is an instant. */
export function observe(
	header: string | number,
	times: ReadTimes,
	readId: string = READ_1,
	accountId: string = ACCOUNT_A,
): BrokerDateSample {
	return observeBrokerDate({
		header: typeof header === "number" ? new Date(header).toUTCString() : header,
		readId,
		accountId,
		...times,
	});
}

export const noHolds: HoldClock = Object.freeze({
	itemRetryMono: () => undefined,
	accountRetryMono: () => undefined,
	pacingReleaseMono: () => undefined,
});
