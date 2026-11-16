import { createHash } from "node:crypto";
import type { ClaimStamp } from "@draftyak/mime";
import { CurrentSendSnapshotV1, type SnapshotAttachment } from "@draftyak/protocol/snapshot";

export const OUTBOX_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const ACCOUNT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
export const CONVERSATION_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
export const DRAFT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
export const USER_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAZ";

/** A valid synthetic stamp value, never an issued native claim or approval. */
export function claimStamp(): ClaimStamp {
	return Object.freeze({
		messageId: "<synthetic-claim@example.test>",
		dateMs: 1_700_000_000_000,
		mimeBoundary: "0123456789abcdef0123456789abcdef",
		uploadBoundary: "draftyak_upload_0123456789abcdef",
	});
}

function common() {
	return {
		v: 1,
		hub: "1".repeat(64),
		epoch: 7,
		outbox: OUTBOX_ID,
		account: ACCOUNT_ID,
		body: { text: "Hello, café.\nSecond line.", footer: "Sent with DraftYak" },
		attachments: [],
		schedule: { kind: "now" },
		source: { draft: DRAFT_ID, rev: 3, authors: [{ kind: "owner", id: USER_ID }] },
	};
}

/** Frozen-content DATA only; this fixture conveys no device, approval or send authority. */
export function emailSnapshot(): Extract<CurrentSendSnapshotV1, { kind: "email" }> {
	const parsed = CurrentSendSnapshotV1.parse({
		...common(),
		kind: "email",
		conversation: null,
		email: {
			from: "sender@example.test",
			to: ["first@example.test", "second@example.test"],
			cc: ["copy@example.test"],
			bcc: ["hidden@example.test"],
			subject: "A café update",
			references: [],
		},
	});
	if (parsed.kind !== "email") throw new Error("Expected email fixture");
	return parsed;
}

export function slackSnapshot(): Extract<CurrentSendSnapshotV1, { kind: "chat" }> {
	const parsed = CurrentSendSnapshotV1.parse({
		...common(),
		kind: "chat",
		conversation: CONVERSATION_ID,
		chat: {
			channelId: "C1234567890",
			channelName: "project-room",
			channelType: "public",
			external: false,
			shared: false,
			memberCount: 5,
			broadcast: false,
		},
	});
	if (parsed.kind !== "chat") throw new Error("Expected chat fixture");
	return parsed;
}

export function attachment(
	bytes: Uint8Array,
	filename = "note.txt",
	contentType = "text/plain",
): SnapshotAttachment {
	return {
		filename,
		contentType,
		size: bytes.byteLength,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	};
}
