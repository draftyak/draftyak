// What the live session records: AS-side facts only, per client, per step and for the proxy in
// front. Every value is a fixed word, a count, a vendor's public host, a header name, an address
// class, a SHA-256 or a per-session HMAC: never a token, code, address, URL path id, the Funnel host
// or anything the owner typed. A fact counts toward a client only when a client ID or a token names
// it (or, for a DCR registration, the step the owner opened the window in); every other request
// stays with the step it arrived in, unattributed.
import { readdirSync, readFileSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import { assertContentFree, hashId, newSessionKey, redactUrl } from "@draftyak/spike-kit";
import type { Client, Configuration, Provider } from "oidc-provider";
import { type AudienceForm, FetchRefused, type GuardedFetch } from "../../src/cimd.ts";
import type { ConsentRequest, ConsentState } from "../../src/consent.ts";
import { MCP_PATH, SCOPES } from "../../src/provider.ts";
import { recorded } from "../connectors.ts";
import { RECORDED_DIR } from "../record-cimd.ts";

export const CLIENTS = ["claude-ai", "chatgpt", "claude-code", "codex"] as const;
export type ClientName = (typeof CLIENTS)[number];
// Where requests that arrive outside a client's step are kept.
export type StepName = ClientName | "outside steps" | "clean-up";

export const TITLES: Readonly<Record<ClientName, string>> = {
	"claude-ai": "claude.ai",
	chatgpt: "ChatGPT developer mode",
	"claude-code": "remote Claude Code",
	codex: "Codex",
};

// The console's fixed choices when the owner stops a client early; free text is never recorded.
export const OWNER_REASONS = {
	"add-refused": "the client refused to add the server",
	"sign-in-failed": "sign-in failed in the client",
	unavailable: "the client or plan isn't available to the owner",
	"no-time": "skipped for time",
} as const;
export type OwnerReason = keyof typeof OWNER_REASONS;

// The owner's answer in ChatGPT's step (§15 S4: the plan's write access), which the requests alone
// can't give: a blocked tool and an unused one look the same from here.
export const WRITE_TOOL_ANSWERS = {
	allowed: "ChatGPT offered draft_create and ran it",
	blocked: "ChatGPT offered draft_create, but the plan or a setting blocked it",
	"not-offered": "ChatGPT didn't offer draft_create",
	"not-tried": "not tried",
} as const;
export type WriteToolAnswer = keyof typeof WRITE_TOOL_ANSWERS;

export type Decision =
	| { readonly kind: "done" }
	| { readonly kind: "blocked"; readonly reason: OwnerReason }
	| { readonly kind: "deadline" };

export type Outcome = "ok" | "fallback" | "blocked";
export type SurfaceName = "prompts" | "resources" | "completion" | "elicitation" | "apps";

// The session's own probes through the proxy carry this header and are left out of every fact.
export const SELF_CHECK_HEADER = "x-draftyak-self-check";
export const UI_EXTENSION = "io.modelcontextprotocol/ui";
// The fake write tool the live MCP endpoint serves, and the scope §6 puts it under.
export const WRITE_TOOL = "draft_create";
export const WRITE_SCOPE = "drafts:write";
// Tailscale serve adds identity headers to tailnet traffic; Funnel's public traffic has none.
export const TAILNET_IDENTITY = "tailscale-user-login";
export type Route = "tailnet identity headers" | "no identity headers";
export const routeOf = (headers: IncomingHttpHeaders): Route =>
	headers[TAILNET_IDENTITY] === undefined ? "no identity headers" : "tailnet identity headers";

// Forwarding headers the self-check sends as a client's own, from the documentation ranges, to see
// whether the proxy drops, replaces, appends to or passes them (M0.19's Caddy evidence does too).
export const CANARIES: Readonly<Record<string, string>> = {
	"x-forwarded-for": "192.0.2.1",
	forwarded: "for=192.0.2.2",
	"x-real-ip": "192.0.2.3",
};

const PROXY_HEADER =
	/^(?:x-forwarded-[\w-]+|forwarded|x-real-ip|via|tailscale-[\w-]+|true-client-ip|cf-connecting-ip|x-client-ip)$/;
// A proxy's header names are recorded only in this shape; anyone can send any name through Funnel.
const HEADER_NAME = /^[a-z][a-z-]{0,40}$/;
const IP_HEADERS = [
	"x-forwarded-for",
	"x-real-ip",
	"true-client-ip",
	"cf-connecting-ip",
	"x-client-ip",
	"forwarded",
];
const HOST_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/;
const WORD = /^[a-z]+(?:[_-][a-z]+)*$/;
const VERSION = /^\d{4}-\d{2}-\d{2}$/;
const NAME = /^[A-Za-z][\w./-]{0,63}$/;
const CLIENT_INFO = /^[\w .@()+/-]{1,64}$/;
const MEDIA_TYPE = /^[a-z]+\/[\w.+-]{1,64}$/;
const AUTH_METHODS = new Set([
	"none",
	"private_key_jwt",
	"client_secret_basic",
	"client_secret_post",
	"client_secret_jwt",
	"tls_client_auth",
	"self_signed_tls_client_auth",
]);

// Address classes, first match wins; an address is never recorded, only its class.
const ADDRESS_CLASSES: readonly (readonly [name: string, cidr: string])[] = [
	["loopback", "127.0.0.0/8"],
	["loopback", "::1/128"],
	["tailnet", "100.64.0.0/10"],
	["tailnet", "fd7a:115c:a1e0::/48"],
	["private", "10.0.0.0/8"],
	["private", "172.16.0.0/12"],
	["private", "192.168.0.0/16"],
	["private", "fc00::/7"],
	["link-local", "169.254.0.0/16"],
	["link-local", "fe80::/10"],
	["documentation", "192.0.2.0/24"],
	["documentation", "198.51.100.0/24"],
	["documentation", "203.0.113.0/24"],
	["documentation", "2001:db8::/32"],
	// The egress range Claude's connector docs give for claude.ai's server-side requests.
	["Anthropic egress", "160.79.104.0/21"],
];
const CLASS_LISTS = ADDRESS_CLASSES.map(([name, cidr]) => {
	const [network = "", prefix = ""] = cidr.split("/");
	const list = new BlockList();
	list.addSubnet(network, Number(prefix), isIP(network) === 4 ? "ipv4" : "ipv6");
	return [name, list] as const;
});

export function addressClass(address: string | undefined): string {
	if (address === undefined || address === "") return "none";
	const bare = address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "").replace(/%.*$/, "");
	const family = isIP(bare);
	if (family === 0) return "not an address";
	for (const [name, list] of CLASS_LISTS) {
		if (list.check(bare, family === 4 ? "ipv4" : "ipv6")) return name;
	}
	return "public";
}

