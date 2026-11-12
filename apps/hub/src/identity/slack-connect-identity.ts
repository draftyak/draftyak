import { Buffer } from "node:buffer";
import { types } from "node:util";
import { parseStrict } from "@draftyak/protocol/jcs";

export interface SlackConnectIdentity {
	readonly teamId: string | null;
	readonly selfUserId: string;
	readonly scopes: readonly string[];
}

export class SlackConnectIdentityError extends Error {
	override name = "SlackConnectIdentityError";
	readonly code = "SLACK_IDENTITY_UNAVAILABLE";

	constructor() {
		super("Slack identity unavailable");
	}
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!;
const copyBytes = Uint8Array.prototype.set;
function unavailable(): never {
	throw new SlackConnectIdentityError();
}

function captureBody(value: unknown): Buffer {
	if (types.isProxy(value) || !types.isUint8Array(value)) unavailable();
	const length = byteLength.call(value) as number;
	if (length < 1 || length > 65_536) unavailable();
	if (types.isSharedArrayBuffer(backingBuffer.call(value))) unavailable();
	const bytes = Buffer.alloc(length);
	try {
		copyBytes.call(bytes, value as Uint8Array);
		return bytes;
	} catch {
		bytes.fill(0);
		return unavailable();
	}
}

function headerValue(value: unknown, index: number): string {
	const field = Object.getOwnPropertyDescriptor(value, String(index));
	if (!field || !("value" in field) || typeof field.value !== "string") unavailable();
	return field.value;
}

function captureScopes(rawHeaders: unknown): readonly string[] {
	if (types.isProxy(rawHeaders) || !Array.isArray(rawHeaders)) unavailable();
	const length: unknown = Object.getOwnPropertyDescriptor(rawHeaders, "length")?.value;
	if (typeof length !== "number" || length % 2 !== 0 || length > 256) unavailable();
	let total = 0;
	let scopesHeader: string | undefined;
	for (let index = 0; index < length; index += 2) {
		const name = headerValue(rawHeaders, index);
		const value = headerValue(rawHeaders, index + 1);
		if (name.length > 16_384 || value.length > 16_384) unavailable();
		if (!name || /[^!#$%&'*+.^_\x60|~0-9A-Za-z-]/u.test(name)) unavailable();
		if (/[\r\n\0]/u.test(value)) unavailable();
		total += Buffer.byteLength(name, "utf8") + Buffer.byteLength(value, "utf8") + 4;
		if (total > 16_384) unavailable();
		if (name.toLowerCase() !== "x-oauth-scopes") continue;
		if (scopesHeader !== undefined) unavailable();
		scopesHeader = value;
	}
	if (scopesHeader === undefined || /[^\x20-\x7e\t]/u.test(scopesHeader)) unavailable();
	const text = scopesHeader.replace(/^[ \t]+|[ \t]+$/gu, "");
	const scopes: string[] = [];
	if (text === "") return Object.freeze(scopes);
	const seen = new Set<string>();
	for (const part of text.split(",")) {
		const scope = part.replace(/^[ \t]+|[ \t]+$/gu, "");
		if (!scope || /[^\x21\x23-\x2b\x2d-\x5b\x5d-\x7e]/u.test(scope)) unavailable();
		if (seen.has(scope)) unavailable();
		seen.add(scope);
		scopes.push(scope);
	}
	return Object.freeze(scopes);
}

function providerId(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= 256 &&
		!/[^\x21-\x7e]/u.test(value)
	);
}

// Detached response DATA only. The original probe retains response and credential provenance.
export function parseSlackConnectIdentity(
	body: unknown,
	rawHeaders: unknown,
): SlackConnectIdentity {
	let bytes: Buffer | undefined;
	try {
		bytes = captureBody(body);
		const scopes = captureScopes(rawHeaders);
		const parsed = parseStrict(bytes);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) unavailable();
		const record = parsed as Record<string, unknown>;
		if (!Object.hasOwn(record, "ok") || record.ok !== true) unavailable();
		if (!Object.hasOwn(record, "team_id") || !Object.hasOwn(record, "user_id")) unavailable();
		if (record.team_id !== null && !providerId(record.team_id)) unavailable();
		if (!providerId(record.user_id)) unavailable();
		return Object.freeze({ teamId: record.team_id, selfUserId: record.user_id, scopes });
	} catch {
		return unavailable();
	} finally {
		bytes?.fill(0);
	}
}
