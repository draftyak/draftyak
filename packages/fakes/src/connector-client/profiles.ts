import {
	constants,
	createHash,
	createPublicKey,
	type KeyObject,
	randomBytes,
	sign,
} from "node:crypto";
import { types } from "node:util";
import { jsonObject, MAX_CONNECTOR_RESPONSE_BYTES, refused, text } from "./data.ts";

export type ConnectorProfileName =
	| "cimd-public"
	| "issuer-resource"
	| "cimd-private"
	| "loopback-cimd"
	| "registered-public";

export type ConnectorAuthMethod = "none" | "private_key_jwt";

export interface ConnectorProfileOptions {
	readonly profile: ConnectorProfileName;
	readonly clientId?: string;
	readonly redirectUri: string;
	readonly metadata?: unknown;
	readonly privateKey?: KeyObject;
	readonly assertionAudience?: string;
}

export interface NormalizedConnectorProfile {
	readonly clientId: string;
	readonly redirectUri: string;
	readonly authMethod: ConnectorAuthMethod;
	readonly requirements: {
		readonly cimd: boolean;
		readonly authMethod: ConnectorAuthMethod;
	};
	clientMetadata(): Readonly<Record<string, unknown>>;
	clientJwks(): Readonly<Record<string, unknown>> | undefined;
	authenticateForm(form: URLSearchParams, endpoint: string): void;
}

const OPTION_KEYS = [
	"profile",
	"clientId",
	"redirectUri",
	"metadata",
	"privateKey",
	"assertionAudience",
] as const;

function options(raw: unknown): Record<string, unknown> {
	if (typeof raw !== "object" || raw === null || types.isProxy(raw)) refused();
	const prototype = Object.getPrototypeOf(raw);
	if (prototype !== null && prototype !== Object.prototype) refused();
	const result = Object.create(null) as Record<string, unknown>;
	for (const key of Reflect.ownKeys(raw)) {
		if (typeof key !== "string" || !OPTION_KEYS.includes(key as (typeof OPTION_KEYS)[number]))
			refused();
		const descriptor = Object.getOwnPropertyDescriptor(raw, key);
		if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) refused();
		result[key] = descriptor.value;
	}
	if (!("profile" in result) || !("redirectUri" in result)) refused();
	return result;
}

// Copy public JSON data without consulting getters, iterators or serialization hooks.
function metadataSnapshot(raw: unknown): Readonly<Record<string, unknown>> {
	if (typeof raw === "string") {
		if (Buffer.byteLength(raw) > MAX_CONNECTOR_RESPONSE_BYTES) refused();
		return jsonObject(raw);
	}
	let nodes = 0,
		bytes = 0;
	const charge = (amount: number): void => {
		if (amount > MAX_CONNECTOR_RESPONSE_BYTES - bytes) refused();
		bytes += amount;
	};
	function copy(value: unknown, depth: number): unknown {
		if (++nodes > 2048 || depth > 16) refused();
		if (value === null || typeof value === "boolean") {
			charge(value === null ? 4 : value ? 4 : 5);
			return value;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) refused();
			charge(Buffer.byteLength(JSON.stringify(value)));
			return value;
		}
		if (typeof value === "string") {
			if (value.length > MAX_CONNECTOR_RESPONSE_BYTES || !value.isWellFormed()) refused();
			charge(Buffer.byteLength(JSON.stringify(value)));
			return value;
		}
		if (typeof value !== "object" || types.isProxy(value)) refused();
		const array = Array.isArray(value);
		const prototype = Object.getPrototypeOf(value);
		if (
			array ? prototype !== Array.prototype : prototype !== null && prototype !== Object.prototype
		)
			refused();
		const result: unknown[] | Record<string, unknown> = array
			? []
			: (Object.create(null) as Record<string, unknown>);
		const keys = Reflect.ownKeys(value);
		charge(2);
		let count = 0;
		let members = 0;
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (!descriptor || !("value" in descriptor)) refused();
			if (array && key === "length") continue;
			if (
				typeof key !== "string" ||
				!descriptor.enumerable ||
				key.length > 2048 ||
				!key.isWellFormed()
			)
				refused();
			if (array && key !== String(count++)) refused();
			charge((members++ === 0 ? 0 : 1) + (array ? 0 : Buffer.byteLength(JSON.stringify(key)) + 1));
			(result as Record<string, unknown>)[key] = copy(descriptor.value, depth + 1);
		}
		if (array && Object.getOwnPropertyDescriptor(value, "length")?.value !== count) refused();
		return Object.freeze(result);
	}
	const result = copy(raw, 0);
	if (typeof result !== "object" || result === null || Array.isArray(result)) refused();
	if (Buffer.byteLength(JSON.stringify(result)) > MAX_CONNECTOR_RESPONSE_BYTES) refused();
	return result as Readonly<Record<string, unknown>>;
}