// What the proxy did with a forwarding header the client sent itself.
export function canaryOutcome(value: string | undefined, canary: string): string {
	if (value === undefined) return "dropped";
	const parts = value.split(",").map((part) => part.trim());
	if (!parts.some((part) => part === canary || part.split(";").includes(canary))) return "replaced";
	return parts.length === 1 ? "passed through" : "appended to";
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();
const bump = (counts: Record<string, number>, key: string, by = 1): void => {
	counts[key] = (counts[key] ?? 0) + by;
};
const header = (headers: IncomingHttpHeaders, name: string): string | undefined => {
	const value = headers[name];
	return Array.isArray(value) ? value.join(", ") : value;
};
const errorCode = (error: unknown): string => {
	const code = (error as { error?: unknown } | undefined)?.error;
	return typeof code === "string" ? safe(code, WORD) : "other";
};

// A string only when it passes the evidence rules, else "other".
function safe(value: string, shape: RegExp): string {
	if (!shape.test(value)) return "other";
	try {
		assertContentFree({ value });
		return value;
	} catch {
		return "other";
	}
}

// The evidence as written: a string that fails the kit's content rules becomes "other", a key that
// fails them is dropped, and the count is kept, so one odd value can't lose a session's evidence.
export function contentFree<T>(value: T): { readonly value: T; readonly replaced: number } {
	let replaced = 0;
	const passes = (text: string): boolean => {
		try {
			assertContentFree(text);
			return true;
		} catch {
			return false;
		}
	};
	const visit = (node: unknown): unknown => {
		if (typeof node === "string") {
			if (passes(node)) return node;
			replaced += 1;
			return "other";
		}
		if (Array.isArray(node)) return node.map(visit);
		if (node === null || typeof node !== "object") return node;
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(node)) {
			if (passes(key)) out[key] = visit(item);
			else replaced += 1;
		}
		return out;
	};
	return { value: visit(value) as T, replaced };
}

// The source URL and SHA-256 of each document recorded in fixtures/cimd/.
export function fixtureHashes(dir: string = RECORDED_DIR): Map<string, string> {
	const hashes = new Map<string, string>();
	for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
		const { source, sha256 } = JSON.parse(readFileSync(path.join(dir, file), "utf8")) as {
			source?: unknown;
			sha256?: unknown;
		};
		if (typeof source === "string" && typeof sha256 === "string") hashes.set(source, sha256);
	}
	return hashes;
}

// The recorded documents name claude.ai's, ChatGPT's and remote Claude Code's client IDs; Codex
// serves its documents under chatgpt.com/oauth/codex/ (learn.chatgpt.com, Codex MCP, 2026-10-18).
// Another ID on claude.ai or chatgpt.com goes to that vendor's client whose step is active, else to
// its hosted client. A registered (DCR) client goes by its self-declared name, then its redirect
// hosts. Any other client ID names no client of the session.
const KNOWN: ReadonlyMap<string, ClientName> = new Map([
	...(["claude-ai", "claude-code", "chatgpt"] as const).map(
		(name) => [String(recorded(name).document.client_id), name] as const,
	),
	[recorded("chatgpt-jwks").source, "chatgpt"],
]);

function byClientName(name: string | undefined): ClientName | undefined {
	const text = name ?? "";
	if (/codex/i.test(text)) return "codex";
	if (/claude code/i.test(text)) return "claude-code";
	if (/chatgpt|openai/i.test(text)) return "chatgpt";
	if (/claude/i.test(text)) return "claude-ai";
	return undefined;
}

function byRedirectHosts(uris: readonly string[]): ClientName | undefined {
	const hosts = uris.map((uri) => URL.parse(uri)?.host);
	if (hosts.includes("claude.ai")) return "claude-ai";
	if (hosts.includes("chatgpt.com")) return "chatgpt";
	return undefined;
}

export function identify(
	clientId: string,
	client?: Pick<Client, "clientName" | "redirectUris">,
	active?: ClientName,
): ClientName | undefined {
	const known = KNOWN.get(clientId);
	if (known) return known;
	const url = URL.parse(clientId);
	if (url?.protocol === "https:" && url.host === "chatgpt.com") {
		return url.pathname.startsWith("/oauth/codex/") || active === "codex" ? "codex" : "chatgpt";
	}
	if (url?.protocol === "https:" && url.host === "claude.ai") {
		return active === "claude-code" ? "claude-code" : "claude-ai";
	}
	return byClientName(client?.clientName) ?? byRedirectHosts(client?.redirectUris ?? []);
}

export interface RedirectShape {
	readonly scheme: string;
	readonly host: string;
	readonly port: string;
	readonly path: string;
}

// A redirect URI as its parts: loopback hosts by kind, the port as none, a loopback port, default
// or the number, and each path segment that isn't a plain lower-case word as {id}.
export function redirectShape(uri: string): RedirectShape {
	const url = URL.parse(uri);
	if (!url) return { scheme: "other", host: "other", port: "other", path: "other" };
	const hostname = url.hostname.replace(/^\[(.*)\]$/, "$1");
	const loopback =
		hostname === "localhost"
			? "loopback name"
			: hostname === "127.0.0.1"
				? "loopback IPv4"
				: hostname === "::1"
					? "loopback IPv6"
					: undefined;
	const host = loopback ?? safe(hostname, HOST_NAME);
	const port =
		url.port === ""
			? loopback
				? "none"
				: "default"
			: loopback
				? "loopback port"
				: safe(url.port, /^\d{1,5}$/);
	const segments = url.pathname
		.split("/")
		.map((part) => (part === "" || WORD.test(part) ? part : "{id}"));
	return {
		scheme: safe(url.protocol.slice(0, -1), /^[a-z]+$/),
		host,
		port,
		path: segments.join("/"),
	};
}

const addShape = (shapes: Map<string, RedirectShape>, uri: string): void => {
	const shape = redirectShape(uri);
	shapes.set(JSON.stringify(shape), shape);
};

export interface DocumentFact {
	readonly kind: "cimd" | "jwks";
	readonly host: string;
	readonly fetches: number;
	readonly statuses: Readonly<Record<string, number>>;
	readonly contentTypes: readonly string[];
	// Only for a 200 response holding a JSON object, the one oidc-provider can use.
	readonly sha256?: string;
	readonly matchesFixture?: "yes" | "no" | "no fixture";
	readonly declaredAuthMethod?: string;
}

interface Fetched {
	readonly kind: "cimd" | "jwks";
	readonly host: string;
	fetches: number;
	readonly statuses: Record<string, number>;
	readonly contentTypes: Set<string>;
	document?: {
		readonly sha256: string;
		readonly matchesFixture: "yes" | "no" | "no fixture";
		readonly declaredAuthMethod: string | undefined;
		readonly redirectUris: readonly string[];
		readonly jwksUri: string | undefined;
	};
}

// One client's own facts: what arrived with a client ID or token that names it.
class Facts {
	decision: Decision | undefined;
	writeToolAnswer: WriteToolAnswer | undefined;
	readonly clientIds = new Set<string>();
	readonly cimdIds = new Set<string>();
	readonly dcrIds = new Set<string>();
	readonly jwksUris = new Set<string>();
	// Why a client document or client was refused, first cause first.
	readonly refusals: string[] = [];
	readonly authMethods = new Set<string>();
	readonly audience = new Set<AudienceForm>();
	readonly redirects = {
		requested: new Map<string, RedirectShape>(),
		registered: new Map<string, RedirectShape>(),
		matched: new Set<string>(),
	};
	readonly authorization = {
		requests: 0,
		codes: 0,
		// Requests that named no scope and got the session's default (session.ts).
		withoutScope: 0,
		resource: new Set<string>(),
		scopes: new Set<string>(),
		errors: new Set<string>(),
	};
	readonly consent = { pushed: 0, approved: 0, denied: 0, refused: 0 };
	readonly token = {
		codeExchanges: 0,
		refreshes: 0,
		rotations: 0,
		errors: new Set<string>(),
		origins: new Set<string>(),
		resource: new Set<string>(),
	};
	readonly dcr = {
		registered: new Set<string>(),
		identifiedBy: new Set<string>(),
		errors: new Set<string>(),
	};
	// Where the client's own server-side requests (token endpoint, MCP) came from, as classes.
	readonly requester: Record<string, number> = {};
	readonly grants = new Set<string>();
	readonly mcp = {
		requests: 0,
		ok: 0,
		statuses: {} as Record<string, number>,
		refusals: {} as Record<string, number>,
		httpMethods: {} as Record<string, number>,
		methods: {} as Record<string, number>,
		handledMethods: {} as Record<string, number>,
		attemptedTools: {} as Record<string, number>,
		tools: {} as Record<string, number>,
		writeTool: { listed: 0, called: 0, refusedWithoutScope: 0 },
		tokenScopes: new Set<string>(),
		eras: new Set<"2025" | "2026">(),
		versions: new Set<string>(),
		capabilityKeys: new Set<string>(),
		elicitation: new Set<string>(),
		uiDeclared: false,
		uiMimeTypes: new Set<string>(),
		uiReads: 0,
		otherReads: 0,
		inputRequired: 0,
		inputAnswered: 0,
		clientInfo: new Set<string>(),
		origins: new Set<string>(),
		routes: new Set<string>(),
	};
	cimdConnected = false;
	dcrConnected = false;
}

