import * as z from "zod";
import { wholeString } from "../entities/common.ts";
import { PublicDnsHost } from "../tool-v1/egress.ts";

export const DESTINATION_BINDINGS = [
	"chat.channelId",
	"chat.threadTs",
	"email.to",
	"email.cc",
	"email.bcc",
	"outbox.id",
] as const;
export type DestinationBinding = (typeof DESTINATION_BINDINGS)[number];
export const DestinationBinding: z.ZodEnum<z.core.util.ToEnum<DestinationBinding>> =
	z.enum(DESTINATION_BINDINGS);
export const FIELD_NAME: z.ZodString = z
	.string()
	.max(64)
	.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/)
	.refine((value) => !["constructor", "prototype"].includes(value))
	.meta({ not: { pattern: "\\n" }, allOf: [{ not: { enum: ["constructor", "prototype"] } }] });
export const HOST_PATTERN = "^[a-z0-9.-]+$";
export const ManifestHost: z.ZodString = wholeString(PublicDnsHost.regex(new RegExp(HOST_PATTERN)));

// SendUrl's canonical octets, excluding encoded path separators as well as raw ones.
const percentOctet = "%(?:[01][0-9A-F]|2[0-9A-C]|3[A-F]|40|5[BDE]|60|7[BCDF]|[89A-F][0-9A-F])";
const pathOctet = `(?:[A-Za-z0-9._~!$&'()*+,;=:@-]|${percentOctet})`;
export const PathSegment: z.ZodString = wholeString(
	z
		.string()
		.min(1)
		.max(8192)
		.regex(new RegExp(`^${pathOctet}+$`)),
)
	.refine((value) => value !== "." && value !== "..")
	.meta({
		not: { pattern: "\\n" },
		allOf: [{ not: { enum: [".", ".."] } }],
	});
const literalSegment = `${pathOctet}+`;
const segment = `(?:${literalSegment}|\\{(?:chat[.](?:channelId|threadTs)|email[.](?:to|cc|bcc)|outbox[.]id)\\})`;
const noDotSegment = (value: string): boolean =>
	value.split("/").every((part) => part !== "." && part !== "..");
const pathMetadata = {
	not: { pattern: "\\n" },
	allOf: [{ not: { pattern: "(?:^|/)[.]{1,2}(?:/|$)" } }],
};
export const PathTemplate: z.ZodString = wholeString(
	z
		.string()
		.max(2048)
		.regex(new RegExp(`^/(?:${segment}(?:/${segment})*)?$`)),
)
	.refine(noDotSegment)
	.meta(pathMetadata);
const wildcard = `(?:${literalSegment}|\\{[A-Za-z][A-Za-z0-9_]{0,31}\\})`;
export const RequestPathTemplate: z.ZodString = wholeString(
	z
		.string()
		.max(2048)
		.regex(new RegExp(`^/(?:${wildcard}(?:/${wildcard})*)?$`)),
)
	.refine(noDotSegment)
	.meta(pathMetadata);

interface RuleBase {
	readonly host: string;
	readonly pathTemplate: string;
	readonly maxBytes: number;
	readonly timeoutMs: number;
}
export type EgressRule = RuleBase &
	(
		| {
				readonly class: "read";
				readonly method: "GET" | "HEAD" | "POST";
				readonly query?: string[];
		  }
		| {
				readonly class: "organize";
				readonly method: "POST" | "PUT" | "PATCH" | "DELETE";
				readonly query?: string[];
		  }
		| {
				readonly class: "send";
				readonly method: "POST" | "PUT" | "PATCH";
				readonly query?: Record<string, DestinationBinding>;
		  }
	);
const fields = {
	host: ManifestHost,
	maxBytes: z
		.int()
		.min(1)
		.max(35 * 1024 * 1024),
	timeoutMs: z.int().min(1).max(30_000),
};
const request = {
	pathTemplate: RequestPathTemplate,
	query: z
		.array(FIELD_NAME)
		.max(32)
		.refine((value) => new Set(value).size === value.length)
		.meta({ uniqueItems: true })
		.optional(),
};
export const EgressRule: z.ZodType<EgressRule> = z
	.discriminatedUnion("class", [
		z.strictObject({
			...fields,
			...request,
			class: z.literal("read"),
			method: z.enum(["GET", "HEAD", "POST"]),
		}),
		z.strictObject({
			...fields,
			...request,
			class: z.literal("organize"),
			method: z.enum(["POST", "PUT", "PATCH", "DELETE"]),
		}),
		z.strictObject({
			...fields,
			pathTemplate: PathTemplate,
			query: z.record(FIELD_NAME, DestinationBinding).optional(),
			class: z.literal("send"),
			method: z.enum(["POST", "PUT", "PATCH"]),
		}),
	])
	.meta({ id: "draftyak.manifest.EgressRule" });

function overlapLiteral(value: string): string {
	return value
		.replace(/%([0-9A-F]{2})/g, (_match: string, hex: string) =>
			String.fromCharCode(Number.parseInt(hex, 16)),
		)
		.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** Conservative path overlap ignores query constraints; classification can never downgrade a send. */
export function crossClassOverlap(rules: readonly EgressRule[]): boolean {
	return rules.some((left, index) =>
		rules.slice(index + 1).some((right) => {
			if (left.class === right.class || left.method !== right.method || left.host !== right.host)
				return false;
			const a = left.pathTemplate === "/" ? [] : left.pathTemplate.slice(1).split("/");
			const b = right.pathTemplate === "/" ? [] : right.pathTemplate.slice(1).split("/");
			return (
				a.length === b.length &&
				a.every(
					(part, i) =>
						part.startsWith("{") ||
						b[i]?.startsWith("{") ||
						overlapLiteral(part) === overlapLiteral(b[i] ?? ""),
				)
			);
		}),
	);
}
