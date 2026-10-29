import { createECDH } from "node:crypto";
import { PublicKeySpki } from "../../../src/entities/device.ts";
import { jcsSha256 } from "../../../src/hash.ts";
import { SigningKey } from "../../../src/statements.ts";
import type { VectorFile } from "../../vectors.ts";
import { SNAPSHOT_IAT, SNAPSHOT_IDS } from "../snapshot.ts";
import { statementBase } from "../statements/shared.ts";
import { type ApiCase, agentSessionFixture, encoded, pairFixture, publicKey } from "./cases.ts";
import { adminKinds, presets } from "./catalogue.ts";

type ObjectValue = Record<string, unknown>;
const id = SNAPSHOT_IDS;
const clone = <T>(value: T): T => structuredClone(value);

// Transcribed independently of ADMIN_REVIEW_KINDS, as catalogue.ts transcribes the admin kinds.
export const reviewKinds: readonly string[] = [
	"account.disconnect",
	"account.mode-full",
	"security.device-capabilities",
	"data.backup",
];
export const refusedKinds: readonly string[] = adminKinds.filter(
	(kind) => !reviewKinds.includes(kind),
);
export const capabilityOrder: readonly string[] = ["read", "draft", "organize", "approve", "admin"];

// Over every pair of nonempty capability sets (bit i is capabilityOrder[i]): the subjects that
// strictly widen, add no approve and add admin only beside a held approve, and with every nonempty
// held set the grants whose signer holds admin and the whole new set.
export function pairCounts(): { subjectPairs: number; grantPairs: number } {
	const approve = 8,
		admin = 16;
	let subjectPairs = 0,
		grantPairs = 0;
	for (let current = 1; current < 32; current++)
		for (let next = 1; next < 32; next++) {
			const added = next & ~current;
			if ((next & current) !== current || added === 0 || added & approve) continue;
			if (added & admin && !(current & approve)) continue;
			subjectPairs++;
			for (let held = 1; held < 32; held++)
				if (held & admin && (held & next) === next) grantPairs++;
		}
	return { subjectPairs, grantPairs };
}

// Deterministic public points used only as fixture identities, as cases.ts makes its own.
const spkiPrefix = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex");
const spki = (point: Uint8Array): string =>
	Buffer.concat([spkiPrefix, point]).toString("base64url");
function fixtureKey(scalar: number): string {
	const curve = createECDH("prime256v1");
	curve.setPrivateKey(Buffer.from([scalar]));
	return spki(curve.getPublicKey());
}
const otherKey = fixtureKey(3);
// The canonical SPKI form of the point (1, 1), which is not on P-256.
const offCurveKey = spki(
	Buffer.concat([
		Buffer.from([4]),
		Buffer.alloc(31),
		Buffer.from([1]),
		Buffer.alloc(31),
		Buffer.from([1]),
	]),
);

const createdAt = Date.parse("2026-10-12T15:00:00.000Z");
const pairedAt = Date.parse("2026-10-14T16:30:00.000Z");
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
export type SubjectName = "email" | "chat" | "device" | "backup";
export function adminSubject(name: SubjectName): ObjectValue {
	switch (name) {
		case "email":
			return {
				channel: "email",
				account: id.account,
				alias: "gmail-1",
				address: "owner@example.test",
				createdAt,
			};
		case "chat":
			return {
				channel: "chat",
				account: id.account,
				alias: "slack-1",
				teamId: "T0123ABCD",
				selfUserId: "U0123ABCD",
				createdAt,
			};
		case "device":
			return {
				device: id.candidate,
				name: "Work laptop",
				transportSpkiSha256: "b".repeat(64),
				signingKey: publicKey,
				pairedAt,
				current: ["read", "draft"],
				capabilities: ["read", "draft", "organize"],
			};
		case "backup":
			return { scope: "backup" };
	}
}
const subjectFor = (kind: string): SubjectName =>
	kind.startsWith("account.")
		? "email"
		: kind === "security.device-capabilities"
			? "device"
			: "backup";
