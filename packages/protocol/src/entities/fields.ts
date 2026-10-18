import * as z from "zod";
import { Alias, Ulid, UtcMs } from "../scalars.ts";
import { AccountMode, AccountStatus, MessageDirection, Provenance, wholeString } from "./common.ts";

// What every channel's variant of an entity shares. A variant file spreads these after its
// channel literal and adds its own fields; the entity's union takes every variant that its
// channels.ts lists, so a channel joins with a variant file and one line there.

export const accountFields: {
	id: typeof Ulid;
	userId: typeof Ulid;
	alias: typeof Alias;
	mode: typeof AccountMode;
	status: typeof AccountStatus;
	deletionDeadline: z.ZodNullable<typeof UtcMs>;
	historyLimitDays: z.ZodInt;
	disclosureVersion: z.ZodInt;
	createdAt: typeof UtcMs;
} = {
	id: Ulid,
	userId: Ulid,
	alias: wholeString(Alias),
	mode: AccountMode,
	status: AccountStatus,
	deletionDeadline: UtcMs.nullable().meta({
		description: "When a credential_lost account is purged unless reconnected; otherwise null.",
	}),
	historyLimitDays: z
		.int()
		.min(1)
		.max(365)
		.meta({ description: "How many days back the first sync reaches." }),
	disclosureVersion: z
		.int()
		.min(1)
		.meta({ description: "The version of the disclosure the owner agreed to for it." }),
	createdAt: UtcMs,
};

// Every account variant applies this: a deletion deadline runs exactly while the account is
// credential_lost, in zod and in JSON Schema.
export function withDeadline<T extends z.ZodObject>(variant: T): T {
	const lost = { const: "credential_lost" };
	return variant
		.refine(
			(account) => {
				const { status, deletionDeadline } = account as {
					status: string;
					deletionDeadline: unknown;
				};
				return (status === lost.const) === (deletionDeadline !== null);
			},
			{ message: "deletionDeadline is set exactly while the account is credential_lost" },
		)
		.meta({
			anyOf: [
				{ properties: { status: lost, deletionDeadline: { type: "integer" } } },
				{ properties: { status: { not: lost }, deletionDeadline: { type: "null" } } },
			],
		});
}

export const conversationFields: {
	id: typeof Ulid;
	accountId: typeof Ulid;
	workspaceId: z.ZodNullable<typeof Ulid>;
	assigneeUserId: z.ZodNullable<typeof Ulid>;
	archived: z.ZodBoolean;
	read: z.ZodBoolean;
	lastMessageAt: z.ZodNullable<typeof UtcMs>;
} = {
	id: Ulid,
	accountId: Ulid,
	workspaceId: Ulid.nullable(),
	assigneeUserId: Ulid.nullable(),
	archived: z.boolean(),
	read: z.boolean(),
	lastMessageAt: UtcMs.nullable(),
};

export const messageFields: {
	id: typeof Ulid;
	accountId: typeof Ulid;
	conversationId: typeof Ulid;
	direction: typeof MessageDirection;
	sentAt: typeof UtcMs;
	provenance: typeof Provenance;
} = {
	id: Ulid,
	accountId: Ulid,
	conversationId: Ulid,
	direction: MessageDirection,
	sentAt: UtcMs,
	provenance: Provenance,
};

// A record's values in the order of their names: test runners and bundlers don't all list a
// module namespace's exports sorted, as ES modules do.
export const valuesByName = <V>(record: Readonly<Record<string, V>>): V[] =>
	Object.keys(record)
		.toSorted()
		.map((name) => record[name] as V);

export function channelUnion<V extends z.core.$ZodTypeDiscriminable>(
	channels: Readonly<Record<string, V>>,
): z.ZodDiscriminatedUnion<V[], "channel"> {
	return z.discriminatedUnion("channel", valuesByName(channels) as [V, ...V[]]);
}

// JSON Schema's uniqueItems for an array of strings, which zod has no check for.
export function uniqueItems<T extends z.ZodArray<z.ZodType<string>>>(array: T): T {
	return array
		.refine((items) => new Set(items).size === items.length, { message: "an item repeats" })
		.meta({ uniqueItems: true });
}