// Everything that arrived during one step (or outside steps), whoever sent it, plus the events no
// client ID or token tied to a client.
class StepTraffic {
	readonly requests = new Map<string, Record<string, number>>();
	readonly unattributed: Record<string, number> = {};
}

// What the MCP endpoint tells the recorder about one request it served. era is undefined for a
// request with no JSON-RPC message (a GET).
export interface McpRequestFacts {
	readonly httpMethod: string;
	readonly era: "2025" | "2026" | undefined;
	readonly methods: readonly string[];
	readonly versions: readonly string[];
	readonly capabilities?: unknown;
	readonly clientInfo?: unknown;
	readonly tools: readonly string[];
	readonly reads: { readonly ui: number; readonly other: number };
	readonly inputAnswered: boolean;
	readonly headers: IncomingHttpHeaders;
}

export type McpRefusal =
	| "unsupported media type"
	| "body too large"
	| "parse error"
	| "header mismatch"
	| "unsupported protocol version";

export interface McpAnswer {
	readonly status: number;
	// A successful JSON-RPC result, rather than a pre-handler or protocol refusal.
	readonly handled: boolean;
	readonly refusal?: McpRefusal | undefined;
	readonly inputRequired: boolean;
	// Whether a tools/list result named the write tool.
	readonly listedWriteTool: boolean;
}

interface EventContext {
	readonly headers: IncomingHttpHeaders;
	readonly req?: IncomingMessage;
	readonly oidc?: {
		readonly client?: Client;
		readonly params?: Readonly<Record<string, unknown>>;
		readonly body?: Readonly<Record<string, unknown>>;
	};
}

export interface Row {
	readonly client: ClientName;
	readonly outcome: Outcome;
	readonly reason: string;
	readonly dcrFallbackVerified: "yes" | "no";
	readonly owner: string;
	readonly registration: readonly string[];
	readonly cimd: readonly DocumentFact[];
	readonly jwks: readonly DocumentFact[];
	readonly cimdRefused: readonly string[];
	readonly authMethods: readonly string[];
	readonly audience: readonly string[];
	readonly redirectUris: Readonly<{
		requested: readonly RedirectShape[];
		registered: readonly RedirectShape[];
		declared: readonly RedirectShape[];
		matched: readonly string[];
	}>;
	readonly authorization: Readonly<Record<string, unknown>>;
	readonly consent: Readonly<Record<string, number>>;
	readonly token: Readonly<Record<string, unknown>>;
	readonly dcr: Readonly<Record<string, unknown>>;
	readonly requester: Readonly<Record<string, number>>;
	readonly era: "2025" | "2026" | "both" | "none";
	readonly protocolVersions: readonly string[];
	// Used: prompts/get, a resources/read other than a view, completion/complete, an answered
	// input-required result, a ui:// read. The surface table for docs/guides/mcp-clients.md.
	readonly surfaces: Readonly<Record<SurfaceName, boolean>>;
	// Used, or declared in the capabilities, or listed: prompts/list, resources/list or
	// templates/list, an elicitation capability, the UI extension.
	readonly declaredOrListed: Readonly<Record<SurfaceName, boolean>>;
	readonly mcp: Readonly<Record<string, unknown>>;
	readonly routes: readonly string[];
}

export interface LiveData {
	readonly session: Readonly<Record<string, unknown>>;
	readonly clients: readonly Row[];
	readonly proxy: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
	readonly traffic: Readonly<Record<string, unknown>>;
	readonly hostedClaudeOrigin: readonly string[];
	readonly chatgptWriteToolAccess: Readonly<Record<string, unknown>>;
	readonly dcrWindow: Readonly<Record<string, number>>;
	readonly consentRefusedByLimits: number;
	readonly serverErrors: number;
	readonly [key: string]: unknown;
}

interface ProxyGroup {
	requests: number;
	readonly headers: Set<string>;
	readonly clientIpHeader: Set<string>;
	readonly forwardedForEntries: Record<string, number>;
	readonly nearestUntrustedHop: Record<string, number>;
	readonly host: Set<string>;
	readonly forwardedHost: Set<string>;
	readonly forwardedProto: Set<string>;
	readonly clientSent: Map<string, Set<string>>;
}

export interface RecorderOptions {
	readonly publicOrigin: URL;
	readonly cimdHosts: ReadonlySet<string>;
	readonly fixtures?: ReadonlyMap<string, string>;
	// The requester address behind the trusted proxy (ProxyTrust.clientIp); only its class is kept.
	readonly clientIp?: (incoming: IncomingMessage) => string | undefined;
}

export type ProgressListener = (client: ClientName | undefined, text: string) => void;

// The rule session.ts adds for clients registered in the DCR window.
export const SESSION_DCR_RULE = "any loopback port (the session's rule for registered clients)";

const DCR_HINT =
	"open the DCR window with `pnpm --filter @draftyak/spike-s04-oauth-as dcr-window` and retry with registration";

export class Recorder {
	readonly #publicOrigin: URL;
	readonly #cimdHosts: ReadonlySet<string>;
	readonly #fixtures: ReadonlyMap<string, string>;
	readonly #clientIp: ((incoming: IncomingMessage) => string | undefined) | undefined;
	readonly #key = newSessionKey();
	readonly #facts = new Map<ClientName, Facts>(CLIENTS.map((name) => [name, new Facts()]));
	readonly #names = new Map<string, ClientName>();
	readonly #fetched = new Map<string, Fetched>();
	// The first recorded cause per client ID or URL; later refusals of it are its consequences.
	readonly #causes = new Map<string, string>();
	readonly #proxy = new Map<string, ProxyGroup>();
	readonly #steps = new Map<StepName, StepTraffic>();
	readonly #listeners: ProgressListener[] = [];
	readonly #told = new Set<string>();
	readonly #withoutScope = new WeakSet<IncomingMessage>();
	#active: ClientName | undefined;
	#outside: StepName = "outside steps";
	#asserting: string | undefined;
	#serverErrors = 0;
	#dcrOpened = 0;
	#dcrRegistrations = 0;
	#consentRefused = 0;

	constructor(options: RecorderOptions) {
		this.#publicOrigin = options.publicOrigin;
		this.#cimdHosts = options.cimdHosts;
		this.#fixtures = options.fixtures ?? fixtureHashes();
		this.#clientIp = options.clientIp;
	}

	get active(): ClientName | undefined {
		return this.#active;
	}

	onProgress(listener: ProgressListener): void {
		this.#listeners.push(listener);
	}

