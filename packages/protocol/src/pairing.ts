import { createHash, createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import * as z from "zod";
import { copyByteView } from "./device-api/bytes.ts";
import { canonicalize, isCanonical, JcsError, parseStrict } from "./jcs.ts";
import { BASE64URL, fromBase64Url, Sha256Hex, toBase64Url, Ulid, UtcMs } from "./scalars.ts";
import { importSpki } from "./sign.ts";

export const PAIRING_PREFIX = "draftyak-pair:v1:";
export const EKM_LABEL = "EXPERIMENTAL-draftyak-pair-v1";
export const EKM_LENGTH = 32;
export const PID_LENGTH = 16;
export const SEC_LENGTH = 16;
// The device's nonce nd and the hub's nh.
export const NONCE_LENGTH = 16;
export const BOOTSTRAP_SECRET_LENGTH = 16;
// Short enough for one QR code that a phone reads easily off a screen.
export const MAX_PAYLOAD_LENGTH = 1000;
export const MAX_CLAIM_BYTES = 4096;
export const MAX_REVEAL_BYTES = 1024;
const PROOF_LABEL = "draftyak/pair/v1";
const COMMIT_LABEL = "draftyak/sas-commit/v1";
const SAS_LABEL = "draftyak/sas/v1";
const SIDECAR_PID_INFO = "draftyak/pair/v1/sidecar-pid";
const SIDECAR_SEC_INFO = "draftyak/pair/v1/sidecar-sec";

// The SMS contract adds "host:sms" to this line; no other line names a role.
const pairingRoles = ["device"] as const;
export type PairingRole = (typeof pairingRoles)[number];
export const PairingRole: z.ZodEnum<z.core.util.ToEnum<PairingRole>> = z.enum(pairingRoles);

export type PairingErrorCode =
	| "PAIR_PREFIX"
	| "PAIR_ENCODING"
	| "PAIR_PAYLOAD_INVALID"
	| "PAIR_EXPIRED"
	| "PAIR_CLAIM_INVALID"
	| "PAIR_REVEAL_INVALID"
	| "PAIR_INVALID_INPUT";

export class PairingError extends Error {
	override name = "PairingError";
	readonly code: PairingErrorCode;

	constructor(code: PairingErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

// Paths name schema members; member names a sender chose are counted, never repeated, so a
// refusal can't carry forged log lines.
const problems = (error: z.ZodError): string =>
	error.issues
		.map((issue) => {
			const where = issue.path.map(String).join(".") || "value";
			const unknown = issue.code === "unrecognized_keys";
			return `${where}: ${unknown ? `${issue.keys.length} unknown member(s)` : issue.message}`;
		})
		.join("; ");

const Bytes16: z.ZodString = z.string().length(22).regex(BASE64URL);

// host:port, the host being IPv4, bracketed IPv6 or a DNS name. One expression per form, none
// with lookaround (Rust's regex crate has none); the rest are separate checks.
const h16 = "[0-9a-f]{1,4}";
const ipv6 = [
	`(?:${h16}:){7}${h16}`,
	`(?:${h16}:){1,7}:`,
	`(?:${h16}:){1,6}:${h16}`,
	`(?:${h16}:){1,5}(?::${h16}){1,2}`,
	`(?:${h16}:){1,4}(?::${h16}){1,3}`,
	`(?:${h16}:){1,3}(?::${h16}){1,4}`,
	`(?:${h16}:){1,2}(?::${h16}){1,5}`,
	`${h16}:(?::${h16}){1,6}`,
	`:(?:(?::${h16}){1,7}|:)`,
].join("|");
const octet = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// The first octet is 1 to 223: no 0.0.0.0/8, multicast, or 240.0.0.0/4 with the broadcast address.
const IPV4 = new RegExp(`^(?:22[0-3]|2[01][0-9]|1[0-9]{2}|[1-9][0-9]?)(?:\\.${octet}){3}$`);
const IPV6 = new RegExp(`^\\[(?:${ipv6})\\]$`);
const DNS_NAME = new RegExp(`^(?:${label}\\.)*${label}$`);
const PORT =
	/^(?:[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/;

function isAddress(address: string): boolean {
	const colon = address.lastIndexOf(":");
	const host = address.slice(0, colon);
	if (colon < 0 || !PORT.test(address.slice(colon + 1))) return false;
	if (IPV4.test(host)) return true;
	// Neither unspecified (zeros only) nor multicast (ff00::/8).
	if (IPV6.test(host)) return !/^\[[0:]+\]$/.test(host) && !/^\[ff[0-9a-f]{2}:/.test(host);
	// URL parsers read a last label of digits, or of 0x and hex digits, as IPv4.
	const last = host.slice(host.lastIndexOf(".") + 1);
	return host.length <= 253 && DNS_NAME.test(host) && !/^(?:[0-9]+|0x[0-9a-f]*)$/.test(last);
}

const Addresses: z.ZodArray<z.ZodString> = z
	.array(
		z.string().refine(isAddress, { message: "an address is host:port in the pairing grammar" }),
	)
	.min(1)
	.max(8)
	.refine((list) => new Set(list).size === list.length, { message: "an address repeats" });

const among =
	(ranges: readonly (readonly [number, number])[]) =>
	(point: number): boolean =>
		ranges.some(([first, last]) => point >= first && point <= last);
type PointRanges = readonly (readonly [number, number])[];
const frozenRanges = (ranges: PointRanges): PointRanges =>
	Object.freeze(ranges.map(([first, last]) => Object.freeze([first, last] as const)));
// Controls, separators, interlinear annotation and Unicode 17's default-ignorable code points
// other than the joiners and variation selectors: what would hide or reorder a shown name.
export const DISPLAY_NAME_HIDDEN_RANGES: PointRanges = frozenRanges([
	[0x00, 0x1f],
	[0x7f, 0x9f],
	[0xad, 0xad],
	[0x34f, 0x34f],
	[0x61c, 0x61c],
	[0x115f, 0x1160],
	[0x17b4, 0x17b5],
	[0x180e, 0x180e],
	[0x200b, 0x200b],
	[0x200e, 0x200f],
	[0x2028, 0x202e],
	[0x2060, 0x206f],
	[0x3164, 0x3164],
	[0xfeff, 0xfeff],
	[0xffa0, 0xffa0],
	[0xfff0, 0xfffb],
	[0x1bca0, 0x1bca3],
	[0x1d173, 0x1d17a],
	[0xe0000, 0xe00ff],
	[0xe01f0, 0xe0fff],
]);
// The white space left, and the braille blank: never first or last.
export const DISPLAY_NAME_BLANK_RANGES: PointRanges = frozenRanges([
	[0x20, 0x20],
	[0xa0, 0xa0],
	[0x1680, 0x1680],
	[0x2000, 0x200a],
	[0x202f, 0x202f],
	[0x205f, 0x205f],
	[0x2800, 0x2800],
	[0x3000, 0x3000],
]);
// The joiners and variation selectors, which emoji and some scripts need, show nothing alone.
export const DISPLAY_NAME_JOINER_RANGES: PointRanges = frozenRanges([
	[0x180b, 0x180d],
	[0x180f, 0x180f],
	[0x200c, 0x200d],
	[0xfe00, 0xfe0f],
	[0xe0100, 0xe01ef],
]);
const hidden = among(DISPLAY_NAME_HIDDEN_RANGES);
const blank = among(DISPLAY_NAME_BLANK_RANGES);
const joiner = among(DISPLAY_NAME_JOINER_RANGES);
// The hub's name in a payload, and a device's in its claim and in the hub's record (Device.name).
// One check, so a bad name is one problem; the bounds reach JSON Schema as boundedText's do.
export const DisplayName: z.ZodString = z
	.string()
	.refine(
		(text) => {
			const points = [...text].map((char) => char.codePointAt(0) ?? 0);
			const ends = [points[0] ?? 0x20, points.at(-1) ?? 0x20];
			const visible = points.some((point) => !blank(point) && !joiner(point));
			const clean = !points.some(hidden) && !ends.some(blank);
			return text.isWellFormed() && points.length <= 64 && visible && clean;
		},
		{ message: "1 to 64 code points, visible, without hidden ones or a blank first or last" },
	)
	.meta({
		id: "draftyak.pairing.DisplayName",
		minLength: 1,
		maxLength: 64,
		description:
			"A display name: 1 to 64 code points under the rules of spec/pairing-v1.md section 2: no " +
			"hidden code point, no blank first or last, and at least one code point that is neither " +
			"a blank nor a joiner. JSON Schema can't state the rules, only the length.",
	});

export const PairingPayload: z.ZodObject<
	{
		hid: z.ZodString;
		addr: z.ZodArray<z.ZodString>;
		pid: z.ZodString;
		sec: z.ZodString;
		exp: z.ZodInt;
		name: z.ZodString;
		role: typeof PairingRole;
	},
	z.core.$strict
> = z.strictObject({
	hid: Sha256Hex,
	addr: Addresses,
	pid: Bytes16,
	sec: Bytes16,
	exp: UtcMs,
	name: DisplayName,
	role: PairingRole,
});
export type PairingPayload = z.infer<typeof PairingPayload>;

export function encodePairingPayload(payload: PairingPayload): string {
	const checked = PairingPayload.safeParse(payload);
	if (!checked.success) throw new PairingError("PAIR_PAYLOAD_INVALID", problems(checked.error));
	const text = `${PAIRING_PREFIX}${toBase64Url(Buffer.from(canonicalize(checked.data)))}`;
	if (text.length > MAX_PAYLOAD_LENGTH) {
		throw new PairingError("PAIR_ENCODING", `a code is at most ${MAX_PAYLOAD_LENGTH} characters`);
	}
	return text;
}

// The checks run in this order, and the first that fails gives the code.
export function decodePairingPayload(text: string, now: number): PairingPayload {
	if (!Number.isSafeInteger(now)) throw new PairingError("PAIR_INVALID_INPUT", "now is UTC ms");
	if (typeof text !== "string" || !text.startsWith(PAIRING_PREFIX)) {
		throw new PairingError("PAIR_PREFIX", `a pairing code starts with ${PAIRING_PREFIX}`);
	}
	const encoded = text.slice(PAIRING_PREFIX.length);
	const bytes = text.length > MAX_PAYLOAD_LENGTH ? undefined : fromBase64Url(encoded);
	if (bytes === undefined || !isCanonical(bytes)) {
		throw new PairingError("PAIR_ENCODING", "not canonical base64url of canonical JSON");
	}
	const payload = PairingPayload.safeParse(parseStrict(bytes));
	if (!payload.success) throw new PairingError("PAIR_PAYLOAD_INVALID", problems(payload.error));
	if (payload.data.exp < now) throw new PairingError("PAIR_EXPIRED", "the pairing window closed");
	return payload.data;
}

// The hub's ID as both screens show it, from the first 8 bytes of its SPKI hash.
export function displayHubId(hid: string): string {
	if (!Sha256Hex.safeParse(hid).success) {
		throw new PairingError("PAIR_INVALID_INPUT", "hid is a lower-case hex SHA-256");
	}
	return `DYK-${hid.slice(0, 16).toUpperCase().match(/.{4}/g)?.join("-")}`;
}

function sized(bytes: Uint8Array, length: number, what: string): Uint8Array {
	if (!(bytes instanceof Uint8Array) || bytes.length !== length) {
		throw new PairingError("PAIR_INVALID_INPUT", `${what} is ${length} bytes`);
	}
	return bytes;
}

const decoded = (text: string, length: number, what: string): Uint8Array =>
	sized(fromBase64Url(text) ?? new Uint8Array(), length, what);

// What a Node TLSSocket offers; rustls calls export_keying_material with the same three values.
export interface KeyingMaterialExporter {
	exportKeyingMaterial(length: number, label: string, context: Buffer): Uint8Array;
}

export function pairingEkm(socket: KeyingMaterialExporter, pid: string): Uint8Array {
	const context = Buffer.from(decoded(pid, PID_LENGTH, "pid"));
	const ekm = socket.exportKeyingMaterial(EKM_LENGTH, EKM_LABEL, context);
	return new Uint8Array(sized(ekm, EKM_LENGTH, "the exported keying material"));
}

// The transport certificate's SPKI hash, then the signing key's uncompressed SEC1 point.
export function pairingPubs(transportSpkiSha256: string, signingKey: string): Uint8Array {
	if (!Sha256Hex.safeParse(transportSpkiSha256).success) {
		throw new PairingError("PAIR_INVALID_INPUT", "transportSpkiSha256 is a lower-case hex SHA-256");
	}
	try {
		importSpki(signingKey);
	} catch {
		throw new PairingError("PAIR_INVALID_INPUT", "signingKey is a P-256 SPKI in base64url");
	}
	const point = (fromBase64Url(signingKey) ?? new Uint8Array()).subarray(26);
	return Buffer.concat([Buffer.from(transportSpkiSha256, "hex"), point]);
}

// SHA-256("draftyak/sas-commit/v1" ‖ nd) in lower-case hex: the claim's c, which only nd opens.
export function pairingCommitment(nd: Uint8Array): string {
	return createHash("sha256")
		.update(COMMIT_LABEL)
		.update(sized(nd, NONCE_LENGTH, "nd"))
		.digest("hex");
}

// HMAC-SHA-256 keyed with sec over "draftyak/pair/v1" ‖ ekm ‖ bound, the S10 skeleton's
// pair_proof. A claim's bound is pubs ‖ c.
export function pairingProof(sec: Uint8Array, ekm: Uint8Array, bound: Uint8Array): Uint8Array {
	if (!(bound instanceof Uint8Array)) {
		throw new PairingError("PAIR_INVALID_INPUT", "bound is bytes");
	}
	const hmac = createHmac("sha256", sized(sec, SEC_LENGTH, "sec")).update(PROOF_LABEL);
	return new Uint8Array(
		hmac
			.update(sized(ekm, EKM_LENGTH, "ekm"))
			.update(bound)
			.digest(),
	);
}

export function verifyPairingProof(
	sec: Uint8Array,
	ekm: Uint8Array,
	bound: Uint8Array,
	proof: Uint8Array,
): boolean {
	const expected = pairingProof(sec, ekm, bound);
	const same = proof instanceof Uint8Array && proof.length === expected.length;
	return same && timingSafeEqual(expected, proof);
}

// Six digits, leading zeros kept:
// u32_be(SHA-256("draftyak/sas/v1" ‖ ekm ‖ nd ‖ nh)[0..4]) mod 10^6.
export function pairingSas(ekm: Uint8Array, nd: Uint8Array, nh: Uint8Array): string {
	const hash = createHash("sha256")
		.update(SAS_LABEL)
		.update(sized(ekm, EKM_LENGTH, "ekm"))
		.update(sized(nd, NONCE_LENGTH, "nd"))
		.update(sized(nh, NONCE_LENGTH, "nh"));
	return String(hash.digest().readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

// The SAS as the pair-confirm review carries it.
export const PairingSas: z.ZodString = z
	.string()
	.length(6)
	.regex(/^[0-9]{6}$/)
	.meta({ description: "A pairing SAS: six ASCII digits, leading zeros kept." });

const SigningKey: z.ZodString = z.string().refine(
	(spki) => {
		try {
			return importSpki(spki) !== undefined;
		} catch {
			return false;
		}
	},
	{ message: "a P-256 SPKI with an uncompressed point, in canonical base64url" },
);
const Hex32: z.ZodString = z
	.string()
	.length(64)
	.regex(/^[0-9a-f]{64}$/);

export const PairingClaim: z.ZodObject<
	{
		pid: z.ZodString;
		role: typeof PairingRole;
		name: z.ZodString;
		transportSpkiSha256: z.ZodString;
		signingKey: z.ZodString;
		c: z.ZodString;
		proof: z.ZodString;
	},
	z.core.$strict
> = z.strictObject({
	pid: Bytes16,
	role: PairingRole,
	name: DisplayName,
	transportSpkiSha256: Sha256Hex,
	signingKey: SigningKey,
	c: Sha256Hex,
	proof: Hex32,
});
export type PairingClaim = z.infer<typeof PairingClaim>;

export const PairingResult: z.ZodObject<
	{ deviceId: z.ZodString; epoch: z.ZodInt; nh: z.ZodString },
	z.core.$strict
> = z.strictObject({ deviceId: Ulid, epoch: z.int().min(0), nh: Bytes16 });
export type PairingResult = z.infer<typeof PairingResult>;

// The window whose claim it opens, and the nonce that claim's c commits to.
export const PairingReveal: z.ZodObject<{ pid: z.ZodString; nd: z.ZodString }, z.core.$strict> =
	z.strictObject({ pid: Bytes16, nd: Bytes16 });
export type PairingReveal = z.infer<typeof PairingReveal>;

const refusalCodes = [
	"PAIR_WINDOW_CLOSED",
	"PAIR_CLAIM_INVALID",
	"PAIR_ROLE_MISMATCH",
	"PAIR_PROOF_INVALID",
	"PAIR_REVEAL_INVALID",
	"PAIR_COMMITMENT_MISMATCH",
] as const;
export type PairingRefusalCode = (typeof refusalCodes)[number];
export const PairingRefusal: z.ZodObject<
	{ code: z.ZodEnum<z.core.util.ToEnum<PairingRefusalCode>> },
	z.core.$strict
> = z.strictObject({ code: z.enum(refusalCodes) });
export type PairingRefusal = z.infer<typeof PairingRefusal>;

export type PairingWindow = Pick<PairingPayload, "pid" | "role" | "sec">;
export interface PairingDevice {
	readonly name: string;
	readonly transportSpkiSha256: string;
	readonly signingKey: string;
}
// The live connection as the hub sees it: its EKM and the client certificate's SPKI hash.
export interface PairingConnection {
	readonly ekm: Uint8Array;
	readonly clientSpkiSha256: string;
}

// The sidecar's device window from the bootstrap secret in the supervisor's unlock frame:
// HKDF-SHA-256 with an empty salt, one info label each.
export function sidecarWindowSecrets(
	bootstrapSecret: Uint8Array,
): Pick<PairingWindow, "pid" | "sec"> {
	const secret = sized(bootstrapSecret, BOOTSTRAP_SECRET_LENGTH, "the bootstrap secret");
	const derive = (info: string, length: number): string =>
		toBase64Url(new Uint8Array(hkdfSync("sha256", secret, new Uint8Array(), info, length)));
	return { pid: derive(SIDECAR_PID_INFO, PID_LENGTH), sec: derive(SIDECAR_SEC_INFO, SEC_LENGTH) };
}

// What a claim's proof covers after the EKM: pubs, then the 32 bytes of c, whose form the
// callers have checked.
function claimBound(transportSpkiSha256: string, signingKey: string, c: string): Uint8Array {
	return Buffer.concat([pairingPubs(transportSpkiSha256, signingKey), Buffer.from(c, "hex")]);
}

// The device's claim, committing to its nonce nd, which it reveals once it has the hub's answer.
export function makePairingClaim(
	window: PairingWindow,
	device: PairingDevice,
	ekm: Uint8Array,
	nd: Uint8Array,
): PairingClaim {
	const c = pairingCommitment(nd);
	const bound = claimBound(device.transportSpkiSha256, device.signingKey, c);
	const proof = pairingProof(decoded(window.sec, SEC_LENGTH, "sec"), ekm, bound);
	const claim = PairingClaim.safeParse({
		pid: window.pid,
		role: window.role,
		name: device.name,
		transportSpkiSha256: device.transportSpkiSha256,
		signingKey: device.signingKey,
		c,
		proof: Buffer.from(proof).toString("hex"),
	});
	if (!claim.success) throw new PairingError("PAIR_INVALID_INPUT", problems(claim.error));
	return claim.data;
}

// A body as the hub receives it: strict JSON, not necessarily canonical, whose received bytes are
// measured before anything parses them.
function readBody(
	body: string | Uint8Array,
	limit: number,
	code: "PAIR_CLAIM_INVALID" | "PAIR_REVEAL_INVALID",
	what: string,
): unknown {
	let received: string | Uint8Array | undefined;
	if (typeof body === "string") received = Buffer.byteLength(body) <= limit ? body : undefined;
	else received = copyByteView(body, limit);
	if (received === undefined) throw new PairingError(code, `${what} is at most ${limit} bytes`);
	try {
		return parseStrict(received);
	} catch (error) {
		// The code alone: a JCS message can quote a member name the sender chose.
		if (error instanceof JcsError) throw new PairingError(code, `not strict JSON (${error.code})`);
		throw error;
	}
}

export function readPairingClaim(body: string | Uint8Array): PairingClaim {
	const value = readBody(body, MAX_CLAIM_BYTES, "PAIR_CLAIM_INVALID", "a claim");
	const claim = PairingClaim.safeParse(value);
	if (!claim.success) throw new PairingError("PAIR_CLAIM_INVALID", problems(claim.error));
	return claim.data;
}

// The hub's check of a claim on the window its pid names; undefined when it holds.
export function verifyPairingClaim(
	claim: PairingClaim,
	window: PairingWindow,
	connection: PairingConnection,
): PairingRefusalCode | undefined {
	const checked = PairingClaim.safeParse(claim);
	if (!checked.success) return "PAIR_CLAIM_INVALID";
	const { pid, role, transportSpkiSha256, signingKey, c } = checked.data;
	if (pid !== window.pid) return "PAIR_WINDOW_CLOSED";
	if (role !== window.role) return "PAIR_ROLE_MISMATCH";
	if (transportSpkiSha256 !== connection.clientSpkiSha256) return "PAIR_PROOF_INVALID";
	const bound = claimBound(transportSpkiSha256, signingKey, c);
	const sec = decoded(window.sec, SEC_LENGTH, "sec");
	const proof = Buffer.from(checked.data.proof, "hex");
	return verifyPairingProof(sec, connection.ekm, bound, proof) ? undefined : "PAIR_PROOF_INVALID";
}

export function readPairingReveal(body: string | Uint8Array): PairingReveal {
	const value = readBody(body, MAX_REVEAL_BYTES, "PAIR_REVEAL_INVALID", "a reveal");
	const reveal = PairingReveal.safeParse(value);
	if (!reveal.success) throw new PairingError("PAIR_REVEAL_INVALID", problems(reveal.error));
	return reveal.data;
}

// The hub's check of a reveal against the claim that held on the reveal's connection and awaits
// it; undefined when the reveal names that claim's window and its nd opens the claim's c.
export function verifyPairingReveal(
	reveal: PairingReveal,
	claim: PairingClaim,
): PairingRefusalCode | undefined {
	const held = PairingClaim.safeParse(claim);
	if (!held.success) throw new PairingError("PAIR_INVALID_INPUT", "claim is the claim that held");
	const checked = PairingReveal.safeParse(reveal);
	if (!checked.success) return "PAIR_REVEAL_INVALID";
	if (checked.data.pid !== held.data.pid) return "PAIR_WINDOW_CLOSED";
	const nd = decoded(checked.data.nd, NONCE_LENGTH, "nd");
	const opened = Buffer.from(pairingCommitment(nd), "hex");
	const committed = Buffer.from(held.data.c, "hex");
	return timingSafeEqual(opened, committed) ? undefined : "PAIR_COMMITMENT_MISMATCH";
}
