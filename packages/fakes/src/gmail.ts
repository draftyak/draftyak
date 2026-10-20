import { createHash } from "node:crypto";
import { Hono } from "hono";
import { type Clock, createFaults, systemClock } from "./faults.ts";
import {
	type GmailBudget,
	type GmailMessage,
	type GmailMessageSeed,
	GmailState,
	matches,
	messageView,
	validateSearch,
} from "./gmail/state.ts";
import {
	body,
	check,
	decimal,
	failure,
	GmailInputError,
	headers,
	id,
	json,
	labels,
	MAX_GMAIL_SEND_STEPS,
	MAX_GMAIL_WIRE_BYTES,
	project,
	query,
	record,
	rewrite,
	target,
	upload,
} from "./gmail/wire.ts";
import type { Recorder } from "./recorder.ts";
import { createFake, type Fake } from "./server.ts";

export type { GmailBudget, GmailMessage, GmailMessageSeed } from "./gmail/state.ts";
export {
	MAX_GMAIL_BODY_CHUNKS,
	MAX_GMAIL_CURSORS,
	MAX_GMAIL_HISTORY,
	MAX_GMAIL_MESSAGES,
	MAX_GMAIL_RAW_BYTES,
	MAX_GMAIL_SEND_STEPS,
	MAX_GMAIL_STATE_BYTES,
	MAX_GMAIL_WIRE_BYTES,
} from "./gmail/wire.ts";
export const GMAIL_HOST = "gmail.googleapis.com";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const METADATA = "https://www.googleapis.com/auth/gmail.metadata";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const ALL = "https://mail.google.com/";
const BASE = "/gmail/v1/users/me";
export interface GmailAccessGrant {
	readonly scopes: readonly string[];
	readonly expiresAt: number;
}
export type GmailSendStep =
	| { readonly kind: "accept"; readonly date?: string; readonly messageId?: string }
	| {
			readonly kind: "mail-rate-limit" | "concurrent-rate-limit";
			readonly retryAfterSeconds: number;
	  };
