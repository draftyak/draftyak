import { createHash } from "node:crypto";
import { types } from "node:util";
import { MediaType, wellFormedText } from "@draftyak/protocol/entities/common";
import type { BlobRef } from "@draftyak/protocol/normalized-change";
import { Sha256Hex } from "@draftyak/protocol/scalars";
import type { SnapshotAttachment } from "@draftyak/protocol/snapshot";
import { WorkDatabase, type WorkScope } from "../jobs/database.ts";
import { fields, id, integer } from "../jobs/values.ts";
import type { MetadataAccountRef } from "../sync/account-ref.ts";
import {
	NativeRawStore,
	RAW_CONTENT_CHUNK_BYTES,
	type RawContentSlice,
} from "../sync/raw-store.ts";
import { MAX_NATIVE_SEND_BODY_BYTES } from "./renderers/native.ts";

const read = NativeRawStore.prototype.read;
const write = WorkDatabase.prototype.write;
const clear = Uint8Array.prototype.fill;
const copy = Uint8Array.prototype.set;
const filename = wellFormedText(256)
	.min(1)
	.refine((value) => !value.includes("\r") && !value.includes("\n"));

export class NativeAttachmentBytesError extends Error {
	readonly code = "ATTACHMENT_BYTES_UNAVAILABLE";
	constructor() {
		super("Attachment bytes unavailable");
		this.name = "NativeAttachmentBytesError";
	}
}

function refuse(): never {
	throw new NativeAttachmentBytesError();
}

function accountReference(raw: MetadataAccountRef): MetadataAccountRef {
	const value = fields(raw, ["accountId", "generation", "pluginInstanceId", "ownerEpoch", "mode"]);
	if (value.mode !== "full" && value.mode !== "read_only") refuse();
	return Object.freeze({
		accountId: id(value.accountId),
		generation: integer(value.generation, 1),
		pluginInstanceId: id(value.pluginInstanceId),
		ownerEpoch: integer(value.ownerEpoch),
		mode: value.mode,
	});
}

/**
 * Copy one committed object's bounded bytes and verify the complete frozen digest.
 * The native caller supplies its genuine services and frozen-revision blob mapping, checks
 * admission before and after this synchronous preparation, and retains its store lifetime.
 * Neither these data inputs nor the returned bytes grant read, approval or send authority.
 */
export function readNativeAttachmentBytes(
	raw: NativeRawStore,
	database: WorkDatabase,
	account: MetadataAccountRef,
	blob: BlobRef,
	expected: SnapshotAttachment,
): Uint8Array {
	let result: Uint8Array | undefined;
	let slice: Uint8Array | undefined;
	let complete = false;
	try {
		if (types.isProxy(raw) || types.isProxy(database)) refuse();
		const ref = accountReference(account);
		const blobRef = Object.freeze({ ref: id(fields(blob, ["ref"]).ref) });
		const frozen = fields(expected, ["filename", "contentType", "size", "sha256"]);
		if (
			!filename.safeParse(frozen.filename).success ||
			!MediaType.safeParse(frozen.contentType).success ||
			!Sha256Hex.safeParse(frozen.sha256).success
		)
			refuse();
		const size = integer(frozen.size, 0, MAX_NATIVE_SEND_BODY_BYTES);
		const digest = frozen.sha256 as string;
		result = new Uint8Array(size);
		for (let offset = 0; ; ) {
			const part = write.call(database, (scope: WorkScope) => {
				const value = read.call(raw, scope, ref, blobRef, offset, RAW_CONTENT_CHUNK_BYTES);
				// Own the returned slice even if the database's final scope guard then refuses.
				slice = value.bytes;
				return value;
			}) as RawContentSlice;
			const bytes = part.bytes;
			const length = bytes.byteLength;
			const end = offset + length;
			if (
				part.totalBytes !== size ||
				part.sha256 !== digest ||
				length !== Math.min(RAW_CONTENT_CHUNK_BYTES, size - offset) ||
				part.nextOffset !== (end === size ? null : end) ||
				(end !== size && end <= offset)
			)
				refuse();
			copy.call(result, bytes, offset);
			clear.call(bytes, 0);
			slice = undefined;
			if (end === size) break;
			offset = end;
		}
		if (createHash("sha256").update(result).digest("hex") !== digest) refuse();
		complete = true;
		return result;
	} catch {
		throw new NativeAttachmentBytesError();
	} finally {
		if (slice !== undefined) clear.call(slice, 0);
		if (!complete && result !== undefined) clear.call(result, 0);
	}
}
