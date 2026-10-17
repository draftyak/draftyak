import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { TokenRegistry } from "./fake-google-oauth.ts";
import {
	decodeHeader,
	getHeader,
	type ParsedPart,
	parseMessage,
	parseParams,
} from "./mime-parse.ts";
import { json, type Served, serve } from "./serve.ts";

// FakeGmail: every request is checked against the vendored discovery document (method, path,
// parameters, types, enums, request schema, media upload rules) before any behaviour runs, and
// every JSON answer it gives is checked against the method's response schema. Anything outside
// the document lands in `violations`, which each test expects to stay empty.

export interface Parameter {
	readonly type?: string;
	readonly location?: string;
	readonly required?: boolean;
	readonly repeated?: boolean;
	readonly enum?: readonly string[];
	readonly format?: string;
}

export interface Schema {
	readonly type?: string;
	readonly $ref?: string;
	readonly properties?: Readonly<Record<string, Schema>>;
	readonly items?: Schema;
	readonly additionalProperties?: Schema;
	readonly format?: string;
	readonly enum?: readonly string[];
	readonly annotations?: { readonly required?: readonly string[] };
}

export interface Protocol {
	readonly multipart: boolean;
	readonly path: string;
}

export interface Method {
	readonly id: string;
	readonly path: string;
	readonly httpMethod: string;
	readonly parameters?: Readonly<Record<string, Parameter>>;
	readonly request?: { readonly $ref: string };
	readonly response?: { readonly $ref: string };
	readonly scopes?: readonly string[];
	readonly mediaUpload?: {
		readonly accept: readonly string[];
		readonly maxSize: string;
		readonly protocols: Readonly<Record<string, Protocol>>;
	};
}

export interface Resource {
	readonly methods?: Readonly<Record<string, Method>>;
	readonly resources?: Readonly<Record<string, Resource>>;
}

export interface Discovery {
	readonly revision: string;
	readonly rootUrl: string;
	readonly servicePath: string;
	readonly parameters: Readonly<Record<string, Parameter>>;
	readonly schemas: Readonly<Record<string, Schema>>;
	readonly resources: Readonly<Record<string, Resource>>;
	readonly auth: { readonly oauth2: { readonly scopes: Readonly<Record<string, unknown>> } };
}

export const vendorDir: string = path.join(import.meta.dirname, "..", "vendor");
export const discoveryBytes: Buffer = readFileSync(path.join(vendorDir, "gmail-discovery.json"));
export const discovery: Discovery = JSON.parse(discoveryBytes.toString("utf8")) as Discovery;

export function allMethods(resources: Discovery["resources"] = discovery.resources): Method[] {
	return Object.values(resources).flatMap((resource) => [
		...Object.values(resource.methods ?? {}),
		...allMethods(resource.resources ?? {}),
	]);
}

export function methodById(id: string): Method {
	const method = allMethods().find((candidate) => candidate.id === id);
	if (method === undefined) throw new Error(`${id} is not in the discovery document`);
	return method;
}

interface Route {
	readonly method: Method;
	readonly pattern: RegExp;
	readonly names: readonly string[];
	readonly protocol: string | null;
}

