import { DraftAuthor } from "../../src/entities/draft.ts";
import { headersSha256 } from "../../src/hash.ts";
import { canonicalize } from "../../src/jcs.ts";
import { CHAT_CHANNEL_TYPES } from "../../src/normalized-change.ts";
import { SEND_METHODS } from "../../src/send-ticket.ts";
import {
	contentHash,
	fingerprint,
	SendSnapshotV1,
	SNAPSHOT_UNICODE_VERSION,
	sendWindow,
} from "../../src/snapshot.ts";
import type { VectorFile } from "../vectors.ts";

export const SNAPSHOT_ID = "01JAZ3W3B6Q8M2V0G5T9K4X7RC";
export const SNAPSHOT_IDS: Readonly<
	Record<
		| "outbox"
		| "account"
		| "draft"
		| "author"
		| "conversation"
		| "device"
		| "op"
		| "login"
		| "candidate",
		string
	>
> = {
	outbox: SNAPSHOT_ID,
	account: "01JAZ3W3B6Q8M2V0G5T9K4X7RD",
	draft: "01JAZ3W3B6Q8M2V0G5T9K4X7RE",
	author: "01JAZ3W3B6Q8M2V0G5T9K4X7RF",
	conversation: "01JAZ3W3B6Q8M2V0G5T9K4X7RG",
	device: "01JAZ3W3B6Q8M2V0G5T9K4X7RH",
	op: "01JAZ3W3B6Q8M2V0G5T9K4X7RJ",
	login: "01JAZ3W3B6Q8M2V0G5T9K4X7RK",
	candidate: "01JAZ3W3B6Q8M2V0G5T9K4X7RM",
} as const;
export const SNAPSHOT_IAT: number = Date.parse("2026-10-18T17:00:00.000Z");
type Zoned = {
	readonly epochMilliseconds: number;
	readonly offset: string;
	toPlainDateTime(): { toString(options: { smallestUnit: "minute" }): string };
};
const temporal = (
	globalThis as unknown as {
		Temporal: {
			Instant: {
				fromEpochMilliseconds(value: number): { toZonedDateTimeISO(zone: string): Zoned };
			};
			ZonedDateTime: {
				from(value: string, options: { offset: "reject"; disambiguation: "reject" }): Zoned;
			};
		};
	}
).Temporal;
export function scheduleAt(
	notBefore: number,
	zone = "UTC",
	latenessSec: 900 | 3600 | 14400 | 86400 = 900,
): import("../../src/snapshot.ts").ScheduleAt {
	if (notBefore % 60000 !== 0) throw Error("Whole-minute fixture required");
	const zoned = temporal.Instant.fromEpochMilliseconds(notBefore).toZonedDateTimeISO(zone);
	const localWallTime = zoned.toPlainDateTime().toString({ smallestUnit: "minute" }) + zoned.offset;
	if (
		temporal.ZonedDateTime.from(`${localWallTime}[${zone}]`, {
			offset: "reject",
			disambiguation: "reject",
		}).epochMilliseconds !== notBefore
	)
		throw Error("Scheduled fixture mismatch");
	return { kind: "at", notBefore, zone, localWallTime, latenessSec, holdIfNewInbound: true };
}
export function exampleSnapshot(): SendSnapshotV1 {
	return {
		v: 1,
		hub: "a".repeat(64),
		epoch: 1,
		outbox: SNAPSHOT_ID,
		account: SNAPSHOT_IDS.account,
		conversation: null,
		kind: "email",
		email: {
			from: "Owner@example.test",
			to: ["Recipient@example.test"],
			cc: [],
			bcc: [],
			subject: "A frozen reply",
			references: [],
		},
		body: { text: "Hello, café.\n", footer: "\nSent with DraftYak" },
		attachments: [],
		schedule: { kind: "now" },
		source: {
			draft: SNAPSHOT_IDS.draft,
			rev: 1,
			authors: [{ kind: "owner", id: SNAPSHOT_IDS.author }],
		},
	};
}
export function changed(path: readonly string[], value: unknown): unknown {
	const result = structuredClone(exampleSnapshot()) as unknown as Record<string, unknown>;
	let cursor = result;
	for (const name of path.slice(0, -1)) cursor = cursor[name] as Record<string, unknown>;
	const name = path.at(-1) as string;
	if (value === undefined) delete cursor[name];
	else cursor[name] = value;
	return result;
}
export interface SnapshotVector {
	readonly id: string;
	readonly snapshot: unknown;
	readonly iat: number;
	readonly error?: string;
	readonly canonicalHex?: string;
	readonly contentHash?: string;
	readonly fingerprint?: string;
	readonly window?: unknown;
}
function accepted(id: string, snapshot: unknown): SnapshotVector {
	const parsed = SendSnapshotV1.parse(snapshot);
	return {
		id,
		snapshot,
		iat: SNAPSHOT_IAT,
		canonicalHex: Buffer.from(canonicalize(parsed)).toString("hex"),
		contentHash: contentHash(parsed),
		fingerprint: fingerprint(parsed),
		window: sendWindow(parsed, SNAPSHOT_IAT),
	};
}
function rejected(id: string, snapshot: unknown): SnapshotVector {
	if (SendSnapshotV1.safeParse(snapshot).success)
		throw new Error(`snapshot vector ${id}: accepted`);
	return { id, snapshot, iat: SNAPSHOT_IAT, error: "SNAPSHOT_INVALID" };
}
export function snapshotVectors(): SnapshotVector[] {
	const base = exampleSnapshot();
	const reply = {
		...base,
		email: {
			...(base.kind === "email" ? base.email : {}),
			threadId: "thread-1",
			inReplyTo: "<message@example.test>",
			references: ["<prior@example.test>"],
		},
	};
	const chat = {
		...base,
		kind: "chat",
		conversation: SNAPSHOT_IDS.conversation,
		chat: {
			channelId: "C123",
			channelName: "engineering",
			channelType: "public",
			external: false,
			memberCount: 5,
			broadcast: false,
		},
	} as Record<string, unknown>;
	delete chat.email;
	const result = [
		accepted("new-email", base),
		accepted("email-reply", reply),
		accepted("chat-post", chat),
		accepted("chat-thread", {
			...chat,
			chat: { ...(chat.chat as object), threadTs: "1792000000.000001" },
		}),
		accepted("chat-broadcast", {
			...chat,
			chat: { ...(chat.chat as object), threadTs: "1792000000.000001", broadcast: true },
		}),
		accepted("chat-shared-false", {
			...chat,
			chat: { ...(chat.chat as object), shared: false },
		}),
		accepted("chat-shared-true", {
			...chat,
			chat: { ...(chat.chat as object), shared: true },
		}),
		accepted("idn-a-label", changed(["email", "to"], ["User@xn--bcher-kva.example"])),
		accepted("mixed-script-a-label", changed(["email", "to"], ["User@xn--pple-43d.example"])),
		accepted("unicode-local-part", changed(["email", "to"], ["Grüße@example.test"])),
		accepted("bcc-only", {
			...base,
			email: {
				...(base.kind === "email" ? base.email : {}),
				to: [],
				bcc: ["Recipient@example.test"],
			},
		}),
	];
	for (const latenessSec of [900, 3600, 14400, 86400] as const)
		result.push(
			accepted(`at-${latenessSec}`, {
				...base,
				schedule: scheduleAt(SNAPSHOT_IAT + 3_600_000, "America/Chicago", latenessSec),
			}),
		);
	for (const value of ["one", "onf"])
		result.push(
			accepted(`render-header-${value}`, {
				...base,
				render: {
					method: "POST",
					url: "https://hello.example/v1/messages",
					headersSha256: headersSha256([["x-test", value]]),
					bodySha256: "b".repeat(64),
				},
			}),
		);
	result.push(
		accepted("attachment", {
			...base,
			attachments: [
				{ filename: "notes.txt", contentType: "text/plain", size: 23, sha256: "c".repeat(64) },
			],
		}),
	);
	const bad: [string, string[], unknown][] = [
		["provider-final-lf", ["email", "threadId"], "thread\n"],
		["address-final-lf", ["email", "to"], ["a@example.test\n"]],
		["null-render", ["render"], null],
		["unknown-field", ["surprise"], true],
		["date-excluded", ["Date"], "today"],
		["message-id-excluded", ["Message-ID"], "<id@example.test>"],
		["boundary-excluded", ["boundary"], "x"],
		["nfd-body", ["body", "text"], "cafe\u0301"],
		["cr-body", ["body", "text"], "a\r\nb"],
		["nfd-footer", ["body", "footer"], "e\u0301"],
		["cr-subject", ["email", "subject"], "a\rb"],
		["lf-subject", ["email", "subject"], "a\nb"],
		["cr-address", ["email", "to"], ["a\r@example.test"]],
		["lf-address", ["email", "from"], "a\n@example.test"],
		["u-label", ["email", "to"], ["a@bücher.example"]],
		["uppercase-domain", ["email", "to"], ["a@EXAMPLE.test"]],
		["trailing-dot", ["email", "to"], ["a@example.test."]],
		["fraction", ["epoch"], 1.5],
		["unsafe-integer", ["epoch"], 2 ** 53],
		["missing-conversation", ["conversation"], undefined],
		["optional-null", ["email", "threadId"], null],
		["unknown-schedule", ["schedule"], { kind: "later" }],
		["now-extra-field", ["schedule"], { kind: "now", notBefore: 0 }],
		["unknown-body-field", ["body", "html"], "<b>x</b>"],
		["wrong-channel-field", ["chat"], null],
		["unknown-kind", ["kind"], "sms"],
		["empty-authors", ["source", "authors"], []],
	];
	for (const [id, path, value] of bad) result.push(rejected(id, changed(path, value)));
	const scheduled = scheduleAt(SNAPSHOT_IAT);
	result.push(
		accepted("shared-zone-alias", { ...base, schedule: scheduleAt(SNAPSHOT_IAT, "EST") }),
		accepted("wall-leap-2028", {
			...base,
			schedule: scheduleAt(Date.parse("2028-02-29T00:00:00.000Z")),
		}),
	);
	// Syntax-only: this 64-character zone is not claimed to exist in tzdata.
	result.push(
		accepted("shared-zone-64-syntax-only", {
			...base,
			schedule: { ...scheduled, zone: `Etc/${"x".repeat(60)}` },
		}),
	);

	for (const [id, zone] of [
		["zone-65", `Etc/${"x".repeat(61)}`],
		["zone-final-lf", "UTC\n"],
	] as const)
		result.push(rejected(id, { ...base, schedule: { ...scheduled, zone } }));

	const invalid: [string, string[], unknown][] = [
		["epoch-negative", ["epoch"], -1],
		["version-two", ["v"], 2],
		["ulid-lowercase", ["outbox"], SNAPSHOT_ID.toLowerCase()],
		["empty-recipient", ["email", "to"], []],
		["subject-2001", ["email", "subject"], "x".repeat(2001)],
		["body-100001", ["body", "text"], "x".repeat(100001)],
		["footer-10001", ["body", "footer"], "x".repeat(10001)],
		[
			"authors-101",
			["source", "authors"],
			Array.from({ length: 101 }, () => base.source.authors[0]),
		],
		["references-101", ["email", "references"], Array.from({ length: 101 }, () => "ref")],
	];
	for (const name of ["to", "cc", "bcc"])
		invalid.push([
			`${name}-101`,
			["email", name],
			Array.from({ length: 101 }, () => "a@example.test"),
		]);
	for (const path of [
		["account"],
		["conversation"],
		["source", "draft"],
		["source", "authors", "0", "id"],
	])
		invalid.push([`ulid-${path.join("-")}`, path, SNAPSHOT_ID.toLowerCase()]);
	invalid.push(
		["bad-hub", ["hub"], "X".repeat(64)],
		["source-revision-zero", ["source", "rev"], 0],
		["author-kind", ["source", "authors", "0", "kind"], "unregistered-test-kind"],
	);
	for (const [id, path, value] of invalid) result.push(rejected(id, changed(path, value)));
	for (const localWallTime of [
		"2027-02-29T00:00+00:00",
		"2028-04-31T00:00+00:00",
		"2028-02-30T00:00+00:00",
		"2100-02-29T00:00+00:00",
		"2028-13-01T00:00+00:00",
		"2028-01-01T24:00+00:00",
		"2028-01-01T00:00-00:00",
		"2028-01-01 00:00+00:00",
	])
		result.push(
			rejected(`wall-${localWallTime}`, { ...base, schedule: { ...scheduled, localWallTime } }),
		);
	for (const zone of ["+05:00", "../etc"])
		result.push(rejected(`zone-${zone}`, { ...base, schedule: { ...scheduled, zone } }));
	result.push(
		rejected("lateness-1800", { ...base, schedule: { ...scheduled, latenessSec: 1800 } }),
		rejected("not-before-unsafe", { ...base, schedule: { ...scheduled, notBefore: 2 ** 53 } }),
	);
	const render = {
		method: "POST",
		url: "https://hello.example/v1/messages",
		headersSha256: "b".repeat(64),
		bodySha256: "c".repeat(64),
	};
	for (const [id, url] of Object.entries({
		http: "http://hello.example/v1",
		port: "https://hello.example:443/v1",
		"port-65536": "https://hello.example:65536/v1",
		upper: "https://HELLO.example/v1",
		dot: "https://hello.example/a/../b",
		escaped: "https://hello.example/%2e",
		"escaped-unreserved": "https://hello.example/%2E",
		"escaped-lowercase-hex": "https://hello.example/%3a",
		query: "https://hello.example/v1?",
		fragment: "https://hello.example/v1#x",
		userinfo: "https://user@hello.example/v1",
		quote: "https://hello.example/v1?q='",
	}))
		result.push(rejected(`render-${id}`, { ...base, render: { ...render, url } }));
	const urlPrefix = "https://hello.example/";
	result.push(
		accepted("render-port-65535", {
			...base,
			render: { ...render, url: "https://hello.example:65535/v1" },
		}),
		accepted("render-url-8192", {
			...base,
			render: { ...render, url: urlPrefix + "x".repeat(8192 - urlPrefix.length) },
		}),
		rejected("render-url-8193", {
			...base,
			render: { ...render, url: urlPrefix + "x".repeat(8193 - urlPrefix.length) },
		}),
	);
	for (const method of SEND_METHODS)
		result.push(accepted(`render-method-${method}`, { ...base, render: { ...render, method } }));
	for (const [field, value] of [
		["headersSha256", "X".repeat(64)],
		["bodySha256", "c".repeat(63)],
	] as const)
		result.push(
			rejected(`render-${field}-invalid`, { ...base, render: { ...render, [field]: value } }),
		);
	result.push(
		accepted("render-query-dot-data", {
			...base,
			render: { ...render, url: "https://hello.example/v1?q=/../" },
		}),
	);
	result.push(rejected("render-get", { ...base, render: { ...render, method: "GET" } }));
	result.push(
		rejected("broadcast-no-thread", {
			...chat,
			chat: { ...(chat.chat as object), broadcast: true },
		}),
	);
	result.push(rejected("chat-null-conversation", { ...chat, conversation: null }));
	result.push(
		rejected("email-with-chat-block", { ...base, chat: chat.chat }),
		rejected("chat-with-email-block", { ...chat, email: base.kind === "email" ? base.email : {} }),
	);
	for (const channelType of CHAT_CHANNEL_TYPES)
		result.push(
			accepted(`channel-type-${channelType}`, {
				...chat,
				chat: { ...(chat.chat as object), channelType },
			}),
		);
	for (const kind of DraftAuthor.shape.kind.options)
		result.push(
			accepted(
				`author-kind-${kind}`,
				changed(["source", "authors"], [{ kind, id: SNAPSHOT_IDS.author }]),
			),
		);
	result.push(
		rejected("channel-name-257", {
			...chat,
			chat: { ...(chat.chat as object), channelName: "x".repeat(257) },
		}),
	);
	const attachment = { filename: "x", contentType: "text/plain", size: 0, sha256: "c".repeat(64) };
	result.push(
		rejected("attachments-101", {
			...base,
			attachments: Array.from({ length: 101 }, () => attachment),
		}),
	);
	result.push(
		rejected("media-parameter", {
			...base,
			attachments: [{ ...attachment, contentType: "text/plain;charset=utf-8" }],
		}),
	);
	result.push(
		rejected("filename-empty", { ...base, attachments: [{ ...attachment, filename: "" }] }),
	);
	for (const [id, change] of [
		["attachment-filename-257", { filename: "x".repeat(257) }],
		["attachment-size-negative", { size: -1 }],
		["attachment-size-unsafe", { size: 2 ** 53 }],
		["attachment-hash", { sha256: "X".repeat(64) }],
	] as [string, object][])
		result.push(rejected(id, { ...base, attachments: [{ ...attachment, ...change }] }));
	result.push(
		accepted("attachment-filename-256", {
			...base,
			attachments: [{ ...attachment, filename: "x".repeat(256) }],
		}),
	);
	result.push(
		rejected("chat-channel-type", {
			...chat,
			chat: { ...(chat.chat as object), channelType: "unregistered-test-type" },
		}),
	);
	result.push(
		rejected("chat-member-count-negative", {
			...chat,
			chat: { ...(chat.chat as object), memberCount: -1 },
		}),
		rejected("chat-member-count-unsafe", {
			...chat,
			chat: { ...(chat.chat as object), memberCount: 2 ** 53 },
		}),
		accepted("chat-member-count-max-safe", {
			...chat,
			chat: { ...(chat.chat as object), memberCount: Number.MAX_SAFE_INTEGER },
		}),
	);
	result.push(
		rejected("chat-channel-id-empty", {
			...chat,
			chat: { ...(chat.chat as object), channelId: "" },
		}),
	);
	result.push(accepted("epoch-zero", { ...base, epoch: 0 }));
	for (const [id, path, value] of [
		["subject-2000", ["email", "subject"], "x".repeat(2000)],
		["subject-2000-astral", ["email", "subject"], "\u{1f600}".repeat(2000)],
		["body-100000", ["body", "text"], "x".repeat(100000)],
		["body-100000-multibyte", ["body", "text"], "\u00e9".repeat(100000)],
		["footer-10000", ["body", "footer"], "x".repeat(10000)],
		[
			"authors-100",
			["source", "authors"],
			Array.from({ length: 100 }, () => base.source.authors[0]),
		],
		["references-100", ["email", "references"], Array.from({ length: 100 }, () => "ref")],
	] as [string, string[], unknown][])
		result.push(accepted(id, changed(path, value)));
	result.push(
		rejected("subject-2001-astral", changed(["email", "subject"], "\u{1f600}".repeat(2001))),
	);
	result.push(
		rejected("body-100001-multibyte", changed(["body", "text"], "\u00e9".repeat(100001))),
	);
	const addressSuffix = "@example.test";
	result.push(
		accepted(
			"address-254",
			changed(["email", "to"], ["x".repeat(254 - addressSuffix.length) + addressSuffix]),
		),
		rejected(
			"address-255",
			changed(["email", "to"], ["x".repeat(255 - addressSuffix.length) + addressSuffix]),
		),
		accepted("address-label-63", changed(["email", "to"], [`a@${"x".repeat(63)}.test`])),
		rejected("address-label-64", changed(["email", "to"], [`a@${"x".repeat(64)}.test`])),
		rejected("address-single-label", changed(["email", "to"], ["a@localhost"])),
	);
	for (const name of ["to", "cc", "bcc"])
		result.push(
			accepted(
				`${name}-100`,
				changed(
					["email", name],
					Array.from({ length: 100 }, () => "a@example.test"),
				),
			),
		);
	result.push(
		accepted("attachments-100", {
			...base,
			attachments: Array.from({ length: 100 }, () => attachment),
		}),
	);
	result.push(
		accepted("channel-name-256", {
			...chat,
			chat: { ...(chat.chat as object), channelName: "x".repeat(256) },
		}),
	);
	for (const [id, shared] of [
		["null", null],
		["string", "false"],
		["number", 0],
		["array", []],
		["object", {}],
	] as const)
		result.push(
			rejected(`chat-shared-${id}`, { ...chat, chat: { ...(chat.chat as object), shared } }),
		);
	return result;
}
export function generate(): VectorFile[] {
	return [
		{
			path: "snapshot/snapshots.json",
			content: {
				format: "draftyak.vectors.snapshot.v1",
				description:
					"Frozen email/chat snapshots, canonical bytes, hashes, human fingerprints and send windows. Unicode normalization is checked without changing text.",
				unicodeVersion: SNAPSHOT_UNICODE_VERSION,
				cases: snapshotVectors(),
			},
		},
	];
}
