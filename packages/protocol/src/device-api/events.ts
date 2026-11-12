import * as z from "zod";
import { wholeString } from "../entities/common.ts";
import { uniqueItems } from "../entities/fields.ts";
import { canonicalize } from "../jcs.ts";
import { Ulid } from "../scalars.ts";

const cursor = z
	.string()
	.max(512)
	.refine((text) => [...text].every((each) => (each.codePointAt(0) ?? 128) <= 127), {
		message: "ASCII cursor required",
	})
	.meta({ pattern: "^[\\u0000-\\u007f]*$" });
export interface EventsRequest {
	readonly after: string | null;
}
export const EventsRequest: z.ZodType<EventsRequest> = z
	.strictObject({ after: cursor.nullable() })
	.meta({ id: "draftyak.device-api.EventsRequest" });
export type EventFrame =
	| { readonly type: "ready"; readonly cursor: string }
	| {
			readonly type: "event";
			readonly cursor: string;
			readonly kind: string;
			readonly ids: readonly string[];
	  }
	| {
			readonly type: "reset";
			readonly reason: "cursor_expired" | "epoch_changed" | "resync_required";
	  };
export const EventFrame: z.ZodType<EventFrame> = z
	.discriminatedUnion("type", [
		z.strictObject({ type: z.literal("ready"), cursor }),
		z.strictObject({
			type: z.literal("event"),
			cursor,
			kind: wholeString(
				z
					.string()
					.min(1)
					.max(64)
					.regex(/^[a-z][a-z0-9.-]*$/),
			)
				.refine((text) => !/[\r\n\u2028\u2029]/.test(text), {
					message: "event kind must match completely",
				})
				.meta({ not: { pattern: "[\\r\\n\\u2028\\u2029]" } }),
			ids: uniqueItems(z.array(Ulid).max(100)),
		}),
		z.strictObject({
			type: z.literal("reset"),
			reason: z.enum(["cursor_expired", "epoch_changed", "resync_required"]),
		}),
	])
	.meta({ id: "draftyak.device-api.EventFrame" });
export function checkFrameLength(byteLength: number): boolean {
	return Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= 65_536;
}
export function checkEventStream(frames: readonly unknown[]): boolean {
	try {
		if (!Array.isArray(frames)) return false;
		const length = frames.length;
		if (!Number.isSafeInteger(length) || length <= 0) return false;
		for (let index = 0; index < length; index++) {
			const parsed = EventFrame.safeParse(frames[index]);
			if (!parsed.success) return false;
			const frame = parsed.data;
			if (
				!checkFrameLength(Buffer.byteLength(canonicalize(frame))) ||
				(index === 0 && frame.type === "event") ||
				(frame.type === "reset" && index !== length - 1)
			)
				return false;
		}
		return true;
	} catch {
		return false;
	}
}