const decode = (text: unknown): ObjectValue =>
	JSON.parse(Buffer.from(text as string, "base64url").toString("utf8"));

// A pending operation of `kind` whose review and signed statement both bind `subject`'s digest.
export function adminFixture(
	kind: string,
	subject: unknown = adminSubject(subjectFor(kind)),
	statementKind: string = kind,
): ObjectValue {
	const digest = jcsSha256(subject);
	const review = {
		id: id.op,
		kind,
		digest,
		subject: clone(subject),
		expiresAt: SNAPSHOT_IAT + 120000,
		remainingMs: 120000,
	};
	const statement = { ...statementBase(), op: id.op, kind: statementKind, digest };
	return {
		challenge: { kind: "admin.v1", id: id.op, statement: encoded(statement) },
		review,
		request: { kind: "admin.v1", id: id.op },
		context: { hub: statement.hub, device: statement.device },
	};
}
const part = (fixture: ObjectValue, name: string): ObjectValue => fixture[name] as ObjectValue;
function signed(fixture: ObjectValue, change: ObjectValue): ObjectValue {
	const copy = clone(fixture);
	part(copy, "challenge").statement = encoded({
		...decode(part(copy, "challenge").statement),
		...change,
	});
	return copy;
}
function patched(fixture: ObjectValue, name: string, change: ObjectValue): ObjectValue {
	const copy = clone(fixture);
	copy[name] = { ...part(copy, name), ...change };
	return copy;
}
// The review shows another record, with its own digest, while the statement keeps the old one.
function stale(fixture: ObjectValue, subject: ObjectValue): ObjectValue {
	return patched(fixture, "review", { subject, digest: jcsSha256(subject) });
}
const without = (value: ObjectValue, name: string): ObjectValue => {
	const copy = clone(value);
	delete copy[name];
	return copy;
};

