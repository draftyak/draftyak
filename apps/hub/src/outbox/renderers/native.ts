import { types } from "node:util";
import { type HeaderList, headersSha256, sha256Hex } from "@draftyak/protocol/hash";
import { Sha256Hex } from "@draftyak/protocol/scalars";
import { ContentType, SendMethod, SendUrl } from "@draftyak/protocol/send-ticket";
import type { SnapshotRender } from "@draftyak/protocol/snapshot";
import type { RenderedSend } from "../ticket-storage.ts";

export const MAX_NATIVE_SEND_BODY_BYTES = 33_554_432;

export class NativeSendRenderError extends Error {
	readonly code = "SEND_RENDER_UNAVAILABLE";
	constructor() {
		super("Send rendering unavailable");
		this.name = "NativeSendRenderError";
	}
}

/** Detached request DATA. Neither a render nor its digests grants a send right. */
export interface NativeRenderedSend extends RenderedSend {
	readonly render: SnapshotRender;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;

function refused(): never {
	throw new NativeSendRenderError();
}

function record(
	raw: unknown,
	keys: readonly string[],
	optional: readonly string[] = [],
): Record<string, unknown> {
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refused();
	const names = Reflect.ownKeys(raw);
	if (names.length < keys.length || names.length > keys.length + optional.length) refused();
	const copy: Record<string, unknown> = Object.create(null);
	for (const key of names) {
		if (typeof key !== "string" || (!keys.includes(key) && !optional.includes(key))) refused();
		const slot = Object.getOwnPropertyDescriptor(raw, key);
		if (!slot?.enumerable || !("value" in slot)) refused();
		copy[key] = slot.value;
	}
	if (keys.some((key) => !Object.hasOwn(copy, key))) refused();
	return copy;
}

function denseArray(raw: unknown, length: number): readonly unknown[] {
	if (
		!Array.isArray(raw) ||
		types.isProxy(raw) ||
		Object.getPrototypeOf(raw) !== Array.prototype ||
		Object.getOwnPropertyDescriptor(raw, "length")?.value !== length ||
		Reflect.ownKeys(raw).length !== length + 1
	)
		refused();
	const result: unknown[] = [];
	for (let i = 0; i < length; i++) {
		const slot = Object.getOwnPropertyDescriptor(raw, String(i));
		if (!slot?.enumerable || !("value" in slot)) refused();
		result.push(slot.value);
	}
	return result;
}

function bodyBytes(raw: unknown): Uint8Array {
	if (!types.isUint8Array(raw) || types.isProxy(raw) || !arrayBuffer || !byteOffset || !byteLength)
		refused();
	const buffer = Reflect.apply(arrayBuffer, raw, []),
		offset = Reflect.apply(byteOffset, raw, []),
		size = Reflect.apply(byteLength, raw, []);
	if (
		!types.isArrayBuffer(buffer) ||
		!Number.isSafeInteger(size) ||
		size < 0 ||
		size > MAX_NATIVE_SEND_BODY_BYTES
	)
		refused();
	const result = new Uint8Array(size);
	result.set(new Uint8Array(buffer, offset, size));
	return result;
}

function captureHeaders(raw: unknown, contentType: string): HeaderList {
	const [entry] = denseArray(raw, 1),
		[name, value] = denseArray(entry, 2);
	if (typeof name !== "string" || name.toLowerCase() !== "content-type" || value !== contentType)
		refused();
	return Object.freeze([Object.freeze(["content-type", contentType] as const)]);
}

function projection(request: RenderedSend): SnapshotRender {
	return Object.freeze({
		method: request.method,
		url: request.url,
		headersSha256: headersSha256(request.headers),
		bodySha256: sha256Hex(request.body),
	});
}

/** Capture one bounded request before comparing or persisting any of its fields. */
export function captureNativeSendRender(input: RenderedSend): NativeRenderedSend {
	try {
		const data = record(input, ["method", "url", "contentType", "headers", "body"], ["render"]),
			method = SendMethod.parse(data.method),
			url = SendUrl.parse(data.url),
			contentType = ContentType.parse(data.contentType),
			headers = captureHeaders(data.headers, contentType),
			body = bodyBytes(data.body);
		const request: RenderedSend = { method, url, contentType, headers, body };
		return Object.freeze({ ...request, render: projection(request) });
	} catch {
		return refused();
	}
}

/** Existing protocol digest spelling only; this does not modify a frozen send snapshot. */
export function nativeSendRenderProjection(input: RenderedSend): SnapshotRender {
	return captureNativeSendRender(input).render;
}

/** Compare the complete approved request projection, without normalizing either URL or body. */
export function assertNativeSendRenderMatches(
	approved: SnapshotRender,
	actual: RenderedSend,
): void {
	try {
		const saved = record(approved, ["method", "url", "headersSha256", "bodySha256"]),
			method = SendMethod.parse(saved.method),
			url = SendUrl.parse(saved.url),
			headerDigest = Sha256Hex.parse(saved.headersSha256),
			bodyDigest = Sha256Hex.parse(saved.bodySha256),
			current = nativeSendRenderProjection(actual);
		if (
			method !== current.method ||
			url !== current.url ||
			headerDigest !== current.headersSha256 ||
			bodyDigest !== current.bodySha256
		)
			refused();
	} catch {
		refused();
	}
}
