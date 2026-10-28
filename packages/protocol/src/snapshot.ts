import * as z from "zod";
import { CALENDAR_DATE_PATTERN } from "./date-pattern.ts";
import {
	ChatChannelType,
	EmailAddress,
	MediaType,
	ProviderId,
	wellFormedText,
} from "./entities/common.ts";
import { DraftAuthor } from "./entities/draft.ts";
import { jcsSha256 } from "./hash.ts";
import { Sha256Hex, Ulid, UtcMs } from "./scalars.ts";
import { SendMethod, SendUrl } from "./send-ticket.ts";
import { IanaZone } from "./tool-v1/kinds.ts";

export const SNAPSHOT_UNICODE_VERSION = "17.0";
export type SnapshotErrorCode =
	| "SNAPSHOT_INVALID"
	| "SNAPSHOT_UNICODE_VERSION"
	| "SNAPSHOT_WINDOW_OVERFLOW";
export class SnapshotError extends Error {
	readonly code: SnapshotErrorCode;
	constructor(code: SnapshotErrorCode) {
		super(code);
		this.code = code;
	}
}

// Normalization is verified, never silently applied after the owner has seen the bytes.
export function checkBodyText(text: string): boolean {
	if (process.versions.unicode !== SNAPSHOT_UNICODE_VERSION)
		throw new SnapshotError("SNAPSHOT_UNICODE_VERSION");
	return (
		typeof text === "string" &&
		text.isWellFormed() &&
		!text.includes("\r") &&
		text.normalize("NFC") === text
	);
}
const bodyText = (max: number): z.ZodString =>
	wellFormedText(max)
		.refine((text) => !text.isWellFormed() || checkBodyText(text), {
			message: "NFC and LF required",
		})
		.meta({ not: { pattern: "\\r" } });
const line = (max: number): z.ZodString =>
	wellFormedText(max)
		.refine((value) => !/[\r\n]/.test(value), { message: "header line break" })
		.meta({ not: { pattern: "[\\r\\n]" } });

export interface ScheduleNow {
	readonly kind: "now";
}
export interface ScheduleAt {
	readonly kind: "at";
	readonly notBefore: number;
	readonly zone: string;
	readonly localWallTime: string;
	readonly latenessSec: 900 | 3600 | 14400 | 86400;
	readonly holdIfNewInbound: boolean;
}
export type Schedule = ScheduleNow | ScheduleAt;

// Resolution, DST rejection and matching this display time to notBefore belong to M1.18.
const WALL = new RegExp(
	`^(?:${CALENDAR_DATE_PATTERN})T(?:[01][0-9]|2[0-3]):[0-5][0-9][+-](?:[01][0-9]|2[0-3]):[0-5][0-9]$`,
);
export const Schedule: z.ZodType<Schedule> = z
	.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("now") }),
		z.strictObject({
			kind: z.literal("at"),
			notBefore: UtcMs,
			zone: IanaZone,
			localWallTime: z
				.string()
				.length(22)
				.regex(WALL)
				.refine((value) => !value.endsWith("-00:00"))
				.meta({ not: { pattern: "-00:00$" } }),
			latenessSec: z.union([z.literal(900), z.literal(3600), z.literal(14400), z.literal(86400)]),
			holdIfNewInbound: z.boolean(),
		}),
	])
	.meta({
		title: "Schedule",
		description:
			"A frozen send time; zone resolution and DST/instant agreement are checked before approval.",
	});

export interface SnapshotAttachment {
	readonly filename: string;
	readonly contentType: string;
	readonly size: number;
	readonly sha256: string;
}
export interface SnapshotRender {
	readonly method: "POST" | "PUT" | "PATCH";
	readonly url: string;
	readonly headersSha256: string;
	readonly bodySha256: string;
}
export interface SnapshotBody {
	readonly text: string;
	readonly footer: string;
}
export interface SnapshotSource {
	readonly draft: string;
	readonly rev: number;
	readonly authors: readonly DraftAuthor[];
}
export interface SnapshotEmail {
	readonly from: string;
	readonly to: readonly string[];
	readonly cc: readonly string[];
	readonly bcc: readonly string[];
	readonly subject: string;
	readonly threadId?: string;
	readonly inReplyTo?: string;
	readonly references: readonly string[];
}
export interface SnapshotChat {
	readonly channelId: string;
	readonly channelName: string;
	readonly channelType: ChatChannelType;
	readonly external: boolean;
	/** Absent only on legacy snapshots; current send admission requires an explicit sharing fact. */
	readonly shared?: boolean;
	readonly memberCount: number;
	readonly threadTs?: string;
	readonly broadcast: boolean;
}
interface SnapshotBase {
	readonly v: 1;
	readonly hub: string;
	readonly epoch: number;
	readonly outbox: string;
	readonly account: string;
	readonly conversation: string | null;
	readonly render?: SnapshotRender;
	readonly body: SnapshotBody;
	readonly attachments: readonly SnapshotAttachment[];
	readonly schedule: Schedule;
	readonly source: SnapshotSource;
}
export type SendSnapshotV1 = SnapshotBase &
	(
		| { readonly kind: "email"; readonly email: SnapshotEmail }
		| { readonly kind: "chat"; readonly conversation: string; readonly chat: SnapshotChat }
	);
export type CurrentSendSnapshotV1 = SendSnapshotV1 &
	(
		| { readonly kind: "email" }
		| { readonly kind: "chat"; readonly chat: SnapshotChat & { readonly shared: boolean } }
	);
