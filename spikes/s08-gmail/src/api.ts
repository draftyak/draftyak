import {
	classifyBodyFailure,
	classifyNetworkError,
	classifyResponse,
	type Outcome,
} from "./classify.ts";

// The Gmail REST API (rootUrl of the vendored discovery document), always as userId "me".
export const GMAIL_ROOT = "https://gmail.googleapis.com";

export interface MessagePartHeader {
	readonly name: string;
	readonly value: string;
}

export interface MessagePart {
	readonly partId?: string;
	readonly mimeType?: string;
	readonly filename?: string;
	readonly headers?: readonly MessagePartHeader[];
	readonly body?: {
		readonly size?: number;
		readonly data?: string;
		readonly attachmentId?: string;
	};
	readonly parts?: readonly MessagePart[];
}

export interface Message {
	readonly id: string;
	readonly threadId: string;
	readonly labelIds?: readonly string[];
	readonly internalDate?: string;
	readonly historyId?: string;
	readonly sizeEstimate?: number;
	readonly payload?: MessagePart;
}

export interface MessageRef {
	readonly id: string;
	readonly threadId: string;
}

export interface MessageList {
	readonly messages?: readonly MessageRef[];
	readonly nextPageToken?: string;
	readonly resultSizeEstimate?: number;
}

export interface Thread {
	readonly id: string;
	readonly historyId?: string;
	readonly messages?: readonly Message[];
}

export interface Profile {
	readonly emailAddress: string;
	readonly historyId: string;
	readonly messagesTotal?: number;
	readonly threadsTotal?: number;
}

export type QueryValue = string | number | boolean | readonly string[] | undefined;
export type Query = Readonly<Record<string, QueryValue>>;

export class GmailError extends Error {
	readonly status: number;
	readonly outcome: Outcome;
	readonly body: unknown;

	constructor(status: number, outcome: Outcome, body: unknown) {
		const detail = outcome.kind === "ok" ? "" : `: ${outcome.reason}`;
		super(
			`gmail: ${status === 0 ? "request failed" : `HTTP ${status}`} (${outcome.kind}${detail})`,
		);
		this.name = "GmailError";
		this.status = status;
		this.outcome = outcome;
		this.body = body;
	}
}

export interface GmailOptions {
	readonly accessToken: string | (() => string | Promise<string>);
	readonly root?: string;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	readonly now?: () => number;
}

export interface CallOptions {
	readonly query?: Query;
	readonly body?: Uint8Array<ArrayBuffer>;
	readonly contentType?: string;
}

export function withQuery(url: string, query: Query = {}): string {
	const params = new URLSearchParams();
	for (const [name, value] of Object.entries(query)) {
		for (const item of typeof value === "object" ? value : [value]) {
			if (item !== undefined) params.append(name, String(item));
		}
	}
	const search = params.toString();
	return search === "" ? url : `${url}?${search}`;
}

const segment = (id: string): string => encodeURIComponent(id);

export class Gmail {
	readonly #options: GmailOptions;

	constructor(options: GmailOptions) {
		this.#options = options;
	}

	// One request; a non-2xx answer or a network failure, before or during the body, throws a
	// classified GmailError.
	async call(method: "GET" | "POST", path: string, options: CallOptions = {}): Promise<unknown> {
		const { accessToken, root = GMAIL_ROOT, timeoutMs = 30_000 } = this.#options;
		const token = typeof accessToken === "string" ? accessToken : await accessToken();
		const headers: Record<string, string> = {
			authorization: `Bearer ${token}`,
			accept: "application/json",
		};
		if (options.contentType !== undefined) headers["content-type"] = options.contentType;
		let response: Response;
		try {
			response = await (this.#options.fetch ?? fetch)(withQuery(`${root}/${path}`, options.query), {
				method,
				headers,
				...(options.body === undefined ? {} : { body: options.body }),
				redirect: "error",
				signal: AbortSignal.timeout(timeoutMs),
			});
		} catch (error) {
			throw new GmailError(0, classifyNetworkError(error), undefined);
		}
		const now = (this.#options.now ?? Date.now)();
		let text: string;
		try {
			text = await response.text();
		} catch (error) {
			const outcome = classifyBodyFailure(response.status, response.headers, error, now);
			throw new GmailError(response.status, outcome, undefined);
		}
		let body: unknown = text;
		try {
			body = text === "" ? undefined : JSON.parse(text);
		} catch {}
		if (!response.ok) {
			throw new GmailError(
				response.status,
				classifyResponse(response.status, body, response.headers, now),
				body,
			);
		}
		return body;
	}

	getMessage(
		id: string,
		query: {
			readonly format?: "minimal" | "metadata" | "full";
			readonly metadataHeaders?: readonly string[];
		} = {},
	): Promise<Message> {
		return this.call("GET", `gmail/v1/users/me/messages/${segment(id)}`, {
			query,
		}) as Promise<Message>;
	}

	listMessages(query: {
		readonly q?: string;
		readonly labelIds?: readonly string[];
		readonly pageToken?: string;
		readonly maxResults?: number;
	}): Promise<MessageList> {
		return this.call("GET", "gmail/v1/users/me/messages", { query }) as Promise<MessageList>;
	}

	getThread(
		id: string,
		query: { readonly format?: "minimal" | "metadata" | "full" } = {},
	): Promise<Thread> {
		return this.call("GET", `gmail/v1/users/me/threads/${segment(id)}`, {
			query,
		}) as Promise<Thread>;
	}

	getProfile(): Promise<Profile> {
		return this.call("GET", "gmail/v1/users/me/profile") as Promise<Profile>;
	}
}

export function header(part: MessagePart | undefined, name: string): string | undefined {
	const wanted = name.toLowerCase();
	return part?.headers?.find((entry) => entry.name.toLowerCase() === wanted)?.value;
}
