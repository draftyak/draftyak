import { type Credential, discover, type Endpoints, planUsage } from "../src/auth.ts";
import { createBroker } from "../src/broker.ts";
import { SiwcError } from "../src/errors.ts";
import { createClient, STRUCTURES, type Structure } from "../src/responses.ts";
import { acceptTransfer, type CredentialStore, Session } from "../src/session.ts";
import { memoryStore } from "./harness.ts";
import {
	afterRevocation,
	authRecorder,
	DRAFT_TIMEOUT_MS,
	draftOnce,
	liveJob,
	MODEL_SLUG,
	name,
	revokeRefreshToken,
} from "./live-record.ts";

// The receiving side of the documented transfer as its own process (test/transfer.test.ts, M0.27):
// node transfer-child.ts <issuer> <this host's ID> [--revoke] [--live <api origin>]
// [--draft <model> <structure>], with transferText on stdin. It takes the credential only for its
// own host ID, refreshes once to own the session, revokes it when asked (even after a failed
// refresh) and prints content-free results, never a token. M0.27's live session adds --live (the
// refresh answer's shape, the revocation statuses and, with --revoke, whether the revoked tokens
// still work) and --draft (one draft through the broker, before the refresh).

interface Flags {
	revoke: boolean;
	live?: string;
	draft?: { readonly model: string; readonly structure: Structure };
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
		} else {
			return undefined;
		}
	}
	return flags.draft && !flags.live ? undefined : flags;
}

const [issuer = "", hostId = "", ...rest] = process.argv.slice(2);
const flags = parseFlags(rest);
if (flags === undefined) {
	process.stderr.write(
		"usage: transfer-child.ts <issuer> <host ID> [--revoke] [--live <api origin>] [--draft <model> <structure>]\n",
	);
	process.exit(2);
}
const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const result: Record<string, unknown> = { accepted: false, refreshed: false };
const recorder = authRecorder();
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
	session = new Session(store, endpoints, flags.live ? { fetch: recorder.fetch } : {});
	if (flags.live && flags.draft) result.draft = await draft(session, flags.live, flags.draft);
	const refreshed = await session.refresh();
	last = refreshed;
	result.refreshed = true;
	result.rotated = refreshed.tokens?.refreshToken !== received.tokens?.refreshToken;
	result.planUsage = planUsage(refreshed);
} catch (error) {
	result.code = error instanceof SiwcError ? error.code : "ERROR";
	if (error instanceof SiwcError) {
		const { detail, status, apiCode } = error.facts;
		if (detail) result.detail = detail;
		if (flags.live && status !== undefined) result.status = status;
		if (flags.live && apiCode !== undefined) result.apiCode = name(apiCode);
	}
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

// One draft through the broker with the transferred access token, before the hub's own refresh.
async function draft(
	owner: Session,
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
