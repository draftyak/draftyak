import { createECDH, createPublicKey } from "node:crypto";
import { SendReview } from "../../../src/device-api.ts";
import { type Flag, flagsHash } from "../../../src/flags.ts";
import { jcsSha256 } from "../../../src/hash.ts";
import { canonicalize } from "../../../src/jcs.ts";
import { contentHash, SendSnapshotV1, sendWindow } from "../../../src/snapshot.ts";
import { requiredAckCodes } from "../../../src/statements.ts";
import type { VectorFile } from "../../vectors.ts";
import { exampleSnapshot, SNAPSHOT_IAT, SNAPSHOT_IDS, scheduleAt } from "../snapshot.ts";
import { statementBase } from "../statements/shared.ts";
import { adminKinds, errors, presets, routes } from "./catalogue.ts";

export interface ApiCase extends Record<string, unknown> {
	id: string;
	action: string;
	valid: boolean;
}
type ObjectValue = Record<string, unknown>;
const id = SNAPSHOT_IDS;
const clone = <T>(value: T): T => structuredClone(value);
export const encoded = (value: unknown): string =>
	Buffer.from(canonicalize(value)).toString("base64url");
// Deterministic public points used only as fixture identities; no signing is performed here.
function publicPoint(scalar: number): string {
	const curve = createECDH("prime256v1");
	curve.setPrivateKey(Buffer.from([scalar]));
	const point = curve.getPublicKey();
	return createPublicKey({
		key: {
			kty: "EC",
			crv: "P-256",
			x: point.subarray(1, 33).toString("base64url"),
			y: point.subarray(33).toString("base64url"),
		},
		format: "jwk",
	})
		.export({ type: "spki", format: "der" })
		.toString("base64url");
}
export const publicKey: string = publicPoint(1);
const otherKey = publicPoint(2);
// A pairing SAS with leading zeros, as the hub shows it for the fixture's candidate.
export const reviewSas = "004917";
export function sendFixture(scheduled = false): ObjectValue {
	return sendFixtureOf(
		{
			...exampleSnapshot(),
			...(scheduled ? { schedule: scheduleAt(SNAPSHOT_IAT + 60000) } : {}),
		},
		[
			{ code: "NEW_RECIPIENT", severity: "ack" },
			{ code: "EXTERNAL_LINK", severity: "ack" },
		],
	);
}
// Between them, every optional snapshot member, attachments and flags with details. Each review
// parses to itself, so both languages check every member as written.
function richSendFixture(kind: "chat" | "email-reply"): ObjectValue {
	const base = exampleSnapshot();
	if (base.kind !== "email") throw Error("the example snapshot is an email");
	const { email, ...common } = base;
	const attachments = [
		{ filename: "notes.txt", contentType: "text/plain", size: 23, sha256: "c".repeat(64) },
		{ filename: "photo.jpg", contentType: "image/jpeg", size: 48213, sha256: "d".repeat(64) },
	];
	const fixture =
		kind === "chat"
			? sendFixtureOf(
					{
						...common,
						kind: "chat",
						conversation: id.conversation,
						chat: {
							channelId: "C123",
							channelName: "engineering",
							channelType: "private",
							external: true,
							shared: true,
							memberCount: 12,
							threadTs: "1792000000.000001",
							broadcast: true,
						},
						attachments,
						schedule: scheduleAt(SNAPSHOT_IAT + 3_600_000, "America/Chicago", 3600),
					},
					[
						{ code: "MASS_MENTION", severity: "ack", detail: "@channel" },
						{ code: "EXTERNAL_LINK", severity: "ack", detail: "example.net" },
						{ code: "TOOL_INSTRUCTIONS", severity: "advisory", detail: "kb.lookup" },
						{ code: "AGENT_AUTHORED", severity: "ack" },
					],
				)
			: sendFixtureOf(
					{
						...common,
						email: {
							...email,
							to: [...email.to, "Second@example.test"],
							cc: ["Copy@example.test"],
							bcc: ["Blind@example.test"],
							subject: "Re: A frozen reply",
							threadId: "thread-1",
							inReplyTo: "<message@example.test>",
							references: ["<first@example.test>", "<message@example.test>"],
						},
						render: {
							method: "POST",
							url: "https://hello.example/v1/messages",
							headersSha256: "b".repeat(64),
							bodySha256: "c".repeat(64),
						},
						attachments,
					},
					[
						{ code: "NEW_RECIPIENT", severity: "ack", detail: "Second@example.test" },
						{ code: "NEW_RECIPIENT", severity: "ack", detail: "Copy@example.test" },
						{ code: "ATTACHMENT_ADDED_BY_AGENT", severity: "ack", detail: "photo.jpg" },
						{ code: "TOOL_CONTEXT_USED", severity: "info", detail: "calendar.freebusy" },
						{ code: "SUSPECTED_INSTRUCTIONS", severity: "advisory" },
					],
				);
	if (canonicalize(SendReview.parse(fixture.review)) !== canonicalize(fixture.review))
		throw Error(`the ${kind} review doesn't parse to itself`);
	return fixture;
}
function sendFixtureOf(snapshot: SendSnapshotV1, flags: readonly Flag[]): ObjectValue {
	const review = {
		id: id.outbox,
		snapshot,
		contentHash: contentHash(snapshot),
		flags,
		flagsHash: flagsHash(flags),
		state: "PENDING_APPROVAL",
		stateReason: null,
		requiredUsers: [id.author],
		expiresAt: SNAPSHOT_IAT + 120000,
	};
	const request = {
		kind: "approval.send.v1",
		id: id.outbox,
		flagsAcked: requiredAckCodes(flags),
	};
	const window = sendWindow(snapshot, SNAPSHOT_IAT);
	const statement = {
		...statementBase(),
		outbox: id.outbox,
		contentHash: review.contentHash,
		flagsHash: review.flagsHash,
		flagsAcked: request.flagsAcked,
		notBefore: window.notBefore ?? null,
		deliverBy: window.deliverBy,
	};
	return {
		challenge: { kind: request.kind, id: request.id, statement: encoded(statement) },
		review,
		request,
		context: { hub: snapshot.hub, device: id.device },
	};
}
export function pairFixture(preset: keyof typeof presets = "desktop"): ObjectValue {
	const subject = {
		candidate: id.candidate,
		name: "Test device",
		role: "device",
		transportSpkiSha256: "b".repeat(64),
		signingKey: publicKey,
		preset,
		capabilities: presets[preset],
		sas: reviewSas,
	};
	const review = {
		id: id.op,
		kind: "pair-confirm",
		subject,
		digest: jcsSha256(subject),
		expiresAt: SNAPSHOT_IAT + 120000,
		remainingMs: 120000,
	};
	const request = { kind: "pair-confirm.v1", id: id.op };
	const statement = {
		...statementBase(),
		candidate: subject.candidate,
		role: subject.role,
		transportSpkiSha256: subject.transportSpkiSha256,
		signingKey: subject.signingKey,
		capabilities: subject.capabilities,
	};
	return {
		challenge: { kind: request.kind, id: request.id, statement: encoded(statement) },
		review,
		request,
		context: { hub: statement.hub, device: statement.device },
	};
}
export function agentSessionFixture(
	choice: "session" | "tool-call" | "resource-read" = "session",
	toolClass: "read" | "draft" | "organize" = "read",
): ObjectValue {
	const authorization =
		choice === "session"
			? { kind: "session", durationMs: 900_000 }
			: {
					kind: "call",
					method: choice === "tool-call" ? "tools/call" : "resources/read",
					paramsDigest: "c".repeat(64),
					validForMs: 600_000,
					singleUse: true,
					target:
						choice === "resource-read"
							? `draftyak://message/${id.outbox}`
							: { read: "accounts_list", draft: "draft_create", organize: "conversation_archive" }[
									toolClass
								],
				};
	const subject = {
		principal: { kind: "grant", id: id.author },
		account: id.account,
		toolClass,
		authorization,
	};
	const review = {
		id: id.op,
		kind: "agent-session",
		subject,
		digest: jcsSha256(subject),
		expiresAt: SNAPSHOT_IAT + 120000,
		remainingMs: 120000,
	};
	const request = { kind: "agent-session.v1", id: review.id };
	const { target: _, ...signedAuthorization } = authorization;
	const statement = {
		...statementBase(),
		session: review.id,
		principal: subject.principal,
		account: subject.account,
		toolClass,
		authorization: signedAuthorization,
	};
	return {
		challenge: { kind: request.kind, id: request.id, statement: encoded(statement) },
		review,
		request,
		context: { hub: statement.hub, device: statement.device },
	};
}
const member = (value: ObjectValue, key: string): ObjectValue => value[key] as ObjectValue;
function change(value: unknown, path: string, replacement: unknown): unknown {
	const copy = clone(value) as ObjectValue;
	const parts = path.split(".");
	let cursor = copy;
	for (const name of parts.slice(0, -1)) cursor = cursor[name] as ObjectValue;
	if (replacement === undefined) delete cursor[parts.at(-1) as string];
	else cursor[parts.at(-1) as string] = replacement;
	return copy;
}
function changeStatement(fixture: ObjectValue, field: string, replacement: unknown): ObjectValue {
	const copy = clone(fixture);
	const statement = JSON.parse(
		Buffer.from(member(copy, "challenge").statement as string, "base64url").toString("utf8"),
	);
	member(copy, "challenge").statement = encoded(change(statement, field, replacement));
	return copy;
}
// Each statement's own members in declared order, the array a by-position decoder would read.
const declaredMembers: Record<string, readonly string[]> = {
	"approval.send.v1": [
		"outbox",
		"contentHash",
		"flagsHash",
		"flagsAcked",
		"notBefore",
		"deliverBy",
	],
	"pair-confirm.v1": ["candidate", "role", "transportSpkiSha256", "signingKey", "capabilities"],
	"login.v1": ["login", "digest"],
	"agent-session.v1": ["session", "principal", "account", "toolClass", "authorization"],
	"admin.v1": ["op", "kind", "digest"],
};
function positional(kind: string, statement: unknown): string {
	const value = JSON.parse(Buffer.from(statement as string, "base64url").toString("utf8"));
	const names = [...Object.keys(statementBase()), ...(declaredMembers[kind] ?? [])];
	if (
		names.length !== Object.keys(value).length ||
		!names.every((name) => Object.hasOwn(value, name))
	)
		throw Error(`positional ${kind} statement`);
	return encoded(names.map((name) => value[name]));
}
// Decimal suffixes avoid letters outside Crockford's alphabet and remain distinct.
const ids = Array.from(
	{ length: 101 },
	(_, n) => `01JAZ3W3B6Q8M2V0G5T9K${n.toString().padStart(5, "0")}`,
);
// The IDs a request of each admin kind with a review subject names: the account or device the
// subject describes, or none for Back up now. Every other admin kind takes up to 100.
const requestIds: Readonly<Record<string, number>> = {
	"account.disconnect": 1,
	"account.mode-full": 1,
	"security.device-capabilities": 1,
	"data.backup": 0,
};
export function apiCases(): ApiCase[] {
	const cases: ApiCase[] = [];
	const add = (name: string, action: string, fields: ObjectValue, valid = false): void => {
		cases.push({ id: name, action, ...fields, valid });
	};
	const schema = (name: string, value: unknown, valid: boolean, label = "base"): void =>
		add(`${name}-${label}`, "schema", { schema: name, value }, valid);
	const pending = {
		deviceId: id.device,
		epoch: 0,
		confirmed: false,
		capabilities: [],
		testUpstreams: false,
	};
	const confirmed = {
		...pending,
		epoch: 1,
		confirmed: true,
		capabilities: presets.desktop,
		testUpstreams: true,
	};
	const send = sendFixture();
	const pair = pairFixture();
	const sendChallenge = member(send, "challenge"),
		pairChallenge = member(pair, "challenge");
	const envelope = {
		statement: sendChallenge.statement,
		signature: Buffer.alloc(64).toString("base64url"),
		pin: "123456",
	};
	const pairEnvelope = { ...envelope, statement: pairChallenge.statement };
	const loginEnvelope = {
		...envelope,
		statement: encoded({ ...statementBase(), login: id.login, digest: "c".repeat(64) }),
	};
	const adminEnvelope = {
		...envelope,
		statement: encoded({
			...statementBase(),
			op: id.op,
			kind: "data.export",
			digest: "c".repeat(64),
		}),
	};
	const fixtures: Record<string, unknown> = {
		DeviceStatus: pending,
		BootstrapRequest: { pin: "123456" },
		BootstrapStatus: confirmed,
		PairingWindowRequest: { role: "device", pin: "123456" },
		PairingWindow: { pairingCode: "draftyak-pair:v1:test" },
		OperationRequest: { kind: "pair-confirm", ids: [id.candidate], preset: "desktop" },
		OperationCreated: { id: id.op },
		SyncPause: { paused: false },
		Accepted: { kind: "approval.send.v1", id: id.outbox },
		SendReview: send.review,
		PairConfirmSubject: member(pair, "review").subject,
		OperationReview: pair.review,
		ChallengeRequest: send.request,
		Challenge: send.challenge,
		SignedEnvelope: envelope,
		EventsRequest: { after: null },
		EventFrame: { type: "ready", cursor: "" },
		ApiError: { code: "INVALID_REQUEST" },
	};
	for (const [name, value] of Object.entries(fixtures)) {
		schema(name, value, true);
		schema(name, { ...(value as ObjectValue), unexpected: true }, false, "unknown-member");
	}
	for (const [field, value] of [
		["testUpstreams", undefined],
		["testUpstreams", "true"],
		["confirmed", true],
		["capabilities", ["read"]],
	] as const)
		schema(
			"DeviceStatus",
			change(pending, field, value),
			false,
			`pending-${field}-${String(value)}`,
		);
	for (const [label, capabilities] of [
		["empty", []],
		["reordered", ["draft", "read"]],
		["duplicate", ["read", "read"]],
		["host", ["host:sms"]],
		["object-form", [{ read: null }, "draft"]],
	] as const)
		schema("DeviceStatus", { ...confirmed, capabilities }, false, label);
	schema("DeviceStatus", confirmed, true, "confirmed");
	for (const testUpstreams of [false, true])
		schema(
			"DeviceStatus",
			{ ...confirmed, testUpstreams },
			true,
			`test-upstreams-${testUpstreams}`,
		);
	for (const [label, value] of [
		["pending", pending],
		["mobile", { ...confirmed, capabilities: presets.mobile }],
		["extra", { ...confirmed, statement: sendChallenge.statement }],
	] as const)
		schema("BootstrapStatus", value, false, label);
	for (const schemaName of ["BootstrapRequest", "PairingWindowRequest", "SignedEnvelope"]) {
		for (const length of [5, 6, 64, 65])
			schema(
				schemaName,
				{ ...(fixtures[schemaName] as ObjectValue), pin: "1".repeat(length) },
				length === 6 || length === 64,
				`pin-${length}`,
			);
		for (const pin of [
			"１２３４５６",
			"12345x",
			...["\r", "\n", "\u2028", "\u2029"].map((suffix) => `123456${suffix}`),
		])
			schema(
				schemaName,
				{ ...(fixtures[schemaName] as ObjectValue), pin },
				false,
				`pin-invalid-${JSON.stringify(pin)}`,
			);
	}
	schema(
		"BootstrapRequest",
		{ pin: "123456", statement: sendChallenge.statement },
		false,
		"statement",
	);
	for (const paused of [true, false]) schema("SyncPause", { paused }, true, `boolean-${paused}`);
	for (const value of [{}, { paused: "false" }, { paused: 0 }, { paused: false, extra: 1 }])
		schema("SyncPause", value, false, `invalid-${JSON.stringify(value)}`);
	for (const role of ["host:sms", "unknown"])
		schema("PairingWindowRequest", { role, pin: "123456" }, false, role);
	for (const length of [1000, 1001])
		schema(
			"PairingWindow",
			{ pairingCode: `draftyak-pair:v1:${"x".repeat(length - "draftyak-pair:v1:".length)}` },
			length === 1000,
			`code-${length}`,
		);
	schema("PairingWindow", { pairingCode: "other:v1:test" }, false, "prefix");
	schema(
		"PairingWindow",
		{ pairingCode: "other:draftyak-pair:v1:test" },
		false,
		"prefix-not-at-start",
	);
	// Only at the very start and in its own case: an m or an i flag on the pattern would pass these.
	schema(
		"PairingWindow",
		{ pairingCode: "other\ndraftyak-pair:v1:test" },
		false,
		"prefix-after-line-break",
	);
	schema("PairingWindow", { pairingCode: "DRAFTYAK-PAIR:V1:test" }, false, "prefix-upper-case");
	for (const kind of adminKinds)
		schema(
			"OperationRequest",
			{ kind, ids: ids.slice(0, 100) },
			!Object.hasOwn(requestIds, kind),
			kind,
		);
	for (const [kind, count] of Object.entries(requestIds))
		for (const length of [0, 1, 2])
			schema(
				"OperationRequest",
				{ kind, ids: ids.slice(0, length) },
				length === count,
				`${kind}-count-${length}`,
			);
	schema("OperationRequest", { kind: "data.export", ids: [] }, true, "empty-admin-ids");
	for (const kind of ["login", "consent", "agent-session", "unknown"])
		schema("OperationRequest", { kind, ids: [id.op] }, false, `kind-${kind}`);
	for (const [label, list] of [
		["101", ids],
		["duplicate", [id.op, id.op]],
	] as const)
		schema("OperationRequest", { kind: "data.export", ids: list }, false, label);
	for (const list of [[], [id.candidate, id.op]])
		schema(
			"OperationRequest",
			{ kind: "pair-confirm", ids: list, preset: "desktop" },
			false,
			`pair-count-${list.length}`,
		);
	schema(
		"OperationRequest",
		{ kind: "data.export", ids: [id.op], preset: "desktop" },
		false,
		"preset-wrong-kind",
	);
	schema(
		"OperationRequest",
		{ kind: "pair-confirm", ids: [id.candidate], preset: "unknown" },
		false,
		"unknown-preset",
	);
	schema(
		"OperationRequest",
		{ kind: "pair-confirm", ids: [id.candidate], preset: { desktop: null } },
		false,
		"object-form-preset",
	);
	for (const preset of ["desktop", "mobile", "cli"] as const) {
		const fixture = pairFixture(preset);
		schema("PairConfirmSubject", member(fixture, "review").subject, true, preset);
		add(`pair-challenge-${preset}`, "challenge", fixture, true);
	}
	for (const [field, replacement] of [
		["capabilities", ["read"]],
		["role", "host:sms"],
		["role", "unknown"],
		["preset", "unknown"],
	] as const)
		schema(
			"PairConfirmSubject",
			change(fixtures.PairConfirmSubject, field, replacement),
			false,
			`${field}-${String(replacement)}`,
		);
	schema(
		"PairConfirmSubject",
		change(fixtures.PairConfirmSubject, "preset", { desktop: null }),
		false,
		"object-form-preset",
	);
	for (const [label, sas] of [
		["missing", undefined],
		["five-digits", "04917"],
		["seven-digits", "0049170"],
		["number", 4917],
		["letter", "00491x"],
		["fullwidth-digits", "００４９１７"],
		...["\r", "\n", "\u2028", "\u2029"].flatMap((end) => [
			[`suffix-${JSON.stringify(end)}`, `${reviewSas}${end}`],
			[`last-${JSON.stringify(end)}`, `${reviewSas.slice(0, 5)}${end}`],
		]),
	] as const)
		schema(
			"PairConfirmSubject",
			change(fixtures.PairConfirmSubject, "sas", sas),
			false,
			`sas-${label}`,
		);
	schema(
		"PairConfirmSubject",
		change(fixtures.PairConfirmSubject, "sas", "000000"),
		true,
		"sas-zeros",
	);
	const otherSas = change(pair.review, "subject.sas", "000000") as ObjectValue;
	schema("OperationReview", otherSas, false, "sas-not-digested");
	schema(
		"OperationReview",
		{ ...otherSas, digest: jcsSha256(otherSas.subject) },
		true,
		"sas-digested",
	);
	// The hub's SAS reaches a device only in the pair-confirm review's subject.
	for (const [name, value] of Object.entries(fixtures))
		if (name !== "PairConfirmSubject")
			schema(name, { ...(value as ObjectValue), sas: reviewSas }, false, "sas-member");
	for (const [field, replacement] of [
		["contentHash", "f".repeat(64)],
		["flagsHash", "f".repeat(64)],
	] as const)
		schema("SendReview", change(send.review, field, replacement), false, field);
	// The hashes stay those of the object forms, so only the form refuses each.
	const reviewFlags = member(send, "review").flags as ObjectValue[];
	for (const [label, path, replacement] of [
		["positional-flags", "flags", reviewFlags.map((flag) => [flag.code, flag.severity])],
		[
			"object-form-flag-code",
			"flags",
			reviewFlags.map((flag) => ({ ...flag, code: { [flag.code as string]: null } })),
		],
		[
			"positional-snapshot-body",
			"snapshot.body",
			Object.values(member(member(member(send, "review"), "snapshot"), "body")),
		],
		["object-form-snapshot-kind", "snapshot.kind", { email: null }],
	] as const)
		schema("SendReview", change(send.review, path, replacement), false, label);
	schema("SendReview", change(send.review, "requiredUsers", ids), true, "101-required-users");
	schema("OperationReview", change(pair.review, "digest", "f".repeat(64)), false, "digest");
	schema("OperationReview", change(pair.review, "remainingMs", 120001), false, "lifetime-120001");
	schema("OperationReview", change(pair.review, "remainingMs", 0), true, "lifetime-zero");
	for (const kind of ["login.v1", "consent.v1", "unknown.v1"])
		schema("ChallengeRequest", { kind, id: id.op }, false, `deferred-${kind}`);
	for (const [label, request] of [
		["missing-acks", { kind: "approval.send.v1", id: id.outbox }],
		["code", { ...member(send, "request"), code: "123456" }],
		["reordered", { ...member(send, "request"), flagsAcked: ["NEW_RECIPIENT", "EXTERNAL_LINK"] }],
		["duplicate", { ...member(send, "request"), flagsAcked: ["NEW_RECIPIENT", "NEW_RECIPIENT"] }],
		[
			"object-form-acks",
			{
				...member(send, "request"),
				flagsAcked: [{ EXTERNAL_LINK: null }, { NEW_RECIPIENT: null }],
			},
		],
	] as const)
		schema("ChallengeRequest", request, false, label);
	schema("ChallengeRequest", pair.request, true, "pair-confirm");
	schema(
		"ChallengeRequest",
		{ ...member(pair, "request"), flagsAcked: [] },
		false,
		"pair-send-member",
	);
	for (const [label, statement] of [
		["padding", `${sendChallenge.statement}=`],
		["bad-alphabet", "+/"],
		[
			"noncanonical-jcs",
			Buffer.from(
				`${Buffer.from(sendChallenge.statement as string, "base64url").toString()} `,
			).toString("base64url"),
		],
		["16385-decoded", Buffer.alloc(16385, 32).toString("base64url")],
		["wrong-type", pairChallenge.statement],
	] as const) {
		schema("Challenge", { ...sendChallenge, statement }, false, label);
		schema("SignedEnvelope", { ...envelope, statement }, label === "wrong-type", label);
	}
	// Each typed statement re-sent as an array: on its signed route, as a challenge member and in a
	// challenge whose other members all match it.
	for (const [route, kind, statement] of [
		["send-approval", "approval.send.v1", sendChallenge.statement],
		["pair-confirmation", "pair-confirm.v1", pairChallenge.statement],
		["login", "login.v1", loginEnvelope.statement],
		["agent-session", "agent-session.v1", member(agentSessionFixture(), "challenge").statement],
		["admin", "admin.v1", adminEnvelope.statement],
	] as const) {
		const array = positional(kind, statement);
		add(`request-${route}-positional-statement`, "request", {
			route,
			value: { ...envelope, statement: array },
		});
		if (kind !== "login.v1")
			schema("Challenge", { kind, id: id.op, statement: array }, false, `positional-${kind}`);
	}
	for (const [name, kind, fixture] of [
		["send", "approval.send.v1", send],
		["pair", "pair-confirm.v1", pair],
		["agent", "agent-session.v1", agentSessionFixture()],
	] as const) {
		const copy = clone(fixture);
		member(copy, "challenge").statement = positional(kind, member(copy, "challenge").statement);
		add(`${name}-challenge-positional-statement`, "challenge", copy);
	}
	for (const length of [63, 64, 65])
		schema(
			"SignedEnvelope",
			{ ...envelope, signature: Buffer.alloc(length).toString("base64url") },
			length === 64,
			`signature-${length}`,
		);
	for (const signature of [`${envelope.signature}=`, "+/", `${"A".repeat(85)}B`])
		schema(
			"SignedEnvelope",
			{ ...envelope, signature },
			false,
			`signature-invalid-${signature.length}`,
		);
	for (const length of [0, 16383, 16384, 16385])
		add(`statement-length-${length}`, "length", { length }, length <= 16384);
	add("send-challenge-matching", "challenge", send, true);
	add("send-challenge-scheduled", "challenge", sendFixture(true), true);
	for (const kind of ["chat", "email-reply"] as const) {
		const rich = richSendFixture(kind);
		schema("SendReview", rich.review, true, `rich-${kind}`);
		add(`send-challenge-rich-${kind}`, "challenge", rich, true);
	}
	const sendZero = change(send, "review.snapshot.epoch", 0) as ObjectValue;
	member(sendZero, "review").contentHash = contentHash(
		SendSnapshotV1.parse(member(member(sendZero, "review"), "snapshot")),
	);
	add(
		"send-challenge-epoch-zero",
		"challenge",
		changeStatement(
			changeStatement(sendZero, "epoch", 0),
			"contentHash",
			member(sendZero, "review").contentHash,
		),
		true,
	);
	add("pair-challenge-epoch-zero", "challenge", changeStatement(pair, "epoch", 0), true);
	const substitutedPendingIds = clone(send);
	for (const field of ["challenge", "review", "request"])
		member(substitutedPendingIds, field).id = id.account;
	add("send-joint-pending-id-substitution", "challenge", substitutedPendingIds);
	add(
		"send-requested-acknowledgements-differ",
		"challenge",
		change(send, "request.flagsAcked", []) as ObjectValue,
	);
	// One code beyond the signed list still covers every required flag; only equality refuses it.
	const ackedSuperset = change(
		send,
		"request.flagsAcked",
		[...(member(send, "request").flagsAcked as string[]), "REPLY_TO_REDIRECT"].toSorted(),
	) as ObjectValue;
	schema("ChallengeRequest", member(ackedSuperset, "request"), true, "acknowledgement-superset");
	add("send-requested-acknowledgements-superset", "challenge", ackedSuperset);
	const signedSuperset = changeStatement(send, "flagsAcked", [
		"EXTERNAL_LINK",
		"NEW_RECIPIENT",
		"REPLY_TO_REDIRECT",
	]);
	schema("Challenge", member(signedSuperset, "challenge"), true, "signed-acknowledgement-superset");
	// Lists of equal length that both cover every required flag: only equality refuses them.
	const sameLength = change(signedSuperset, "request.flagsAcked", [
		"DMARC_FAIL",
		"EXTERNAL_LINK",
		"NEW_RECIPIENT",
	]) as ObjectValue;
	schema("ChallengeRequest", member(sameLength, "request"), true, "acknowledgement-same-length");
	add("send-acknowledgements-same-length-differ", "challenge", sameLength);
	const objectFormAcks = changeStatement(send, "flagsAcked", [
		{ EXTERNAL_LINK: null },
		{ NEW_RECIPIENT: null },
	]);
	schema("Challenge", member(objectFormAcks, "challenge"), false, "object-form-acks");
	add("send-statement-object-form-acks", "challenge", objectFormAcks);
	for (const [kind, fixture] of [
		["send", send],
		["pair", pair],
	] as const) {
		for (const [path, replacement] of [
			["challenge.id", id.account],
			["challenge.kind", "unknown.v1"],
			["review.id", id.account],
			["request.id", id.account],
			["context.hub", "f".repeat(64)],
			["context.device", id.account],
		] as const)
			add(
				`${kind}-binding-${path}`,
				"challenge",
				change(fixture, path, replacement) as ObjectValue,
			);
		for (const [field, replacement] of [
			["hub", "f".repeat(64)],
			["device", id.account],
		] as const)
			add(`${kind}-statement-${field}`, "challenge", changeStatement(fixture, field, replacement));
		add(
			`${kind}-challenge-known-wrong-kind`,
			"challenge",
			change(
				fixture,
				"challenge.kind",
				kind === "send" ? "pair-confirm.v1" : "approval.send.v1",
			) as ObjectValue,
		);
	}
	for (const [field, replacement] of [
		["outbox", id.account],
		["contentHash", "f".repeat(64)],
		["flagsHash", "f".repeat(64)],
		["flagsAcked", []],
		["flagsAcked", ["NEW_RECIPIENT", "EXTERNAL_LINK"]],
		["flagsAcked", ["EXTERNAL_LINK", "EXTERNAL_LINK"]],
		// A signed superset still covers every required flag; only equality refuses it.
		["flagsAcked", ["EXTERNAL_LINK", "NEW_RECIPIENT", "REPLY_TO_REDIRECT"]],
		["notBefore", SNAPSHOT_IAT],
		["deliverBy", SNAPSHOT_IAT + 1],
		["epoch", 2],
	] as const)
		add(
			`send-statement-${field}-${JSON.stringify(replacement)}`,
			"challenge",
			changeStatement(send, field, replacement),
		);
	for (const [field, replacement] of [
		["hub", "f".repeat(64)],
		["epoch", 2],
		["outbox", id.account],
	] as const) {
		const fixture = change(send, `review.snapshot.${field}`, replacement) as ObjectValue;
		member(fixture, "review").contentHash = contentHash(
			SendSnapshotV1.parse(member(member(fixture, "review"), "snapshot")),
		);
		const changedHash = member(fixture, "review").contentHash;
		add(
			`send-snapshot-independent-${field}`,
			"challenge",
			changeStatement(fixture, "contentHash", changedHash),
		);
	}
	for (const [field, replacement] of [
		["candidate", id.account],
		["role", "host:sms"],
		["transportSpkiSha256", "f".repeat(64)],
		["signingKey", otherKey],
		["capabilities", presets.mobile],
	] as const)
		add(`pair-statement-${field}`, "challenge", changeStatement(pair, field, replacement));
	add("pair-review-kind", "challenge", change(pair, "review.kind", "login") as ObjectValue);
	add(
		"send-unacknowledged-flag",
		"challenge",
		changeStatement(change(send, "request.flagsAcked", []) as ObjectValue, "flagsAcked", []),
	);
	for (const [field, replacement] of [
		["candidate", id.account],
		["role", "host:sms"],
		["transportSpkiSha256", "f".repeat(64)],
		["signingKey", otherKey],
		["preset", "mobile"],
		["capabilities", presets.mobile],
	] as const) {
		const fixture = change(pair, `review.subject.${field}`, replacement) as ObjectValue;
		member(fixture, "review").digest = jcsSha256(member(fixture, "review").subject);
		add(`pair-subject-${field}`, "challenge", fixture);
	}
	const peer = {
		role: "device",
		known: true,
		revoked: false,
		epoch: 1,
		confirmedEpoch: 1,
		capabilities: presets.desktop,
		sidecarClaim: false,
		bootstrapDone: false,
	};
	for (const route of routes) {
		const operation = {
			kind: route.id === "challenge" ? "pair-confirm.v1" : "pair-confirm",
			preset: "desktop",
		};
		add(
			`access-${route.id}-allowed`,
			"access",
			{
				route: route.id,
				peer:
					route.id === "bootstrap"
						? { ...peer, confirmedEpoch: null, capabilities: [], sidecarClaim: true }
						: peer,
				operation,
			},
			true,
		);
		for (const [field, value] of [
			["role", "host:sms"],
			["known", false],
			["revoked", true],
		] as const)
			add(`access-${route.id}-${field}`, "access", {
				route: route.id,
				peer: { ...peer, [field]: value },
				operation,
			});
		if (!["status", "bootstrap"].includes(route.id)) {
			for (const [label, patch] of [
				["pending", { confirmedEpoch: null, capabilities: [] }],
				["old-epoch", { confirmedEpoch: 0 }],
				["no-capabilities", { capabilities: [] }],
			] as const)
				add(`access-${route.id}-${label}`, "access", {
					route: route.id,
					peer: { ...peer, ...patch },
					operation,
				});
		}
		for (const direction of ["request", "response"] as const) {
			const cap = direction === "request" ? route.requestBytes : route.responseBytes;
			add(
				`cap-${route.id}-${direction}-${cap}`,
				"cap",
				{ route: route.id, direction, length: cap },
				true,
			);
			add(`cap-${route.id}-${direction}-${cap + 1}`, "cap", {
				route: route.id,
				direction,
				length: cap + 1,
			});
		}
	}
	add(
		"access-status-pending-device",
		"access",
		{ route: "status", peer: { ...peer, confirmedEpoch: null, capabilities: [] } },
		true,
	);
	add("access-status-pending-host", "access", {
		route: "status",
		peer: { ...peer, role: "host:sms", confirmedEpoch: null, capabilities: [] },
	});
	add("access-status-object-form-capability", "access", {
		route: "status",
		peer: { ...peer, capabilities: [{ read: null }, ...presets.desktop.slice(1)] },
	});
	for (const patch of [{ sidecarClaim: false }, { bootstrapDone: true }, { confirmedEpoch: 1 }])
		add(`access-bootstrap-${Object.keys(patch)[0]}`, "access", {
			route: "bootstrap",
			peer: { ...peer, confirmedEpoch: null, capabilities: [], sidecarClaim: true, ...patch },
		});
	for (const route of ["new-operation", "challenge", "pair-confirmation"])
		for (const preset of ["desktop", "mobile", "cli"] as const) {
			const operation = {
				kind: route === "challenge" ? "pair-confirm.v1" : "pair-confirm",
				preset,
			};
			add(`can-confirm-${route}-desktop-${preset}`, "access", { route, peer, operation }, true);
			for (const capabilities of [
				presets[preset].filter((cap) => cap !== "read"),
				["approve"],
				presets.desktop.filter((cap) => cap !== "approve"),
			])
				add(`cannot-confirm-${route}-${preset}-${capabilities.join("-")}`, "access", {
					route,
					peer: { ...peer, capabilities },
					operation,
				});
		}
	add("access-null-operation", "access", { route: "status", peer, operation: null });
	add("access-unknown-operation-member", "access", {
		route: "status",
		peer,
		operation: { extra: true },
	});
	const requestValues: Record<string, unknown> = {
		bootstrap: fixtures.BootstrapRequest,
		"pairing-window": fixtures.PairingWindowRequest,
		"new-operation": fixtures.OperationRequest,
		challenge: send.request,
		"send-approval": envelope,
		"pair-confirmation": pairEnvelope,
		login: loginEnvelope,
		admin: adminEnvelope,
		"sync-pause": fixtures.SyncPause,
		events: fixtures.EventsRequest,
	};
	const responseValues: Record<string, unknown> = {
		status: pending,
		bootstrap: confirmed,
		"pairing-window": fixtures.PairingWindow,
		"send-review": send.review,
		"new-operation": fixtures.OperationCreated,
		"operation-review": pair.review,
		challenge: send.challenge,
		"sync-pause": fixtures.SyncPause,
		events: fixtures.EventFrame,
	};
	for (const route of routes) {
		if (route.request === "none") {
			add(`request-${route.id}-absent`, "request", { route: route.id, present: false }, true);
			for (const value of [null, {}])
				add(`request-${route.id}-body-${String(value)}`, "request", { route: route.id, value });
			add(`request-${route.id}-empty-received-body`, "request", {
				route: route.id,
				receivedHex: "",
			});
		} else if (route.id in requestValues) {
			const value = requestValues[route.id];
			add(`request-${route.id}-base`, "request", { route: route.id, value }, true);
			for (const length of [route.requestBytes, route.requestBytes + 1])
				add(
					`request-${route.id}-received-${length}`,
					"request",
					{ route: route.id, value, padToBytes: length },
					length === route.requestBytes,
				);
		}
		const value = responseValues[route.id] ?? { kind: route.statementType, id: id.op };
		add(`response-${route.id}-base`, "response", { route: route.id, value }, true);
		for (const length of [route.responseBytes, route.responseBytes + 1])
			add(
				`response-${route.id}-received-${length}`,
				"response",
				{ route: route.id, value, padToBytes: length },
				length === route.responseBytes,
			);
	}
	for (const text of ['{"paused":true,"paused":false}', '{"paused":true}garbage'])
		add(`request-sync-pause-invalid-json-${text}`, "request", {
			route: "sync-pause",
			receivedHex: Buffer.from(text).toString("hex"),
		});
	for (const [label, text] of [
		["conflicting", '{"paused":true,"paused":false}'],
		["identical", '{"paused":false,"paused":false}'],
	] as const)
		add(`response-sync-pause-duplicate-${label}`, "response", {
			route: "sync-pause",
			receivedHex: Buffer.from(text).toString("hex"),
		});
	for (const [number, valid] of [
		["-0", true],
		["-0.0", true],
		["0e999", true],
		["1.0", true],
		["1e0", true],
		["9007199254740991", true],
		["9007199254740992", false],
		["1e-999", true],
		["-1e-999", true],
	] as const)
		add(
			`response-status-raw-epoch-${number}`,
			"response",
			{
				route: "status",
				receivedHex: Buffer.from(
					`{"deviceId":"${id.device}","epoch":${number},"confirmed":false,"capabilities":[],"testUpstreams":false}`,
				).toString("hex"),
			},
			valid,
		);
	for (const route of routes.filter((route) => route.statementType !== null)) {
		const wrong = {
			kind: route.statementType === "approval.send.v1" ? "pair-confirm.v1" : "approval.send.v1",
			id: id.op,
		};
		add(`response-${route.id}-wrong-known-kind`, "response", { route: route.id, value: wrong });
		add(`response-${route.id}-wrong-known-kind-received`, "response", {
			route: route.id,
			receivedHex: Buffer.from(JSON.stringify(wrong)).toString("hex"),
		});
	}
	for (const route of [
		"send-approval",
		"pair-confirmation",
		"login",
		"consent",
		"agent-session",
		"admin",
	])
		add(`request-${route}-wrong-statement`, "request", {
			route,
			value: route === "send-approval" ? pairEnvelope : envelope,
		});
	for (const [code, status] of Object.entries(errors)) {
		add(`error-${code}`, "error", { value: { code }, status }, true);
		for (const length of [1024, 1025])
			add(
				`error-${code}-received-${length}`,
				"error",
				{ value: { code }, status, padToBytes: length },
				length === 1024,
			);
		add(`error-${code}-status`, "error", { value: { code }, status: status + 1 });
		add(`error-${code}-extra`, "error", { value: { code, message: "untrusted" }, status });
	}
	add("error-unknown", "error", { value: { code: "UNKNOWN" }, status: 400 });
	add(
		"error-FORBIDDEN-valid-received-json",
		"error",
		{ receivedHex: Buffer.from('{"code":"FORBIDDEN"}').toString("hex"), status: 403 },
		true,
	);
	for (const [label, text] of [
		["identical", '{"code":"FORBIDDEN","code":"FORBIDDEN"}'],
		["conflicting", '{"code":"INVALID_REQUEST","code":"FORBIDDEN"}'],
	] as const)
		add(`error-duplicate-code-${label}`, "error", {
			receivedHex: Buffer.from(text).toString("hex"),
			status: 403,
		});
	const ready = { type: "ready", cursor: "cursor" },
		event = { type: "event", cursor: "next", kind: "outbox.changed", ids: [id.outbox] };
	for (const reason of ["cursor_expired", "epoch_changed", "resync_required"]) {
		schema("EventFrame", { type: "reset", reason }, true, reason);
		add(`stream-reset-${reason}`, "stream", { frames: [{ type: "reset", reason }] }, true);
	}
	schema("EventFrame", { ...event, unexpected: true }, false, "event-unknown-member");
	schema(
		"EventFrame",
		{ type: "reset", reason: "epoch_changed", unexpected: true },
		false,
		"reset-unknown-member",
	);
	schema(
		"EventFrame",
		{ ...event, ids: ids.slice(0, 100), kind: "a".repeat(64), cursor: "x".repeat(512) },
		true,
		"maxima",
	);
	for (const [label, frame] of [
		["cursor513", { ...ready, cursor: "x".repeat(513) }],
		["cursor-nonascii", { ...ready, cursor: "é" }],
		["unknown-type", { type: "other", cursor: "x" }],
		["unknown-reason", { type: "reset", reason: "other" }],
		["kind65", { ...event, kind: "a".repeat(65) }],
		["kind-uppercase", { ...event, kind: "A" }],
		["kind-empty", { ...event, kind: "" }],
		["kind-underscore", { ...event, kind: "a_b" }],
		["ids101", { ...event, ids }],
		["duplicate-ids", { ...event, ids: [id.outbox, id.outbox] }],
	] as const)
		schema("EventFrame", frame, false, label);
	for (const length of [512, 513])
		schema("EventsRequest", { after: "a".repeat(length) }, length === 512, `cursor-${length}`);
	schema("EventsRequest", { after: "é" }, false, "cursor-nonascii");
	schema("EventsRequest", { after: "\u0000\r\n\u007f" }, true, "opaque-ascii-controls");
	schema("EventFrame", { ...ready, cursor: "\u0000\r\n\u007f" }, true, "opaque-ascii-controls");
	schema("EventFrame", { ...event, ids: [] }, true, "empty-event-ids");
	for (const suffix of ["\r", "\n", "\u2028", "\u2029"])
		schema(
			"EventFrame",
			{ ...event, kind: `outbox.changed${suffix}` },
			false,
			`kind-suffix-${JSON.stringify(suffix)}`,
		);
	add("stream-ready-event", "stream", { frames: [ready, event] }, true);
	add("stream-event-first", "stream", { frames: [event] });
	add("stream-empty", "stream", { frames: [] });
	add("stream-after-reset", "stream", {
		frames: [{ type: "reset", reason: "epoch_changed" }, ready],
	});
	for (const length of [65536, 65537])
		add(`frame-length-${length}`, "frame-cap", { length }, length === 65536);
	// Session records originate at the hub; OperationRequest intentionally remains unchanged.
	const session = agentSessionFixture();
	const call = agentSessionFixture("tool-call");
	const resource = agentSessionFixture("resource-read");
	const sessionEnvelope = { ...envelope, statement: member(session, "challenge").statement };
	const subjectOf = (fixture: ObjectValue): ObjectValue =>
		member(member(fixture, "review"), "subject");
	const changedSubject = (fixture: ObjectValue, path: string, value: unknown): ObjectValue => {
		const changed = change(fixture, `review.subject.${path}`, value) as ObjectValue;
		member(changed, "review").digest = jcsSha256(subjectOf(changed));
		return changed;
	};
	for (const [name, fixture] of [
		["session", session],
		["tool-call", call],
		["resource-read", resource],
	] as const) {
		schema("AgentSessionReviewSubject", subjectOf(fixture), true, name);
		schema("OperationReview", fixture.review, true, `agent-${name}`);
		schema("Challenge", fixture.challenge, true, `agent-${name}`);
		schema(
			"SignedEnvelope",
			{ ...envelope, statement: member(fixture, "challenge").statement },
			true,
			`agent-${name}`,
		);
		add(`agent-${name}-matching`, "challenge", fixture, true);
		add(
			`agent-${name}-envelope`,
			"request",
			{
				route: "agent-session",
				value: { ...envelope, statement: member(fixture, "challenge").statement },
			},
			true,
		);
	}
	schema("ChallengeRequest", session.request, true, "agent-session");
	schema(
		"AgentSessionReviewSubject",
		{ ...subjectOf(session), extra: true },
		false,
		"unknown-member",
	);
	for (const field of ["principal", "account", "toolClass", "authorization"])
		schema(
			"AgentSessionReviewSubject",
			change(subjectOf(session), field, undefined),
			false,
			`missing-${field}`,
		);
	for (const [label, subject] of [
		["positional", Object.values(subjectOf(session))],
		["positional-principal", change(subjectOf(session), "principal", ["grant", id.author])],
		["object-form-tool-class", change(subjectOf(session), "toolClass", { read: null })],
		["positional-authorization", change(subjectOf(session), "authorization", ["session", 900_000])],
	] as const)
		schema("AgentSessionReviewSubject", subject, false, label);
	schema(
		"OperationReview",
		{ ...member(session, "review"), extra: true },
		false,
		"agent-unknown-member",
	);
	schema(
		"SignedEnvelope",
		{ ...sessionEnvelope, target: "accounts_list" },
		false,
		"agent-target-member",
	);
	for (const [path, replacement] of [
		["principal.kind", "host"],
		["principal.id", "invalid"],
		["principal.extra", true],
		["account", "invalid"],
		["toolClass", "send"],
		["authorization.durationMs", 900_001],
		["authorization.target", "accounts_list"],
		["authorization.singleUse", true],
		["authorization", undefined],
	] as const)
		schema(
			"AgentSessionReviewSubject",
			change(subjectOf(session), path, replacement),
			false,
			`session-${path}`,
		);
	for (const [path, replacement] of [
		["authorization.paramsDigest", "invalid"],
		["authorization.validForMs", 600_001],
		["authorization.singleUse", false],
		["authorization.method", "prompts/get"],
		["authorization.durationMs", 900_000],
		["authorization.target", "unknown_tool"],
		["authorization.target", "draft_create"],
		["authorization.target", undefined],
		["authorization.extra", true],
	] as const)
		schema(
			"AgentSessionReviewSubject",
			change(subjectOf(call), path, replacement),
			false,
			`call-${path}-${String(replacement)}`,
		);
	for (const target of [
		"draftyak://guide/agents",
		"ui://draftyak/draft-v1",
		"ui://draftyak/send-status-v1",
		`draftyak://message/${id.outbox}?x=1`,
		`draftyak://message/${id.outbox}#x`,
		`draftyak://message/%${id.outbox}`,
		`DRAFTYAK://message/${id.outbox}`,
	])
		schema(
			"AgentSessionReviewSubject",
			change(subjectOf(resource), "authorization.target", target),
			false,
			`resource-${target}`,
		);
	schema(
		"AgentSessionReviewSubject",
		change(subjectOf(resource), "toolClass", "draft"),
		false,
		"resource-class",
	);
	for (const duration of [900_000, 3_600_000, 28_800_000]) {
		const fixture = changeStatement(
			changedSubject(session, "authorization.durationMs", duration),
			"authorization.durationMs",
			duration,
		);
		add(`agent-session-duration-${duration}`, "challenge", fixture, true);
	}
	for (const principal of ["grant", "token"])
		add(
			`agent-principal-${principal}`,
			"challenge",
			changeStatement(
				changedSubject(session, "principal.kind", principal),
				"principal.kind",
				principal,
			),
			true,
		);
	for (const toolClass of ["read", "draft", "organize"] as const) {
		add(
			`agent-session-class-${toolClass}`,
			"challenge",
			agentSessionFixture("session", toolClass),
			true,
		);
		add(
			`agent-tool-class-${toolClass}`,
			"challenge",
			agentSessionFixture("tool-call", toolClass),
			true,
		);
	}
	for (const kind of ["conversation", "message", "draft", "send-request"])
		add(
			`agent-resource-${kind}`,
			"challenge",
			changedSubject(resource, "authorization.target", `draftyak://${kind}/${id.outbox}`),
			true,
		);
	// Target is derived from immutable params by the producer; only its method/class form is
	// checked here. A same-class target with a recomputed review digest is not a signed field.
	add(
		"agent-target-derived-not-signed",
		"challenge",
		changedSubject(call, "authorization.target", "messages_search"),
		true,
	);
	for (const [path, replacement] of [
		["challenge.id", id.account],
		["challenge.kind", "pair-confirm.v1"],
		["request.id", id.account],
		["request.kind", "pair-confirm.v1"],
		["review.id", id.account],
		["review.kind", "pair-confirm"],
		["review.digest", "f".repeat(64)],
		["context.hub", "f".repeat(64)],
		["context.device", id.account],
	] as const)
		add(`agent-binding-${path}`, "challenge", change(session, path, replacement) as ObjectValue);
	for (const [field, replacement] of [
		["hub", "f".repeat(64)],
		["device", id.account],
		["session", id.account],
		["principal.kind", "token"],
		["principal.id", id.account],
		["account", id.author],
		["toolClass", "draft"],
		["authorization.durationMs", 3_600_000],
	] as const) {
		add(`agent-statement-${field}`, "challenge", changeStatement(session, field, replacement));
		if (!["hub", "device", "session"].includes(field))
			add(`agent-subject-${field}`, "challenge", changedSubject(session, field, replacement));
	}
	for (const [field, replacement] of [
		["authorization.method", "resources/read"],
		["authorization.paramsDigest", "f".repeat(64)],
		["authorization.validForMs", 600_001],
		["authorization.singleUse", false],
		["authorization.target", "accounts_list"],
	] as const)
		add(`agent-call-statement-${field}`, "challenge", changeStatement(call, field, replacement));
	add(
		"agent-call-subject-paramsDigest",
		"challenge",
		changedSubject(call, "authorization.paramsDigest", "f".repeat(64)),
	);
	add(
		"agent-authorization-choice",
		"challenge",
		changeStatement(session, "authorization", {
			kind: "call",
			method: "tools/call",
			paramsDigest: "c".repeat(64),
			validForMs: 600_000,
			singleUse: true,
		}),
	);
	add("agent-epoch-zero", "challenge", changeStatement(session, "epoch", 0), true);
	for (const [field, value] of [
		["flagsAcked", []],
		["code", "123456"],
		["authorization", { kind: "session", durationMs: 900_000 }],
	] as const)
		schema(
			"ChallengeRequest",
			{ ...member(session, "request"), [field]: value },
			false,
			`agent-extra-${field}`,
		);
	for (const [field, value] of [
		["statement", pairChallenge.statement],
		["kind", "pair-confirm.v1"],
	] as const)
		schema(
			"Challenge",
			{ ...member(session, "challenge"), [field]: value },
			false,
			`agent-wrong-${field}`,
		);
	for (const route of ["send-approval", "pair-confirmation", "login", "consent", "admin"])
		add(`agent-envelope-wrong-route-${route}`, "request", { route, value: sessionEnvelope });
	for (const length of [32768, 32769])
		add(
			`request-agent-session-received-${length}`,
			"request",
			{ route: "agent-session", value: sessionEnvelope, padToBytes: length },
			length === 32768,
		);
	for (const length of [1024, 1025])
		add(
			`request-agent-challenge-received-${length}`,
			"request",
			{ route: "challenge", value: session.request, padToBytes: length },
			length === 1024,
		);
	for (const route of ["challenge", "operation-review", "agent-session"]) {
		const operation = { kind: route === "challenge" ? "agent-session.v1" : "agent-session" };
		add(
			`agent-access-${route}-approve-only`,
			"access",
			{ route, peer: { ...peer, capabilities: ["approve"] }, operation },
			true,
		);
		for (const [label, patch] of [
			["no-approve", { capabilities: ["read", "draft", "organize", "admin"] }],
			["pending", { confirmedEpoch: null }],
			["old-epoch", { confirmedEpoch: 0 }],
			["revoked", { revoked: true }],
			["unknown", { known: false }],
			["host", { role: "host:sms" }],
		] as const)
			add(`agent-access-${route}-${label}`, "access", {
				route,
				peer: { ...peer, ...patch },
				operation,
			});
	}
	if (new Set(cases.map((value) => value.id)).size !== cases.length)
		throw Error("duplicate device API vector id");
	return cases;
}
export const generate = (): VectorFile[] => [
	{
		path: "device-api/cases.json",
		content: {
			format: "draftyak.vectors.device-api.v1",
			description:
				"Shared strict forms, access rules, byte boundaries and independent challenge-field refusals. padToBytes appends legal JSON whitespace to the received outer body; cap and length actions test length alone.",
			cases: apiCases(),
		},
	},
];
