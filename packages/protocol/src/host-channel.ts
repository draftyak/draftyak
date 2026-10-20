import * as z from "zod";
import type { HeaderList } from "./hash.ts";
import { canonicalize, parseStrict } from "./jcs.ts";
import { type BlobRef, Bytes } from "./normalized-change.ts";
import { Base64Url } from "./scalars.ts";

export const HOST_FRAME_TAG = "\u001e";
export const HOST_MAX_FRAME_BYTES = 1_048_576;
export const HOST_MAX_HEADER_BYTES = 16_384;
export const HOST_MAX_ACTIVE_REQUESTS = 16;
export const HOST_REQUEST_TIMEOUT_MS = 30_000;
export const HOST_MAX_STREAM_BYTES = 33_554_432;
export const HOST_JSON_MEMBER_MAX_ENTITY_BYTES = 50_331_648;
export const HOST_JSON_MEMBER_MAX_DECODED_BYTES = 33_554_432;
export const HOST_JSON_MEMBER_MAX_DEPTH = 64;
export const HOST_JSON_MEMBER_MAX_NODES = 65_536;
export const HOST_JSON_MEMBER_MAX_ERROR_BYTES = 65_536;
export const LOOKUP_PERMIT_META_KEY = "io.github.draftyak/lookup-permit";

// Exactly 32 bytes, including the canonical zero unused bits of the last character.
export const LookupPermit: z.ZodString = Base64Url.length(43).meta({
	description: "A parent-issued lookup grant: 32 bytes as canonical unpadded base64url.",
});
export type LookupPermit = z.infer<typeof LookupPermit>;

const NO_LINE_BREAK = { not: { pattern: "[\\u000a\\u000d\\u2028\\u2029]" } };
function singleLine(schema: z.ZodString): z.ZodString {
	return schema.refine((text) => !/[\r\n\u2028\u2029]/.test(text)).meta(NO_LINE_BREAK);
}
const Text = singleLine(z.string().max(8192));
const Id = singleLine(
	z
		.string()
		.min(1)
		.max(128)
		.regex(/^[!-~]+$/),
);
const HeaderName = singleLine(
	z
		.string()
		.min(1)
		.max(128)
		.regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/),
);
const HeaderValue = singleLine(
	z
		.string()
		.max(8192)
		.regex(/^(?:[!-~](?:[\t -~]*[!-~])?)?$/),
);
export const HostHeaders: z.ZodType<HeaderList> = z
	.array(z.tuple([HeaderName, HeaderValue]))
	.max(64);
export const HOST_ERROR_CODES = [
	"DENIED",
	"TIMEOUT",
	"TOO_LARGE",
	"BAD_REQUEST",
	"UNSUPPORTED",
] as const;
export type HostErrorCode = (typeof HOST_ERROR_CODES)[number];
export const HostErrorCode: z.ZodType<HostErrorCode> = z.enum(HOST_ERROR_CODES);

export interface HostJsonMemberSaveAs {
	readonly kind: "base64url-json-member";
	readonly member: "raw" | "data";
}
export const HostJsonMemberSaveAs: z.ZodType<HostJsonMemberSaveAs> = z.strictObject({
	kind: z.literal("base64url-json-member"),
	member: z.enum(["raw", "data"]),
});
export type HostSaveAs = "blob" | HostJsonMemberSaveAs;

export interface HostFetchParams {
	readonly method: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
	readonly url: string;
	readonly headers: HeaderList;
	readonly body?: Bytes;
	readonly sendTicket?: unknown;
	readonly saveAs?: HostSaveAs;
	readonly stream?: boolean;
	readonly lookupPermit?: LookupPermit;
}
const fetchFields = {
	url: Text.min(1),
	headers: HostHeaders,
	body: Bytes.optional(),
	sendTicket: z.unknown().optional(),
	lookupPermit: LookupPermit.optional(),
};
export const HostFetchParams: z.ZodType<HostFetchParams> = z.union([
	z.strictObject({
		...fetchFields,
		method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
		saveAs: z.literal("blob").optional(),
		stream: z.boolean().optional(),
	}),
	z.strictObject({
		...fetchFields,
		method: z.literal("GET"),
		saveAs: HostJsonMemberSaveAs,
		stream: z.literal(false).optional(),
	}),
]);
export interface HostFetchResult {
	readonly status: number;
	readonly headers: HeaderList;
	readonly body?: Bytes;
	readonly streamId?: string;
}
export const HostFetchResult: z.ZodType<HostFetchResult> = z.union([
	z.strictObject({ status: z.int().min(200).max(599), headers: HostHeaders, body: Bytes }),
	z.strictObject({ status: z.int().min(200).max(599), headers: HostHeaders, streamId: Id }),
]);
export interface HostStreamChunk {
	readonly streamId: string;
	readonly sequence: number;
	readonly base64: string;
	readonly done: boolean;
	readonly error?: HostErrorCode;
}
export const HostStreamChunk: z.ZodType<HostStreamChunk> = z.strictObject({
	streamId: Id,
	sequence: z.int().min(0),
	base64: Base64Url.max(87_382),
	done: z.boolean(),
	error: HostErrorCode.optional(),
});