	#tell(client: ClientName | undefined, text: string, once = true): void {
		const key = `${client}\n${text}`;
		if (once && this.#told.has(key)) return;
		this.#told.add(key);
		for (const listener of this.#listeners) listener(client, text);
	}

	begin(client: ClientName): void {
		this.#active = client;
		for (const key of [...this.#told]) if (key.startsWith(`${client}\n`)) this.#told.delete(key);
	}

	end(client: ClientName, decision: Decision, writeTool?: WriteToolAnswer): void {
		const facts = this.#of(client);
		facts.decision = decision;
		if (writeTool !== undefined) facts.writeToolAnswer = writeTool;
		if (this.#active === client) this.#active = undefined;
	}

	// From now on, requests outside a step count toward the clean-up.
	cleaningUp(): void {
		this.#outside = "clean-up";
	}

	#of(client: ClientName): Facts {
		const facts = this.#facts.get(client);
		if (!facts) throw new Error(`no facts for ${client}`);
		return facts;
	}

	#step(): StepTraffic {
		const name = this.#active ?? this.#outside;
		let step = this.#steps.get(name);
		if (!step) {
			step = new StepTraffic();
			this.#steps.set(name, step);
		}
		return step;
	}

	// An event no client ID or token ties to a session client, kept with the step it happened in.
	#unattributed(event: string): void {
		bump(this.#step().unattributed, event);
		this.#tell(undefined, `${event} (no client of this session named)`);
	}

	// The client a client ID belongs to, or undefined when it names none of the four.
	nameOf(clientId: string, client?: Client): ClientName | undefined {
		const name = this.#owner(clientId, client);
		if (name !== undefined) this.#of(name).clientIds.add(clientId);
		return name;
	}

	#owner(id: string, client?: Pick<Client, "clientName" | "redirectUris">): ClientName | undefined {
		let name = this.#names.get(id);
		if (name === undefined) {
			name = identify(id, client, this.#active);
			if (name !== undefined) this.#names.set(id, name);
		}
		return name;
	}

	// A registered client: by its self-declared name or redirect hosts, else the step the owner opened
	// the DCR window in.
	#registeredOwner(
		clientName: string | undefined,
		redirectUris: readonly string[],
	): readonly [ClientName, string] | undefined {
		const byName = byClientName(clientName);
		if (byName) return [byName, "client name"];
		const byHost = byRedirectHosts(redirectUris);
		if (byHost) return [byHost, "redirect host"];
		return this.#active === undefined ? undefined : [this.#active, "active step"];
	}

	// An authorization request that named no scope, before the provider reads it (session.ts).
	scopeDefaulted(request: IncomingMessage): void {
		this.#withoutScope.add(request);
	}

	#category(value: string | undefined): string {
		if (value === undefined || value === "") return "none";
		if (value === "null") return "null";
		if (value === this.#publicOrigin.origin) return "self";
		const url = URL.parse(value);
		if (url?.protocol !== "https:" || url.port !== "" || `${url.origin}` !== value) return "other";
		return url.hostname.endsWith(".ts.net") ? "other" : `https://${safe(url.hostname, HOST_NAME)}`;
	}

	#resource(value: unknown): string {
		if (value === undefined) return "absent";
		const resource = new URL(MCP_PATH, this.#publicOrigin).href;
		if (value === resource) return "MCP resource";
		const origin = this.#publicOrigin.origin;
		return value === origin || value === `${origin}/` ? "origin" : "other";
	}

	#scopes(value: unknown): string[] {
		const known = new Set([...SCOPES, "openid", "offline_access"]);
		return String(value ?? "")
			.split(" ")
			.filter(Boolean)
			.map((scope) => (known.has(scope) ? scope : "other"));
	}

	#requester(facts: Facts, incoming: IncomingMessage | undefined): void {
		if (incoming === undefined || this.#clientIp === undefined) return;
		bump(facts.requester, addressClass(this.#clientIp(incoming)));
	}

	#group(route: string): ProxyGroup {
		let group = this.#proxy.get(route);
		if (!group) {
			group = {
				requests: 0,
				headers: new Set(),
				clientIpHeader: new Set(),
				forwardedForEntries: {},
				nearestUntrustedHop: {},
				host: new Set(),
				forwardedHost: new Set(),
				forwardedProto: new Set(),
				clientSent: new Map(),
			};
			this.#proxy.set(route, group);
		}
		return group;
	}

	// Each request as it reached the AS, before the forwarding headers were sanitized.
	arrival(incoming: IncomingMessage, trusted: boolean): void {
		const { headers } = incoming;
		if (header(headers, SELF_CHECK_HEADER) !== undefined) return;
		const [target = "", query = ""] = (incoming.url ?? "").split("?");
		const route = trusted ? routeOf(headers) : "not from the proxy";
		const step = this.#step();
		let kinds = step.requests.get(route);
		if (!kinds) {
			kinds = {};
			step.requests.set(route, kinds);
		}
		bump(kinds, arrivalKind(incoming.method ?? "", target, query));
		if (!trusted) return;
		const group = this.#group(route);
		group.requests += 1;
		for (const name of Object.keys(headers)) {
			if (PROXY_HEADER.test(name)) group.headers.add(safe(name, HEADER_NAME));
		}
		for (const name of IP_HEADERS) {
			const first = (header(headers, name) ?? "").split(",")[0]?.trim() ?? "";
			const candidate =
				name === "forwarded" ? (/for="?\[?([^\]";]+)/i.exec(first)?.[1] ?? "") : first;
			if (isIP(candidate) !== 0) group.clientIpHeader.add(name);
		}
		const forwardedFor = header(headers, "x-forwarded-for");
		const entries = forwardedFor === undefined ? 0 : forwardedFor.split(",").length;
		bump(group.forwardedForEntries, entries > 5 ? "more than 5" : String(entries));
		if (this.#clientIp) bump(group.nearestUntrustedHop, addressClass(this.#clientIp(incoming)));
		const publicHost = this.#publicOrigin.host;
		const host = header(headers, "host") ?? "";
		group.host.add(
			host === publicHost ? "public host" : isLoopbackHost(host) ? "loopback" : "other",
		);
		const forwardedHost = header(headers, "x-forwarded-host");
		group.forwardedHost.add(
			forwardedHost === undefined
				? "absent"
				: forwardedHost === publicHost
					? "public host"
					: "other",
		);
		const proto = header(headers, "x-forwarded-proto");
		group.forwardedProto.add(
			proto === undefined ? "absent" : proto === "https" || proto === "http" ? proto : "other",
		);
	}

	// The self-check's own request: what the proxy did with the forwarding headers it sent.
	selfCheckArrival(incoming: IncomingMessage): void {
		const group = this.#group(routeOf(incoming.headers));
		for (const [name, canary] of Object.entries(CANARIES)) {
			let outcomes = group.clientSent.get(name);
			if (!outcomes) {
				outcomes = new Set();
				group.clientSent.set(name, outcomes);
			}
			outcomes.add(canaryOutcome(header(incoming.headers, name), canary));
		}
	}

	// A POST to the registration route while the DCR window is closed (it answers 404). Nothing in it
	// names a client, so it stays with the step.
	registrationRefused(): void {
		bump(this.#step().unattributed, "registration while the DCR window was closed");
		const who = this.#active === undefined ? "the client" : TITLES[this.#active];
		this.#tell(
			undefined,
			`a registration request arrived while the DCR window is closed (answered 404). If ${who} reports a registration error, ${DCR_HINT}`,
		);
	}

