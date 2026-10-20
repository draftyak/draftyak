import { types } from "node:util";
import { MediaType } from "@draftyak/protocol/entities/common";
import { DraftContent } from "@draftyak/protocol/entities/draft";

// A native intake budget in UTF-16 units, separate from the shared output code-point limits.
const MAX_RAW_BODY_UNITS = 400_000;
const EMAIL_FIELDS = ["channel", "to", "cc", "bcc", "subject", "body", "attachments"];
const CHAT_FIELDS = ["channel", "threadTs", "broadcast", "body"];
const ATTACHMENT_FIELDS = ["blobId", "filename", "contentType", "size", "sha256"];

function refused(): never {
	throw new Error("Draft content refused.");
}

function record(input: unknown): Record<string, unknown> {
	if (input === null || typeof input !== "object" || types.isProxy(input)) refused();
	const prototype: unknown = Object.getPrototypeOf(input);
	if (prototype !== Object.prototype && prototype !== null) refused();
	const keys = Reflect.ownKeys(input);
	if (keys.length > EMAIL_FIELDS.length) refused();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		if (typeof key !== "string") refused();
		const descriptor = Object.getOwnPropertyDescriptor(input, key);
		if (!descriptor?.enumerable || !("value" in descriptor)) refused();
		result[key] = descriptor.value;
	}
	return result;
}

function fields(value: Record<string, unknown>, expected: readonly string[]): void {
	const keys = Object.keys(value);
	if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
		refused();
}

function list(input: unknown): unknown[] {
	if (input === null || typeof input !== "object" || types.isProxy(input) || !Array.isArray(input))
		refused();
	const length = Object.getOwnPropertyDescriptor(input, "length")?.value as number;
	if (length > 100 || Reflect.ownKeys(input).length !== length + 1) refused();
	const result: unknown[] = [];
	for (let index = 0; index < length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
		if (!descriptor?.enumerable || !("value" in descriptor)) refused();
		result.push(descriptor.value);
	}
	return result;
}

/** Converts native body input before shared validation, flags and immutable hashing. */
export function normalizeDraftBody(body: string): string {
	if (typeof body !== "string" || body.length > MAX_RAW_BODY_UNITS || !body.isWellFormed())
		refused();
	return body.replace(/\r\n?/g, "\n").normalize("NFC");
}

/** Normalizes body/media fields; one-line identity fields are preserved or refused. */
export function normalizeDraftContent(input: unknown): DraftContent {
	try {
		const value = record(input);
		const body = normalizeDraftBody(value.body as string);
		if (value.channel === "email") {
			fields(value, EMAIL_FIELDS);
			const attachments = list(value.attachments).map((raw) => {
				const attachment = record(raw);
				fields(attachment, ATTACHMENT_FIELDS);
				const type =
					typeof attachment.contentType === "string"
						? attachment.contentType.split(";", 1)[0]?.trim().toLowerCase()
						: undefined;
				return {
					...attachment,
					contentType: MediaType.safeParse(type).success ? type : "application/octet-stream",
				};
			});
			return DraftContent.parse({
				...value,
				to: list(value.to),
				cc: list(value.cc),
				bcc: list(value.bcc),
				body,
				attachments,
			});
		}
		fields(value, CHAT_FIELDS);
		return DraftContent.parse({ ...value, body });
	} catch {
		refused();
	}
}
