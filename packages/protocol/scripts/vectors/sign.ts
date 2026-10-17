import { canonicalize } from "../../src/jcs.ts";
import { fromBase64Url, toBase64Url } from "../../src/scalars.ts";
import { SignError, signingInput, verifyStatement } from "../../src/sign.ts";
import { keptSignature, type TestKey, testKey } from "../lib.ts";
import type { VectorContext, VectorFile } from "../vectors.ts";

const file = "sign/es256.json";
const TYP = "test-statement.v1";
const statement = {
	v: 1,
	hub: "01JAZ3W3B6Q8M2V0G5T9K4X7RC",
	nonce: "AAECAwQFBgcICQoLDA0ODw",
	iat: 1792000000000,
	exp: 1792000120000,
	note: "Gr\u{fc}\u{df}e \u{2713} \u{1f600}",
};

interface Recorded {
	readonly keys?: { readonly signer?: unknown; readonly other?: unknown };
	readonly cases?: readonly { readonly id?: unknown; readonly signature?: unknown }[];
}

// The same r and s as an ASN.1 DER sequence, an encoding the protocol never accepts.
function derEncoded(signature: Uint8Array): Uint8Array {
	const integer = (bytes: Uint8Array): number[] => {
		let start = 0;
		while (start < bytes.length - 1 && bytes[start] === 0) start++;
		const body = [...bytes.subarray(start)];
		if ((body[0] ?? 0) >= 0x80) body.unshift(0);
		return [0x02, body.length, ...body];
	};
	const content = [...integer(signature.subarray(0, 32)), ...integer(signature.subarray(32))];
	return new Uint8Array([0x30, content.length, ...content]);
}

// The same key with its point compressed, which a lax SPKI reader accepts.
function compressedSpki(spki: string): string {
	const der = fromBase64Url(spki) ?? new Uint8Array();
	const header = Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex");
	const parity = (der.at(-1) ?? 0) & 1;
	return toBase64Url(Buffer.concat([header, Buffer.of(2 + parity), der.subarray(27, 59)]));
}

function flipLastBit(encoded: string): string {
	const bytes = fromBase64Url(encoded) ?? new Uint8Array();
	bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 1;
	return toBase64Url(bytes);
}

// The same bytes with an unused low bit of the last character set, which a lax decoder accepts.
function looseEncoding(encoded: string): string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
	const loose = `${encoded.slice(0, -1)}${alphabet[alphabet.indexOf(encoded.at(-1) ?? "") + 1]}`;
	const same = Buffer.from(loose, "base64url").equals(Buffer.from(encoded, "base64url"));
	if (!same || fromBase64Url(loose) !== undefined) throw new Error(`${encoded} has no loose form`);
	return loose;
}

// What a signature over a typ and a body covers, even where signingInput refuses to build it.
const rawInput = (typ: string, body: string): Uint8Array =>
	Buffer.from(`draftyak/v1/${typ}\n${body}`);

function refusal(typ: string, body: object): string | undefined {
	try {
		signingInput(typ, body);
		return undefined;
	} catch (error) {
		if (error instanceof SignError) return error.code;
		throw error;
	}
}

