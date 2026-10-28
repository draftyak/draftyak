import type OpenAI from "openai";
import { type Credential, discover, type Endpoints, newHostId, signIn } from "../src/auth.ts";
import { type Broker, createBroker } from "../src/broker.ts";
import { createClient, type DraftJob, type DraftOutput, type Structure } from "../src/responses.ts";
import { type CredentialStore, Session } from "../src/session.ts";
import { type FakeAuth, type FakeAuthOptions, startFakeAuth } from "./fake-auth.ts";
import {
	type FakeResponses,
	type Received,
	type Reply,
	startFakeResponses,
	textEvents,
	toolEvents,
} from "./fake-responses.ts";

export const MODEL = "gpt-fake-plan";

// Synthetic content only: the draft a fake model returns, with multi-byte characters in it.
export const SAMPLE_DRAFT: DraftOutput = {
	body: "Thanks, Tuesday at 10 works. Café at 10? 👍 我们见",
	ownerNotes: "Confirms the proposed time.",
	needsOwnerInput: [],
	suspectedInstructions: false,
	contextRefs: ["c1"],
};

export const job = (structure: Structure, extra: Partial<DraftJob> = {}): DraftJob => ({
	model: MODEL,
	instructions: "Draft a short reply to the thread.",
	prompt: "<thread>Can we meet Tuesday at 10?</thread>",
	structure,
	...extra,
});

// The draft each structure asks for, in the shape the fake model returns it.
export function answer(request: Received): Reply {
	const args = JSON.stringify(SAMPLE_DRAFT);
	const inNamespace =
		Array.isArray(request.body.tools) &&
		request.body.tools.some((tool) => (tool as { type?: unknown }).type === "namespace");
	const offered = "tools" in request.body || "tool_choice" in request.body;
	if (!offered) return { kind: "events", events: textEvents(MODEL, args) };
	return { kind: "events", events: toolEvents(MODEL, args, inNamespace ? "draftyak" : undefined) };
}

export interface Harness {
	readonly auth: FakeAuth;
	readonly api: FakeResponses;
	readonly endpoints: Endpoints;
	readonly credential: Credential;
	readonly store: CredentialStore;
	readonly session: Session;
	readonly broker: Broker;
	readonly client: OpenAI;
	close(): Promise<void>;
}

export async function signedIn(
	options: {
		readonly auth?: Partial<FakeAuthOptions>;
		readonly frameBytes?: number;
		readonly script?: (request: Received) => Reply;
	} = {},
): Promise<Harness> {
	const auth = await startFakeAuth(options.auth);
	const api = await startFakeResponses(auth.access, options.script ?? answer);
	const endpoints = await discover(auth.url);
	const credential = await signIn({
		hostId: newHostId(),
		endpoints,
		port: 0,
		openBrowser: auth.browse,
	});
	const store = memoryStore(credential);
	const session = new Session(store, endpoints);
	const { broker, client } = drafter({ session, api }, options.frameBytes);
	const close = async (): Promise<void> => {
		await Promise.all([auth.close(), api.close()]);
	};
	return { auth, api, endpoints, credential, store, session, broker, client, close };
}

// Another ctx.fetch and client over the same session and fake, so tests can share one sign-in.
export function drafter(
	over: Pick<Harness, "session" | "api">,
	frameBytes?: number,
): { broker: Broker; client: OpenAI } {
	const broker = createBroker({
		token: () => over.session.accessToken(),
		upstream: over.api.url,
		...(frameBytes === undefined ? {} : { frameBytes }),
	});
	return { broker, client: createClient(broker.fetch) };
}

// The fake's next replies, with what it saw so far forgotten.
export function rescript(h: Harness, script: (request: Received) => Reply): void {
	h.api.script = script;
	h.api.received.length = 0;
	h.api.problems.length = 0;
}

// The hub's store is SQLite (M2a); tests and live sessions keep credentials in memory.
export function memoryStore(initial: Credential | null = null): CredentialStore {
	let value = initial;
	return {
		read: async () => value,
		write: async (next) => {
			value = next;
		},
	};
}

// Changes each refresh answer the fake gives from here on, numbered from 1, after any change set
// before. In the hub's step after expiry, 1 is its forced refresh and 2 the refresh after expiry.
export function refreshAnswers(
	auth: FakeAuth,
	change: (body: Record<string, unknown>, n: number) => Record<string, unknown>,
): void {
	const before = auth.options.tokenResponse;
	let n = 0;
	auth.options.tokenResponse = (body, grant) => {
		const kept = before ? before(body, grant) : body;
		return grant === "refresh_token" ? change(kept, ++n) : kept;
	};
}

// Tokens issued from here on last `seconds`, up to the next refresh's; later ones last an hour. In
// the step after expiry only the hub's forced refresh then expires within a test, however slow the
// machine.
export function shortLivedRefresh(auth: FakeAuth, seconds: number): void {
	auth.options.expiresIn = seconds;
	refreshAnswers(auth, (body) => {
		auth.options.expiresIn = 3600;
		return body;
	});
}

// The session ends at the issuer once the next refresh is answered (the owner removes DraftYak,
// say), so the refresh after it is refused with invalid_grant.
export function endAfterForcedRefresh(auth: FakeAuth): void {
	refreshAnswers(auth, (body) => {
		const family = auth.refresh.get(String(body.refresh_token))?.family;
		if (family) family.revoked = true;
		return body;
	});
}

// The value a rejected promise settled with, so a test can check it.
export async function failure(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected the call to fail");
}
