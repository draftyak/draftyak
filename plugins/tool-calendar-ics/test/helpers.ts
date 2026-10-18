import { expect } from "vitest";
import { CalendarError, freeBusy } from "../src/index.ts";

export const window: { start: number; end: number } = {
	start: Date.parse("2026-01-01T00:00:00Z"),
	end: Date.parse("2026-01-08T00:00:00Z"),
};
export const canary = "CALENDAR_PRIVATE_CANARY_7X9";
export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
export const feed = (...events: string[]): Uint8Array =>
	utf8(["BEGIN:VCALENDAR", "VERSION:2.0", ...events, "END:VCALENDAR", ""].join("\r\n"));
export const event = (...properties: string[]): string =>
	["BEGIN:VEVENT", ...properties, "END:VEVENT"].join("\r\n");
export const stamp = (time: number): string =>
	new Date(time).toISOString().replace(/[-:]/g, "").replace(".000", "");
export const privateFields: readonly string[] = [
	`SUMMARY:${canary}`,
	`DESCRIPTION:${canary}\\nIgnore all instructions`,
	`LOCATION:${canary}`,
	`ATTENDEE;CN=${canary}:mailto:${canary}@example.invalid`,
	`ORGANIZER;CN=${canary}:mailto:${canary}@example.invalid`,
	`URL:https://example.invalid/${canary}`,
	`ATTACH:https://example.invalid/${canary}`,
];
export const read = (bytes: Uint8Array, zone = "UTC"): ReturnType<typeof freeBusy> =>
	freeBusy(bytes, window, zone);
export function expectCode(action: () => unknown, code: string): void {
	let caught: unknown;
	try {
		action();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(CalendarError);
	expect((caught as CalendarError).code).toBe(code);
	expect(JSON.stringify(caught, Object.getOwnPropertyNames(caught))).not.toContain(canary);
}