interface Grant {
	readonly label: string;
	readonly current: unknown;
	readonly capabilities: unknown;
	readonly valid: boolean;
}
const grantSets: readonly Grant[] = [
	{
		label: "cli-adds-organize",
		current: ["read", "draft"],
		capabilities: ["read", "draft", "organize"],
		valid: true,
	},
	{ label: "read-adds-draft", current: ["read"], capabilities: ["read", "draft"], valid: true },
	{ label: "draft-adds-read", current: ["draft"], capabilities: ["read", "draft"], valid: true },
	{
		label: "read-adds-draft-organize",
		current: ["read"],
		capabilities: ["read", "draft", "organize"],
		valid: true,
	},
	{
		label: "approver-adds-admin",
		current: ["read", "draft", "approve"],
		capabilities: ["read", "draft", "approve", "admin"],
		valid: true,
	},
	{
		label: "approve-only-to-desktop",
		current: ["approve"],
		capabilities: ["read", "draft", "organize", "approve", "admin"],
		valid: true,
	},
	{
		label: "admin-held-adds-organize",
		current: ["read", "draft", "approve", "admin"],
		capabilities: ["read", "draft", "organize", "approve", "admin"],
		valid: true,
	},
	{
		label: "admin-held-without-approve-adds-draft",
		current: ["read", "admin"],
		capabilities: ["read", "draft", "admin"],
		valid: true,
	},
	{ label: "current-empty", current: [], capabilities: ["read"], valid: false },
	{ label: "capabilities-empty", current: ["read"], capabilities: [], valid: false },
	{
		label: "current-unordered",
		current: ["draft", "read"],
		capabilities: ["read", "draft", "organize"],
		valid: false,
	},
	{
		label: "capabilities-unordered",
		current: ["read", "draft"],
		capabilities: ["read", "organize", "draft"],
		valid: false,
	},
	{ label: "equal", current: ["read", "draft"], capabilities: ["read", "draft"], valid: false },
	{
		label: "narrower",
		current: ["read", "draft", "organize"],
		capabilities: ["read", "draft"],
		valid: false,
	},
	{ label: "sideways", current: ["draft"], capabilities: ["read", "organize"], valid: false },
	{
		label: "sideways-approver",
		current: ["read", "approve"],
		capabilities: ["draft", "approve", "admin"],
		valid: false,
	},
	{
		label: "current-duplicate",
		current: ["read", "read"],
		capabilities: ["read", "draft"],
		valid: false,
	},
	{
		label: "capabilities-duplicate",
		current: ["read"],
		capabilities: ["read", "draft", "draft"],
		valid: false,
	},
	{
		label: "adds-approve",
		current: ["read", "draft"],
		capabilities: ["read", "draft", "approve"],
		valid: false,
	},
	{
		label: "adds-approve-and-admin",
		current: ["read", "draft"],
		capabilities: ["read", "draft", "approve", "admin"],
		valid: false,
	},
	{
		label: "cli-to-desktop",
		current: ["read", "draft"],
		capabilities: ["read", "draft", "organize", "approve", "admin"],
		valid: false,
	},
	{
		label: "adds-admin-without-approve",
		current: ["read", "draft"],
		capabilities: ["read", "draft", "admin"],
		valid: false,
	},
	{
		label: "mobile-adds-approve",
		current: ["read", "draft", "organize"],
		capabilities: ["read", "draft", "organize", "approve"],
		valid: false,
	},
	{
		label: "mobile-adds-admin",
		current: ["read", "draft", "organize"],
		capabilities: ["read", "draft", "organize", "admin"],
		valid: false,
	},
	{
		label: "mobile-to-desktop",
		current: ["read", "draft", "organize"],
		capabilities: ["read", "draft", "organize", "approve", "admin"],
		valid: false,
	},
	{
		label: "read-adds-approve",
		current: ["read"],
		capabilities: ["read", "approve"],
		valid: false,
	},
	{
		label: "host-tripwire",
		current: ["read", "draft"],
		capabilities: ["read", "draft", "host:sms"],
		valid: false,
	},
	{ label: "host-held", current: ["host:sms"], capabilities: ["read", "host:sms"], valid: false },
	{
		label: "owner",
		current: ["read", "draft"],
		capabilities: ["read", "draft", "owner"],
		valid: false,
	},
	{ label: "current-string", current: "read", capabilities: ["read", "draft"], valid: false },
	{
		label: "current-map-element",
		current: [{ read: null }, "draft"],
		capabilities: ["read", "draft", "organize"],
		valid: false,
	},
	{
		label: "capabilities-map-element",
		current: ["read", "draft"],
		capabilities: ["read", "draft", { organize: null }],
		valid: false,
	},
	{
		label: "capabilities-upper-case",
		current: ["read"],
		capabilities: ["read", "DRAFT"],
		valid: false,
	},
];

