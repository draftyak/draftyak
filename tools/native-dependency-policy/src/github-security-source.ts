import { createHash } from "node:crypto";
import { request } from "node:https";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { parseStrictJson } from "./strict-json.ts";

const MAX_BYTES = 1_048_576;
const MAX_AGE = 3_600_000;
const REQUEST_MS = 10_000;
const COLLECTION_MS = 60_000;
const ACCEPT = "application/vnd.github+json";
const byteLength = Object.getOwnPropertyDescriptor(
	Object.getPrototypeOf(Uint8Array.prototype),
	"byteLength",
)?.get;
const repositories = Object.freeze([
	Object.freeze({
		channel: "G1" as const,
		id: 366664320,
		fullName: "gtk-rs/gtk-rs-core",
		defaultBranch: "main",
	}),
	Object.freeze({
		channel: "G2" as const,
		id: 639304056,
		fullName: "z-galaxy/zbus",
		defaultBranch: "main",
	}),
]);
type Repository = (typeof repositories)[number];
export type GitHubSecurityCode =
	| "GITHUB_SECURITY_INVALID"
	| "GITHUB_SECURITY_UNSUPPORTED"
	| "GITHUB_SECURITY_UNAVAILABLE"
	| "GITHUB_SECURITY_CHANGED"
	| "GITHUB_SECURITY_DEADLINE"
	| "GITHUB_SECURITY_RATE_LIMIT"
	| "GITHUB_SECURITY_CLOCK"
	| "GITHUB_SECURITY_STALE"
	| "GITHUB_SECURITY_TEST_ONLY";