export interface HostMethods {
	"host/fetch": { params: HostFetchParams; result: HostFetchResult };
	"host/ws.open": { params: { url: string }; result: { socketId: string } };
	"host/ws.send": { params: { socketId: string; envelopeId: string }; result: null };
	"host/ws.close": { params: { socketId: string }; result: null };
	"host/kv.get": { params: { key: string }; result: { value: unknown } };
	"host/kv.set": { params: { key: string; value: unknown }; result: null };
	"host/kv.delete": { params: { key: string }; result: null };
	"host/changed": { params: { cursor?: string }; result: null };
	"host/log": {
		params: { level: "debug" | "info" | "warn" | "error"; message: string };
		result: null;
	};
	"host/progress": {
		params: { token: string | number; progress: number; total?: number };
		result: null;
	};
}
export type HostMethod = keyof HostMethods;
export const HOST_METHOD_SCHEMAS: Readonly<
	Record<HostMethod, { params: z.ZodType; result: z.ZodType }>
> = {
	"host/fetch": { params: HostFetchParams, result: HostFetchResult },
	"host/ws.open": {
		params: z.strictObject({ url: Text.min(1) }),
		result: z.strictObject({ socketId: Id }),
	},
	"host/ws.send": { params: z.strictObject({ socketId: Id, envelopeId: Id }), result: z.null() },
	"host/ws.close": { params: z.strictObject({ socketId: Id }), result: z.null() },
	"host/kv.get": {
		params: z.strictObject({ key: Id }),
		result: z.strictObject({ value: z.unknown() }),
	},
	"host/kv.set": { params: z.strictObject({ key: Id, value: z.unknown() }), result: z.null() },
	"host/kv.delete": { params: z.strictObject({ key: Id }), result: z.null() },
	"host/changed": { params: z.strictObject({ cursor: Text.optional() }), result: z.null() },
	"host/log": {
		params: z.strictObject({ level: z.enum(["debug", "info", "warn", "error"]), message: Text }),
		result: z.null(),
	},
	"host/progress": {
		params: z.strictObject({
			token: z.union([Id, z.int()]),
			progress: z.number().nonnegative(),
			total: z.number().nonnegative().optional(),
		}),
		result: z.null(),
	},
};
export interface HostRequest {
	readonly jsonrpc: "2.0";
	readonly id: string;
	readonly method: HostMethod;
	readonly params: unknown;
}
export interface HostReply {
	readonly jsonrpc: "2.0";
	readonly id: string;
	readonly result?: unknown;
	readonly error?: {
		readonly code: number;
		readonly message: string;
		readonly data: { readonly code: HostErrorCode };
	};
}
export type HostNotification =
	| {
			readonly jsonrpc: "2.0";
			readonly method: "host/stream.chunk";
			readonly params: HostStreamChunk;
	  }
	| {
			readonly jsonrpc: "2.0";
			readonly method: "host/ws.message";
			readonly params: { readonly socketId: string; readonly data: string };
	  };
const requestSchemas = (Object.keys(HOST_METHOD_SCHEMAS) as HostMethod[]).map((method) =>
	z.strictObject({
		jsonrpc: z.literal("2.0"),
		id: Id,
		method: z.literal(method),
		params: HOST_METHOD_SCHEMAS[method].params,
	}),
);
// The closed method table above is nonempty; each branch fixes its method and corresponding params.
const RequestSchema: z.ZodType<HostRequest> = z.union(
	requestSchemas as unknown as [z.ZodType<HostRequest>, ...z.ZodType<HostRequest>[]],
);
const ReplySchema = z.union([
	z.strictObject({ jsonrpc: z.literal("2.0"), id: Id, result: z.unknown() }),
	z.strictObject({
		jsonrpc: z.literal("2.0"),
		id: Id,
		error: z.strictObject({
			code: z.int(),
			message: Text,
			data: z.strictObject({ code: HostErrorCode }),
		}),
	}),
]);
export const HostNotification: z.ZodType<HostNotification> = z.union([
	z.strictObject({
		jsonrpc: z.literal("2.0"),
		method: z.literal("host/stream.chunk"),
		params: HostStreamChunk,
	}),
	z.strictObject({
		jsonrpc: z.literal("2.0"),
		method: z.literal("host/ws.message"),
		params: z.strictObject({ socketId: Id, data: Text }),
	}),
]);
export const HostMessage: z.ZodType<HostRequest | HostReply | HostNotification> = z.union([
	RequestSchema,
	ReplySchema,
	HostNotification,
]);

export function jsonCopy<T>(value: T): T {
	const text = canonicalize(value);
	if (Buffer.byteLength(text) > HOST_MAX_FRAME_BYTES) throw new Error("Host value too large");
	return parseStrict(text) as T;
}
export function checkHeaders(headers: HeaderList): void {
	if (
		headers.reduce((size, [name, value]) => size + name.length + value.length, 0) >
		HOST_MAX_HEADER_BYTES
	)
		throw new Error("Host headers too large");
}
export function parseHostParams<M extends HostMethod>(
	method: M,
	value: unknown,
): HostMethods[M]["params"] {
	const result = HOST_METHOD_SCHEMAS[method].params.parse(
		jsonCopy(value),
	) as HostMethods[M]["params"];
	if (method === "host/fetch") checkHeaders((result as HostFetchParams).headers);
	return result;
}
export function parseHostResult<M extends HostMethod>(
	method: M,
	value: unknown,
): HostMethods[M]["result"] {
	const result = HOST_METHOD_SCHEMAS[method].result.parse(
		jsonCopy(value),
	) as HostMethods[M]["result"];
	if (method === "host/fetch") checkHeaders((result as HostFetchResult).headers);
	return result;
}
export type { BlobRef, Bytes };
