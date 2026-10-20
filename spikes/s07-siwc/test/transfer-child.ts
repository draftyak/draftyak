import { type Credential, discover, type Endpoints, planUsage, type Tokens } from "../src/auth.ts";
import { createBroker } from "../src/broker.ts";
import { SiwcError } from "../src/errors.ts";
import { createClient, STRUCTURES, type Structure } from "../src/responses.ts";
import { acceptTransfer, type CredentialStore, Session } from "../src/session.ts";
import { memoryStore } from "./harness.ts";
import {
	AFTER_EXPIRY_MS,
	afterRevocation,
	authRecorder,
	DRAFT_TIMEOUT_MS,
	draftOnce,
	isDeferredMinutes,
	liveJob,
	MODEL_SLUG,
	name,
	revokeRefreshToken,
} from "./live-record.ts";

// The receiving side of the documented transfer as its own process (test/transfer.test.ts, M0.27):
// node transfer-child.ts <issuer> <this host's ID> [--revoke] [--live <api origin>]
// [--draft <model> <structure>] [--deferred <minutes> [--after-expiry-ms <ms>]], with transferText
// on stdin. It takes the credential only for its own host ID, refreshes once to own the session,
// revokes it when asked (even after a failed refresh) and prints content-free results, never a
// token. M0.27's live session adds --live (the refresh answer's shape, the revocation statuses and,
// with --revoke, whether the revoked tokens still work), --draft (one draft through the broker,
// before the refresh) and --deferred, with --live and --revoke: after the refresh it keeps the
// session until its access token has expired, then drafts once more with a token from
// Session.accessToken(), which refreshes first, as the product does with drafts hours apart. It
// waits at most <minutes>; tests shorten the time after expiry with --after-expiry-ms.

interface Flags {
	revoke: boolean;
	live?: string;
	draft?: { readonly model: string; readonly structure: Structure };
	deferred?: number;
	afterExpiryMs?: number;
}

const isStructure = (value: string): value is Structure =>
	(STRUCTURES as readonly string[]).includes(value);

function parseFlags(args: readonly string[]): Flags | undefined {
	const flags: Flags = { revoke: false };
	for (let at = 0; at < args.length; at++) {
		const [arg, next = "", third = ""] = args.slice(at, at + 3);
		if (arg === "--revoke") {
			flags.revoke = true;
		} else if (arg === "--live" && /^https?:\/\/[^/]+$/.test(next)) {
			flags.live = next;
			at++;
		} else if (arg === "--draft" && MODEL_SLUG.test(next) && isStructure(third)) {
			flags.draft = { model: next, structure: third };
			at += 2;
		} else if (arg === "--deferred" && isDeferredMinutes(next)) {
			flags.deferred = Number(next);
			at++;
		} else if (arg === "--after-expiry-ms" && /^\d{1,7}$/.test(next)) {
			flags.afterExpiryMs = Number(next);
			at++;
		} else {
			return undefined;
		}
	}
	if (flags.draft && !flags.live) return undefined;
	if (flags.deferred !== undefined && !(flags.live && flags.revoke)) return undefined;
	return flags.afterExpiryMs !== undefined && flags.deferred === undefined ? undefined : flags;
}

const [issuer = "", hostId = "", ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
if (flags === undefined) {
	process.stderr.write(
		"usage: transfer-child.ts <issuer> <host ID> [--revoke] [--live <api origin>] [--draft <model> <structure>] [--deferred <minutes> [--after-expiry-ms <ms>]]\n",
	);
	process.exit(2);
}
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const result: Record<string, unknown> = { accepted: false, refreshed: false };
const recorder = authRecorder();
// When each of the session's refresh requests went out, on the clock its tokens' expiresAt is on.
const refreshesSent: number[] = [];
const sessionFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
	const form = typeof init?.body === "string" ? new URLSearchParams(init.body) : undefined;
	if (form?.get("grant_type") === "refresh_token") refreshesSent.push(Date.now());
	return recorder.fetch(input, init);
}) as typeof fetch;
let session: Session | undefined;
let store: CredentialStore | undefined;
let endpoints: Endpoints | undefined;
// The last tokens this process held: a refresh refused as unusable clears the store, and --live
// still revokes them rather than trusting that refusal.
let last: Credential | undefined;
try {
	const received = acceptTransfer(Buffer.concat(chunks).toString("utf8"), { hostId, issuer });
	result.accepted = true;
	last = received;
	endpoints = await discover(issuer);
	store = memoryStore(received);
	session = new Session(store, endpoints, flags.live ? { fetch: sessionFetch } : {});
	if (flags.live && flags.draft) result.draft = await draft(session, flags.live, flags.draft);
	const refreshed = await session.refresh();
	last = refreshed;
	result.refreshed = true;
	result.rotated = refreshed.tokens?.refreshToken !== received.tokens?.refreshToken;
	result.planUsage = planUsage(refreshed);
	if (flags.live && flags.deferred !== undefined && refreshed.tokens) {
		const step = {
			apiOrigin: flags.live,
			job: flags.draft,
			minutes: flags.deferred,
			afterExpiryMs: flags.afterExpiryMs ?? AFTER_EXPIRY_MS,
		};
		result.deferred = await afterExpiry(session, store, refreshed.tokens, step).catch(
			(error: unknown) => {
				process.exitCode = 1;
				return { ran: true, ...failure(error, true) };
			},
		);
		const newest = await store.read();
		if (newest?.tokens) last = newest;
	}
} catch (error) {
	Object.assign(result, failure(error, flags.live !== undefined));
	process.exitCode = 1;
}
if (flags.live) {
	const refresh = recorder.calls.find((call) => call.kind === "refresh");
	if (refresh) result.refresh = { status: refresh.status, ms: refresh.ms, shape: refresh.shape };
}
if (session && store && flags.revoke) {
	const stored = await store.read();
	const held = stored?.tokens ? stored : flags.live ? last : undefined;
	result.revoked =
		held !== stored && held?.tokens && endpoints
			? await revokeRefreshToken(endpoints, held.clientId, held.tokens.refreshToken, recorder.fetch)
			: await session.revoke();
	if (flags.live && endpoints) {
		const revocations = recorder.calls.filter((call) => call.kind === "revocation");
		result.revocation = revocations.map((call) => call.status);
		if (held?.tokens) {
			const before = recorder.calls.length;
			const after = await afterRevocation(
				held.tokens,
				held.clientId,
				endpoints,
				flags.live,
				recorder.fetch,
			);
			const retried = recorder.calls.slice(before).find((call) => call.kind === "refresh");
			result.afterRevoke = { ...after, ...(retried?.shape && { refreshShape: retried.shape }) };
		}
	}
}
process.stdout.write(JSON.stringify(result));

