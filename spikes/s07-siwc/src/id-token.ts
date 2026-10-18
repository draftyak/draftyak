import { createPublicKey, type KeyObject, verify, type webcrypto } from "node:crypto";
import { SiwcError } from "./errors.ts";

// Registration and sign-in, step 4.

type JsonWebKey = webcrypto.JsonWebKey & { readonly kid?: unknown };

export interface IdTokenCheck {
	readonly issuer: string;
	readonly jwksUri: string;
	readonly clientId: string;
	readonly nonce: string;
	readonly now: number;
	readonly fetch: typeof fetch;
}

export interface Identity {
	readonly subject: string;
	readonly email?: string;
}

const SKEW_S = 30;
const ALGORITHMS = new Map([
	["RS256", { kty: "RSA", ec: false }],
	["ES256", { kty: "EC", ec: true }],
]);

const bad = (detail: string): SiwcError => new SiwcError("ID_TOKEN_INVALID", { detail });

function decode(part: string | undefined): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(Buffer.from(part ?? "", "base64url").toString("utf8"));
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
	} catch {}
	throw bad("malformed");
}

async function keyFor(check: IdTokenCheck, kid: unknown, kty: string): Promise<KeyObject> {
	const response = await check
		.fetch(check.jwksUri, {
			headers: { accept: "application/json" },
			redirect: "error",
			signal: AbortSignal.timeout(30_000),
		})
		.catch(() => undefined);
	const keys = ((await response?.json().catch(() => undefined)) as { keys?: unknown })?.keys;
	if (!response?.ok || !Array.isArray(keys)) throw bad("jwks unavailable");
	const found = (keys as JsonWebKey[]).find(
		(key) => key.kid === kid && key.kty === kty && (key.use === undefined || key.use === "sig"),
	);
	if (!found) throw bad("unknown signing key");
	try {
		return createPublicKey({ key: found, format: "jwk" });
	} catch {
		throw bad("jwks unavailable");
	}
}

export async function verifyIdToken(token: string, check: IdTokenCheck): Promise<Identity> {
	const parts = token.split(".");
	if (parts.length !== 3) throw bad("malformed");
	const [head, body, signature] = parts as [string, string, string];
	const header = decode(head);
	const claims = decode(body);
	const algorithm = ALGORITHMS.get(String(header.alg));
	if (algorithm === undefined || typeof header.kid !== "string") throw bad("unsupported algorithm");
	const key = await keyFor(check, header.kid, algorithm.kty);
	const proof = Buffer.from(signature, "base64url");
	const options = algorithm.ec ? { key, dsaEncoding: "ieee-p1363" as const } : key;
	if (!verify("sha256", Buffer.from(`${head}.${body}`), options, proof)) throw bad("signature");
	const now = Math.floor(check.now / 1000);
	const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (claims.iss !== check.issuer) throw bad("issuer");
	if (!audience.includes(check.clientId)) throw bad("audience");
	if (audience.length > 1 && claims.azp !== check.clientId) throw bad("authorized party");
	if (typeof claims.exp !== "number" || claims.exp + SKEW_S <= now) throw bad("expired");
	if (typeof claims.iat !== "number" || claims.iat - SKEW_S > now)
		throw bad("issued in the future");
	if (claims.nonce !== check.nonce) throw bad("nonce");
	if (typeof claims.sub !== "string" || claims.sub === "") throw bad("subject");
	return { subject: claims.sub, ...(typeof claims.email === "string" && { email: claims.email }) };
}
