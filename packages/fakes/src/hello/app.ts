import { createHash } from "node:crypto";
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type HelloState, type PageRefusal, SELF } from "./state.ts";

const MAX_TEXT = 4_000;
const MAX_LIMIT = 200;
const PAGE_STATUS: Record<PageRefusal, ContentfulStatusCode> = {
	unknown_conversation: 404,
	invalid_cursor: 400,
	cursor_expired: 410,
};

const refuse = (c: Context, status: ContentfulStatusCode, error: string): Response =>
	c.json({ error }, status);

// One object with one member, "text", and nothing around it: no byte order mark, no second key.
const SEND_BODY = /^\{[\t\n\r ]*"text"[\t\n\r ]*:[\t\n\r ]*"(?:[^"\\]|\\.)*"[\t\n\r ]*\}$/;

// Exactly {"text": "<1 to 4,000 code points>"} in strict UTF-8, with no lone surrogate.
function parseText(bytes: Uint8Array): string | undefined {
	try {
		const json = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
		if (!SEND_BODY.test(json)) return undefined;
		const { text } = JSON.parse(json) as { text: string };
		const length = [...text].length;
		return text.isWellFormed() && length >= 1 && length <= MAX_TEXT ? text : undefined;
	} catch {
		return undefined;
	}
}

export function helloApp(state: HelloState): Hono {
	const app = new Hono();
	app.get("/v1/me", (c) => c.json({ id: SELF }));
	app.get("/v1/conversations", (c) => c.json({ conversations: state.conversations() }));
	app.get("/v1/conversations/:id/messages", (c) => {
		const raw = c.req.query("limit") ?? "50";
		const limit = /^\d{1,3}$/.test(raw) ? Number(raw) : 0;
		if (limit < 1 || limit > MAX_LIMIT) return refuse(c, 400, "invalid_limit");
		// An empty cursor, as a template leaves it on the first sync, asks for the first page.
		const page = state.page(c.req.param("id"), c.req.query("cursor") || undefined, limit);
		return typeof page === "string" ? refuse(c, PAGE_STATUS[page], page) : c.json(page);
	});
	app.post("/v1/conversations/:id/messages", async (c) => {
		const conversationId = c.req.param("id");
		if (!state.has(conversationId)) return refuse(c, 404, "unknown_conversation");
		// A json-template binds the outbox id into the query; other clients may send the header.
		const fromQuery = c.req.query("idempotency_key");
		const fromHeader = c.req.header("idempotency-key");
		if (fromQuery !== undefined && fromHeader !== undefined && fromQuery !== fromHeader) {
			return refuse(c, 400, "idempotency_key_mismatch");
		}
		if (!/^application\/json\s*(?:;|$)/i.test(c.req.header("content-type") ?? "")) {
			return refuse(c, 415, "unsupported_media_type");
		}
		const bytes = new Uint8Array(await c.req.arrayBuffer());
		const text = parseText(bytes);
		if (text === undefined) return refuse(c, 400, "invalid_body");
		const key = fromQuery ?? fromHeader;
		const bodySha256 = createHash("sha256").update(bytes).digest("hex");
		const sent = state.send(
			conversationId,
			text,
			key === undefined ? undefined : { key, bodySha256 },
		);
		if (sent === "idempotency_key_reused") return refuse(c, 409, sent);
		if (sent.replayed) c.header("Idempotent-Replayed", "true");
		const { id, createdAt } = sent.message;
		return c.json({ id, conversationId, createdAt }, 201);
	});
	app.notFound((c) => refuse(c, 404, "not_found"));
	app.onError((error) => {
		throw error;
	});
	return app;
}