// A failure's code; for a SiwcError also its detail and, with --live, its status and upstream code.
function failure(error: unknown, live: boolean): Record<string, unknown> {
	const record: Record<string, unknown> = {
		code: error instanceof SiwcError ? error.code : "ERROR",
	};
	if (error instanceof SiwcError) {
		const { detail, status, apiCode } = error.facts;
		if (detail) record.detail = detail;
		if (live && status !== undefined) record.status = status;
		if (live && apiCode !== undefined) record.apiCode = name(apiCode);
	}
	return record;
}

// One draft through the broker, with a token from the session as the product takes it.
async function draft(
	owner: Pick<Session, "accessToken">,
	apiOrigin: string,
	job: NonNullable<Flags["draft"]>,
): Promise<Record<string, unknown>> {
	const broker = createBroker({ token: () => owner.accessToken(), upstream: apiOrigin });
	const record = await draftOnce(
		createClient(broker.fetch),
		liveJob(job.model, job.structure),
		AbortSignal.timeout(DRAFT_TIMEOUT_MS),
	);
	const { status, apiCode } = record.error ?? {};
	return {
		outcome: record.outcome,
		ms: record.ms,
		deltas: record.events.deltas,
		...(record.via && { via: record.via }),
		...(record.error && { code: record.error.code }),
		...(status !== undefined && { status }),
		...(apiCode !== undefined && { apiCode }),
	};
}

interface AfterExpiry {
	readonly apiOrigin: string;
	readonly job: Flags["draft"];
	readonly minutes: number;
	readonly afterExpiryMs: number;
}

// The step after expiry: nothing is sent until afterExpiryMs past the forced refresh's expiresAt,
// unless that is more than `minutes` away. Then one draft (or, without --draft, the token alone)
// asks Session.accessToken(), which refreshes first. A refusal is recorded, never thrown, so the
// revocation still runs.
async function afterExpiry(
	owner: Session,
	kept: CredentialStore,
	early: Tokens,
	step: AfterExpiry,
): Promise<Record<string, unknown>> {
	const due = early.expiresAt + step.afterExpiryMs;
	const dueInMs = due - Date.now();
	if (dueInMs > step.minutes * 60_000) return { ran: false, dueInMs };
	// A minute per timer at most, so a clock that jumped (a PC that slept) still ends the wait on time.
	for (let left = dueInMs; left > 0; left = due - Date.now()) {
		await new Promise((resolve) => setTimeout(resolve, Math.min(left, 60_000)));
	}
	const sentBefore = refreshesSent.length;
	const callsBefore = recorder.calls.length;
	const refused: unknown[] = [];
	const accessToken = (): Promise<string> =>
		owner.accessToken().catch((error: unknown) => {
			refused.push(error);
			throw error;
		});
	const drafted = step.job
		? await draft({ accessToken }, step.apiOrigin, step.job)
		: await accessToken().then(
				() => null,
				() => null,
			);
	const sent = refreshesSent[sentBefore];
	const call = recorder.calls.slice(callsBefore).find((recorded) => recorded.kind === "refresh");
	const newest = (await kept.read())?.tokens;
	const refreshed =
		newest !== undefined && newest !== null && newest.accessToken !== early.accessToken;
	if (!refreshed) process.exitCode = 1;
	return {
		ran: true,
		refreshed,
		rotated: refreshed && newest.refreshToken !== early.refreshToken,
		msAfterExpiry: sent === undefined ? null : sent - early.expiresAt,
		// The forced refresh's answer was the hub's last request before the wait.
		idleMs: sent === undefined ? null : sent - early.savedAt,
		refresh: call ? { status: call.status, ms: call.ms, shape: call.shape } : null,
		draft: drafted,
		...(refused.length > 0 && failure(refused[0], true)),
	};
}
