export type Completion = "chat" | "ollama";

const JSON_MEDIA = /^\s*application\/json\s*(?:;\s*charset\s*=\s*(?:utf-8|"utf-8")\s*)?$/i;

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactly(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const own = Object.keys(value);
	return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// The core's two prompt parts: the hub's system text, then its user text.
function messages(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.length === 2 &&
		["system", "user"].every((role, index) => {
			const message: unknown = value[index];
			return (
				object(message) &&
				exactly(message, ["role", "content"]) &&
				message.role === role &&
				typeof message.content === "string"
			);
		})
	);
}

function responseFormat(value: unknown): boolean {
	if (!object(value)) return false;
	if (value.type === "json_object") return exactly(value, ["type"]);
	if (value.type !== "json_schema" || !exactly(value, ["type", "json_schema"])) return false;
	const format = value.json_schema;
	return (
		object(format) &&
		exactly(format, ["name", "strict", "schema"]) &&
		format.name === "draft_output_v1" &&
		format.strict === true &&
		object(format.schema)
	);
}

function draftShape(body: unknown, route: Completion, model: string): boolean {
	if (!object(body)) return false;
	const format = route === "chat" ? "response_format" : "format";
	if (!exactly(body, ["model", "messages", format, "stream"])) return false;
	if (body.model !== model || body.stream !== false || !messages(body.messages)) return false;
	return route === "chat" ? responseFormat(body.response_format) : object(body.format);
}

/**
 * Whether the request is the compatible core's draft request for this dialect: application/json
 * (charset utf-8 at most) in strict UTF-8 with no byte order mark, read with JSON.parse's
 * last-member semantics. The fake's intake has already capped the body. Schemas stay opaque, and
 * no prompt, header or credential is checked.
 */
export async function acceptsDraft(
	request: Request,
	route: Completion,
	model: string,
): Promise<boolean> {
	if (!JSON_MEDIA.test(request.headers.get("content-type") ?? "")) return false;
	const bytes = await request.arrayBuffer();
	let body: unknown;
	try {
		body = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
	} catch {
		return false;
	}
	return draftShape(body, route, model);
}