function route(method: Method, template: string, protocol: string | null): Route {
	const names: string[] = [];
	const source = template
		.replace(/^\//, "")
		.split(/(\{\+?\w+\})/)
		.map((piece) => {
			const name = /^\{\+?(\w+)\}$/.exec(piece)?.[1];
			if (name === undefined) return piece.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			names.push(name);
			return piece.startsWith("{+") ? "(.+)" : "([^/]+)";
		})
		.join("");
	return { method, pattern: new RegExp(`^/${source}$`), names, protocol };
}

const routes: readonly Route[] = allMethods().flatMap((method) => [
	route(method, `${discovery.servicePath}${method.path}`, null),
	...Object.entries(method.mediaUpload?.protocols ?? {}).map(([name, protocol]) =>
		route(method, protocol.path, name),
	),
]);

const resolve = (schema: Schema): Schema =>
	schema.$ref === undefined ? schema : (discovery.schemas[schema.$ref] ?? { type: "missing" });

export function checkSchema(
	value: unknown,
	schema: Schema,
	at: string,
	methodId: string | undefined,
	problems: string[],
): void {
	const resolved = resolve(schema);
	const fail = (what: string): void => {
		problems.push(`${at}: ${what}`);
	};
	switch (resolved.type) {
		case "object": {
			if (value === null || typeof value !== "object" || Array.isArray(value)) {
				fail("expected an object");
				return;
			}
			for (const [key, item] of Object.entries(value)) {
				const property = resolved.properties?.[key] ?? resolved.additionalProperties;
				if (property === undefined) fail(`${key} is not in the discovery document`);
				else checkSchema(item, property, `${at}.${key}`, undefined, problems);
			}
			for (const [key, property] of Object.entries(resolved.properties ?? {})) {
				const required =
					methodId !== undefined && property.annotations?.required?.includes(methodId);
				if (required && !(key in value)) fail(`${key} is required for ${methodId}`);
			}
			return;
		}
		case "array":
			if (!Array.isArray(value)) fail("expected an array");
			else {
				value.forEach((item, index) => {
					checkSchema(item, resolved.items ?? {}, `${at}[${index}]`, undefined, problems);
				});
			}
			return;
		case "string":
			if (typeof value !== "string") {
				fail("expected a string");
				return;
			}
			if (resolved.enum !== undefined && !resolved.enum.includes(value)) fail("not in its enum");
			if (/^u?int64$/.test(resolved.format ?? "") && !/^-?\d+$/.test(value))
				fail(`not ${resolved.format}`);
			if (resolved.format === "byte" && !/^[\w+/-]*=*$/.test(value)) fail("not base64");
			return;
		case "integer":
			if (typeof value !== "number" || !Number.isInteger(value)) fail("expected an integer");
			return;
		case "number":
			if (typeof value !== "number") fail("expected a number");
			return;
		case "boolean":
			if (typeof value !== "boolean") fail("expected a boolean");
			return;
		case "any":
			return;
		default:
			fail(`schema type ${resolved.type}`);
	}
}

function checkParameter(
	name: string,
	values: readonly string[],
	parameter: Parameter | undefined,
): string[] {
	if (parameter === undefined || parameter.location !== "query") {
		return [`query ${name} is not in the discovery document`];
	}
	const problems =
		values.length > 1 && !parameter.repeated ? [`query ${name} is not repeated`] : [];
	for (const value of values) {
		if (parameter.enum !== undefined && !parameter.enum.includes(value)) {
			problems.push(`query ${name}=${value} is not in its enum`);
		}
		const integer = parameter.type === "integer" || /^u?int(32|64)$/.test(parameter.format ?? "");
		if (integer && !/^\d+$/.test(value)) problems.push(`query ${name} is not ${parameter.format}`);
		if (parameter.type === "boolean" && value !== "true" && value !== "false") {
			problems.push(`query ${name} is not a boolean`);
		}
	}
	return problems;
}

export interface Validated {
	readonly method: Method;
	readonly protocol: string | null;
	readonly path: Readonly<Record<string, string>>;
	readonly query: ReadonlyMap<string, readonly string[]>;
	readonly body: unknown;
	readonly media?: { readonly type: string; readonly bytes: Buffer };
}

function splitMultipart(body: Buffer, boundary: string): { type: string; bytes: Buffer }[] {
	const delimiter = Buffer.from(`--${boundary}`);
	const parts: { type: string; bytes: Buffer }[] = [];
	let at = body.indexOf(delimiter);
	while (at !== -1) {
		const start = at + delimiter.byteLength;
		if (body.subarray(start, start + 2).toString() === "--") break;
		const next = body.indexOf(Buffer.from(`\r\n--${boundary}`), start);
		if (next === -1) break;
		const piece = body.subarray(start + 2, next);
		const split = piece.indexOf("\r\n\r\n");
		const head = piece.subarray(0, split).toString("latin1");
		const type = /^content-type:\s*(.+)$/im.exec(head)?.[1]?.trim() ?? "";
		parts.push({ type, bytes: piece.subarray(split + 4) });
		at = next + 2;
	}
	return parts;
}

function mediaUpload(
	validated: Validated,
	request: Request,
	body: Buffer,
	problems: string[],
): Validated {
	const { method } = validated;
	const upload = method.mediaUpload;
	const uploadType = validated.query.get("uploadType")?.[0] ?? "";
	const protocol = upload?.protocols[validated.protocol ?? ""];
	const allowed =
		validated.protocol === "simple"
			? ["media", ...(protocol?.multipart ? ["multipart"] : [])]
			: ["resumable"];
	if (upload === undefined || !allowed.includes(uploadType)) {
		problems.push(`${method.id}: uploadType=${uploadType} on ${validated.protocol}`);
		return validated;
	}
	// In the document, but the fake serves only multipart uploads.
	if (uploadType !== "multipart") return validated;
	const contentType = parseParams(request.headers.get("content-type") ?? "");
	const boundary = contentType.params.boundary ?? "";
	const parts = contentType.type === "multipart/related" ? splitMultipart(body, boundary) : [];
	const [metadata, media] = parts;
	if (parts.length !== 2 || metadata === undefined || media === undefined) {
		problems.push(`${method.id}: a multipart upload has exactly a metadata and a media part`);
		return validated;
	}
	if (parseParams(metadata.type).type !== "application/json") problems.push("metadata is not JSON");
	let json: unknown;
	try {
		json = JSON.parse(metadata.bytes.toString("utf8"));
	} catch {
		problems.push("metadata is not valid JSON");
	}
	if (method.request !== undefined)
		checkSchema(json, method.request, "metadata", undefined, problems);
	if (json !== null && typeof json === "object" && "raw" in json) problems.push("raw beside media");
	const mediaType = parseParams(media.type).type;
	const accepted = upload.accept.some((pattern) =>
		new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace("*", "[^/]+")}$`).test(
			mediaType,
		),
	);
	if (!accepted) problems.push(`media type ${mediaType} not in ${upload.accept.join()}`);
	if (media.bytes.byteLength > Number(upload.maxSize)) problems.push("media over maxSize");
	return { ...validated, body: json, media: { type: mediaType, bytes: media.bytes } };
}

// What the plan's egress broker strips (§4 step 4), so the hub never sends it.
const METHOD_OVERRIDES = ["x-http-method-override", "x-http-method", "x-method-override"];

// The request as the discovery document describes it, or undefined with the reasons in `problems`.
export function validate(
	request: Request,
	body: Buffer,
	problems: string[],
): Validated | undefined {
	const url = new URL(request.url);
	for (const name of METHOD_OVERRIDES) {
		if (request.headers.has(name)) problems.push(`header ${name} overrides the method`);
	}
	for (const name of new Set(url.searchParams.keys())) {
		if (name.startsWith("$")) problems.push(`query ${name} is a Google system parameter`);
	}
	const found = routes
		.filter((candidate) => candidate.method.httpMethod === request.method)
		.map((candidate) => ({ candidate, match: candidate.pattern.exec(url.pathname) }))
		.find(({ match }) => match !== null);
	if (found === undefined || found.match === null) {
		problems.push(`${request.method} ${url.pathname} is not in the discovery document`);
		return undefined;
	}
	const { candidate, match } = found;
	const { method } = candidate;
	const pathParams = Object.fromEntries(
		candidate.names.map((name, index) => [name, decodeURIComponent(match[index + 1] ?? "")]),
	);
	const query = new Map<string, string[]>();
	for (const [name, value] of url.searchParams)
		query.set(name, [...(query.get(name) ?? []), value]);
	for (const [name, values] of query) {
		problems.push(
			...checkParameter(name, values, method.parameters?.[name] ?? discovery.parameters[name]),
		);
	}
	for (const [name, parameter] of Object.entries(method.parameters ?? {})) {
		if (parameter.required && parameter.location === "query" && !query.has(name)) {
			problems.push(`query ${name} is required`);
		}
	}
	const validated: Validated = {
		method,
		protocol: candidate.protocol,
		path: pathParams,
		query,
		body: undefined,
	};
	if (candidate.protocol !== null) return mediaUpload(validated, request, body, problems);
	if (query.has("uploadType")) problems.push(`uploadType on ${method.id}'s plain path`);
	if (method.request === undefined) {
		if (body.byteLength > 0) problems.push(`${method.id} takes no request body`);
		return validated;
	}
	if (parseParams(request.headers.get("content-type") ?? "").type !== "application/json") {
		problems.push(`${method.id} takes a JSON body`);
	}
	let json: unknown;
	try {
		json = JSON.parse(body.toString("utf8"));
	} catch {
		problems.push(`${method.id}: the body is not JSON`);
	}
	checkSchema(json, method.request, "request", method.id, problems);
	return { ...validated, body: json };
}

export function googleError(
	code: number,
	message: string,
	reason: string,
	status: string,
	headers: Record<string, string> = {},
): Response {
	const body = {
		error: { code, message, errors: [{ message, domain: "global", reason }], status },
	};
	return json(code, body, headers);
}

export interface StoredMessage {
	readonly id: string;
	threadId: string;
	labelIds: string[];
	readonly internalDate: number;
	historyId: number;
	readonly raw: Buffer;
	readonly parsed: ParsedPart;
}

type HistoryKind = "messageAdded" | "messageDeleted" | "labelAdded" | "labelRemoved";

interface HistoryEntry {
	readonly id: number;
	readonly kind: HistoryKind;
	readonly message: { readonly id: string; readonly threadId: string; readonly labelIds: string[] };
	readonly changed?: readonly string[];
}

export interface FakeGmailOptions {
	readonly tokens: TokenRegistry;
	readonly email?: string;
	readonly now?: () => number;
	// What S8 asks of the real API: does Gmail keep our Message-ID and Date?
	readonly messageIdPolicy?: "keep" | "replace";
	readonly datePolicy?: "keep" | "replace";
	readonly headerValues?: "decoded" | "raw";
	// "day" models a search that reads after: by calendar day (UTC here), coarser than the seconds asked.
	readonly searchAfter?: "seconds" | "day";
	// How long a new message takes to show in q= search results (Gmail's index can trail a send).
	readonly searchLagMs?: number;
}

export interface FakeGmail extends Served {
	readonly violations: string[];
	readonly unimplemented: string[];
	readonly calls: string[];
	readonly searches: string[];
	readonly messages: Map<string, StoredMessage>;
	historyId(): number;
	failNext(methodId: string, ...responses: Response[]): void;
	insert(
		raw: Buffer,
		labelIds: readonly string[],
		options?: { threadId?: string; internalDate?: number },
	): StoredMessage;
	relabel(id: string, add: readonly string[], remove: readonly string[]): void;
	expireHistory(): void;
}

const newId = (): string => randomBytes(8).toString("hex");
const subjectKey = (subject: string): string =>
	decodeHeader(subject)
		.replace(/^\s*((re|fwd?):\s*)+/i, "")
		.trim()
		.toLowerCase();

function replaceHeader(raw: Buffer, name: string, value: string): Buffer {
	const end = raw.indexOf("\r\n\r\n");
	const head = raw.subarray(0, end).toString("latin1");
	const line = new RegExp(`^${name}:.*(?:\\r\\n[ \\t].*)*$`, "im");
	const next = line.test(head)
		? head.replace(line, `${name}: ${value}`)
		: `${head}\r\n${name}: ${value}`;
	return Buffer.concat([Buffer.from(next, "latin1"), raw.subarray(end)]);
}

export async function startFakeGmail(options: FakeGmailOptions): Promise<FakeGmail> {
	const now = options.now ?? Date.now;
	const email = options.email ?? "owner@example.com";
	const violations: string[] = [];
	const unimplemented: string[] = [];
	const calls: string[] = [];
	const searches: string[] = [];
	const messages = new Map<string, StoredMessage>();
	const searchableAt = new Map<string, number>();
	const history: HistoryEntry[] = [];
	const failures = new Map<string, Response[]>();
	let current = 1000;
	let oldest = 1000;

	const record = (kind: HistoryKind, message: StoredMessage, changed?: readonly string[]): void => {
		current += 1 + Math.floor(Math.random() * 3);
		message.historyId = current;
		const snapshot = {
			id: message.id,
			threadId: message.threadId,
			labelIds: [...message.labelIds],
		};
		history.push({
			id: current,
			kind,
			message: snapshot,
			...(changed === undefined ? {} : { changed }),
		});
	};

	const insert = (
		raw: Buffer,
		labelIds: readonly string[],
		place: { threadId?: string; internalDate?: number } = {},
	): StoredMessage => {
		const message: StoredMessage = {
			id: newId(),
			threadId: place.threadId ?? newId(),
			labelIds: [...labelIds],
			internalDate: place.internalDate ?? now(),
			historyId: current,
			raw,
			parsed: parseMessage(raw),
		};
		messages.set(message.id, message);
		searchableAt.set(message.id, now() + (options.searchLagMs ?? 0));
		record("messageAdded", message);
		return message;
	};

	const headersOut = (part: ParsedPart, wanted?: readonly string[]) =>
		part.headers
			.filter(
				(header) =>
					wanted === undefined ||
					wanted.length === 0 ||
					wanted.some((name) => name.toLowerCase() === header.name.toLowerCase()),
			)
			.map((header) => ({
				name: header.name,
				value: options.headerValues === "raw" ? header.value : decodeHeader(header.value),
			}));

	const partJson = (part: ParsedPart, partId: string): Record<string, unknown> => {
		const leaf = part.parts.length === 0;
		const body = !leaf
			? { size: 0 }
			: part.filename !== ""
				? { size: part.body.byteLength, attachmentId: newId() }
				: { size: part.body.byteLength, data: part.body.toString("base64url") };
		return {
			partId,
			mimeType: part.mimeType,
			filename: part.filename,
			headers: headersOut(part),
			body,
			...(leaf
				? {}
				: {
						parts: part.parts.map((child, index) =>
							partJson(child, partId === "" ? `${index}` : `${partId}.${index}`),
						),
					}),
		};
	};

	const notFound = (): Response =>
		googleError(404, "Requested entity was not found.", "notFound", "NOT_FOUND");

	const messageJson = (
		message: StoredMessage,
		format: string,
		wanted: readonly string[],
	): Record<string, unknown> => {
		const base = {
			id: message.id,
			threadId: message.threadId,
			labelIds: message.labelIds,
			historyId: String(message.historyId),
			internalDate: String(message.internalDate),
			sizeEstimate: message.raw.byteLength,
		};
		if (format === "minimal") return base;
		if (format === "raw") return { ...base, raw: message.raw.toString("base64url") };
		if (format === "metadata") {
			const headers = headersOut(message.parsed, wanted);
			return { ...base, payload: { mimeType: message.parsed.mimeType, headers } };
		}
		return { ...base, payload: partJson(message.parsed, "") };
	};

	const page = <T>(items: readonly T[], query: ReadonlyMap<string, readonly string[]>) => {
		const max = Math.min(Number(query.get("maxResults")?.[0] ?? 100), 500);
		const offset = Number(
			Buffer.from(query.get("pageToken")?.[0] ?? "", "base64url").toString() || 0,
		);
		const slice = items.slice(offset, offset + max);
		const more = offset + max < items.length;
		return {
			slice,
			next: more ? Buffer.from(String(offset + max)).toString("base64url") : undefined,
		};
	};

	const matches = (message: StoredMessage, q: string): boolean | "unsupported" => {
		for (const token of q.split(/\s+/).filter((item) => item !== "")) {
			const [operator = "", value = ""] = token.split(/:(.*)/s);
			const labels: Record<string, string> = {
				sent: "SENT",
				inbox: "INBOX",
				scheduled: "SCHEDULED",
				drafts: "DRAFT",
			};
			if (operator === "in" && labels[value] !== undefined) {
				if (!message.labelIds.includes(labels[value] ?? "")) return false;
			} else if (operator === "rfc822msgid") {
				const id = (getHeader(message.parsed, "Message-ID") ?? "").replace(/^<|>$/g, "");
				if (id !== value.replace(/^<|>$/g, "")) return false;
			} else if ((operator === "after" || operator === "before") && /^\d+$/.test(value)) {
				const exact = Number(value) * 1000;
				const at = options.searchAfter === "day" ? exact - (exact % 86_400_000) : exact;
				if (operator === "after" ? message.internalDate < at : message.internalDate >= at)
					return false;
			} else {
				return "unsupported";
			}
		}
		return true;
	};

	const handlers: Record<string, (valid: Validated) => Response> = {
		"gmail.users.getProfile": () =>
			json(200, {
				emailAddress: email,
				messagesTotal: messages.size,
				threadsTotal: new Set([...messages.values()].map((message) => message.threadId)).size,
				historyId: String(current),
			}),
		"gmail.users.messages.send": (valid) => {
			let raw = valid.media?.bytes ?? Buffer.alloc(0);
			if (options.messageIdPolicy === "replace") {
				raw = replaceHeader(raw, "Message-ID", `<fake.${newId()}@mail.gmail.com>`);
			}
			if (options.datePolicy === "replace") {
				raw = replaceHeader(raw, "Date", new Date(now()).toUTCString().replace("GMT", "+0000"));
			}
			const parsed = parseMessage(raw);
			const wanted = (valid.body as { threadId?: string } | undefined)?.threadId;
			let threadId: string | undefined;
			if (wanted !== undefined) {
				const thread = [...messages.values()].filter((message) => message.threadId === wanted);
				const [first] = thread;
				if (first === undefined) return notFound();
				// Gmail's threading rule (Message.threadId in the discovery document).
				const linked = getHeader(parsed, "In-Reply-To") ?? getHeader(parsed, "References");
				const sameSubject =
					subjectKey(getHeader(parsed, "Subject") ?? "") ===
					subjectKey(getHeader(first.parsed, "Subject") ?? "");
				if (linked !== undefined && sameSubject) threadId = wanted;
			}
			const stored = insert(raw, ["SENT"], threadId === undefined ? {} : { threadId });
			return json(200, { id: stored.id, threadId: stored.threadId, labelIds: stored.labelIds });
		},
		"gmail.users.messages.get": (valid) => {
			const message = messages.get(valid.path.id ?? "");
			if (message === undefined) return notFound();
			const format = valid.query.get("format")?.[0] ?? "full";
			return json(200, messageJson(message, format, valid.query.get("metadataHeaders") ?? []));
		},
		"gmail.users.threads.get": (valid) => {
			const thread = [...messages.values()]
				.filter((message) => message.threadId === valid.path.id)
				.sort((a, b) => a.internalDate - b.internalDate);
			if (thread.length === 0) return notFound();
			const format = valid.query.get("format")?.[0] ?? "full";
			const wanted = valid.query.get("metadataHeaders") ?? [];
			return json(200, {
				id: valid.path.id,
				historyId: String(Math.max(...thread.map((message) => message.historyId))),
				messages: thread.map((message) => messageJson(message, format, wanted)),
			});
		},
		"gmail.users.messages.list": (valid) => {
			const q = valid.query.get("q")?.[0] ?? "";
			searches.push(q);
			const labelIds = valid.query.get("labelIds") ?? [];
			const spamTrash = valid.query.get("includeSpamTrash")?.[0] === "true";
			const found: StoredMessage[] = [];
			for (const message of messages.values()) {
				if (q !== "" && (searchableAt.get(message.id) ?? 0) > now()) continue;
				const hit = matches(message, q);
				if (hit === "unsupported") {
					unimplemented.push(`messages.list q=${q}`);
					return googleError(
						501,
						"query not supported by the fake",
						"notImplemented",
						"UNIMPLEMENTED",
					);
				}
				const hidden =
					!spamTrash && message.labelIds.some((label) => label === "SPAM" || label === "TRASH");
				if (hit && !hidden && labelIds.every((label) => message.labelIds.includes(label)))
					found.push(message);
			}
			found.sort((a, b) => b.internalDate - a.internalDate);
			const { slice, next } = page(found, valid.query);
			return json(200, {
				...(slice.length > 0
					? { messages: slice.map(({ id, threadId }) => ({ id, threadId })) }
					: {}),
				...(next === undefined ? {} : { nextPageToken: next }),
				resultSizeEstimate: found.length,
			});
		},
		"gmail.users.history.list": (valid) => {
			const start = valid.query.get("startHistoryId")?.[0];
			if (start === undefined) {
				return googleError(
					400,
					"startHistoryId is required",
					"invalidArgument",
					"INVALID_ARGUMENT",
				);
			}
			if (Number(start) < oldest) return notFound();
			const types = valid.query.get("historyTypes") ?? [];
			const labelId = valid.query.get("labelId")?.[0];
			const entries = history.filter(
				(entry) =>
					entry.id > Number(start) &&
					(types.length === 0 || types.includes(entry.kind)) &&
					(labelId === undefined || entry.message.labelIds.includes(labelId)),
			);
			const { slice, next } = page(entries, valid.query);
			const field: Record<HistoryKind, string> = {
				messageAdded: "messagesAdded",
				messageDeleted: "messagesDeleted",
				labelAdded: "labelsAdded",
				labelRemoved: "labelsRemoved",
			};
			const records = slice.map((entry) => ({
				id: String(entry.id),
				messages: [{ id: entry.message.id, threadId: entry.message.threadId }],
				[field[entry.kind]]: [
					{
						message: entry.message,
						...(entry.changed === undefined ? {} : { labelIds: entry.changed }),
					},
				],
			}));
			return json(200, {
				...(records.length > 0 ? { history: records } : {}),
				...(next === undefined ? {} : { nextPageToken: next }),
				historyId: String(current),
			});
		},
	};

	async function handle(request: Request): Promise<Response> {
		const body = Buffer.from(await request.arrayBuffer());
		const problems: string[] = [];
		const valid = validate(request, body, problems);
		if (valid === undefined || problems.length > 0) {
			violations.push(...problems);
			return googleError(400, "Invalid request.", "badRequest", "INVALID_ARGUMENT");
		}
		calls.push(valid.method.id);
		const token = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "";
		const grant = options.tokens.lookup(token, "access");
		if (grant === undefined) {
			return googleError(
				401,
				"Request had invalid authentication credentials.",
				"authError",
				"UNAUTHENTICATED",
			);
		}
		if (!(valid.method.scopes ?? []).some((scope) => grant.scopes.includes(scope))) {
			return googleError(
				403,
				"Request had insufficient authentication scopes.",
				"insufficientPermissions",
				"PERMISSION_DENIED",
			);
		}
		if (valid.path.userId !== "me" && valid.path.userId !== email) {
			return googleError(403, "Delegation denied.", "forbidden", "PERMISSION_DENIED");
		}
		const queued = failures.get(valid.method.id)?.shift();
		if (queued !== undefined) return queued;
		const handler = handlers[valid.method.id];
		if (handler === undefined || (valid.protocol !== null && valid.media === undefined)) {
			unimplemented.push(`${valid.method.id} ${valid.protocol ?? ""}`.trim());
			return googleError(501, "Not implemented by the fake.", "notImplemented", "UNIMPLEMENTED");
		}
		const response = handler(valid);
		if (response.ok && valid.method.response !== undefined) {
			const own: string[] = [];
			checkSchema(await response.clone().json(), valid.method.response, "response", undefined, own);
			violations.push(...own.map((problem) => `fake ${valid.method.id} ${problem}`));
		}
		return response;
	}

	const server = await serve(handle, now);
	return {
		...server,
		violations,
		unimplemented,
		calls,
		searches,
		messages,
		historyId: () => current,
		failNext: (methodId, ...responses) => {
			methodById(methodId);
			failures.set(methodId, [...(failures.get(methodId) ?? []), ...responses]);
		},
		insert,
		relabel: (id, add, remove) => {
			const message = messages.get(id);
			if (message === undefined) throw new Error(`no message ${id}`);
			message.labelIds = message.labelIds.filter((label) => !remove.includes(label));
			if (remove.length > 0) record("labelRemoved", message, remove);
			message.labelIds.push(...add.filter((label) => !message.labelIds.includes(label)));
			if (add.length > 0) record("labelAdded", message, add);
		},
		expireHistory: () => {
			oldest = current + 1;
		},
	};
}
