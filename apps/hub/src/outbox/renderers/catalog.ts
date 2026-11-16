import { types } from "node:util";
import { type ClaimStamp, snapshotClaimStamp } from "@draftyak/mime";
import { sha256Hex } from "@draftyak/protocol/hash";
import type { ChannelProfile, SendDeclaration } from "@draftyak/protocol/manifest";
import { CurrentSendSnapshotV1 } from "@draftyak/protocol/snapshot";
import { captureDraftData } from "../../drafts/revisions.ts";
import { renderGmailRequest } from "./gmail-rfc5322.ts";
import {
	captureNativeSendRender,
	MAX_NATIVE_SEND_BODY_BYTES,
	type NativeRenderedSend,
	NativeSendRenderError,
} from "./native.ts";
import { renderSlackRequest } from "./slack-postmessage.ts";

/** Native caller input DATA; the caller independently authenticates its origin and currentness. */
export interface NativeBuiltinSendInput {
	readonly snapshot: CurrentSendSnapshotV1;
	readonly profile: ChannelProfile;
	readonly declaration: SendDeclaration;
	readonly stamp: ClaimStamp;
	readonly attachments: readonly Uint8Array[];
}

export interface NativeGmailWireInput {
	readonly snapshot: Extract<CurrentSendSnapshotV1, { kind: "email" }>;
	readonly stamp: ClaimStamp;
	readonly attachments: readonly Uint8Array[];
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;

function refused(): never {
	throw new NativeSendRenderError();
}

function fields(raw: unknown, keys: readonly string[]): Record<string, unknown> {
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refused();
	const names = Reflect.ownKeys(raw);
	if (names.length !== keys.length) refused();
	const result: Record<string, unknown> = Object.create(null);
	for (const key of names) {
		if (typeof key !== "string" || !keys.includes(key)) refused();
		const slot = Object.getOwnPropertyDescriptor(raw, key);
		if (!slot?.enumerable || !("value" in slot)) refused();
		result[key] = slot.value;
	}
	return result;
}

function frozen<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value)) frozen(child);
		Object.freeze(value);
	}
	return value;
}

function copyAttachments(
	raw: unknown,
	expected: CurrentSendSnapshotV1["attachments"],
): readonly Uint8Array[] {
	if (
		!Array.isArray(raw) ||
		types.isProxy(raw) ||
		Object.getPrototypeOf(raw) !== Array.prototype ||
		Object.getOwnPropertyDescriptor(raw, "length")?.value !== expected.length ||
		Reflect.ownKeys(raw).length !== expected.length + 1 ||
		!arrayBuffer ||
		!byteOffset ||
		!byteLength
	)
		refused();
	const result: Uint8Array[] = [];
	let total = 0;
	try {
		for (let index = 0; index < expected.length; index++) {
			const slot = Object.getOwnPropertyDescriptor(raw, String(index)),
				metadata = expected[index];
			if (!slot?.enumerable || !("value" in slot) || !metadata) refused();
			const value: unknown = slot.value;
			if (!types.isUint8Array(value) || types.isProxy(value)) refused();
			const backing = Reflect.apply(arrayBuffer, value, []),
				offset = Reflect.apply(byteOffset, value, []),
				size = Reflect.apply(byteLength, value, []);
			if (
				!types.isArrayBuffer(backing) ||
				!Number.isSafeInteger(size) ||
				size < 0 ||
				size !== metadata.size ||
				size > MAX_NATIVE_SEND_BODY_BYTES - total
			)
				refused();
			total += size;
			const bytes = new Uint8Array(size);
			result.push(bytes);
			bytes.set(new Uint8Array(backing, offset, size));
			if (sha256Hex(bytes) !== metadata.sha256) refused();
		}
		return Object.freeze(result);
	} catch {
		for (const bytes of result) bytes.fill(0);
		return refused();
	}
}

/** Closed native codecs only. Rendering DATA never authorizes a claim, ticket or request. */
export async function renderNativeBuiltinSend(
	raw: NativeBuiltinSendInput,
): Promise<NativeRenderedSend> {
	let attachments: readonly Uint8Array[] = [];
	try {
		const input = fields(raw, ["snapshot", "profile", "declaration", "stamp", "attachments"]),
			snapshot = frozen(CurrentSendSnapshotV1.parse(captureDraftData(input.snapshot))),
			declaration = fields(input.declaration, ["render"]);
		if (snapshot.render !== undefined) refused();
		const gmail =
			input.profile === "gmail-v1" &&
			declaration.render === "gmail-rfc5322" &&
			snapshot.kind === "email";
		const slack =
			input.profile === "slack-v1" &&
			declaration.render === "slack-postmessage" &&
			snapshot.kind === "chat";
		if (!gmail && !slack) refused();
		if (slack && snapshot.attachments.length !== 0) refused();
		const stamp = Object.freeze(snapshotClaimStamp(input.stamp));
		attachments = copyAttachments(input.attachments, snapshot.attachments);
		if (gmail && snapshot.kind === "email") {
			const request = await renderGmailRequest(
				Object.freeze({ snapshot, stamp, attachments } satisfies NativeGmailWireInput),
			);
			return captureNativeSendRender(request);
		}
		if (!slack || snapshot.kind !== "chat") refused();
		const request = renderSlackRequest({
			channelId: snapshot.chat.channelId,
			threadTs: snapshot.chat.threadTs,
			broadcast: snapshot.chat.broadcast,
			text: snapshot.body.text,
			footer: snapshot.body.footer,
			authors: snapshot.source.authors.map((author) => author.kind),
		});
		if (typeof request.body !== "string" || !request.body.isWellFormed()) refused();
		return captureNativeSendRender({
			method: request.method,
			url: request.url,
			contentType: request.contentType,
			headers: request.headers,
			body: new TextEncoder().encode(request.body),
		});
	} catch {
		return refused();
	} finally {
		for (const bytes of attachments) bytes.fill(0);
	}
}