export interface GmailOptions {
	readonly accessGrant: (token: string) => GmailAccessGrant | undefined;
	readonly clock?: Clock;
	readonly recorder?: Recorder;
	readonly messages?: readonly GmailMessageSeed[];
	readonly readBudget?: GmailBudget;
	readonly sendBudget?: GmailBudget;
}
export interface GmailFake extends Fake {
	readonly clock: Clock;
	readonly historyId: string;
	addMessage(message: GmailMessageSeed): void;
	deleteMessage(id: string): void;
	setLabels(id: string, labelIds: readonly string[]): void;
	expireHistory(before: string): void;
	message(id: string): GmailMessage;
	queueSend(...steps: readonly GmailSendStep[]): void;
}
function budget(value?: GmailBudget): GmailBudget | undefined {
	if (!value) return;
	check(
		Number.isSafeInteger(value.units) &&
			value.units > 0 &&
			Number.isSafeInteger(value.windowMs) &&
			value.windowMs > 0 &&
			value.windowMs <= 86_400_000,
	);
	return { units: value.units, windowMs: value.windowMs };
}
function sendStep(step: GmailSendStep): GmailSendStep {
	check(step && ["accept", "mail-rate-limit", "concurrent-rate-limit"].includes(step.kind));
	if (step.kind !== "accept") {
		check(
			Number.isSafeInteger(step.retryAfterSeconds) &&
				step.retryAfterSeconds >= 0 &&
				step.retryAfterSeconds <= 604_800,
		);
		return { kind: step.kind, retryAfterSeconds: step.retryAfterSeconds };
	}
	if (step.date !== undefined)
		check(
			typeof step.date === "string" &&
				step.date.length <= 128 &&
				/^[\x20-\x7e]+$/.test(step.date) &&
				Number.isFinite(Date.parse(step.date)),
		);
	if (step.messageId !== undefined)
		check(
			typeof step.messageId === "string" &&
				/^<[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.example>$/.test(step.messageId) &&
				step.messageId.length <= 256,
		);
	return {
		kind: "accept",
		...(step.date === undefined ? {} : { date: step.date }),
		...(step.messageId === undefined ? {} : { messageId: step.messageId }),
	};
}

/** Synthetic HTTP fixture only. Grant callbacks are test data, never native account authority. */
export function createGmailFake(options: GmailOptions): GmailFake {
	check(options && typeof options.accessGrant === "function");
	const clock = options.clock ?? systemClock,
		state = new GmailState(clock);
	const reads = budget(options.readBudget),
		sends = budget(options.sendBudget);
	const script: GmailSendStep[] = [];
	check(!options.messages || (Array.isArray(options.messages) && options.messages.length <= 1024));
	for (const message of options.messages ?? []) state.add(message);
	let generated = 0,
		active = 0;
	const app = new Hono();
	app.onError((error) => {
		throw error;
	});
	app.all("*", async (context) => {
		const request = context.req.raw;
		if (active >= 64)
			return failure(429, "rateLimitExceeded", "Too many concurrent requests", {
				"retry-after": "1",
			});
		active++;
		try {
			check(
				!["x-http-method", "x-http-method-override", "x-method-override"].some((name) =>
					request.headers.has(name),
				),
			);
			const { path, query: params } = target(request);
			const uploadPath = path === "/upload/gmail/v1/users/me/messages/send";
			const relative = uploadPath
				? "/messages/send"
				: path.startsWith(`${BASE}/`)
					? path.slice(BASE.length)
					: "";
			const get = request.method === "GET",
				post = request.method === "POST";
			const isSend = post && relative === "/messages/send";
			const match = /^\/(messages|threads)\/([A-Za-z0-9_-]{1,128})(\/modify)?$/.exec(relative);
			const list = get && ["/messages", "/threads"].includes(relative);
			const history = get && relative === "/history",
				profile = get && relative === "/profile";
			const getOne = get && match && !match[3],
				modify = post && match?.[1] === "messages" && match[3] === "/modify";
			const batch = post && relative === "/messages/batchModify";
			if (!isSend && !list && !history && !profile && !getOne && !modify && !batch)
				return failure(404, "notFound", "Unsupported Gmail fixture method or path");
			check(!uploadPath || isSend);
			query(
				params,
				isSend
					? uploadPath
						? ["uploadType"]
						: []
					: list
						? ["maxResults", "pageToken", "q", "labelIds", "includeSpamTrash"]
						: history
							? ["startHistoryId", "maxResults", "pageToken", "labelId", "historyTypes"]
							: getOne
								? ["format", "metadataHeaders"]
								: [],
			);
			project({}, params.get("fields"));
			if (uploadPath) check(params.get("uploadType") === "multipart");
			const format = params.get("format") ?? "full";
			if (getOne)
				check(
					(match?.[1] === "threads"
						? ["minimal", "metadata", "full"]
						: ["minimal", "metadata", "full", "raw"]
					).includes(format),
				);
			if (list) {
				validateSearch(params);
				for (const value of params.getAll("labelIds")) id(value);
			}
			if (history) check(params.has("startHistoryId"));
			const bearer = /^Bearer ([\x21-\x7e]{1,1024})$/.exec(
				request.headers.get("authorization") ?? "",
			);
			const grant = bearer ? options.accessGrant(bearer[1] as string) : undefined;
			if (
				!grant ||
				!Array.isArray(grant.scopes) ||
				!Number.isFinite(grant.expiresAt) ||
				grant.expiresAt <= state.now()
			)
				return failure(401, "authError", "Invalid synthetic grant");
			const allowed = isSend
				? [ALL, GMAIL_MODIFY_SCOPE, COMPOSE, SEND]
				: modify || batch
					? [ALL, GMAIL_MODIFY_SCOPE]
					: profile
						? [ALL, GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, METADATA, COMPOSE]
						: [ALL, GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, METADATA];
			if (!grant.scopes.some((scope) => allowed.includes(scope)))
				return failure(403, "insufficientPermissions", "Insufficient synthetic scope");
			const metadataOnly =
				grant.scopes.includes(METADATA) &&
				!grant.scopes.some((scope) =>
					[ALL, GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE].includes(scope),
				);
			if (metadataOnly && (params.has("q") || (getOne && ["full", "raw"].includes(format))))
				return failure(
					403,
					"insufficientPermissions",
					"Metadata scope cannot retrieve bodies or search",
				);
			if (get && request.body) return failure(400, "invalidArgument", "Read request body refused");
			if (!state.charge(isSend ? "send" : "read", 1, isSend ? sends : reads))
				return failure(
					429,
					"userRateLimitExceeded",
					isSend ? "Mail sending quota exceeded" : "Read quota exceeded",
					{ "retry-after": "60" },
				);
			const answer = (value: unknown) => json(project(value, params.get("fields")));
			if (profile)
				return answer({
					emailAddress: "owner@draftyak.example",
					messagesTotal: state.messages.size,
					threadsTotal: new Set([...state.messages.values()].map((m) => m.threadId)).size,
					historyId: String(state.sequence),
				});
			if (list || history) {
				let rows: readonly unknown[];
				if (history) {
					const start = decimal(params.get("startHistoryId") as string);
					if (start < state.floor || start > state.sequence)
						return failure(404, "notFound", "History checkpoint expired or invalid");
					const types: Record<string, string> = {
						messageAdded: "messagesAdded",
						messageDeleted: "messagesDeleted",
						labelAdded: "labelsAdded",
						labelRemoved: "labelsRemoved",
					};
					rows = state.history
						.filter((h) => BigInt(h.id) > start)
						.filter(
							(h) =>
								!params.has("historyTypes") ||
								params
									.getAll("historyTypes")
									.some((type) => Object.hasOwn(h, types[type] as string)),
						)
						.filter(
							(h) =>
								!params.has("labelId") ||
								(h.messages as { labelIds: string[] }[]).some((m) =>
									m.labelIds.includes(params.get("labelId") as string),
								),
						);
				} else {
					const values = [...state.messages.values()].filter((m) => matches(m, params));
					rows =
						relative === "/messages"
							? values.map((m) => ({ id: m.id, threadId: m.threadId }))
							: [...new Set(values.map((m) => m.threadId))].map((id) => ({ id }));
				}
				const canonical = [...params]
					.filter(([k]) => k !== "pageToken")
					.sort(([a, x], [b, y]) => a.localeCompare(b) || x.localeCompare(y));
				const key = createHash("sha256")
					.update(JSON.stringify([bearer?.[1], relative, canonical]))
					.digest("hex");
				const page = state.page(
					key,
					params.get("pageToken"),
					rows,
					Number(params.get("maxResults") ?? 100),
				);
				return answer({
					[history ? "history" : relative.slice(1)]: page.rows,
					...(history ? { historyId: page.revision } : { resultSizeEstimate: page.total }),
					...(page.nextPageToken ? { nextPageToken: page.nextPageToken } : {}),
				});
			}
			if (getOne) {
				const values =
					match?.[1] === "messages"
						? ([state.messages.get(match[2] as string)].filter(Boolean) as GmailMessage[])
						: [...state.messages.values()].filter((m) => m.threadId === match?.[2]);
				if (!values.length) return failure(404, "notFound", "Synthetic message or thread absent");
				const messages = values.map((m) =>
					messageView(m, format, params.getAll("metadataHeaders")),
				);
				return answer(
					match?.[1] === "messages"
						? messages[0]
						: { id: match?.[2], historyId: String(state.sequence), messages },
				);
			}
			if (
				!(uploadPath
					? /^multipart\/related;/i.test(request.headers.get("content-type") ?? "")
					: /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
							request.headers.get("content-type") ?? "",
						))
			)
				return failure(415, "invalidArgument", "Unsupported fixture content type");
			const step = isSend ? script.shift() : undefined;
			const bytes = await body(request);
			request.signal.throwIfAborted();
			if (isSend) {
				const message = upload(bytes, request.headers.get("content-type") ?? "");
				if (step && step.kind !== "accept")
					return failure(
						429,
						"rateLimitExceeded",
						step.kind === "mail-rate-limit"
							? "Mail sending quota exceeded"
							: "Too many concurrent requests",
						{ "retry-after": String(step.retryAfterSeconds) },
					);
				if (message.threadId) {
					const parents = [...state.messages.values()].filter(
						(m) => m.threadId === message.threadId,
					);
					check(parents.length);
					const values = headers(message.raw).entries,
						find = (name: string) => values.find((h) => h.name.toLowerCase() === name)?.value;
					check(
						parents.some((parent) => {
							const h = headers(parent.raw).entries,
								parentId = h.find((v) => v.name.toLowerCase() === "message-id")?.value,
								subject = h.find((v) => v.name.toLowerCase() === "subject")?.value;
							return (
								parentId &&
								find("subject") === subject &&
								find("in-reply-to") === parentId &&
								find("references")?.split(/\s+/).includes(parentId)
							);
						}),
					);
				}
				let key: string;
				do {
					key = `sent_${++generated}`;
				} while (state.messages.has(key));
				state.add({
					id: key,
					threadId: message.threadId ?? key,
					raw: rewrite(message.raw, step ?? {}),
					labelIds: ["SENT"],
					internalDate: state.now(),
				});
				return answer(messageView(state.get(key), "minimal", []));
			}
			const data = record(
				JSON.parse(bytes.toString("utf8")),
				batch ? ["ids", "addLabelIds", "removeLabelIds"] : ["addLabelIds", "removeLabelIds"],
			);
			const adds = labels((data.addLabelIds ?? []) as string[]),
				removes = labels((data.removeLabelIds ?? []) as string[]);
			const ids = batch ? data.ids : [match?.[2]];
			check(Array.isArray(ids) && ids.length > 0 && ids.length <= 1000);
			const changes = ids.map((key) => {
				id(key);
				const current = state.get(key);
				return {
					key,
					labels: labels([
						...current.labelIds.filter((x) => !removes.includes(x)),
						...adds.filter((x) => !current.labelIds.includes(x)),
					]),
				};
			});
			check(state.sequence + BigInt(changes.length * 2) <= 18_446_744_073_709_551_615n);
			for (const change of changes) state.setLabels(change.key, change.labels);
			return batch
				? new Response(null, { status: 204 })
				: answer(messageView(state.get(match?.[2] as string), "minimal", []));
		} catch (error) {
			if (request.signal.aborted) throw request.signal.reason;
			if (
				error instanceof GmailInputError ||
				error instanceof SyntaxError ||
				error instanceof TypeError
			)
				return failure(400, "invalidArgument", "Gmail fixture request refused");
			throw error;
		} finally {
			active--;
		}
	});
	const fake = createFake(app, {
		host: GMAIL_HOST,
		recorder: options.recorder,
		faults: createFaults({ clock }),
		maxRequestBodyBytes: MAX_GMAIL_WIRE_BYTES,
	});
	return {
		...fake,
		clock,
		addMessage: (seed: GmailMessageSeed) => state.add(seed),
		deleteMessage: (key: string) => state.remove(key),
		setLabels: (key: string, value: readonly string[]) => state.setLabels(key, value),
		expireHistory: (before: string) => state.expire(before),
		message: (key: string): GmailMessage => structuredClone(state.get(key)),
		queueSend: (...steps: readonly GmailSendStep[]): void => {
			check(steps.length <= MAX_GMAIL_SEND_STEPS - script.length);
			const checked = steps.map(sendStep);
			script.push(...checked);
		},
		get historyId() {
			return String(state.sequence);
		},
	};
}
