import * as z from "zod";
import { IanaZone } from "../tool-v1/kinds.ts";
import { uniqueItems } from "./fields.ts";

// tool-v1's definition, re-exported as the same object.
export { IanaZone };

const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof weekdays)[number];
export const Weekday: z.ZodEnum<z.core.util.ToEnum<Weekday>> = z
	.enum(weekdays)
	.meta({ id: "draftyak.entities.Weekday" });

const HOUR_MINUTE = "(?:[01][0-9]|2[0-3]):[0-5][0-9]";

export const WorkingHours: z.ZodObject<
	{ days: z.ZodArray<typeof Weekday>; start: z.ZodString; end: z.ZodString },
	z.core.$strict
> = z
	.strictObject({
		days: uniqueItems(z.array(Weekday).min(1)),
		start: z
			.string()
			.length(5)
			.regex(new RegExp(`^${HOUR_MINUTE}$`)),
		end: z
			.string()
			.length(5)
			.regex(new RegExp(`^(?:${HOUR_MINUTE}|24:00)$`)),
	})
	.refine(({ start, end }) => start < end, { message: "start is before end" })
	.meta({
		id: "draftyak.entities.WorkingHours",
		description:
			"The owner's working days and hours, HH:mm in their zone, start before end; the default " +
			"is mon to fri, 09:00 to 17:00.",
	});
export type WorkingHours = z.infer<typeof WorkingHours>;

export const OwnerSettings: z.ZodObject<
	{ zone: typeof IanaZone; workingHours: typeof WorkingHours },
	z.core.$strict
> = z.strictObject({ zone: IanaZone, workingHours: WorkingHours }).meta({
	id: "draftyak.entities.OwnerSettings",
	description: "The owner's time zone, which schedules and lookups use, and working hours.",
});
export type OwnerSettings = z.infer<typeof OwnerSettings>;
