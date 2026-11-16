import { types } from "node:util";
import { Ulid } from "@draftyak/protocol/scalars";
import { NativeAdminError } from "./admin-errors.ts";

interface Metadata {
	readonly alias: string;
	readonly mode: "full" | "read_only";
	readonly historyLimitDays: number;
	readonly disclosureVersion: number;
	readonly pluginLogicalId: string;
}
export interface NativeSlackConnectCandidate {
	readonly metadata: Metadata;
	/** Owned mutable copy; its native consumer erases it after the original producer takes a copy. */
	readonly token: Buffer;
}

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const bufferOf = Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get;
const offsetOf = Object.getOwnPropertyDescriptor(typedArray, "byteOffset")?.get;
const lengthOf = Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get;

function unavailable(): never {
	throw new NativeAdminError();
}
function metadata(input: unknown): Metadata {
	const keys = ["alias", "mode", "historyLimitDays", "disclosureVersion", "pluginLogicalId"];
	if (
		!input ||
		typeof input !== "object" ||
		types.isProxy(input) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(input)) ||
		Reflect.ownKeys(input).length !== keys.length
	)
		unavailable();
	const value: Record<string, unknown> = Object.create(null);
	for (const key of keys) {
		const member = Object.getOwnPropertyDescriptor(input, key);
		if (!member || !("value" in member)) unavailable();
		value[key] = member.value;
	}
	if (
		typeof value.alias !== "string" ||
		!/^[a-z0-9][a-z0-9-]{0,31}$(?![\s\S])/u.test(value.alias) ||
		(value.mode !== "full" && value.mode !== "read_only") ||
		typeof value.historyLimitDays !== "number" ||
		!Number.isSafeInteger(value.historyLimitDays) ||
		value.historyLimitDays < 1 ||
		value.historyLimitDays > 365 ||
		typeof value.disclosureVersion !== "number" ||
		!Number.isSafeInteger(value.disclosureVersion) ||
		value.disclosureVersion < 1 ||
		!Ulid.safeParse(value.pluginLogicalId).success
	)
		unavailable();
	return Object.freeze(value) as unknown as Metadata;
}
function tokenCopy(input: unknown): Buffer {
	let owned: Buffer | undefined;
	try {
		if (!input || typeof input !== "object" || types.isProxy(input) || !types.isUint8Array(input))
			unavailable();
		const buffer = bufferOf?.call(input),
			offset = offsetOf?.call(input),
			length = lengthOf?.call(input);
		if (
			types.isSharedArrayBuffer(buffer) ||
			!Number.isSafeInteger(length) ||
			length < 1 ||
			length > 8192
		)
			unavailable();
		owned = Buffer.alloc(length);
		owned.set(new Uint8Array(buffer, offset, length));
		for (const byte of owned) if (byte < 0x21 || byte > 0x7e) unavailable();
		return owned;
	} catch {
		owned?.fill(0);
		throw new NativeAdminError();
	}
}
/** Pure DATA capture before native initialization awaits; this creates no pending input or proof. */
export function captureNativeSlackConnectCandidate(
	rawMetadata: unknown,
	enteredToken: unknown,
): NativeSlackConnectCandidate {
	if (arguments.length !== 2) unavailable();
	const captured = metadata(rawMetadata);
	return Object.freeze({ metadata: captured, token: tokenCopy(enteredToken) });
}
