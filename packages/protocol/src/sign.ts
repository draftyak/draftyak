import { createPublicKey, type KeyObject, sign, verify } from "node:crypto";
import { canonicalize, JcsError, parseStrict } from "./jcs.ts";
import { fromBase64Url, toBase64Url } from "./scalars.ts";

export type SignErrorCode =
	| "SIGN_INVALID_TYP"
	| "SIGN_INVALID_KEY"
	| "SIGN_NOT_OBJECT"
	| "SIGN_UNSAFE_NUMBER";

export class SignError extends Error {
	override name = "SignError";
	readonly code: SignErrorCode;

	constructor(code: SignErrorCode, message: string) {
		super(`${code}: ${message}`);
		this.code = code;
	}
}

// Statement types such as "approval.send.v1": dotted segments of lower-case letters, digits and
// hyphens, each starting with a letter, ending in the major version without a leading zero.
const TYP = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.v[1-9][0-9]*$/;
const encoder = new TextEncoder();

function prefix(typ: string): Uint8Array {
	if (typeof typ !== "string" || !TYP.test(typ)) {
		throw new SignError("SIGN_INVALID_TYP", `${JSON.stringify(typ)} isn't a statement type`);
	}
	return encoder.encode(`draftyak/v1/${typ}\n`);
}

// Every number in a signed form is a safe integer, so no signing input depends on how a language
// writes fractions or large numbers.
function assertSafeIntegers(value: unknown): void {
	if (typeof value === "number") {
		if (!Number.isSafeInteger(value)) {
			throw new SignError("SIGN_UNSAFE_NUMBER", `${value} isn't a safe integer`);
		}
	} else if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) assertSafeIntegers(item);
	}
}

// A statement is a JSON object. Call it on a value canonicalize has accepted.
function assertStatement(value: unknown): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new SignError("SIGN_NOT_OBJECT", "a statement is a JSON object");
	}
	assertSafeIntegers(value);
}

function statementBytes(statement: object): Uint8Array {
	const jcs = encoder.encode(canonicalize(statement));
	assertStatement(statement);
	return jcs;
}

// The UTF-8 of "draftyak/v1/<typ>\n" followed by the statement's JCS bytes.
export function signingInput(typ: string, statement: object): Uint8Array {
	return Buffer.concat([prefix(typ), statementBytes(statement)]);
}

// What `run` returns, or undefined when the statement it reads breaks a JCS or statement rule.
function unlessRefused<T>(run: () => T): T | undefined {
	try {
		return run();
	} catch (error) {
		if (error instanceof JcsError || error instanceof SignError) return undefined;
		throw error;
	}
}

function assertP256(key: KeyObject, type: "public" | "private"): void {
	const curve = key.asymmetricKeyDetails?.namedCurve;
	if (key.type !== type || key.asymmetricKeyType !== "ec" || curve !== "prime256v1") {
		throw new SignError("SIGN_INVALID_KEY", `a P-256 ${type} key is expected`);
	}
}

// A P-256 SubjectPublicKeyInfo up to its uncompressed point, 0x04 ‖ x ‖ y.
const SPKI_P256 = Buffer.from("3059301306072a8648ce3d020106082a8648ce3d03010703420004", "hex");

// The public key as base64url SPKI DER, always the 91-byte uncompressed form: OpenSSL would
// re-export a key read from a compressed point in that compressed form.
export function exportSpki(publicKey: KeyObject): string {
	assertP256(publicKey, "public");
	const { x = "", y = "" } = publicKey.export({ format: "jwk" });
	const der = Buffer.concat([SPKI_P256, Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]);
	if (der.length !== 91)
		throw new SignError("SIGN_INVALID_KEY", "a P-256 point has 32-byte x and y");
	return toBase64Url(der);
}

export function importSpki(spki: string): KeyObject {
	const der = fromBase64Url(spki);
	if (der === undefined) throw new SignError("SIGN_INVALID_KEY", "an SPKI is canonical base64url");
	let key: KeyObject;
	try {
		key = createPublicKey({ key: Buffer.from(der), format: "der", type: "spki" });
	} catch {
		throw new SignError("SIGN_INVALID_KEY", "not an SPKI public key");
	}
	assertP256(key, "public");
	if (exportSpki(key) !== spki) {
		throw new SignError("SIGN_INVALID_KEY", "a P-256 SPKI with an uncompressed point is expected");
	}
	return key;
}

// ES256 over the signing input, the signature as base64url of the 64-byte r‖s.
export function signStatement(typ: string, statement: object, privateKey: KeyObject): string {
	assertP256(privateKey, "private");
	const input = signingInput(typ, statement);
	return toBase64Url(sign("sha256", input, { key: privateKey, dsaEncoding: "ieee-p1363" }));
}

// A signature is canonical base64url of 64 bytes, and a key string canonical SPKI.
function signs(input: Uint8Array, signature: string, publicKey: KeyObject | string): boolean {
	const bytes = fromBase64Url(signature);
	if (bytes?.length !== 64) return false;
	let key: KeyObject;
	try {
		key = typeof publicKey === "string" ? importSpki(publicKey) : publicKey;
	} catch {
		return false;
	}
	return verify("sha256", input, { key, dsaEncoding: "ieee-p1363" }, bytes);
}

// The statement in `received` when those bytes are the canonical JCS of a statement and
// `signature` signs exactly them, otherwise undefined. A statement that arrives from elsewhere is
// opened this way, never parsed first and verified as an object. Like verifyStatement, it throws
// only for a malformed typ or a KeyObject that isn't a P-256 public key.
export function openStatement(
	typ: string,
	received: Uint8Array,
	signature: string,
	publicKey: KeyObject | string,
): Record<string, unknown> | undefined {
	const head = prefix(typ);
	if (typeof publicKey !== "string") assertP256(publicKey, "public");
	if (!(received instanceof Uint8Array)) return undefined;
	const statement = unlessRefused(() => {
		const value = parseStrict(received);
		assertStatement(value);
		return Buffer.from(received).equals(encoder.encode(canonicalize(value))) ? value : undefined;
	});
	if (statement === undefined) return undefined;
	return signs(Buffer.concat([head, received]), signature, publicKey) ? statement : undefined;
}

// For a statement the caller built itself; received bytes are checked as openStatement checks
// them. Whatever is wrong with the statement, the signature or a key string, it returns false;
// only a malformed typ or a KeyObject that isn't a P-256 public key throws.
export function verifyStatement(
	typ: string,
	statement: object,
	signature: string,
	publicKey: KeyObject | string,
): boolean {
	if (statement instanceof Uint8Array) {
		return openStatement(typ, statement, signature, publicKey) !== undefined;
	}
	const head = prefix(typ);
	if (typeof publicKey !== "string") assertP256(publicKey, "public");
	const jcs = unlessRefused(() => statementBytes(statement));
	return jcs !== undefined && signs(Buffer.concat([head, jcs]), signature, publicKey);
}
