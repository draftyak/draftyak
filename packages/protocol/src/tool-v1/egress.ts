import * as z from "zod";
import type { HeaderList } from "../hash.ts";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Two or more lower-case LDH labels, the last starting with a letter, so no IPv4 address matches.
export const DNS_NAME: string = `(?:${LABEL}\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?`;

export const DnsHost: z.ZodString = z
	.string()
	.max(253)
	.regex(new RegExp(`^${DNS_NAME}$`))
	.meta({ description: "A DNS host name in lower case, never an IP address." });

// Names that resolve only on the owner's machine or network, or nowhere on the public DNS.
const LOCAL_SUFFIXES = Object.freeze(["localhost", "local", "internal", "home.arpa", "onion"]);

export const PublicDnsHost: z.ZodString = DnsHost.refine(
	(host) => !LOCAL_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)),
	"a name under localhost, local, internal, home.arpa or onion isn't public",
);

const SECRET_NAME = "[a-z][A-Za-z0-9]{0,31}";

export const UrlSecretName: z.ZodString = z
	.string()
	.regex(new RegExp(`^${SECRET_NAME}$`))
	.meta({ description: "The name a manifest gives a url-secret, such as calendarUrl." });

// Exactly secret://<name>: any added path, query, fragment, port or userinfo is refused.
export const SecretRef: z.ZodString = z
	.string()
	.regex(new RegExp(`^secret:[/][/]${SECRET_NAME}$`))
	.meta({ description: "secret://<name>, which the hub replaces with the owner-entered address." });

export function parseSecretRef(url: string): string | undefined {
	return SecretRef.safeParse(url).success ? url.slice("secret://".length) : undefined;
}

export const TOOL_REQUESTS_PER_LOOKUP = 4;
export const TOOL_FETCH_MAX_BYTES: number = 32 * 1024 ** 2;
export const TOOL_FETCH_MAX_TIMEOUT_MS = 15_000;

// The tool-* profile: read class, GET or HEAD, a public DNS host or a secret:// reference.
export type ToolEgressRule = {
	class: "read";
	method: "GET" | "HEAD";
	maxBytes: number;
	timeoutMs: number;
} & ({ host: string } | { url: string });

const rule = {
	class: z.literal("read"),
	method: z.enum(["GET", "HEAD"]),
	maxBytes: z.int().min(1).max(TOOL_FETCH_MAX_BYTES),
	timeoutMs: z.int().min(1).max(TOOL_FETCH_MAX_TIMEOUT_MS),
};

export const ToolEgressRule: z.ZodType<ToolEgressRule> = z
	.union([
		z.strictObject({ ...rule, host: PublicDnsHost }),
		z.strictObject({ ...rule, url: SecretRef }),
	])
	.meta({ title: "ToolEgressRule", description: "One egress rule of a tool plugin." });

export const TOOL_REQUEST_HEADERS: readonly ["accept", "if-none-match", "if-modified-since"] =
	Object.freeze(["accept", "if-none-match", "if-modified-since"] as const);
export const TOOL_RESPONSE_HEADERS: readonly [
	"content-type",
	"etag",
	"last-modified",
	"content-length",
] = Object.freeze(["content-type", "etag", "last-modified", "content-length"] as const);

// The headers of `headers` whose names, in any case, are on `allowed`.
export function keepToolHeaders(headers: HeaderList, allowed: readonly string[]): HeaderList {
	return headers.filter(([name]) => allowed.includes(name.toLowerCase()));
}

export const URL_SECRET_MAX_LENGTH = 2048;

export type UrlSecretRefusal =
	| "URL_SECRET_INVALID"
	| "URL_SECRET_NOT_HTTPS"
	| "URL_SECRET_TOO_LONG"
	| "URL_SECRET_USERINFO"
	| "URL_SECRET_HOST"
	| "URL_SECRET_FRAGMENT"
	| "URL_SECRET_NOT_CANONICAL";

export type UrlSecretCheck =
	| { readonly ok: true; readonly url: string; readonly host: string }
	| { readonly ok: false; readonly refusal: UrlSecretRefusal };

// The url-secret entry rules: https (a pasted webcal:// becomes https://), no userinfo, a public
// DNS host, at most 2,048 characters, no fragment, and exactly the URL that fetch sends, so the
// hub can send it byte for byte (a %40 stays %40).
export function checkUrlSecret(input: string): UrlSecretCheck {
	const refuse = (refusal: UrlSecretRefusal): UrlSecretCheck => ({ ok: false, refusal });
	const text = input.trim();
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(text)?.[1]?.toLowerCase();
	if (scheme === undefined) return refuse("URL_SECRET_INVALID");
	if (scheme !== "https" && scheme !== "webcal") return refuse("URL_SECRET_NOT_HTTPS");
	const candidate = `https${text.slice(scheme.length)}`;
	if (candidate.length > URL_SECRET_MAX_LENGTH) return refuse("URL_SECRET_TOO_LONG");
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return refuse("URL_SECRET_INVALID");
	}
	if (url.username !== "" || url.password !== "") return refuse("URL_SECRET_USERINFO");
	if (!PublicDnsHost.safeParse(url.hostname).success) return refuse("URL_SECRET_HOST");
	if (candidate.includes("#")) return refuse("URL_SECRET_FRAGMENT");
	if (url.href !== candidate) return refuse("URL_SECRET_NOT_CANONICAL");
	return { ok: true, url: candidate, host: url.host };
}