export function adminCases(): ApiCase[] {
	if (
		!SigningKey.safeParse(otherKey).success ||
		!PublicKeySpki.safeParse(offCurveKey).success ||
		SigningKey.safeParse(offCurveKey).success
	)
		throw Error("admin fixture keys");
	const cases: ApiCase[] = [];
	const add = (name: string, action: string, fields: ObjectValue, valid = false): void => {
		cases.push({ id: `admin-${name}`, action, ...fields, valid });
	};
	const schema = (name: string, schemaName: string, value: unknown, valid: boolean): void =>
		add(name, "schema", { schema: schemaName, value }, valid);
	const email = adminSubject("email"),
		chat = adminSubject("chat"),
		device = adminSubject("device"),
		backup = adminSubject("backup");
	const subjects: readonly [SubjectName, ObjectValue][] = [
		["email", email],
		["chat", chat],
		["device", device],
		["backup", backup],
	];
	const namedSchema: Record<SubjectName, string> = {
		email: "AdminAccountSubject",
		chat: "AdminAccountSubject",
		device: "AdminDeviceCapabilitiesSubject",
		backup: "AdminDataBackupSubject",
	};
	const kindOf: Record<SubjectName, string> = {
		email: "account.disconnect",
		chat: "account.disconnect",
		device: "security.device-capabilities",
		backup: "data.backup",
	};
	// A refused subject fails as its named schema and as the record of a challenge whose review and
	// statement both carry its own digest, so only the subject rule refuses it.
	const refuse = (name: string, subjectName: SubjectName, subject: unknown): void => {
		schema(`subject-${name}`, namedSchema[subjectName], subject, false);
		add(`challenge-subject-${name}`, "challenge", adminFixture(kindOf[subjectName], subject));
	};
	const accept = (name: string, subjectName: SubjectName, subject: unknown): void => {
		schema(`subject-${name}`, namedSchema[subjectName], subject, true);
		const fixture = adminFixture(kindOf[subjectName], subject);
		schema(`review-${name}`, "OperationReview", fixture.review, true);
		add(`challenge-${name}`, "challenge", fixture, true);
	};

	// Each included kind with each subject that fits it.
	for (const kind of reviewKinds)
		for (const [name, subject] of subjects) {
			const fits = subjectFor(kind) === name || (name === "chat" && kind.startsWith("account."));
			const fixture = adminFixture(kind, subject);
			schema(`review-${kind}-${name}`, "OperationReview", fixture.review, fits);
			add(`challenge-${kind}-${name}`, "challenge", fixture, fits);
		}
	schema(
		"review-remaining-zero",
		"OperationReview",
		{ ...part(adminFixture("data.backup"), "review"), remainingMs: 0 },
		true,
	);
	schema(
		"review-remaining-120001",
		"OperationReview",
		{ ...part(adminFixture("data.backup"), "review"), remainingMs: 120001 },
		false,
	);
	schema(
		"review-digest",
		"OperationReview",
		{ ...part(adminFixture("account.disconnect"), "review"), digest: "f".repeat(64) },
		false,
	);
	schema(
		"review-unknown-member",
		"OperationReview",
		{ ...part(adminFixture("security.device-capabilities"), "review"), requester: id.device },
		false,
	);
	schema(
		"review-expires-at-unsafe",
		"OperationReview",
		{ ...part(adminFixture("data.backup"), "review"), expiresAt: 2 ** 53 },
		false,
	);

	// Every admin kind without a subject, with every subject: no review member, no challenge.
	for (const kind of [...refusedKinds, "plugin.enable", "unknown.kind"])
		for (const [name, subject] of subjects) {
			const fixture = adminFixture(kind, subject);
			schema(`refused-review-${kind}-${name}`, "OperationReview", fixture.review, false);
			add(`refused-challenge-${kind}-${name}`, "challenge", fixture);
		}

	// Named subject schemas.
	for (const [name, subject] of subjects) {
		schema(`subject-${name}`, namedSchema[name], subject, true);
		schema(`subject-${name}-unknown-member`, namedSchema[name], { ...subject, extra: true }, false);
		refuse(`${name}-array`, name, Object.values(subject));
	}
	accept("chat-no-team", "chat", { ...chat, teamId: null });
	accept("chat-team-256", "chat", { ...chat, teamId: "T".repeat(256) });
	accept("email-unicode-local-part", "email", { ...email, address: "zoë@example.test" });
	accept("alias-32", "email", { ...email, alias: `a${"-".repeat(31)}` });
	accept("alias-digit", "chat", { ...chat, alias: "1" });
	for (const value of [0, MAX_SAFE]) {
		accept(`email-created-${value}`, "email", { ...email, createdAt: value });
		accept(`device-paired-${value}`, "device", { ...device, pairedAt: value });
	}

	// Account subjects.
	for (const [label, subject] of [
		["email-plugin-instance", { ...email, pluginInstanceId: id.author }],
		["email-mode", { ...email, mode: "read_only" }],
		["email-missing-address", without(email, "address")],
		["email-team", { ...email, teamId: "T0123ABCD" }],
		["chat-address", { ...chat, address: "owner@example.test" }],
		["chat-missing-user", without(chat, "selfUserId")],
		["chat-missing-team", without(chat, "teamId")],
		["missing-channel", without(email, "channel")],
		["missing-alias", without(email, "alias")],
		["missing-created", without(chat, "createdAt")],
		["channel-sms", { ...chat, channel: "sms" }],
		["channel-upper-case", { ...email, channel: "EMAIL" }],
		["channel-map", { ...email, channel: { email: null } }],
		["account-lower-case", { ...email, account: id.account.toLowerCase() }],
		["account-8", { ...email, account: `8${id.account.slice(1)}` }],
		["alias-upper-case", { ...email, alias: "Gmail-1" }],
		["alias-leading-hyphen", { ...email, alias: "-gmail" }],
		["alias-33", { ...email, alias: `a${"-".repeat(32)}` }],
		["alias-empty", { ...chat, alias: "" }],
		["alias-line-feed", { ...email, alias: "gmail-1\n" }],
		["alias-underscore", { ...email, alias: "gmail_1" }],
		["alias-non-ascii", { ...email, alias: "gmäil" }],
		["address-upper-case-domain", { ...email, address: "owner@Example.test" }],
		["address-no-domain", { ...email, address: "owner" }],
		["address-space", { ...email, address: "a b@example.test" }],
		["address-null", { ...email, address: null }],
		["team-empty", { ...chat, teamId: "" }],
		["team-space", { ...chat, teamId: "T 1" }],
		["team-257", { ...chat, teamId: "T".repeat(257) }],
		["user-null", { ...chat, selfUserId: null }],
		["user-non-ascii", { ...chat, selfUserId: "Ü0123ABCD" }],
		["created-negative", { ...email, createdAt: -1 }],
		["created-fraction", { ...email, createdAt: 1.5 }],
		["created-unsafe", { ...chat, createdAt: 2 ** 53 }],
		["created-string", { ...email, createdAt: "0" }],
	] as const)
		refuse(`account-${label}`, "email", subject);

	// Device subjects: the grant rules, then each member.
	for (const grant of grantSets) {
		const subject = { ...device, current: grant.current, capabilities: grant.capabilities };
		if (grant.valid) accept(`grant-${grant.label}`, "device", subject);
		else refuse(`grant-${grant.label}`, "device", subject);
	}
	for (const [label, subject] of [
		["missing-current", without(device, "current")],
		["missing-key", without(device, "signingKey")],
		["preset", { ...device, preset: "desktop" }],
		["device-lower-case", { ...device, device: id.candidate.toLowerCase() }],
		["name-empty", { ...device, name: "" }],
		["name-65", { ...device, name: "x".repeat(65) }],
		["name-hidden", { ...device, name: "Work​laptop" }],
		["name-leading-space", { ...device, name: " Work laptop" }],
		["transport-upper-case", { ...device, transportSpkiSha256: "B".repeat(64) }],
		["transport-63", { ...device, transportSpkiSha256: "b".repeat(63) }],
		["key-off-curve", { ...device, signingKey: offCurveKey }],
		["key-truncated", { ...device, signingKey: publicKey.slice(0, 121) }],
		["paired-negative", { ...device, pairedAt: -1 }],
		["paired-fraction", { ...device, pairedAt: 1.5 }],
		["paired-unsafe", { ...device, pairedAt: 2 ** 53 }],
		["paired-string", { ...device, pairedAt: "0" }],
	] as const)
		refuse(`device-${label}`, "device", subject);
	accept("device-name-64", "device", { ...device, name: "x".repeat(64) });
	accept("device-other-key", "device", { ...device, signingKey: otherKey });

	// Back up now only.
	for (const [label, subject] of [
		["empty", {}],
		["account", { scope: "account" }],
		["upper-case", { scope: "BACKUP" }],
		["path", { scope: "backup", path: "backup.dyb" }],
		["map", { scope: { backup: null } }],
		["null", { scope: null }],
		["string", "backup"],
	] as const)
		refuse(`backup-${label}`, "backup", subject);

	// The challenge request and the challenge's shape.
	const base = adminFixture("account.disconnect");
	schema("request", "ChallengeRequest", base.request, true);
	for (const [label, change] of [
		["admin-kind", { adminKind: "account.disconnect" }],
		["digest", { digest: "c".repeat(64) }],
		["flags-acked", { flagsAcked: [] }],
		["code", { code: "123456" }],
		["id-lower-case", { id: id.op.toLowerCase() }],
	] as const)
		schema(`request-${label}`, "ChallengeRequest", { ...part(base, "request"), ...change }, false);
	schema("request-missing-id", "ChallengeRequest", { kind: "admin.v1" }, false);
	schema("challenge", "Challenge", base.challenge, true);
	schema(
		"challenge-tool-kind",
		"Challenge",
		part(signed(base, { kind: "tool.enable" }), "challenge"),
		true,
	);
	for (const [label, statement] of [
		["pair-statement", part(pairFixture(), "challenge").statement],
		["session-statement", part(agentSessionFixture(), "challenge").statement],
		["plugin-enable", part(signed(base, { kind: "plugin.enable" }), "challenge").statement],
		["missing-digest", encoded(without(decode(part(base, "challenge").statement), "digest"))],
	] as const)
		schema(`challenge-${label}`, "Challenge", { ...part(base, "challenge"), statement }, false);

	// The challenge row: each field against its source.
	add("challenge-epoch-zero", "challenge", signed(base, { epoch: 0 }), true);
	const swap = adminFixture("account.mode-full");
	add(
		"challenge-kind-disconnect-for-mode-full",
		"challenge",
		signed(base, { kind: "account.mode-full" }),
	);
	add(
		"challenge-kind-mode-full-for-disconnect",
		"challenge",
		signed(swap, { kind: "account.disconnect" }),
	);
	add(
		"challenge-kind-backup-for-device",
		"challenge",
		signed(adminFixture("security.device-capabilities"), { kind: "data.backup" }),
	);
	add(
		"challenge-kind-export-for-backup",
		"challenge",
		signed(adminFixture("data.backup"), { kind: "data.export" }),
	);
	add("challenge-kind-tool", "challenge", signed(base, { kind: "tool.enable" }));
	for (const [label, change] of [
		["op", { op: id.account }],
		["digest", { digest: "f".repeat(64) }],
		["hub", { hub: "b".repeat(64) }],
		["device", { device: id.account }],
	] as const)
		add(`challenge-statement-${label}`, "challenge", signed(base, change));
	for (const [label, name, change] of [
		["context-hub", "context", { hub: "f".repeat(64) }],
		["context-device", "context", { device: id.account }],
		["challenge-id", "challenge", { id: id.account }],
		["request-id", "request", { id: id.account }],
		["review-id", "review", { id: id.account }],
		["request-kind", "request", { kind: "pair-confirm.v1" }],
		["challenge-kind", "challenge", { kind: "pair-confirm.v1" }],
		["review-kind-swap", "review", { kind: "account.mode-full" }],
	] as const)
		add(`challenge-binding-${label}`, "challenge", patched(base, name, change));
	const otherRecords: [string, ObjectValue][] = [
		["pair-review", part(pairFixture(), "review")],
		["session-review", part(agentSessionFixture(), "review")],
	];
	for (const [label, review] of otherRecords) {
		const fixture = signed(patched(base, "review", review), { digest: review.digest });
		add(`challenge-other-record-${label}`, "challenge", fixture);
	}
	for (const grant of grantSets.filter((each) => each.valid)) {
		const subject = { ...device, current: grant.current, capabilities: grant.capabilities };
		add(
			`challenge-self-target-${grant.label}`,
			"challenge",
			adminFixture("security.device-capabilities", { ...subject, device: id.device }),
		);
	}
	add(
		"challenge-target-other-device",
		"challenge",
		adminFixture("security.device-capabilities", { ...device, device: id.author }),
		true,
	);
	// Each member that identifies the account or device is bound through the digest.
	const changes: readonly [string, SubjectName, ObjectValue, string, unknown][] = [
		["account", "email", email, "account", id.author],
		["alias", "email", email, "alias", "gmail-2"],
		["address", "email", email, "address", "other@example.test"],
		["created", "email", email, "createdAt", createdAt + 1],
		["account", "chat", chat, "account", id.author],
		["alias", "chat", chat, "alias", "slack-2"],
		["team", "chat", chat, "teamId", "T0123ABCE"],
		["team-null", "chat", chat, "teamId", null],
		["user", "chat", chat, "selfUserId", "U0123ABCE"],
		["created", "chat", chat, "createdAt", createdAt + 1],
		["target", "device", device, "device", id.author],
		["name", "device", device, "name", "Home laptop"],
		["transport", "device", device, "transportSpkiSha256", "c".repeat(64)],
		["key", "device", device, "signingKey", otherKey],
		["paired", "device", device, "pairedAt", pairedAt + 1],
		["current", "device", device, "current", ["read"]],
		[
			"capabilities",
			"device",
			{ ...device, current: ["read"], capabilities: ["read", "draft"] },
			"capabilities",
			["read", "draft", "organize"],
		],
	];
	for (const [label, name, original, member, value] of changes)
		add(
			`stale-${name}-${label}`,
			"challenge",
			stale(adminFixture(kindOf[name], original), { ...original, [member]: value }),
		);
	add(
		"stale-mode-full-chat-alias",
		"challenge",
		stale(adminFixture("account.mode-full", chat), { ...chat, alias: "slack-2" }),
	);

	// Admission and the route's byte caps.
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
	for (const [label, change, valid] of [
		["desktop", {}, true],
		["admin-only", { capabilities: ["admin"] }, true],
		["approve-only", { capabilities: ["approve"] }, false],
		["no-admin", { capabilities: ["read", "draft", "organize", "approve"] }, false],
		["pending", { confirmedEpoch: null, capabilities: [] }, false],
		["old-epoch", { confirmedEpoch: 0 }, false],
		["revoked", { revoked: true }, false],
		["unknown", { known: false }, false],
		["host", { role: "host:sms" }, false],
	] as const) {
		const allowed = { ...peer, ...change };
		add(
			`access-challenge-${label}`,
			"access",
			{
				route: "challenge",
				peer: allowed,
				operation: { kind: "admin.v1" },
			},
			valid,
		);
		for (const kind of reviewKinds)
			add(
				`access-operation-review-${kind}-${label}`,
				"access",
				{ route: "operation-review", peer: allowed, operation: { kind } },
				valid,
			);
	}
	add("access-challenge-admin-kind", "access", {
		route: "challenge",
		peer,
		operation: { kind: "security.device-capabilities" },
	});
	add("request-challenge", "request", { route: "challenge", value: base.request }, true);
	for (const length of [1024, 1025])
		add(
			`request-challenge-received-${length}`,
			"request",
			{ route: "challenge", value: base.request, padToBytes: length },
			length === 1024,
		);
	add("response-challenge", "response", { route: "challenge", value: base.challenge }, true);
	for (const kind of reviewKinds)
		add(
			`response-operation-review-${kind}`,
			"response",
			{ route: "operation-review", value: part(adminFixture(kind), "review") },
			true,
		);
	add("response-operation-review-refused-kind", "response", {
		route: "operation-review",
		value: part(adminFixture("security.pin-change", device), "review"),
	});
	add("response-operation-review-refused-export", "response", {
		route: "operation-review",
		value: part(adminFixture("data.export", backup), "review"),
	});
	const envelope = {
		statement: part(base, "challenge").statement,
		signature: Buffer.alloc(64).toString("base64url"),
		pin: "123456",
	};
	add("request-admin-envelope", "request", { route: "admin", value: envelope }, true);
	add("request-admin-envelope-wrong-route", "request", { route: "agent-session", value: envelope });

	if (cases.some((value) => !value.id.startsWith("admin-")))
		throw Error("admin vector ids start with admin-");
	if (new Set(cases.map((value) => value.id)).size !== cases.length)
		throw Error("duplicate admin vector id");
	return cases;
}