	dcrOpened(): void {
		this.#dcrOpened += 1;
		this.#tell(this.#active, "the DCR window is open for 10 minutes or 10 registrations", false);
	}

	// After cimd's and the DCR window's configure: the outbound fetch, the CIMD allow hooks and the
	// client-assertion check are observed, not changed.
	configure(configuration: Configuration): void {
		const features = configuration.features as Record<string, Record<string, unknown>>;
		const feature = features.clientIdMetadataDocument as {
			allowFetch: (ctx: unknown, id: string) => Promise<boolean>;
			allowClient: (ctx: unknown, client: Client) => Promise<boolean>;
		};
		const { allowFetch, allowClient } = feature;
		feature.allowFetch = async (ctx, id) => {
			const allowed = await allowFetch(ctx, id);
			if (!allowed) {
				const host = URL.parse(id)?.host ?? "";
				if (this.#cimdHosts.has(host)) {
					this.#refused(id, "a failed lookup of this client ID is still remembered", true);
				} else {
					this.#refused(id, "the document's host isn't allowlisted");
				}
			}
			return allowed;
		};
		feature.allowClient = async (ctx, client) => {
			const allowed = await allowClient(ctx, client);
			if (!allowed) {
				this.#refused(client.clientId, "the document's auth method or jwks_uri host isn't allowed");
			}
			return allowed;
		};
		const fetch = configuration.fetch as GuardedFetch;
		configuration.fetch = (async (input, init) => {
			const url = String(input);
			// oidc-provider 9.12.2 fetches client ID metadata documents with redirect "manual", and
			// jwks_uri without it.
			const kind =
				(init as { redirect?: unknown } | undefined)?.redirect === "manual" ? "cimd" : "jwks";
			try {
				const response = await fetch(input, init);
				const bytes = new Uint8Array(await response.clone().arrayBuffer());
				this.#fetchedDocument(url, kind, response, bytes);
				return response;
			} catch (error) {
				const reason = error instanceof FetchRefused ? error.reason : "error";
				this.#refused(url, `the fetch was refused (${reason})`);
				throw error;
			}
		}) satisfies GuardedFetch;
		const assert = configuration.assertJwtClientAuthClaimsAndHeader as (
			...args: [unknown, unknown, unknown, Client | undefined]
		) => Promise<void>;
		// cimd's check reports the audience synchronously, before its first await.
		configuration.assertJwtClientAuthClaimsAndHeader = (
			ctx: unknown,
			claims: unknown,
			header: unknown,
			client: Client | undefined,
		) => {
			this.#asserting = client?.clientId;
			try {
				return assert(ctx, claims, header, client);
			} finally {
				this.#asserting = undefined;
			}
		};
	}

	// cimd's onAssertion: the audience category of a client assertion it accepted.
	assertion(form: AudienceForm): void {
		const name = this.#asserting === undefined ? undefined : this.nameOf(this.#asserting);
		if (name === undefined) return;
		this.#of(name).audience.add(form);
		this.#tell(name, `client assertion audience: ${form}`);
	}

