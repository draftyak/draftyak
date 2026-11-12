import { types } from "node:util";
import { type MimeInput, renderMime, snapshotClaimStamp } from "@draftyak/mime";
import { sha256Hex } from "@draftyak/protocol/hash";
import { CurrentSendSnapshotV1 } from "@draftyak/protocol/snapshot";
import { captureDraftData } from "../../drafts/revisions.ts";
import type { RenderedSend } from "../ticket-storage.ts";
import {
	captureNativeSendRender,
	MAX_NATIVE_SEND_BODY_BYTES,
	NativeSendRenderError,
} from "./native.ts";

const GMAIL_UPLOAD_URL =
	"https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send?uploadType=multipart";
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const arrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")?.get;
const byteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")?.get;
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")?.get;

function refused(): never {
	throw new NativeSendRenderError();
}

function fields(raw: unknown): Record<string, unknown> {
	if (
		!raw ||
		typeof raw !== "object" ||
		types.isProxy(raw) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(raw))
	)
		refused();
	const keys = ["snapshot", "stamp", "attachments"],
		names = Reflect.ownKeys(raw);
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

/** Gmail wire DATA only. The native caller retains the claim stamp and all send authority. */
export async function renderGmailRequest(raw: unknown): Promise<RenderedSend> {
	let attachments: readonly Uint8Array[] = [];
	let mime: Buffer | undefined,
		prefix: Buffer | undefined,
		suffix: Buffer | undefined,
		body: Buffer | undefined;
	try {
		const input = fields(raw),
			snapshot = CurrentSendSnapshotV1.parse(captureDraftData(input.snapshot));
		if (snapshot.kind !== "email" || snapshot.render !== undefined) refused();
		const stamp = Object.freeze(snapshotClaimStamp(input.stamp));
		attachments = copyAttachments(input.attachments, snapshot.attachments);
		const message: MimeInput = {
			from: { address: snapshot.email.from },
			to: snapshot.email.to.map((address) => ({ address })),
			cc: snapshot.email.cc.map((address) => ({ address })),
			bcc: snapshot.email.bcc.map((address) => ({ address })),
			subject: snapshot.email.subject,
			text: snapshot.body.text + (snapshot.body.footer === "" ? "" : `\n${snapshot.body.footer}`),
			...(snapshot.email.inReplyTo === undefined ? {} : { inReplyTo: snapshot.email.inReplyTo }),
			references: snapshot.email.references,
			attachments: snapshot.attachments.map((item, index) => {
				const content = attachments[index];
				if (!content) refused();
				return { filename: item.filename, contentType: item.contentType, content };
			}),
		};
		mime = (await renderMime(message, stamp)).raw;
		const boundary = stamp.uploadBoundary;
		if (mime.includes(Buffer.from(`--${boundary}`, "ascii"))) refused();
		const metadata =
			snapshot.email.threadId === undefined ? {} : { threadId: snapshot.email.threadId };
		prefix = Buffer.from(
			`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: message/rfc822\r\n\r\n`,
			"utf8",
		);
		suffix = Buffer.from(`\r\n--${boundary}--\r\n`, "ascii");
		if (mime.byteLength > MAX_NATIVE_SEND_BODY_BYTES - prefix.byteLength - suffix.byteLength)
			refused();
		body = Buffer.concat([prefix, mime, suffix]);
		const contentType = `multipart/related; boundary="${boundary}"`;
		return captureNativeSendRender({
			method: "POST",
			url: GMAIL_UPLOAD_URL,
			contentType,
			headers: [["content-type", contentType]],
			body,
		});
	} catch {
		return refused();
	} finally {
		for (const bytes of attachments) bytes.fill(0);
		mime?.fill(0);
		prefix?.fill(0);
		suffix?.fill(0);
		body?.fill(0);
	}
}