export interface GrantCase {
	readonly id: string;
	readonly held: unknown;
	readonly subject: unknown;
	readonly valid: boolean;
}
export function grantCases(): GrantCase[] {
	const device = adminSubject("device");
	const subject = (current: string[], capabilities: string[]): ObjectValue => ({
		...device,
		current,
		capabilities,
	});
	const cases: GrantCase[] = [];
	for (const [label, held, granted, valid] of [
		["desktop", presets.desktop, device, true],
		["exact-set-and-admin", ["read", "draft", "organize", "admin"], device, true],
		["unordered-held", ["admin", "draft", "read"], subject(["read"], ["read", "draft"]), true],
		[
			"approver-adds-admin",
			["read", "draft", "approve", "admin"],
			subject(["read", "draft", "approve"], ["read", "draft", "approve", "admin"]),
			true,
		],
		["held-without-admin", ["read", "draft", "organize", "approve"], device, false],
		["held-lacks-added", ["read", "draft", "admin"], device, false],
		[
			"held-lacks-kept",
			["draft", "organize", "approve", "admin"],
			subject(["read", "draft", "approve"], ["read", "draft", "organize", "approve", "admin"]),
			false,
		],
		["held-duplicate", ["read", "draft", "organize", "admin", "admin"], device, false],
		["held-empty", [], device, false],
		["held-owner", ["read", "draft", "organize", "admin", "owner"], device, false],
		["held-host", ["host:sms"], device, false],
		["held-string", "admin", device, false],
		["subject-equal", presets.desktop, subject(["read", "draft"], ["read", "draft"]), false],
		[
			"subject-adds-approve",
			presets.desktop,
			subject(["read", "draft"], ["read", "draft", "approve"]),
			false,
		],
		[
			"subject-adds-admin-without-approve",
			presets.desktop,
			subject(["read", "draft"], ["read", "draft", "admin"]),
			false,
		],
		[
			"subject-cli-to-desktop",
			presets.desktop,
			subject(["read", "draft"], ["read", "draft", "organize", "approve", "admin"]),
			false,
		],
		["subject-unknown-member", presets.desktop, { ...device, extra: true }, false],
		["subject-account", presets.desktop, adminSubject("email"), false],
	] as const)
		cases.push({ id: `admin-grant-${label}`, held, subject: granted, valid });
	if (new Set(cases.map((value) => value.id)).size !== cases.length)
		throw Error("duplicate admin grant id");
	return cases;
}

export const generate = (): VectorFile[] => [
	{
		path: "device-api/admin.json",
		content: {
			format: "draftyak.vectors.device-api.v1",
			description:
				"Admin review subjects, the admin.v1 challenge member and row, and canGrant. reviewKinds lists the admin kinds that have a subject; every other kind is refused at review and challenge. subjectPairs counts the valid security.device-capabilities subjects over every pair of capability sets, and grantPairs the pairs of a nonempty held set and such a subject that canGrant accepts; grants holds canGrant(held, subject) cases.",
			reviewKinds,
			...pairCounts(),
			grants: grantCases(),
			cases: adminCases(),
		},
	},
];