export function generate(context: VectorContext): VectorFile[] {
	const recorded = context.previous(file) as Recorded | undefined;
	const signer: TestKey = testKey(recorded?.keys?.signer);
	const other: TestKey = testKey(recorded?.keys?.other);
	const kept = (id: string, input: Uint8Array): string => {
		const previous = recorded?.cases?.find((item) => item.id === id)?.signature;
		return keptSignature(previous, input, signer);
	};
	const spki = signer.record.publicKeySpki;
	const jcs = canonicalize(statement);
	const signature = kept("valid", rawInput(TYP, jcs));

	const variant = (id: string, change: object, valid: boolean): object => {
		const item = { id, typ: TYP, statement, publicKeySpki: spki, signature, ...change };
		const error = refusal(item.typ, item.statement);
		const verified =
			error !== "SIGN_INVALID_TYP" &&
			verifyStatement(item.typ, item.statement, item.signature, item.publicKeySpki);
		if (verified !== valid)
			throw new Error(`sign ${id}: expected ${valid ? "a valid" : "an invalid"} signature`);
		const body = canonicalize(item.statement);
		const input = Buffer.from(rawInput(item.typ, body)).toString("hex");
		const refused = error === undefined ? {} : { error };
		return { ...item, jcs: body, signingInputHex: input, ...refused, valid };
	};
	// A case whose signature correctly signs its own typ and statement.
	const signed = (id: string, change: { typ?: string; statement?: unknown }, valid: boolean) => {
		const input = rawInput(change.typ ?? TYP, canonicalize(change.statement ?? statement));
		return variant(id, { ...change, signature: kept(id, input) }, valid);
	};
	// Received bytes that aren't canonical, with a correct signature over exactly those bytes.
	const received = (id: string, text: string): object => {
		const bytes = Buffer.from(text);
		const input = rawInput(TYP, text);
		const item = {
			id,
			typ: TYP,
			receivedHex: bytes.toString("hex"),
			publicKeySpki: spki,
			signature: kept(id, input),
			signingInputHex: Buffer.from(input).toString("hex"),
			valid: false,
		};
		if (verifyStatement(TYP, bytes, item.signature, spki))
			throw new Error(`sign ${id}: the received bytes verified`);
		return item;
	};
	const der = toBase64Url(derEncoded(fromBase64Url(signature) ?? new Uint8Array()));
	const outOfRange = toBase64Url(new Uint8Array(64).fill(255));
	const cases = [
		variant("valid", {}, true),
		variant("statement-byte-changed", { statement: { ...statement, iat: 1792000000001 } }, false),
		variant("signature-bit-flipped", { signature: flipLastBit(signature) }, false),
		variant("key-bit-flipped", { publicKeySpki: flipLastBit(spki) }, false),
		variant("other-key", { publicKeySpki: other.record.publicKeySpki }, false),
		variant("typ-byte-changed", { typ: "test-statement.v2" }, false),
		variant("der-encoded-signature", { signature: der }, false),
		variant("zero-signature", { signature: toBase64Url(new Uint8Array(64)) }, false),
		variant("out-of-range-signature", { signature: outOfRange }, false),
		variant("signature-not-canonical-base64url", { signature: looseEncoding(signature) }, false),
		variant("key-not-canonical-base64url", { publicKeySpki: looseEncoding(spki) }, false),
		variant("key-compressed-point", { publicKeySpki: compressedSpki(spki) }, false),
		signed("fraction-in-statement", { statement: { ...statement, iat: 1792000000000.5 } }, false),
		signed("unsafe-integer-in-statement", { statement: { ...statement, iat: 2 ** 53 } }, false),
		signed("statement-is-string", { statement: jcs }, false),
		signed("statement-is-array", { statement: [statement] }, false),
		signed("typ-digits-and-hyphens", { typ: "test-2.statement-x.v10" }, true),
		signed("typ-upper-case-version", { typ: "test-statement.V1" }, false),
		signed("typ-version-zero", { typ: "test-statement.v0" }, false),
		signed("typ-version-leading-zero", { typ: "test-statement.v01" }, false),
		signed("typ-segment-starting-with-digit", { typ: "test.2-statement.v1" }, false),
		received("received-inner-space", jcs.replace(",", ", ")),
		received("received-trailing-line-feed", `${jcs}\n`),
		received("received-members-in-other-order", JSON.stringify(statement)),
		received("received-duplicate-member", `{"v":2,${jcs.slice(1)}`),
	];
	const description =
		'ES256 statement signatures. "signingInputHex" is the case\'s signing input: the UTF-8 of ' +
		'"draftyak/v1/<typ>\\n" followed by "jcs", the statement\'s canonical JSON, which verifies ' +
		'as received bytes exactly as the statement does. "signature" is base64url of the 64-byte ' +
		'r||s and "publicKeySpki" base64url SPKI DER with the uncompressed point, both canonical: ' +
		"the same bytes with an unused low bit set, or the point compressed, never verify. Each " +
		'case verifies as "valid" says. A case with "error" holds a correct signature over its ' +
		"signing input but breaks a rule: a typ is dotted segments of lower-case letters, digits " +
		"and hyphens, each starting with a letter, ending in .v and the major version without a " +
		"leading zero; a statement is a JSON object, and every number in it a safe integer. " +
		"Building its signing input fails with that code, and it never verifies. A case with " +
		'"receivedHex" gives a statement as received, in bytes that aren\'t canonical JCS, and a ' +
		'correct signature over "draftyak/v1/<typ>\\n" followed by exactly those bytes: a verifier ' +
		'checks the bytes first, so it never verifies. "keys" are test-only keys made for these ' +
		'vectors and never used anywhere else; "signer" made every signature.';
	return [
		{
			path: file,
			content: {
				format: "draftyak.vectors.sign.v1",
				description,
				keys: { signer: signer.record, other: other.record },
				cases,
			},
		},
	];
}