function canonicalUrl(value: unknown): URL {
	const raw = text(value);
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return refused();
	}
	if (
		parsed.href !== raw ||
		parsed.hostname === "" ||
		parsed.username !== "" ||
		parsed.password !== "" ||
		(raw.includes("?") && parsed.search === "") ||
		raw.includes("#")
	)
		refused();
	return parsed;
}

function httpsUrl(value: unknown): string {
	const parsed = canonicalUrl(value);
	if (parsed.protocol !== "https:") refused();
	return parsed.href;
}

function loopback(url: URL): boolean {
	return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function redirect(value: unknown): string {
	const parsed = canonicalUrl(value);
	if (parsed.protocol !== "https:" && !loopback(parsed)) refused();
	for (const name of parsed.searchParams.keys())
		if (["iss", "state", "code", "error", "error_description", "error_uri"].includes(name))
			refused();
	return parsed.href;
}

function identity(value: unknown, cimd: boolean): string {
	const raw = text(value);
	if (cimd || raw.startsWith("https:")) return httpsUrl(raw);
	if (raw.includes("://")) refused();
	return raw;
}

function matchesRedirect(selected: string, recorded: string, portAgnostic: boolean): boolean {
	if (selected === recorded) return true;
	if (!portAgnostic) return false;
	const candidate = new URL(selected),
		allowed = new URL(recorded);
	if (!loopback(candidate) || !loopback(allowed)) return false;
	candidate.port = "";
	allowed.port = "";
	return candidate.href === allowed.href;
}

function publicJwks(value: unknown): void {
	if (typeof value !== "object" || value === null || Array.isArray(value)) refused();
	const keys = (value as Readonly<Record<string, unknown>>).keys;
	if (!Array.isArray(keys) || keys.length < 1 || keys.length > 16) refused();
	for (const key of keys) {
		if (typeof key !== "object" || key === null || Array.isArray(key)) refused();
		if (["d", "p", "q", "dp", "dq", "qi", "oth", "k"].some((part) => part in key)) refused();
	}
}

function signer(raw: unknown): {
	readonly key: KeyObject;
	readonly kid: string;
	readonly jwks: Readonly<Record<string, unknown>>;
} {
	if (typeof raw !== "object" || raw === null || types.isProxy(raw) || !types.isKeyObject(raw))
		refused();
	for (const name of Reflect.ownKeys(raw)) {
		const descriptor = Object.getOwnPropertyDescriptor(raw, name);
		if (!descriptor || !("value" in descriptor)) refused();
	}
	// Derive only the public half; the supplied private object is never serialized.
	const publicKey = createPublicKey(raw as KeyObject);
	const bits = publicKey.asymmetricKeyDetails?.modulusLength;
	if (publicKey.asymmetricKeyType !== "rsa" || bits === undefined || bits < 2048 || bits > 4096)
		refused();
	const exported = publicKey.export({ format: "jwk" });
	const kid =
		"DYTEST-" +
		createHash("sha256")
			.update(JSON.stringify([exported.n, exported.e]))
			.digest("hex")
			.slice(0, 24);
	const jwk = Object.freeze({ ...exported, kid, alg: "RS256", use: "sig" });
	return {
		key: raw as KeyObject,
		kid,
		jwks: Object.freeze({ keys: Object.freeze([jwk]) }),
	};
}

/** Normalizes public fixture metadata without fetching or registering a client. */
export function normalizeConnectorProfile(
	raw: ConnectorProfileOptions,
): NormalizedConnectorProfile {
	try {
		const input = options(raw);
		const profile = input.profile;
		if (
			profile !== "cimd-public" &&
			profile !== "issuer-resource" &&
			profile !== "cimd-private" &&
			profile !== "loopback-cimd" &&
			profile !== "registered-public"
		)
			refused();
		const cimd = profile !== "issuer-resource" && profile !== "registered-public";
		const authMethod: ConnectorAuthMethod = profile === "cimd-private" ? "private_key_jwt" : "none";
		const redirectUri = redirect(input.redirectUri);
		if (profile === "loopback-cimd" && !loopback(new URL(redirectUri))) refused();
		const signing = authMethod === "private_key_jwt" ? signer(input.privateKey) : undefined;
		if (!signing && (input.privateKey !== undefined || input.assertionAudience !== undefined))
			refused();
		const audience =
			input.assertionAudience === undefined ? undefined : httpsUrl(input.assertionAudience);
		const recorded = input.metadata === undefined ? undefined : metadataSnapshot(input.metadata);
		const clientId = identity(recorded ? recorded.client_id : input.clientId, cimd);
		if (input.clientId !== undefined && input.clientId !== clientId) refused();
		if (recorded) {
			if (["client_secret", "registration_access_token"].some((field) => field in recorded))
				refused();
			if (recorded.token_endpoint_auth_method !== authMethod) refused();
			const uris = recorded.redirect_uris;
			if (!Array.isArray(uris) || uris.length < 1 || uris.length > 16) refused();
			const allowed = uris.map(redirect);
			if (profile === "loopback-cimd" && allowed.some((uri) => !loopback(new URL(uri)))) refused();
			if (!allowed.some((uri) => matchesRedirect(redirectUri, uri, profile === "loopback-cimd")))
				refused();
			if (
				recorded.token_endpoint_auth_signing_alg !== undefined &&
				recorded.token_endpoint_auth_signing_alg !== "RS256"
			)
				refused();
			if (recorded.jwks_uri !== undefined) httpsUrl(recorded.jwks_uri);
			if (recorded.jwks !== undefined) publicJwks(recorded.jwks);
			if (recorded.jwks !== undefined && recorded.jwks_uri !== undefined) refused();
			if (signing && recorded.jwks_uri === undefined && recorded.jwks === undefined) refused();
		}
		const metadata =
			(recorded && signing && recorded.jwks !== undefined
				? Object.freeze({ ...recorded, jwks: signing.jwks })
				: recorded) ??
			Object.freeze({
				client_id: clientId,
				client_name: "DYTEST synthetic connector",
				redirect_uris: Object.freeze([redirectUri]),
				token_endpoint_auth_method: authMethod,
				grant_types: Object.freeze(["authorization_code", "refresh_token"]),
				response_types: Object.freeze(["code"]),
				...(signing ? { jwks: signing.jwks } : {}),
			});
		const requirements = Object.freeze({ cimd, authMethod });
		return Object.freeze({
			clientId,
			redirectUri,
			authMethod,
			requirements,
			clientMetadata: () => metadata,
			clientJwks: () => signing?.jwks,
			authenticateForm(form: URLSearchParams, endpoint: string): void {
				try {
					httpsUrl(endpoint);
					if (types.isProxy(form) || !(form instanceof URLSearchParams)) refused();
					for (const field of ["client_secret", "client_assertion", "client_assertion_type"])
						if (URLSearchParams.prototype.has.call(form, field)) refused();
					URLSearchParams.prototype.set.call(form, "client_id", clientId);
					if (!signing) return;
					const now = Math.floor(Date.now() / 1000);
					if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + 60)) refused();
					const encode = (value: unknown): string =>
						Buffer.from(JSON.stringify(value)).toString("base64url");
					const header = encode({ alg: "RS256", kid: signing.kid, typ: "JWT" });
					const claims = encode({
						iss: clientId,
						sub: clientId,
						aud: audience ?? endpoint,
						jti: randomBytes(16).toString("hex"),
						iat: now,
						exp: now + 60,
					});
					const input = `${header}.${claims}`;
					const signature = sign("RSA-SHA256", Buffer.from(input), {
						key: signing.key,
						padding: constants.RSA_PKCS1_PADDING,
					}).toString("base64url");
					URLSearchParams.prototype.set.call(
						form,
						"client_assertion_type",
						"urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
					);
					URLSearchParams.prototype.set.call(form, "client_assertion", `${input}.${signature}`);
				} catch {
					refused();
				}
			},
		});
	} catch {
		return refused();
	}
}
