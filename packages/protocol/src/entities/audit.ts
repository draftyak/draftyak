import * as z from "zod";
import { Ulid, UtcMs } from "../scalars.ts";
import { patterned } from "./common.ts";

const actorKinds = ["device", "browser", "agent", "plugin"] as const;
const idlessKinds = ["cli", "hub"] as const;
export type AuditActorKind = (typeof actorKinds)[number] | (typeof idlessKinds)[number];

export const AuditActor: z.ZodDiscriminatedUnion<
	[
		z.ZodObject<
			{ kind: z.ZodEnum<z.core.util.ToEnum<(typeof actorKinds)[number]>>; id: typeof Ulid },
			z.core.$strict
		>,
		z.ZodObject<
			{ kind: z.ZodEnum<z.core.util.ToEnum<(typeof idlessKinds)[number]>>; id: z.ZodNull },
			z.core.$strict
		>,
	],
	"kind"
> = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.enum(actorKinds), id: Ulid }),
		z.strictObject({ kind: z.enum(idlessKinds), id: z.null() }),
	])
	.meta({
		id: "draftyak.entities.AuditActor",
		description:
			"Who acted: a device, a loopback browser session, an agent (a grant or token) or a " +
			"plugin instance, by id; the hub CLI (unsigned) and the hub itself have none.",
	});
export type AuditActor = z.infer<typeof AuditActor>;

const refs: z.ZodRecord<z.ZodString, typeof Ulid> = z.record(
	patterned(/^[a-z][A-Za-z0-9]*$/, 32),
	Ulid,
);

export const AuditEvent: z.ZodObject<
	{
		id: typeof Ulid;
		at: typeof UtcMs;
		action: z.ZodString;
		actor: typeof AuditActor;
		refs: z.ZodPreprocess<typeof refs>;
	},
	z.core.$strict
> = z
	.strictObject({
		id: Ulid,
		at: UtcMs,
		action: patterned(/^[a-z][a-z0-9_]*(?:[.][a-z][a-z0-9_]*)*$/, 64),
		actor: AuditActor,
		// zod's record skips a __proto__ member, which JSON Schema refuses, so refuse it first.
		refs: z.preprocess((value, context) => {
			if (value !== null && typeof value === "object" && Object.hasOwn(value, "__proto__")) {
				context.addIssue({ code: "custom", message: "a ref kind is __proto__" });
			}
			return value;
		}, refs),
	})
	.meta({
		id: "draftyak.entities.AuditEvent",
		description:
			"An entry in the audit chain: what happened (a dotted action name), who did it, and the " +
			"ids it concerns by kind, as outbox or device. Ids only, never content.",
	});
export type AuditEvent = z.infer<typeof AuditEvent>;