export class GitHubSecurityError extends Error {
	readonly code: GitHubSecurityCode;
	constructor(code: GitHubSecurityCode) {
		super("GitHub security channel refused");
		this.name = "GitHubSecurityError";
		this.code = code;
	}
}
function refuse(code: GitHubSecurityCode = "GITHUB_SECURITY_INVALID"): never {
	throw new GitHubSecurityError(code);
}
function digest(domain: string, value: unknown): string {
	return createHash("sha256")
		.update(`draftyak/native-dependency-policy/${domain}/v1\0`)
		.update(JSON.stringify(value))
		.digest("hex");
}
function now(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0) return refuse("GITHUB_SECURITY_CLOCK");
	return value;
}
export interface GitHubSecurityRequest {
	readonly url: string;
	readonly method: "GET";
	readonly accept: typeof ACCEPT;
}
/** Simulation transport only; the production factory accepts no transport or source options. */
export interface GitHubSecurityTestResponse {
	readonly status: number;
	readonly contentType: string;
	readonly link?: string;
	readonly body: Uint8Array;
}
interface Receipt {
	readonly observedAt: number;
	readonly bodySha256: string;
	readonly projectionSha256: string;
}
export interface GitHubSecurityChannel {
	readonly channel: "G1" | "G2";
	readonly repository: Readonly<{ id: number; fullName: string; defaultBranch: string }>;
	readonly inventory: readonly never[];
	readonly initial: Readonly<{ repository: Receipt; advisories: Receipt }>;
	readonly recheck: Readonly<{ repository: Receipt; advisories: Receipt }>;
}
export interface GitHubSecurityChannelFacts {
	readonly delivery: "fixed-public-github-advisory-channels";
	readonly revision: string;
	readonly deliveryRevision: string;
	readonly observedAt: number;
	readonly completedAt: number;
	readonly channels: readonly GitHubSecurityChannel[];
}
declare const brand: unique symbol;
export interface GitHubSecurityObservation {
	readonly [brand]: true;
}
export interface GitHubSecuritySource {
	observe(): Promise<GitHubSecurityObservation>;
	revalidate(previous: GitHubSecurityObservation): Promise<GitHubSecurityObservation>;
	facts(observation: GitHubSecurityObservation): GitHubSecurityChannelFacts;
}
interface Services {
	readonly native: boolean;
	readonly clock: () => number;
	readonly transport: (
		request: GitHubSecurityRequest,
		signal: AbortSignal,
	) => Promise<GitHubSecurityTestResponse>;
}
interface Saved {
	readonly owner: GitHubSecuritySource;
	readonly native: boolean;
	readonly facts: GitHubSecurityChannelFacts;
}
const observations = new WeakMap<GitHubSecurityObservation, Saved>();
let backoffUntil = 0;
function fixedRequest(repo: Repository, advisories: boolean): GitHubSecurityRequest {
	return Object.freeze({
		url: `https://api.github.com/repos/${repo.fullName}${advisories ? "/security-advisories?state=published&per_page=100" : ""}`,
		method: "GET",
		accept: ACCEPT,
	});
}
async function nativeTransport(
	selected: GitHubSecurityRequest,
	signal: AbortSignal,
): Promise<GitHubSecurityTestResponse> {
	if (Date.now() < backoffUntil) return refuse("GITHUB_SECURITY_RATE_LIMIT");
	return new Promise((resolve, reject) => {
		let done = false;
		const chunks: Buffer[] = [];
		let size = 0;
		const fail = (code: GitHubSecurityCode): void => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			operation.destroy();
			reject(new GitHubSecurityError(code));
		};
		const operation = request(
			selected.url,
			{
				method: "GET",
				signal,
				agent: false,
				rejectUnauthorized: true,
				maxHeaderSize: 16_384,
				headers: {
					accept: ACCEPT,
					"x-github-api-version": "2022-11-28",
					"user-agent": "draftyak-native-dependency-policy",
				},
			},
			(response) => {
				if (response.statusCode === 403 || response.statusCode === 429) {
					backoffUntil = Date.now() + 900_000;
					fail("GITHUB_SECURITY_RATE_LIMIT");
					response.destroy();
					return;
				}
				if (response.statusCode !== 200) {
					fail("GITHUB_SECURITY_UNAVAILABLE");
					response.destroy();
					return;
				}
				const contentType = response.headers["content-type"];
				const link = response.headers.link;
				if (typeof contentType !== "string" || (link !== undefined && typeof link !== "string")) {
					fail("GITHUB_SECURITY_UNSUPPORTED");
					response.destroy();
					return;
				}
				response.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_BYTES) {
						fail("GITHUB_SECURITY_INVALID");
						response.destroy();
					} else chunks.push(chunk);
				});
				response.once("end", () => {
					if (done) return;
					if (!response.complete) {
						fail("GITHUB_SECURITY_UNAVAILABLE");
						return;
					}
					done = true;
					clearTimeout(timer);
					resolve(
						Object.freeze({
							status: 200,
							contentType,
							...(link === undefined ? {} : { link }),
							body: Buffer.concat(chunks, size),
						}),
					);
				});
				response.once("error", () => fail("GITHUB_SECURITY_UNAVAILABLE"));
				response.once("aborted", () => fail("GITHUB_SECURITY_UNAVAILABLE"));
			},
		);
		const timer = setTimeout(() => fail("GITHUB_SECURITY_DEADLINE"), REQUEST_MS);
		operation.once("error", () => fail("GITHUB_SECURITY_UNAVAILABLE"));
		operation.end();
	});
}
function object(value: unknown): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		types.isProxy(value) ||
		![null, Object.prototype].includes(Object.getPrototypeOf(value))
	)
		return refuse();
	return value as Record<string, unknown>;
}
function wireId(body: Uint8Array, expected: number): void {
	// Strict decoding/duplicate-key validation has already succeeded. Node26 exposes
	// the original numeric token, which must not be replaced with its rounded Number.
	const ids = new WeakMap<object, string>();
	const parsed: unknown = JSON.parse(
		new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body),
		function (this: unknown, key: string, value: unknown, context?: { source?: string }): unknown {
			if (
				key === "id" &&
				this !== null &&
				typeof this === "object" &&
				typeof context?.source === "string"
			)
				ids.set(this, context.source);
			return value;
		},
	);
	if (parsed === null || typeof parsed !== "object" || ids.get(parsed) !== String(expected))
		refuse();
}
function technical(
	response: GitHubSecurityTestResponse,
	repo: Repository,
	advisories: boolean,
): { bytes: Uint8Array; projection: readonly unknown[] } {
	const headers = object(response);
	const descriptors = Object.getOwnPropertyDescriptors(headers);
	if (
		Reflect.ownKeys(headers).some(
			(key) => typeof key !== "string" || !["status", "contentType", "link", "body"].includes(key),
		) ||
		Object.values(descriptors).some((d) => !("value" in d))
	)
		return refuse();
	if (response.status === 403 || response.status === 429)
		return refuse("GITHUB_SECURITY_RATE_LIMIT");
	if (response.status !== 200) return refuse("GITHUB_SECURITY_UNAVAILABLE");
	if (
		typeof response.contentType !== "string" ||
		!["application/json", ACCEPT].includes(
			response.contentType.split(";")[0]?.trim().toLowerCase() ?? "",
		) ||
		Object.hasOwn(response, "link")
	)
		return refuse("GITHUB_SECURITY_UNSUPPORTED");
	const input = response.body;
	if (!(input instanceof Uint8Array) || types.isProxy(input)) return refuse();
	const size: unknown = byteLength?.call(input);
	if (typeof size !== "number" || size > MAX_BYTES) return refuse();
	const bytes = Uint8Array.prototype.slice.call(input) as Uint8Array;
	const value = parseStrictJson(bytes, {
		maxBytes: MAX_BYTES,
		maxDepth: 32,
		maxNodes: 50_000,
		maxStringBytes: 262_144,
	});
	if (advisories) {
		if (!Array.isArray(value) || value.length !== 0) return refuse("GITHUB_SECURITY_UNSUPPORTED");
		return {
			bytes,
			projection: Object.freeze([
				repo.channel,
				repo.id,
				repo.fullName,
				"published-terminal-empty",
				[],
			]),
		};
	}
	const metadata = object(value);
	if (
		metadata.id !== repo.id ||
		metadata.full_name !== repo.fullName ||
		metadata.private !== false ||
		metadata.archived !== false ||
		metadata.default_branch !== repo.defaultBranch
	)
		return refuse();
	wireId(bytes, repo.id);
	return {
		bytes,
		projection: Object.freeze([
			repo.channel,
			repo.id,
			repo.fullName,
			false,
			false,
			repo.defaultBranch,
		]),
	};
}
async function collect(services: Services): Promise<GitHubSecurityChannelFacts> {
	const startedAt = now(services.clock()),
		monotonic = performance.now();
	let lastTime = startedAt;
	const checkedTime = (): number => {
		const value = now(services.clock());
		if (value < lastTime) return refuse("GITHUB_SECURITY_CLOCK");
		lastTime = value;
		return value;
	};
	const remaining = (): number => {
		const value = COLLECTION_MS - (performance.now() - monotonic);
		if (value <= 0) return refuse("GITHUB_SECURITY_DEADLINE");
		return value;
	};
	const read = async (repo: Repository, advisories: boolean): Promise<Receipt> => {
		const requestStarted = performance.now();
		const selected = fixedRequest(repo, advisories);
		const timeout = Math.min(REQUEST_MS, remaining());
		const controller = new AbortController();
		const withinRequest = (): void => {
			remaining();
			if (controller.signal.aborted || performance.now() - requestStarted >= REQUEST_MS)
				refuse("GITHUB_SECURITY_DEADLINE");
		};
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const response = await Promise.race([
				Promise.resolve().then(() => {
					withinRequest();
					return services.transport(selected, controller.signal);
				}),
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => {
						controller.abort();
						reject(new GitHubSecurityError("GITHUB_SECURITY_DEADLINE"));
					}, timeout);
				}),
			]);
			withinRequest();
			const accepted = technical(response, repo, advisories);
			const receipt = Object.freeze({
				observedAt: checkedTime(),
				bodySha256: createHash("sha256").update(accepted.bytes).digest("hex"),
				projectionSha256: digest("github-security-channel-projection", accepted.projection),
			});
			withinRequest();
			return receipt;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			controller.abort();
		}
	};
	try {
		const channels: GitHubSecurityChannel[] = [];
		for (const repo of repositories) {
			const initial = Object.freeze({
				repository: await read(repo, false),
				advisories: await read(repo, true),
			});
			channels.push(
				Object.freeze({
					channel: repo.channel,
					repository: Object.freeze({
						id: repo.id,
						fullName: repo.fullName,
						defaultBranch: repo.defaultBranch,
					}),
					inventory: Object.freeze([]) as readonly never[],
					initial,
					recheck: initial,
				}),
			);
		}
		const checked: GitHubSecurityChannel[] = [];
		for (const channel of channels) {
			const repo = repositories.find((r) => r.channel === channel.channel);
			if (!repo) return refuse();
			const recheck = Object.freeze({
				repository: await read(repo, false),
				advisories: await read(repo, true),
			});
			if (
				recheck.repository.projectionSha256 !== channel.initial.repository.projectionSha256 ||
				recheck.advisories.projectionSha256 !== channel.initial.advisories.projectionSha256
			)
				return refuse("GITHUB_SECURITY_CHANGED");
			checked.push(Object.freeze({ ...channel, recheck }));
		}
		remaining();
		const completedAt = checkedTime();
		const observedAt = Math.min(
			...checked.flatMap((c) => [
				c.initial.repository.observedAt,
				c.initial.advisories.observedAt,
				c.recheck.repository.observedAt,
				c.recheck.advisories.observedAt,
			]),
		);
		if (completedAt - observedAt >= MAX_AGE || completedAt - startedAt >= MAX_AGE)
			return refuse("GITHUB_SECURITY_STALE");
		const revision = digest(
			"github-security-channels",
			checked.map((c) => [
				c.channel,
				c.repository.id,
				c.repository.fullName,
				c.repository.defaultBranch,
				c.initial.repository.projectionSha256,
				c.initial.advisories.projectionSha256,
			]),
		);
		return Object.freeze({
			delivery: "fixed-public-github-advisory-channels",
			revision,
			deliveryRevision: digest("github-security-channel-delivery", [
				startedAt,
				completedAt,
				checked,
			]),
			observedAt,
			completedAt,
			channels: Object.freeze(checked),
		});
	} catch (error) {
		if (error instanceof GitHubSecurityError) throw error;
		return refuse();
	}
}
function source(services: Services): GitHubSecuritySource {
	const issue = (facts: GitHubSecurityChannelFacts): GitHubSecurityObservation => {
		const token = Object.freeze({}) as GitHubSecurityObservation;
		observations.set(token, { owner: result, native: services.native, facts });
		return token;
	};
	const saved = (observation: GitHubSecurityObservation): Saved => {
		const value = observations.get(observation);
		if (!value || value.owner !== result) return refuse();
		const current = now(services.clock());
		if (current < value.facts.completedAt) return refuse("GITHUB_SECURITY_CLOCK");
		if (current - value.facts.observedAt >= MAX_AGE) return refuse("GITHUB_SECURITY_STALE");
		return value;
	};
	const result: GitHubSecuritySource = Object.freeze({
		observe: async () => issue(await collect(services)),
		revalidate: async (previous: GitHubSecurityObservation) => {
			const before = saved(previous);
			const after = await collect(services);
			if (before.facts.revision !== after.revision) return refuse("GITHUB_SECURITY_CHANGED");
			return issue(after);
		},
		facts: (observation: GitHubSecurityObservation) => {
			const value = saved(observation);
			if (!value.native) return refuse("GITHUB_SECURITY_TEST_ONLY");
			return value.facts;
		},
	});
	return result;
}
/** Fixed G1/G2 terminal-empty channel facts only; never a full security feed or allowance. */
export function createGitHubSecuritySource(...unexpected: readonly never[]): GitHubSecuritySource {
	if (unexpected.length !== 0) return refuse();
	return source({ native: true, clock: Date.now, transport: nativeTransport });
}
/** Simulations cannot issue production channel facts, a SecurityBasis or an authorization grant. */
export const githubSecurityTestInterface: {
	create(options: {
		readonly transport: (request: GitHubSecurityRequest) => Promise<GitHubSecurityTestResponse>;
		readonly clock?: () => number;
	}): GitHubSecuritySource;
	metadata(
		owner: GitHubSecuritySource,
		observation: GitHubSecurityObservation,
	): Readonly<Omit<GitHubSecurityChannelFacts, "delivery"> & { delivery: "test-only" }>;
} = Object.freeze({
	create: (options) =>
		source({ native: false, transport: options.transport, clock: options.clock ?? Date.now }),
	metadata: (owner, observation) => {
		const value = observations.get(observation);
		if (!value || value.owner !== owner || value.native) return refuse();
		return Object.freeze({ ...value.facts, delivery: "test-only" });
	},
});