	// A refused client ID, document or jwks_uri. A consequence (the error page looking a failed
	// client up again) is kept only when no earlier cause for that ID was recorded.
	#refused(id: string, reason: string, consequence = false): void {
		const cause = this.#causes.get(id);
		if (cause === reason || (consequence && cause !== undefined)) return;
		if (cause === undefined) this.#causes.set(id, reason);
		const name = this.#owner(id);
		if (name === undefined) {
			this.#unattributed(`CIMD refused: ${reason}`);
			return;
		}
		const facts = this.#of(name);
		facts.clientIds.add(id);
		if (!facts.refusals.includes(reason)) facts.refusals.push(reason);
		this.#tell(name, `CIMD refused: ${reason}. For the DCR fallback, ${DCR_HINT}`);
	}

	#fetchedDocument(
		url: string,
		kind: "cimd" | "jwks",
		response: Response,
		bytes: Uint8Array,
	): void {
		const host = safe(URL.parse(url)?.host ?? "", HOST_NAME);
		let fetched = this.#fetched.get(url);
		if (!fetched) {
			fetched = { kind, host, fetches: 0, statuses: {}, contentTypes: new Set() };
			this.#fetched.set(url, fetched);
		}
		fetched.fetches += 1;
		bump(fetched.statuses, String(response.status));
		const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
		const contentType = type ? safe(type, MEDIA_TYPE) : "none";
		fetched.contentTypes.add(contentType);
		const what = kind === "cimd" ? "client document" : "jwks_uri";
		let parsed: Record<string, unknown> | undefined;
		try {
			const value = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
			if (typeof value === "object" && value !== null && !Array.isArray(value)) {
				parsed = value as Record<string, unknown>;
			}
		} catch {
			parsed = undefined;
		}
		if (response.status !== 200) {
			this.#refused(url, `the ${what} fetch answered HTTP ${response.status} (${contentType})`);
			return;
		}
		if (parsed === undefined) {
			this.#refused(url, `the ${what} wasn't a JSON object (${contentType})`);
			return;
		}
		if (fetched.document) return;
		const { sha256 } = redactUrl(url, bytes);
		const fixture = this.#fixtures.get(url);
		const method = parsed.token_endpoint_auth_method;
		const jwksUri = typeof parsed.jwks_uri === "string" ? parsed.jwks_uri : undefined;
		fetched.document = {
			sha256,
			matchesFixture: fixture === undefined ? "no fixture" : fixture === sha256 ? "yes" : "no",
			declaredAuthMethod:
				typeof method === "string" ? (AUTH_METHODS.has(method) ? method : "other") : undefined,
			redirectUris: [parsed.redirect_uris]
				.flat()
				.filter((uri): uri is string => typeof uri === "string"),
			jwksUri,
		};
		const owner = this.#owner(url);
		if (owner === undefined) {
			this.#unattributed(`a ${what} fetched from ${host}`);
			return;
		}
		// The jwks_uri a client's own document names belongs to that client.
		if (jwksUri !== undefined && !this.#names.has(jwksUri)) this.#names.set(jwksUri, owner);
		const matches =
			fixture === undefined
				? "no recorded fixture"
				: `${fixture === sha256 ? "matches" : "differs from"} its fixtures/cimd/ record`;
		this.#tell(owner, `fetched a ${what} from ${host} (${matches})`);
	}

	consentPushed(request: ConsentRequest): void {
		const name = this.nameOf(request.clientId);
		if (name === undefined) {
			this.#unattributed("a sign-in waits for a code");
			return;
		}
		this.#of(name).consent.pushed += 1;
		this.#tell(
			name,
			"sign-in waiting: type the 2-digit code from the DraftYak page into the session console",
			false,
		);
	}

	consentDecided(clientId: string, state: ConsentState | undefined): void {
		if (state === undefined || state === "pending") return;
		if (state === "refused") this.#consentRefused += 1;
		const name = this.nameOf(clientId);
		if (name === undefined) {
			this.#unattributed(`a sign-in was ${state}`);
			return;
		}
		this.#of(name).consent[state] += 1;
		this.#tell(name, `sign-in ${state}`, false);
	}

	// Which rule let a redirect URI through: exact, cimd's port-free rule, or the session's.
	redirectMatched(clientId: string, rule: string): void {
		const name = this.nameOf(clientId);
		if (name !== undefined) this.#of(name).redirects.matched.add(rule);
	}

	// oidc-provider's events, and its client lookups: the authorization, token, registration and
	// rotation facts, and why a lookup failed.
	attach(provider: Provider): void {
		const find = provider.Client.find.bind(provider.Client);
		provider.Client.find = async (id, options) => {
			try {
				return await find(id, options);
			} catch (error) {
				this.#refused(id, `the client lookup failed (${errorCode(error)})`, true);
				throw error;
			}
		};
		provider.on("interaction.started", (ctx) => this.#authorizationStarted(ctx as EventContext));
		provider.on("authorization.success", (ctx) => {
			const name = this.#client(ctx as EventContext);
			if (name !== undefined) this.#of(name).authorization.codes += 1;
		});
		provider.on("authorization.error", (ctx, error) =>
			this.#failed(ctx as EventContext, error, "authorization"),
		);
		provider.on("grant.success", (ctx) => this.#granted(ctx as EventContext));
		provider.on("grant.error", (ctx, error) => this.#failed(ctx as EventContext, error, "token"));
		provider.on("registration_create.success", (_ctx, client) => {
			const registered = client as Client;
			this.#dcrRegistrations += 1;
			const owner = this.#registeredOwner(registered.clientName, registered.redirectUris);
			if (owner === undefined) {
				this.#unattributed("a client registered in the DCR window");
				return;
			}
			const [name, by] = owner;
			this.#names.set(registered.clientId, name);
			const facts = this.#of(name);
			facts.clientIds.add(registered.clientId);
			facts.dcrIds.add(registered.clientId);
			facts.dcr.registered.add(hashId(this.#key, registered.clientId));
			facts.dcr.identifiedBy.add(by);
			for (const uri of registered.redirectUris) addShape(facts.redirects.registered, uri);
			this.#tell(name, `registered in the DCR window (identified by ${by})`);
		});
		provider.on("registration_create.error", (ctx, error) => {
			const body = (ctx as EventContext).oidc?.body ?? {};
			const uris = [body.redirect_uris]
				.flat()
				.filter((uri): uri is string => typeof uri === "string");
			const clientName = typeof body.client_name === "string" ? body.client_name : undefined;
			const owner = this.#registeredOwner(clientName, uris);
			const code = errorCode(error);
			if (owner === undefined) {
				this.#unattributed(`registration refused: ${code}`);
				return;
			}
			const facts = this.#of(owner[0]);
			facts.dcr.errors.add(code);
			for (const uri of uris) addShape(facts.redirects.registered, uri);
			this.#tell(owner[0], `registration refused: ${code}`);
		});
		provider.on("refresh_token.consumed", (token) => {
			const name = this.nameOf(String((token as { clientId?: unknown }).clientId ?? ""));
			if (name !== undefined) this.#of(name).token.rotations += 1;
		});
		provider.on("server_error", () => {
			this.#serverErrors += 1;
		});
	}

	#client(ctx: EventContext): ClientName | undefined {
		const client = ctx.oidc?.client;
		const id = client?.clientId ?? ctx.oidc?.params?.client_id;
		return typeof id === "string" && id !== "" ? this.nameOf(id, client) : undefined;
	}

	#authorizationStarted(ctx: EventContext): void {
		const name = this.#client(ctx);
		if (name === undefined) {
			this.#unattributed("an authorization request");
			return;
		}
		const facts = this.#of(name);
		const params = ctx.oidc?.params ?? {};
		facts.authorization.requests += 1;
		facts.authorization.resource.add(this.#resource(params.resource));
		if (ctx.req !== undefined && this.#withoutScope.has(ctx.req)) {
			facts.authorization.withoutScope += 1;
			this.#tell(name, "the authorization request named no scope: the session's default applied");
		} else {
			for (const scope of this.#scopes(params.scope)) facts.authorization.scopes.add(scope);
		}
		if (typeof params.redirect_uri === "string") {
			addShape(facts.redirects.requested, params.redirect_uri);
		}
		const client = ctx.oidc?.client;
		if (client?.clientIdMetadataDocument === true) {
			facts.cimdIds.add(client.clientId);
			if (client.jwksUri) facts.jwksUris.add(client.jwksUri);
		}
		this.#tell(name, "authorization request accepted; the consent page is open");
	}

	#granted(ctx: EventContext): void {
		const name = this.#client(ctx);
		const client = ctx.oidc?.client;
		if (name === undefined || client === undefined) return;
		const facts = this.#of(name);
		const params = ctx.oidc?.params ?? {};
		const grantType = String(params.grant_type ?? "");
		if (grantType === "authorization_code") facts.token.codeExchanges += 1;
		if (grantType === "refresh_token") facts.token.refreshes += 1;
		facts.token.origins.add(this.#category(header(ctx.headers, "origin")));
		facts.token.resource.add(this.#resource(params.resource));
		facts.authMethods.add(
			AUTH_METHODS.has(client.clientAuthMethod) ? client.clientAuthMethod : "other",
		);
		this.#requester(facts, ctx.req);
		if (client.clientIdMetadataDocument === true) {
			facts.cimdIds.add(client.clientId);
			if (client.jwksUri) facts.jwksUris.add(client.jwksUri);
		}
		this.#tell(name, `token issued (${safe(grantType, WORD)}, ${client.clientAuthMethod})`);
	}

	#failed(ctx: EventContext, error: unknown, where: "authorization" | "token"): void {
		const code = errorCode(error);
		const name = this.#client(ctx);
		if (name === undefined) {
			this.#unattributed(`${where} error: ${code}`);
			return;
		}
		const facts = this.#of(name);
		(where === "token" ? facts.token.errors : facts.authorization.errors).add(code);
		const redirect = ctx.oidc?.params?.redirect_uri;
		if (where === "authorization" && typeof redirect === "string") {
			addShape(facts.redirects.requested, redirect);
		}
		this.#tell(name, `${where} error: ${code}`);
	}

	mcpUnauthenticated(): void {
		bump(this.#step().unattributed, "MCP request without a valid token");
	}

	// Called by the fake write handler only after its input validation reaches the scope check.
	mcpWriteScope(clientId: string, allowed: boolean): void {
		const name = this.nameOf(clientId);
		if (name === undefined) return;
		const { writeTool } = this.#of(name).mcp;
		writeTool.called += 1;
		if (!allowed) writeTool.refusedWithoutScope += 1;
	}

	// One authenticated MCP request, by the token's client and grant, and how it was answered.
	mcp(
		clientId: string,
		grantId: string,
		scopes: readonly string[],
		request: McpRequestFacts,
		response: McpAnswer,
		incoming?: IncomingMessage,
	): void {
		const name = this.nameOf(clientId);
		if (name === undefined) {
			this.#unattributed("an MCP request with another client's token");
			return;
		}
		const facts = this.#of(name);
		const { mcp } = facts;
		facts.grants.add(hashId(this.#key, grantId));
		for (const scope of this.#scopes(scopes.join(" "))) mcp.tokenScopes.add(scope);
		this.#requester(facts, incoming);
		mcp.requests += 1;
		bump(mcp.statuses, String(response.status));
		if (response.refusal !== undefined) bump(mcp.refusals, response.refusal);
		bump(mcp.httpMethods, safe(request.httpMethod, /^[A-Z]{1,16}$/));
		const ok = response.status >= 200 && response.status < 300;
		if (ok) {
			mcp.ok += 1;
			if (facts.dcrIds.has(clientId)) facts.dcrConnected = true;
			else facts.cimdConnected = true;
		}
		if (request.era !== undefined) mcp.eras.add(request.era);
		for (const version of request.versions) mcp.versions.add(safe(version, VERSION));
		for (const method of request.methods) {
			bump(mcp.methods, safe(method, NAME));
			this.#tell(
				name,
				`MCP ${safe(method, NAME)} (${request.era} era) answered ${response.status}`,
			);
		}
		if (request.era === undefined) {
			this.#tell(
				name,
				`MCP ${safe(request.httpMethod, /^[A-Z]{1,16}$/)} answered ${response.status}`,
			);
		}
		for (const tool of request.tools) bump(mcp.attemptedTools, safe(tool, NAME));
		if (response.handled) {
			for (const method of request.methods) bump(mcp.handledMethods, safe(method, NAME));
			for (const tool of request.tools) bump(mcp.tools, safe(tool, NAME));
			if (response.listedWriteTool) mcp.writeTool.listed += 1;
			mcp.uiReads += request.reads.ui;
			mcp.otherReads += request.reads.other;
			if (request.inputAnswered) mcp.inputAnswered += 1;
			if (response.inputRequired) mcp.inputRequired += 1;
		}
		this.#capabilities(facts, request.capabilities);
		const info = request.clientInfo as { name?: unknown; version?: unknown } | undefined;
		if (typeof info?.name === "string") {
			const version = typeof info.version === "string" ? safe(info.version, CLIENT_INFO) : "none";
			mcp.clientInfo.add(`${safe(info.name, CLIENT_INFO)} ${version}`);
		}
		mcp.origins.add(this.#category(header(request.headers, "origin")));
		mcp.routes.add(routeOf(request.headers));
	}

	#capabilities(facts: Facts, capabilities: unknown): void {
		if (typeof capabilities !== "object" || capabilities === null) return;
		const declared = capabilities as Record<string, unknown>;
		for (const key of Object.keys(declared)) facts.mcp.capabilityKeys.add(safe(key, NAME));
		const elicitation = declared.elicitation;
		if (typeof elicitation === "object" && elicitation !== null) {
			const modes = Object.keys(elicitation).filter((mode) => mode === "form" || mode === "url");
			for (const mode of modes.length > 0 ? modes : ["form"]) facts.mcp.elicitation.add(mode);
		}
		const extensions = declared.extensions as Record<string, unknown> | undefined;
		const ui = extensions?.[UI_EXTENSION] as { mimeTypes?: unknown } | undefined;
		if (ui !== undefined) {
			facts.mcp.uiDeclared = true;
			for (const type of [ui.mimeTypes].flat()) {
				if (typeof type === "string") facts.mcp.uiMimeTypes.add(safe(type, /^[\w./;=+-]{1,64}$/));
			}
		}
	}

	#documents(client: ClientName, kind: "cimd" | "jwks"): DocumentFact[] {
		return [...this.#fetched]
			.filter(([url, fetched]) => fetched.kind === kind && this.#names.get(url) === client)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, fetched]) => ({
				kind,
				host: fetched.host,
				fetches: fetched.fetches,
				statuses: { ...fetched.statuses },
				contentTypes: sorted(fetched.contentTypes),
				...(fetched.document && {
					sha256: fetched.document.sha256,
					matchesFixture: fetched.document.matchesFixture,
					...(kind === "cimd" && fetched.document.declaredAuthMethod !== undefined
						? { declaredAuthMethod: fetched.document.declaredAuthMethod }
						: {}),
				}),
			}));
	}

	#declaredRedirects(client: ClientName): RedirectShape[] {
		const shapes = new Map<string, RedirectShape>();
		for (const [url, fetched] of this.#fetched) {
			if (fetched.kind !== "cimd" || this.#names.get(url) !== client) continue;
			for (const uri of fetched.document?.redirectUris ?? []) addShape(shapes, uri);
		}
		return [...shapes.values()];
	}

	#outcome(facts: Facts): { outcome: Outcome; reason: string } {
		const owner = facts.decision;
		if (owner?.kind === "blocked") {
			return { outcome: "blocked", reason: `owner: ${OWNER_REASONS[owner.reason]}` };
		}
		const notes = [
			...(facts.authorization.withoutScope > 0 ? ["with the session's default scope"] : []),
			...(facts.redirects.matched.has(SESSION_DCR_RULE)
				? ["through the session's any-port loopback rule"]
				: []),
		];
		const noted = (reason: string): string =>
			notes.length === 0 ? reason : `${reason} ${notes.join(", ")}`;
		if (facts.cimdConnected) return { outcome: "ok", reason: noted("connected through CIMD") };
		if (facts.dcrConnected) {
			return {
				outcome: "fallback",
				reason: noted("connected after registering in the DCR window"),
			};
		}
		return { outcome: "blocked", reason: blockedReason(facts) };
	}

	rows(clients: readonly ClientName[] = CLIENTS): Row[] {
		return clients.map((client) => {
			const facts = this.#of(client);
			const { outcome, reason } = this.#outcome(facts);
			const { mcp } = facts;
			const methods = Object.keys(mcp.handledMethods);
			const eras = [...mcp.eras];
			const decision = facts.decision;
			const used: Record<SurfaceName, boolean> = {
				prompts: methods.includes("prompts/get"),
				resources: mcp.otherReads > 0,
				completion: methods.includes("completion/complete"),
				elicitation: mcp.inputAnswered > 0,
				apps: mcp.uiReads > 0,
			};
			return {
				client,
				outcome,
				reason,
				dcrFallbackVerified: facts.dcrConnected ? "yes" : "no",
				owner:
					decision === undefined
						? "not run"
						: decision.kind === "blocked"
							? `blocked: ${decision.reason}`
							: decision.kind,
				registration: sorted([
					...(facts.cimdIds.size > 0 ? ["cimd"] : []),
					...(facts.dcrIds.size > 0 ? ["dcr"] : []),
				]),
				cimd: this.#documents(client, "cimd"),
				jwks: this.#documents(client, "jwks"),
				cimdRefused: [...facts.refusals],
				authMethods: sorted(facts.authMethods),
				audience: sorted(facts.audience),
				redirectUris: {
					requested: [...facts.redirects.requested.values()],
					registered: [...facts.redirects.registered.values()],
					declared: this.#declaredRedirects(client),
					matched: sorted(facts.redirects.matched),
				},
				authorization: {
					requests: facts.authorization.requests,
					codes: facts.authorization.codes,
					withoutScope: facts.authorization.withoutScope,
					resource: sorted(facts.authorization.resource),
					scopes: sorted(facts.authorization.scopes),
					errors: sorted(facts.authorization.errors),
				},
				consent: { ...facts.consent },
				token: {
					codeExchanges: facts.token.codeExchanges,
					refreshes: facts.token.refreshes,
					rotations: facts.token.rotations,
					errors: sorted(facts.token.errors),
					origins: sorted(facts.token.origins),
					resource: sorted(facts.token.resource),
				},
				dcr: {
					registeredClients: sorted(facts.dcr.registered),
					identifiedBy: sorted(facts.dcr.identifiedBy),
					registrationErrors: sorted(facts.dcr.errors),
				},
				requester: { ...facts.requester },
				era: eras.length === 2 ? "both" : (eras[0] ?? "none"),
				protocolVersions: sorted(mcp.versions),
				surfaces: used,
				declaredOrListed: {
					prompts: used.prompts || methods.includes("prompts/list"),
					resources:
						used.resources ||
						methods.includes("resources/list") ||
						methods.includes("resources/templates/list"),
					completion: used.completion,
					elicitation: used.elicitation || mcp.elicitation.size > 0,
					apps: used.apps || mcp.uiDeclared,
				},
				mcp: {
					requests: mcp.requests,
					ok: mcp.ok,
					grants: facts.grants.size,
					statuses: { ...mcp.statuses },
					refusals: { ...mcp.refusals },
					httpMethods: { ...mcp.httpMethods },
					methods: { ...mcp.methods },
					handledMethods: { ...mcp.handledMethods },
					attemptedTools: { ...mcp.attemptedTools },
					tools: { ...mcp.tools },
					writeTool: { ...mcp.writeTool },
					tokenScopes: sorted(mcp.tokenScopes),
					uiReads: mcp.uiReads,
					resourceReads: mcp.otherReads,
					capabilityKeys: sorted(mcp.capabilityKeys),
					elicitation: {
						declared: sorted(mcp.elicitation),
						inputRequired: mcp.inputRequired,
						answered: mcp.inputAnswered,
					},
					apps: { extensionDeclared: mcp.uiDeclared, mimeTypes: sorted(mcp.uiMimeTypes) },
					clientInfo: sorted(mcp.clientInfo),
					origins: sorted(mcp.origins),
				},
				routes: sorted(mcp.routes),
			};
		});
	}

	// Lines for the printed summary: ChatGPT's write tool, and per step what no client was tied to.
	notes(): string[] {
		const lines: string[] = [];
		const chatgpt = this.#of("chatgpt");
		if (chatgpt.decision !== undefined) {
			const { writeTool } = chatgpt.mcp;
			const answer =
				chatgpt.writeToolAnswer === undefined
					? "not answered"
					: WRITE_TOOL_ANSWERS[chatgpt.writeToolAnswer];
			lines.push(
				`ChatGPT's ${WRITE_TOOL}: ${answer}; listed: ${writeTool.listed > 0 ? "yes" : "no"}; called: ${writeTool.called}; refused without ${WRITE_SCOPE}: ${writeTool.refusedWithoutScope}`,
			);
		}
		for (const [name, step] of this.#steps) {
			const events = Object.entries(step.unattributed);
			if (events.length === 0) continue;
			const listed = events.map(([event, count]) => `${event} (${count})`).join("; ");
			lines.push(`not tied to a client during ${name}: ${listed}`);
		}
		return lines.length > 0 ? ["", ...lines] : [];
	}

	// Every request that reached the AS, by step, route and kind, and per step what no client ID or
	// token tied to a client.
	traffic(): Record<string, unknown> {
		return Object.fromEntries(
			[...this.#steps].map(([name, step]) => [
				name,
				{
					requests: Object.fromEntries(
						[...step.requests].map(([route, kinds]) => [route, { ...kinds }]),
					),
					unattributed: { ...step.unattributed },
				},
			]),
		);
	}

	// The evidence data: the rows, what reached the AS through the proxy, and the traffic by step.
	data(
		meta: Readonly<Record<string, unknown>>,
		clients: readonly ClientName[] = CLIENTS,
	): LiveData {
		const rows = this.rows(clients);
		const proxy = Object.fromEntries(
			[...this.#proxy].map(([route, group]) => [
				route,
				{
					requests: group.requests,
					headers: sorted(group.headers),
					clientIpHeader: sorted(group.clientIpHeader),
					forwardedForEntries: { ...group.forwardedForEntries },
					nearestUntrustedHop: { ...group.nearestUntrustedHop },
					host: sorted(group.host),
					forwardedHost: sorted(group.forwardedHost),
					forwardedProto: sorted(group.forwardedProto),
					clientSent: Object.fromEntries(
						[...group.clientSent].map(([name, outcomes]) => [name, sorted(outcomes)]),
					),
				},
			]),
		);
		const byClient = new Map(rows.map((row) => [row.client, row]));
		const chatgpt = clients.includes("chatgpt") ? this.#of("chatgpt") : undefined;
		const built = {
			session: meta,
			clients: rows,
			proxy,
			traffic: this.traffic(),
			hostedClaudeOrigin: (byClient.get("claude-ai")?.mcp.origins as string[] | undefined) ?? [],
			chatgptWriteToolAccess:
				chatgpt === undefined
					? { owner: "not run" }
					: {
							owner:
								chatgpt.writeToolAnswer === undefined
									? "not answered"
									: WRITE_TOOL_ANSWERS[chatgpt.writeToolAnswer],
							listed: chatgpt.mcp.writeTool.listed > 0 ? "yes" : "no",
							called: chatgpt.mcp.writeTool.called,
							refusedWithoutScope: chatgpt.mcp.writeTool.refusedWithoutScope,
						},
			dcrWindow: { opened: this.#dcrOpened, registrations: this.#dcrRegistrations },
			consentRefusedByLimits: this.#consentRefused,
			serverErrors: this.#serverErrors,
		};
		const { value, replaced } = contentFree(built);
		const data: LiveData = { ...value, session: { ...value.session, valuesReplaced: replaced } };
		assertContentFree(data, "live-clients");
		return data;
	}
}

function isLoopbackHost(host: string): boolean {
	const name = host.replace(/:\d+$/, "").replace(/^\[(.*)\]$/, "$1");
	return name === "127.0.0.1" || name === "::1" || name === "localhost";
}

function arrivalKind(method: string, target: string, query: string): string {
	if (method === "OPTIONS") return "preflight";
	if (new URLSearchParams(query).has("check")) return "route check";
	if (target === MCP_PATH) return method === "POST" ? "mcp" : `mcp ${safe(method, /^[A-Z]+$/)}`;
	if (target.startsWith("/.well-known/oauth-protected-resource")) return "resource metadata";
	if (target.startsWith("/.well-known/oauth-authorization-server")) return "AS metadata";
	if (target.startsWith("/.well-known/openid-configuration")) return "openid configuration";
	if (target.startsWith("/.well-known/")) return "other well-known";
	if (target.startsWith("/oauth/interaction/")) return "consent page";
	if (target.startsWith("/oauth/authorize/")) return "authorize resume";
	const routes: Readonly<Record<string, string>> = {
		"/oauth/authorize": "authorize",
		"/oauth/token": "token",
		"/oauth/register": "register",
		"/oauth/revoke": "revoke",
		"/oauth/jwks": "jwks",
	};
	return routes[target] ?? "other";
}

// The furthest a client got, from its own facts only, for a client that never made an MCP request
// with its token. Requests nothing tied to it are in the evidence's traffic, not here.
function blockedReason(facts: Facts): string {
	const { mcp, token, authorization, consent, dcr } = facts;
	if (mcp.requests > 0) return `MCP requests failed (HTTP ${Object.keys(mcp.statuses).join(", ")})`;
	if (token.codeExchanges > 0) return "no MCP request with the issued token";
	if (token.errors.size > 0) return `token request refused: ${sorted(token.errors).join(", ")}`;
	if (authorization.codes > 0) return "no token request after the authorization code";
	if (consent.refused > 0) return "sign-in refused by the consent limits";
	if (consent.denied > 0 && consent.approved === 0) return "sign-in denied in the console";
	if (consent.pushed > 0 && consent.approved === 0) return "sign-in not approved in the console";
	const [cause, ...more] = facts.refusals;
	if (cause !== undefined) {
		return `CIMD refused: ${cause}${more.length > 0 ? ` (and ${more.length} more in cimdRefused)` : ""}`;
	}
	if (authorization.errors.size > 0) {
		return `authorization refused: ${sorted(authorization.errors).join(", ")}`;
	}
	if (dcr.errors.size > 0) return `registration refused: ${sorted(dcr.errors).join(", ")}`;
	return "no request that named this client reached the AS";
}