const fields = {
	v: z.literal(1),
	hub: Sha256Hex,
	epoch: z.int().min(0),
	outbox: Ulid,
	account: Ulid,
	conversation: Ulid.nullable(),
	render: z
		.strictObject({
			method: SendMethod,
			url: SendUrl.meta({
				allOf: [
					{ not: { pattern: "^https://[^/]+:443/" } },
					{
						not: {
							pattern:
								"^https://[^/]+:(?:6553[6-9]|655[4-9][0-9]|65[6-9][0-9]{2}|6[6-9][0-9]{3}|[7-9][0-9]{4})/",
						},
					},
					{ not: { pattern: "^https://[^/]+/(?:[^?]*/)?[.]{1,2}(/|[?]|$)" } },
				],
			}),
			headersSha256: Sha256Hex,
			bodySha256: Sha256Hex,
		})
		.optional(),
	body: z.strictObject({ text: bodyText(100_000), footer: bodyText(10_000) }),
	attachments: z
		.array(
			z.strictObject({
				filename: line(256).min(1),
				contentType: MediaType,
				size: z.int().min(0),
				sha256: Sha256Hex,
			}),
		)
		.max(100),
	schedule: Schedule,
	source: z.strictObject({
		draft: Ulid,
		rev: z.int().min(1),
		authors: z.array(DraftAuthor).min(1).max(100),
	}),
};
const email = z
	.strictObject({
		from: EmailAddress,
		to: z.array(EmailAddress).max(100),
		cc: z.array(EmailAddress).max(100),
		bcc: z.array(EmailAddress).max(100),
		subject: line(2000),
		threadId: ProviderId.optional(),
		inReplyTo: ProviderId.optional(),
		references: z.array(ProviderId).max(100),
	})
	.refine((value) => value.to.length + value.cc.length + value.bcc.length > 0, {
		message: "recipient required",
	})
	.meta({
		anyOf: ["to", "cc", "bcc"].map((name) => ({ properties: { [name]: { minItems: 1 } } })),
	});
const chatSchema = <Shared extends z.ZodType>(shared: Shared) =>
	z
		.strictObject({
			channelId: ProviderId,
			channelName: line(256),
			channelType: ChatChannelType,
			external: z.boolean(),
			shared,
			memberCount: z.int().min(0),
			threadTs: ProviderId.optional(),
			broadcast: z.boolean(),
		})
		.refine((value) => value.threadTs !== undefined || !value.broadcast, {
			message: "broadcast needs a thread",
		})
		.meta({
			anyOf: [{ properties: { broadcast: { const: false } } }, { required: ["threadTs"] }],
		});
const snapshotSchema = <Chat extends SnapshotChat>(chat: z.ZodType<Chat>) =>
	z
		.discriminatedUnion("kind", [
			z.strictObject({ ...fields, kind: z.literal("email"), email }),
			z.strictObject({ ...fields, kind: z.literal("chat"), conversation: Ulid, chat }),
		])
		.superRefine((snapshot, context) => {
			function inspect(value: unknown, path: (string | number)[]): void {
				if (value === undefined) {
					context.addIssue({ code: "custom", message: "undefined member", path });
				} else if (value !== null && typeof value === "object") {
					for (const [key, child] of Object.entries(value))
						inspect(child, [...path, Array.isArray(value) ? Number(key) : key]);
				}
			}
			inspect(snapshot, []);
		});
export const SendSnapshotV1: z.ZodType<SendSnapshotV1> = snapshotSchema(
	chatSchema(z.boolean().optional()),
).meta({
	title: "SendSnapshotV1",
	description:
		"The exact frozen send content. Body and footer are Unicode 17 NFC with LF line endings; claim-time MIME fields are absent. Legacy sharing-field absence is preserved without authorizing a current send.",
});

/** Structural current-send admission; it never inserts a sharing fact into legacy signed bytes. */
export const CurrentSendSnapshotV1: z.ZodType<CurrentSendSnapshotV1> = snapshotSchema(
	chatSchema(z.boolean()),
).meta({
	title: "CurrentSendSnapshotV1",
	description: "Current sends require the explicit frozen chat sharing fact; email is unchanged.",
});

export function checkCurrentSendSnapshot(snapshot: unknown): snapshot is CurrentSendSnapshotV1 {
	try {
		return CurrentSendSnapshotV1.safeParse(snapshot).success;
	} catch {
		return false;
	}
}

export function contentHash(snapshot: SendSnapshotV1): string {
	const result = SendSnapshotV1.safeParse(snapshot);
	if (!result.success) throw new SnapshotError("SNAPSHOT_INVALID");
	try {
		return jcsSha256(result.data);
	} catch {
		throw new SnapshotError("SNAPSHOT_INVALID");
	}
}
export const fingerprint = (snapshot: SendSnapshotV1): string =>
	contentHash(snapshot).slice(0, 8).toUpperCase();
export interface SendWindow {
	readonly notBefore?: number;
	readonly deliverBy: number;
}
export function sendWindow(snapshot: SendSnapshotV1, iat: number): SendWindow {
	const result = SendSnapshotV1.safeParse(snapshot);
	if (!result.success || !UtcMs.safeParse(iat).success) throw new SnapshotError("SNAPSHOT_INVALID");
	const schedule = result.data.schedule;
	const deliverBy =
		schedule.kind === "now" ? iat + 15 * 60_000 : schedule.notBefore + schedule.latenessSec * 1000;
	if (!Number.isSafeInteger(deliverBy)) throw new SnapshotError("SNAPSHOT_WINDOW_OVERFLOW");
	return schedule.kind === "now" ? { deliverBy } : { notBefore: schedule.notBefore, deliverBy };
}
